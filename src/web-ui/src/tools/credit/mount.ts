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
  homedir: () => {
    // plugin-fs 无 homedir；CREDIT 固定基目录由调用方配置（桌面端 home）
    // 退而用 document 基址不现实，这里由 core 默认 rootDir 覆盖；挂载时建议显式传 rootDir
    return (globalThis as any).__CREDIT_HOME__ ?? ".";
  },
};

let wired: WiredBridge | null = null;

export interface InitOptions {
  /** 显式根目录（默认 <home>/.bitfun/credit，需宿主提供 home） */
  rootDir?: string;
  /** terminal_event 监听所需的 api 实例（可选；不提供则跳过 terminal 采集） */
  api?: { listen(event: string, handler: (data: any) => void): () => void };
  /** Monaco 实例获取器（可选；提供则补发 scroll/selection） */
  getMonacoInstance?: () => any;
}

export async function initCreditBridge(opts: InitOptions = {}): Promise<WiredBridge> {
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
  // 预建目录：bitfunFsPort.mkdir 是 fire-and-forget（Tauri plugin-fs 异步），
  // 若不在 wire 前 await 建好，logger 首次 200ms flush 会早于 mkdir 完成而失败并锁死写。
  try {
    await fsPlugin.mkdir(rootDir as any, { recursive: true } as any);
    await fsPlugin.mkdir(logDir as any, { recursive: true } as any);
    console.info("[credit] init: ensured dirs", { rootDir, logDir });
  } catch (e) {
    console.error("[credit] init: mkdir failed", { rootDir, logDir, error: String(e) });
  }
  wired = wireCreditBridges({
    globalEventBus: globalEventBus as any,
    api: opts.api ?? (api as any),
    agentAPI: agentAPI as any,
    snapshotBus: SnapshotEventBus as any,
    getMonacoInstance: () => {
      try {
        // 返回当前活跃 Monaco editor 实例（用于挂 scroll/selection 补发）
        // Monaco 未初始化时 monacoApi.editor 访问会抛，须吞掉返回 null
        const editors = (monacoApi.editor.getEditors?.() ?? []) as any[];
        const editor = editors.find((e) => e && e.getModel && e.getModel()) ?? editors[0] ?? null;
        return editor;
      } catch {
        return null;
      }
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
  return wired;
}

export function disposeCreditBridge(): void {
  wired?.dispose();
  wired = null;
}
