/**
 * CREDIT 采集桥挂载入口（白名单改动 1/3，同步自 credit/bridges/bitfun）。
 * 仅此文件出现 Bitfun 宿主符号（globalEventBus / agentAPI / SnapshotEventBus / @tauri-apps）。
 * 调用方在 WebUI 启动入口一行：import { initCreditBridge } from "@/tools/credit/mount"; initCreditBridge();
 */
import { globalEventBus } from "@/infrastructure/event-bus";
import { agentAPI } from "@/infrastructure/api/service-api/agentAPI";
import { api } from "@/infrastructure/api/service-api/ApiClient";
import { SnapshotEventBus } from "@/tools/snapshot_system/core/SnapshotEventBus";
import { monacoModelManager } from "@/tools/editor/services/MonacoModelManager";
import { monacoApi } from "@/tools/editor/services/monacoRuntime";
import * as fsPlugin from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { wireCreditBridges, type WiredBridge } from "./index.js";
// 用 namespace 导入并**容错读取**构建标识：若运行时加载的是不含该导出的旧 dist，
// 具名导入会直接抛 SyntaxError 导致整个应用无法启动（诊断代码不该有这种破坏力）。
import * as creditCore from "@credit/core";
import { activeEditTargetService } from "@/tools/editor/services/ActiveEditTargetService";
import type { FsPort } from "@credit/core";

/** Bitfun fs 适配（渲染进程经 Tauri plugin-fs 落盘 home/.bitfun/credit） */
const bitfunFsPort: FsPort = {
  mkdir: (dir) => {
    // plugin-fs mkdir 递归
    void fsPlugin.mkdir(dir as any, { recursive: true } as any);
  },
  appendFile: async (file, data) => {
    await fsPlugin.writeTextFile(file, data, { append: true } as any);
  },
  appendFileSync: (file, data) => {
    // 同步接口在渲染进程不可用；降级为同步阻塞写
    throw new Error("appendFileSync not available in web-ui; use async flush");
  },
  writeFile: async (file, data) => {
    await fsPlugin.writeTextFile(file, data);
  },
  readFile: async (file) => {
    return await fsPlugin.readTextFile(file);
  },
  rename: async (from, to) => {
    const data = await fsPlugin.readTextFile(from);
    await fsPlugin.writeTextFile(to, data);
    await fsPlugin.remove(from);
  },
  // P1：放弃本轮记录（reset）需要删除本轮 raw/behaviors 数据文件
  unlink: async (file) => {
    await fsPlugin.remove(file);
  },
  // 注：FsPort.exists 是同步接口，Tauri plugin-fs 无同步 exists，故不提供；
  // removeSessionData 会直接尝试 unlink，文件不存在时记入 failed 并降级（不抛错）。
  homedir: () => {
    // plugin-fs 无 homedir；CREDIT 固定基目录由调用方配置（桌面端 home）
    // 退而用 document 基址不现实，这里由 core 默认 rootDir 覆盖；挂载时建议显式传 rootDir
    return (globalThis as any).__CREDIT_HOME__ ?? ".";
  },
};

let wired: WiredBridge | null = null;
/** 会话同步轮询定时器（P1：与 MiniApp 原型跨进程同步 session.json） */
let syncTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Bitfun LSP adapter 注册表（延迟加载）。
 *
 * 为什么必须用它：`monacoApi.editor.getEditors()` 恒为空数组，而
 * `monacoApi.editor.getActiveEditor()` 的实现是 `MonacoLspAdapter#getActiveEditor()`，
 * 后者取的是内部 `editors` 集合的**第一个元素**（并非"当前激活的"），
 * 因此无论切到哪个 tab，它永远返回第一个 editor —— 这就是"只有第一个文件有 scroll"的根因。
 * `GlobalAdapterRegistry.adapters` 是按 uri 存的**全部** adapter，从中可取到所有 tab 的 editor。
 */
let adapterRegistry: any = null;

/**
 * 候选 monaco editor 命名空间。
 * Bitfun 可能存在**多个 monaco 副本**：`monacoApi`（import 的）与实际渲染编辑器所用的不是同一个，
 * 表现为 `getEditors()` 恒为空、`getActiveEditor()` 只返回第一个 tab 的 editor。
 * 故把所有候选源都列出来，取真正有 editor 实例的那个。
 */
function editorApiSources(): Array<{ src: string; api: any }> {
  const out: Array<{ src: string; api: any }> = [];
  const wm = (globalThis as any).monaco?.editor;
  if (wm) out.push({ src: "window.monaco", api: wm });
  const ma = (monacoApi as any)?.editor;
  if (ma && ma !== wm) out.push({ src: "monacoApi", api: ma });
  return out;
}

/** 取第一个真正有 editor 实例的源的实例列表 */
function allEditors(): any[] {
  for (const { api } of editorApiSources()) {
    try {
      const l = typeof api.getEditors === "function" ? api.getEditors() ?? [] : [];
      if (l.length > 0) return l.filter(Boolean);
    } catch {
      /* 继续下一个候选源 */
    }
  }
  return [];
}

export interface InitOptions {
  /** 显式根目录（默认 <home>/.bitfun/credit，需宿主提供 home） */
  rootDir?: string;
  /** terminal_event 监听所需的 api 实例（可选；不提供则跳过 terminal 采集） */
  api?: { listen(event: string, handler: (data: any) => void): () => void };
  /** Monaco 实例获取器（可选；提供则补发 scroll/selection） */
  getMonacoInstance?: () => any;
}

/** 版本标记：用于确认运行时加载的是哪一份 mount.ts（排障用） */
const MOUNT_VERSION = "P1-scroll-fix-2026-08-31-c";

export async function initCreditBridge(opts: InitOptions = {}): Promise<WiredBridge> {
  // 打印 core 构建标识：确认运行时加载的是哪一份 @credit/core dist
  // （改完 core 必须重启 dev server，否则进程内仍是旧模块）
  const coreBuild = String(
    (creditCore as unknown as Record<string, unknown>).CORE_BUILD_ID ?? "UNKNOWN(旧 dist)",
  );
  console.info(`[credit] mount version: ${MOUNT_VERSION} | core build: ${coreBuild}`);
  // 注：此处原为"与硬编码期望值比对版本字符串"，已废弃 —— 每次改 core 都需手工同步
  // 期望值，一不同步就误报"版本不匹配"（2026-09-02 实测：dist 正确无误，却因常量
  // 停留在旧值而告警）。改为下方 wire 之后的**能力探测**，不依赖常量同步。
  if (wired) return wired;
  // 桌面端 home（Tauri）；server/web 部署回退到点，需调用方显式传 rootDir
  let home = opts.rootDir;
  if (!home) {
    try {
      home = (await homeDir()) as string;
    } catch {
      home = ".";
    }
  }
  const rootDir = `${home}/.bitfun/credit`;
  const logDir = `${rootDir}/logs`;
  const rawDir = `${rootDir}/raw`; // P1：原始事件层（审计与重放基线）
  // 预建目录：bitfunFsPort.mkdir 是 fire-and-forget（Tauri plugin-fs 异步），
  // 若不在 wire 前 await 建好，logger 首次 200ms flush 会早于 mkdir 完成而失败并锁死写。
  try {
    await fsPlugin.mkdir(rootDir as any, { recursive: true } as any);
    await fsPlugin.mkdir(logDir as any, { recursive: true } as any);
    await fsPlugin.mkdir(rawDir as any, { recursive: true } as any);
    console.info("[credit] init: ensured dirs", { rootDir, logDir, rawDir });
  } catch (e) {
    console.error("[credit] init: mkdir failed", { rootDir, logDir, error: String(e) });
  }

  // 延迟加载 LSP adapter 注册表（用于取全部 tab 的 editor 实例）；失败不影响采集
  try {
    const mod = await import("@/tools/lsp/services/MonacoLspAdapter");
    adapterRegistry = (mod as any).GlobalAdapterRegistry ?? null;
  } catch (e) {
    console.warn("[credit] adapter registry unavailable", { error: String(e) });
  }

  wired = wireCreditBridges({
    globalEventBus: globalEventBus as any,
    api: opts.api ?? (api as any),
    agentAPI: agentAPI as any,
    snapshotBus: SnapshotEventBus as any,
    // 全部 editor 实例（Bitfun 每个 tab 一个 editor），用于全量挂载 scroll/selection，
    // 避免只挂 getEditors()[0] 导致"只有第一个文件的 scroll 被采集"。
    getMonacoEditors: () => {
      const out: any[] = [];
      // 首选：Bitfun 编辑目标注册表 —— 每个编辑器组件挂载时都会 bindTarget，
      // 且 EditTarget 已带上 editor 实例引用（见 ActiveEditTargetService）。
      try {
        const targets = (activeEditTargetService as any)?.targets;
        if (targets && typeof targets.values === "function") {
          for (const t of targets.values()) {
            if (t?.editor) out.push(t.editor);
          }
        }
      } catch {
        /* 注册表不可用时继续尝试其他来源 */
      }
      if (out.length > 0) return out;
      // 次选：LSP adapter 注册表
      try {
        const adapters = adapterRegistry?.adapters;
        if (adapters && typeof adapters.values === "function") {
          for (const a of adapters.values()) {
            const eds = (a as any)?.editors; // TS private，运行时可读（只读用途）
            if (eds && typeof eds.values === "function") {
              for (const ed of eds.values()) if (ed) out.push(ed);
            }
          }
        }
      } catch {
        /* 注册表不可用时回退 */
      }
      if (out.length > 0) return out;
      // 回退：monaco 命名空间的 getEditors()
      try {
        return allEditors();
      } catch {
        return [];
      }
    },
    // B-012：枚举全部 TipTap 编辑器 —— md 文件走 `markdown-editor`（MEditor/TipTap），
    // 不经 Monaco，故 monaco 相关枚举器永远取不到它们。与 monaco 共用同一注册表
    // （ActiveEditTargetService），只取带 `tiptapEditor` 字段的条目。
    getTiptapEditors: () => {
      const out: Array<{ editor: unknown; filePath?: string | null; active?: boolean }> = [];
      try {
        const svc = activeEditTargetService as any;
        // activeTargetId 为私有字段，此处仅**只读**取用（不改行为），用于让采集桥
        // 感知"当前活跃的是哪个编辑器" —— TipTap 自身没有激活事件，不感知则切回
        // 已打开的 md 时不再产出 open/view（monaco 有真实激活事件，故无此问题）。
        const activeId = svc?.activeTargetId ?? null;
        const targets = svc?.targets;
        if (targets && typeof targets.values === "function") {
          for (const t of targets.values()) {
            if (t?.tiptapEditor) {
              out.push({
                editor: t.tiptapEditor,
                filePath: t.editorFilePath ?? null,
                active: t.id === activeId,
              });
            }
          }
        }
      } catch {
        /* 注册表不可用时返回空（采集降级，不干扰主流程） */
      }
      return out;
    },
    // B-012：枚举全部 markdown textarea —— md 文件默认以 textarea 承载
    // （ActiveEditTargetService 中 kind = 'markdown-textarea'，页面无 ProseMirror），
    // TipTap 桥在该场景下无效，必须靠 textarea 桥采集阅读与编辑行为。
    getMarkdownTextareas: () => {
      const out: Array<{ el: unknown; filePath?: string | null; active?: boolean }> = [];
      try {
        const svc = activeEditTargetService as any;
        const activeId = svc?.activeTargetId ?? null;
        const targets = svc?.targets;
        if (targets && typeof targets.values === "function") {
          for (const t of targets.values()) {
            if (t?.textarea) {
              out.push({
                el: t.textarea,
                filePath: t.editorFilePath ?? null,
                active: t.id === activeId,
              });
            }
          }
        }
      } catch {
        /* 注册表不可用时返回空（采集降级，不干扰主流程） */
      }
      return out;
    },
    // B-012：枚举全部 markdown 预览容器 —— 预览是 md 的**默认模式**，纯渲染无编辑器实例，
    // 靠它采集"打开就看"的阅读滚动（行区间按滚动比例 × 源码总行数估算）。
    getMarkdownPreviews: () => {
      const out: Array<{ el: unknown; filePath?: string | null; lineCount?: number | null; active?: boolean }> = [];
      try {
        const svc = activeEditTargetService as any;
        const activeId = svc?.activeTargetId ?? null;
        const targets = svc?.targets;
        if (targets && typeof targets.values === "function") {
          for (const t of targets.values()) {
            if (t?.previewElement) {
              out.push({
                el: t.previewElement,
                filePath: t.editorFilePath ?? null,
                lineCount: t.previewLineCount ?? null,
                active: t.id === activeId,
              });
            }
          }
        }
      } catch {
        /* 注册表不可用时返回空（采集降级，不干扰主流程） */
      }
      return out;
    },
    getMonacoInstance: () => {
      try {
        // 返回当前活跃 Monaco editor 实例（用于挂 scroll/selection 补发）。
        // 多路径获取：Bitfun 的 monacoApi 是包装对象，不同版本暴露的取 editor 的 API 不同，
        // 逐一尝试，取不到返回 null（桥侧会打诊断日志，便于定位）。
        // 优先取"真正有实例的那个 monaco 副本"的全部 editor（覆盖多 tab 场景）
        const list = allEditors();
        if (list.length > 0) {
          return list.find((e) => e && e.getModel && e.getModel()) ?? list[0] ?? null;
        }
        // 回退：逐个候选源试 getActiveEditor
        for (const { api } of editorApiSources()) {
          try {
            if (typeof api.getActiveEditor === "function") {
              const ed = api.getActiveEditor();
              if (ed) return ed;
            }
          } catch {
            /* 继续下一个候选源 */
          }
        }
        return null;
      } catch {
        return null;
      }
    },
    // 新 editor 实例创建（切 tab / 新开文件）时通知桥补挂 scroll/selection，
    // 避免"只有第一个文件的 scroll 被采集"——轮询有延迟，事件驱动可即时生效。
    onEditorCreated: (cb: (ed: any) => void) => {
      try {
        const edApi: any = (monacoApi as any)?.editor ?? (globalThis as any).monaco?.editor;
        if (typeof edApi?.onDidCreateEditor === "function") {
          const d = edApi.onDidCreateEditor(cb);
          return typeof d?.dispose === "function" ? () => d.dispose() : undefined;
        }
      } catch {
        /* noop */
      }
      return undefined;
    },
    // textChanged 主路径：旁路订阅 Monaco model 内容变更（CodeEditor 不外发 editor:file:changed）
    onModelContentChanged: (cb) =>
      monacoModelManager.onModelContentChanged((e: any) =>
        cb({ uri: e.uri, filePath: e.filePath, content: e.content }),
      ),
    // fileOpened / activeEditorChanged 主路径：旁路订阅 model 创建/就绪
    //（Bitfun 打开文件不发 editor:file:opened，EditorManager 未被 CodeEditor 使用）
    onModelCreated: (cb) =>
      monacoModelManager.onModelCreated((e: any) =>
        cb({ uri: e.uri, filePath: e.filePath, language: e.language }),
      ),
    onModelContentReady: (cb) =>
      monacoModelManager.onModelContentReady((e: any) =>
        cb({ uri: e.uri, filePath: e.filePath, content: e.content }),
      ),
    registerMethod: (method, handler) => {
      // credit.* 方法域路由：经 globalEventBus 命名空间（worker app.call → bridge → emit）
      globalEventBus.on(method, (params: any) => handler(params));
    },
    core: {
      store: { fsPort: bitfunFsPort, rootDir },
      logger: { fsPort: bitfunFsPort, logDir },
    },
  });

  // 能力自检（替代原版本字符串硬比对）：直接探测运行时 core 是否具备 P1/B-012 关键能力。
  // 版本字符串需手工同步期望值，一不同步就误报；能力探测真实反映"加载的是不是新 dist"。
  const REQUIRED_CORE_APIS = ["recover", "syncSession", "persist", "flush", "discardPending"] as const;
  const missingApis = REQUIRED_CORE_APIS.filter((m) => typeof (wired as any)?.core?.[m] !== "function");
  if (missingApis.length > 0) {
    console.warn(
      `[credit] core 能力缺失：${missingApis.join(", ")}（实际 build: ${coreBuild}）。` +
        "说明 dev server 仍在用旧模块 —— 请彻底结束进程后重启（仅刷新页面无效）。",
    );
  } else {
    console.info(`[credit] core 能力自检通过（build: ${coreBuild}）`);
  }

  // P1：断点恢复 —— Bitfun 重启后自动续采未提交会话
  // （recording → 沿用原 prId 续采；computing → 回退 recording；committed/idle → 等待 start）
  try {
    const report = await wired.core.recover();
    console.info("[credit] recover:", { action: report.action, prId: report.prId });
  } catch (e) {
    // 打印完整错误信息：仅 String(e) 在 webview 控制台折叠后只剩 "Object"，无法定位
    console.error("[credit] recover failed", {
      error: String(e),
      message: (e as any)?.message ?? null,
      stack: String((e as any)?.stack ?? "").slice(0, 600),
    });
  }

  // 诊断出口（仅 dev）：排查采集链路用。浏览器 console 执行：
  //   __CREDIT__.targets()     查看当前注册的编辑器（kind / filePath / dom 是否连接在文档上）
  //   __CREDIT__.scrollables() 查看页面里真正可滚动的元素（定位滚动体）
  //   __CREDIT__.counts        已产出事件计数（含 tiptap-bridge:scroll:* 诊断项）
  try {
    // 无条件暴露：import.meta.env 在 Tauri webview 的构建替换中可能不生效，
    // 导致诊断出口拿不到（2026-09-02 实测 __CREDIT__ is not defined）。
    // 本应用为本地桌面应用，暴露只读诊断对象无外泄风险。
    {
      (globalThis as any).__CREDIT__ = {
        targets: () =>
          Array.from(((activeEditTargetService as any)?.targets?.values?.() ?? []) as any[]).map(
            (t: any) => ({
              id: String(t?.id ?? "").slice(0, 12),
              kind: t?.kind,
              filePath: t?.editorFilePath ?? null,
              hasMonaco: !!t?.editor,
              hasTiptap: !!t?.tiptapEditor,
              tiptapDomConnected: (t?.tiptapEditor as any)?.view?.dom?.isConnected ?? null,
            }),
          ),
        scrollables: () =>
          (Array.from(document.querySelectorAll("*")) as HTMLElement[])
            .filter((el) => {
              const cs = getComputedStyle(el);
              return (
                (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
                el.scrollHeight > el.clientHeight + 1
              );
            })
            .map((el) => ({
              tag: el.tagName,
              cls: String(el.className ?? "").slice(0, 60),
              scrollH: el.scrollHeight,
              clientH: el.clientHeight,
            })),
        get counts() {
          return (wired as any)?.core?.session?.current?.counts ?? {};
        },
      };
    }
  } catch {
    /* 诊断出口失败不影响采集 */
  }

  // P1：会话同步 —— MiniApp 原型是独立进程，它改写 session.json 后本进程需感知，
  // 否则事件会落到另一个 prId（桥内存会话与磁盘不一致）。2s 轮询，仅在有变更时采纳。
  syncTimer = setInterval(() => {
    void (async () => {
      try {
        const changed = await wired?.core.syncSession();
        if (changed) {
          console.info("[credit] session synced from disk:", {
            prId: wired?.core.session.current?.prId,
            state: wired?.core.session.current?.state,
          });
        }
        // 回写内存会话（最新 seq/counts + 治理统计），否则原型读到的永远是 start 时的快照
        await wired?.core.persist();
      } catch {
        /* 同步/回写失败静默：不干扰采集 */
      }
    })();
  }, 2000);

  return wired;
}

export function disposeCreditBridge(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  wired?.dispose();
  wired = null;
}
