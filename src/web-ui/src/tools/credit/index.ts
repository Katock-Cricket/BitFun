/**
 * bridges/bitfun 组合器：装配四桥 + control-api 到单个 core BridgeSink。
 * 事件源符号由调用方注入（BitFun 端挂载时传入真实 globalEventBus/agentAPI/
 * snapshotBus/api + 路由注册器），以便离线单测用 mock 注入。
 */
import { createBridge, type BridgeSink } from "@credit/core";
import { createForeshadowBridge, type ForeshadowDeps } from "./foreshadow-bridge.js";
import { createAcceptBridge, type AcceptDeps } from "./accept-bridge.js";
import { createAgentBridge, type AgentDeps } from "./agent-bridge.js";
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
  /** 可选：订阅 Monaco model 创建（fileOpened / activeEditorChanged 主路径） */
  onModelCreated?: ForeshadowDeps["onModelCreated"];
  /** 可选：订阅 Monaco model 内容就绪（fileOpened 主路径 + 内容基线初始化） */
  onModelContentReady?: ForeshadowDeps["onModelContentReady"];
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

  try {
    createControlApi({
      registerMethod: deps.registerMethod,
      session: core.session,
      logError: (m, meta) => core.logger.error("control-api", m, meta),
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
