/**
 * bridges/bitfun 组合器：装配四桥 + control-api 到单个 core BridgeSink。
 * 事件源符号由调用方注入（BitFun 端挂载时传入真实 globalEventBus/agentAPI/
 * snapshotBus/api + 路由注册器），以便离线单测用 mock 注入。
 */
import { createBridge, type BridgeSink } from "@credit/core";
import { createForeshadowBridge, type ForeshadowDeps } from "./foreshadow-bridge.js";
import { createAcceptBridge, type AcceptDeps } from "./accept-bridge.js";
import { createAgentBridge, type AgentDeps } from "./agent-bridge.js";
import { createTiptapBridge, type TiptapDeps } from "./tiptap-bridge.js";
import { createTextareaBridge, type TextareaDeps } from "./textarea-bridge.js";
import { createPreviewBridge, type PreviewDeps } from "./preview-bridge.js";
import { OpenedDedup } from "./dom-shared.js";
import { createControlApi, type ControlDeps } from "./control-api.js";

export interface BitfunDeps {
  globalEventBus: ForeshadowDeps["globalEventBus"];
  api: ForeshadowDeps["api"];
  agentAPI: AgentDeps["agentAPI"];
  snapshotBus: AcceptDeps["snapshotBus"];
  registerMethod: ControlDeps["registerMethod"];
  /** 可选：Monaco 实例获取器（用于 scroll/selection 补发） */
  getMonacoInstance?: ForeshadowDeps["getMonacoInstance"];
  /** 可选：订阅 Monaco model 内容变更（textChanged 主路径） */
  onModelContentChanged?: ForeshadowDeps["onModelContentChanged"];
  /**
   * 可选：枚举当前全部 TipTap 编辑器（B-012）。
   * md 文件走 `markdown-editor`（MEditor/TipTap），不走 Monaco，
   * 未提供则 md 文件的行为（打开/编辑/光标/滚动）全部丢失。
   */
  getTiptapEditors?: TiptapDeps["getTiptapEditors"];
  /**
   * 可选：枚举当前全部 markdown textarea（B-012）。
   * md 默认以 textarea 承载（kind = 'markdown-textarea'，页面无 ProseMirror），
   * TipTap 桥在该场景下无效，必须靠此桥采集。
   */
  getMarkdownTextareas?: TextareaDeps["getMarkdownTextareas"];
  /**
   * 可选：枚举当前全部 markdown 预览容器（B-012）。
   * 预览是 md 的**默认模式**且为纯渲染（无 textarea / ProseMirror），
   * 前两个桥都挂不上，必须靠此桥采阅读行为。
   */
  getMarkdownPreviews?: PreviewDeps["getMarkdownPreviews"];
  /** core bridge 选项 */
  core?: Parameters<typeof createBridge>[0];
}

export interface WiredBridge {
  core: BridgeSink;
  dispose(): void;
  flush(): Promise<void>;
}

export function wireCreditBridges(deps: BitfunDeps): WiredBridge {
  const core = createBridge(deps.core);
  // 跨桥共享的 fileOpened 去重器：md 编辑器有三种形态（tiptap/textarea/preview），
  // 切换形态时多个桥可能同时看到"这个文件被打开"，各自去重会产生重复 fileOpened。
  const openedDedup = new OpenedDedup();
  const disposers: Array<() => void> = [];
  const safeCreate = (name: string, fn: () => { dispose(): void }) => {
    try {
      const b = fn();
      console.log(`[credit] bridge created: ${name}`);
      disposers.push(() => b.dispose());
    } catch (e) {
      const err = e as Error;
      console.error(`[credit] bridge FAILED: ${name} :: ${err?.message ?? String(e)}`);
      console.error(`[credit] bridge FAILED stack: ${err?.stack ?? "no-stack"}`);
    }
  };

  safeCreate("foreshadow", () =>
    createForeshadowBridge({
      globalEventBus: deps.globalEventBus,
      api: deps.api,
      getMonacoInstance: deps.getMonacoInstance,
      // 以下字段必须逐个转交：桥只从 deps 取值，漏传即功能静默缺失
      // （getMonacoEditors 漏传 → 只挂第一个 tab 的 editor；
      //  onModelCreated/onModelContentReady 漏传 → fileOpened 事件与即时挂载全部失效）
      getMonacoEditors: deps.getMonacoEditors,
      getMonacoDebugInfo: deps.getMonacoDebugInfo,
      onEditorCreated: deps.onEditorCreated,
      onModelContentChanged: deps.onModelContentChanged,
      onModelCreated: deps.onModelCreated,
      onModelContentReady: deps.onModelContentReady,
      publish: core.publish,
      count: (k) => core.logger.count(k),
      logError: (m, meta) => core.logger.error("foreshadow-bridge", m, meta),
    }),
  );

  safeCreate("accept", () =>
    createAcceptBridge({
      snapshotBus: deps.snapshotBus,
      publish: core.publish,
      count: (k) => core.logger.count(k),
      logError: (m, meta) => core.logger.error("accept-bridge", m, meta),
    }),
  );

  safeCreate("agent", () =>
    createAgentBridge({
      agentAPI: deps.agentAPI,
      publish: core.publish,
      count: (k) => core.logger.count(k),
      logError: (m, meta) => core.logger.error("agent-bridge", m, meta),
    }),
  );

  safeCreate("tiptap", () =>
    createTiptapBridge({
      getTiptapEditors: deps.getTiptapEditors,
      openedDedup,
      publish: core.publish,
      count: (k) => core.logger.count(k),
      logError: (m, meta) => core.logger.error("tiptap-bridge", m, meta),
    }),
  );

  safeCreate("textarea", () =>
    createTextareaBridge({
      getMarkdownTextareas: deps.getMarkdownTextareas,
      openedDedup,
      publish: core.publish,
      count: (k) => core.logger.count(k),
      logError: (m, meta) => core.logger.error("textarea-bridge", m, meta),
    }),
  );

  safeCreate("preview", () =>
    createPreviewBridge({
      getMarkdownPreviews: deps.getMarkdownPreviews,
      openedDedup,
      publish: core.publish,
      count: (k) => core.logger.count(k),
      logError: (m, meta) => core.logger.error("preview-bridge", m, meta),
    }),
  );

  try {
    createControlApi({
      registerMethod: deps.registerMethod,
      session: core.session,
      logError: (m, meta) => core.logger.error("control-api", m, meta),
      // 保存时冲刷治理层暂存并落盘；放弃时丢弃暂存
      flush: async () => {
        await core.flush();
      },
      discard: () => {
        core.discardPending();
      },
    });
    console.log("[credit] bridge created: control-api");
  } catch (e) {
    console.error("[credit] bridge FAILED: control-api", { error: String(e) });
  }

  return {
    core,
    dispose() {
      disposers.forEach((d) => d());
    },
    async flush() {
      await core.flush();
    },
  };
}
