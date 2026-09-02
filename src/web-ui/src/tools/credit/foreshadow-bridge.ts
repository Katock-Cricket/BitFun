/**
 * foreshadow-bridge：订阅 globalEventBus / api 的编辑器相关事件，归一化为
 * CreditRawEvent（textChanged / selectionChanged / activeEditorChanged / terminalCommand / textScrolled）。
 * 全部为附加 listener；异常自捕获 + log + 计数，绝不向事件源抛错（§5 纪律）。
 *
 * 依赖注入：事件源实例由 mount.ts 注入（复制进 BitFun 后注入真实符号），
 * 以便离线单测用 mock 注入。
 */
import type { CreditRawEvent } from "@credit/protocol";
import type { BridgeSink } from "@credit/core";
import { isAgentEditing } from "./agent-edit-state";

export interface ForeshadowDeps {
  /** globalEventBus 实例（Bitfun 内部） */
  globalEventBus: {
    on(event: string, handler: (data: any) => void): () => void;
  };
  /** api.listen 用于 terminal_event（Tauri IPC 不走 globalEventBus） */
  api: {
    listen(event: string, handler: (data: any) => void): () => void;
  };
  /** 桥 → core 转发入口 */
  publish: (evt: CreditRawEvent) => void;
  /** 计数 + 日志（core 提供） */
  count: (key: string) => void;
  logError: (msg: string, meta?: unknown) => void;
  /** 是否尝试挂 Monaco 滚动/光标补发（需调用方提供 monaco 实例获取器） */
  getMonacoInstance?: () => { onDidScrollChange?: (h: (e: any) => void) => void; onDidChangeCursorSelection?: (h: (e: any) => void) => void } | null;
  /** 获取全部 Monaco editor 实例（Bitfun 每 tab 一个；用于全量挂载 scroll/selection） */
  getMonacoEditors?: () => any[];
  /** 订阅 Monaco editor 实例创建（monaco.editor.onDidCreateEditor）。
   *  切 tab / 新开文件会创建新 editor 实例；靠轮询挂载有延迟，事件驱动可即时补挂。 */
  onEditorCreated?: (cb: (ed: any) => void) => (() => void) | undefined;
  /** 订阅 Monaco model 内容变更（Source: MonacoModelManager.onModelContentChanged）。
   *  Bitfun 的 CodeEditor 仅用 getValue() 更新 dirty、不外发 editor:file:changed，
   *  故 textChanged 必须旁路挂 model listener（SPEC §5.2 / 风险 R1）。 */
  onModelContentChanged?: (
    cb: (e: { uri: string; filePath: string; content: string }) => void,
  ) => () => void;
  /** 订阅 Monaco model 创建（MonacoModelManager.onModelCreated）。文件首次打开创建 model。 */
  onModelCreated?: (
    cb: (e: { uri: string; filePath: string; language: string }) => void,
  ) => () => void;
  /** 订阅 Monaco model 内容就绪（MonacoModelManager.onModelContentReady）。
   *  model 复用（同文件再次打开）也触发；用于 fileOpened 旁路与 lastContent 基线初始化。 */
  onModelContentReady?: (
    cb: (e: { uri: string; filePath: string; content: string }) => void,
  ) => () => void;
}

const SOURCE = "foreshadow-bridge";

export interface DisposableBridge {
  dispose(): void;
}

export function createForeshadowBridge(deps: ForeshadowDeps): DisposableBridge {
  const unsubs: Array<() => void> = [];
  console.log("[credit] foreshadow-bridge wired; globalEventBus=", typeof deps.globalEventBus?.on, "api.listen=", typeof deps.api?.listen);

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      deps.logError(`${SOURCE} handler failed`, { error: String(e) });
      deps.count(`${SOURCE}:error`);
    }
  };

  const resolveUri = (payload: any): string | null => {
    const u = payload?.uri ?? payload?.filePath ?? payload?.path ?? payload?.name;
    if (u) return String(u);
    if (payload?.index != null) return `file-index://${payload.index}`;
    return null;
  };

  // fileOpened —— editor:file:opened（dev 或 agent 打开文档）
  unsubs.push(
    deps.globalEventBus.on("editor:file:opened", (payload: any) => {
      guard(() => {
        const uri = payload?.filePath ?? payload?.path ?? payload?.uri ?? payload?.name;
        if (!uri) return;
        deps.publish({
          type: "fileOpened",
          uri: String(uri),
          ts: Date.now(),
          fidelity: "frontend",
        });
        deps.count(`${SOURCE}:fileOpened`);
      });
    }),
  );

  // fileOpened / activeEditorChanged（主路径）—— Monaco model 创建/就绪旁路。
  // Bitfun 打开文件不发 editor:file:opened（EditorManager 未被 CodeEditor 使用），
  // 但 MonacoModelManager 在 getOrCreateModel 时必发 modelCreated（新建）/ contentReady（复用）。
  const lastContent = new Map<string, string>(); // 文件当前内容基线（diff before 依据）
  const openedRecent = new Map<string, number>(); // fileOpened 去重（同 uri 10s 窗口）
  const markOpened = (uri: string): boolean => {
    const now = Date.now();
    const last = openedRecent.get(uri) ?? 0;
    if (now - last < 10_000) return false;
    openedRecent.set(uri, now);
    return true;
  };
  const publishOpened = (uri: string) => {
    guard(() => {
      deps.publish({
        type: "fileOpened",
        uri,
        ts: Date.now(),
        fidelity: "frontend",
      });
      deps.count(`${SOURCE}:fileOpened`);
      deps.publish({
        type: "activeEditorChanged",
        uri,
        editorKind: "monaco",
        ts: Date.now(),
        fidelity: "frontend",
      });
      deps.count(`${SOURCE}:activeEditorChanged`);
    });
  };
  if (deps.onModelCreated) {
    unsubs.push(
      deps.onModelCreated((e: { uri: string; filePath: string; language: string }) => {
        const uri = e.filePath || e.uri;
        if (!uri) return;
        if (markOpened(uri)) publishOpened(uri);
        try {
          tryAttachScroll(true);
        } catch {
          /* Monaco 可能仍未就绪；后续 contentReady 再试 */
        }
      }),
    );
  }
  if (deps.onModelContentReady) {
    unsubs.push(
      deps.onModelContentReady((e: { uri: string; filePath: string; content: string }) => {
        const uri = e.filePath || e.uri;
        if (!uri) return;
        // 初始化内容基线：agent 直接写盘 → CodeEditor 磁盘同步 reload model 时，
        // beforeText 需有值才能算出真实 diff（而非全文 insert）
        if (typeof e.content === "string" && e.content && !lastContent.has(uri)) {
          lastContent.set(uri, e.content);
        }
        if (markOpened(uri)) publishOpened(uri);
        try {
          tryAttachScroll(true);
        } catch {
          /* noop */
        }
      }),
    );
  }

  // textChanged（主路径）—— Monaco model 内容变更旁路（CodeEditor 不外发 editor:file:changed）
  // 合并：同一文件在 EDIT_MERGE_MS 内的连续变更 debounce 为一条（参考 foreshadow edit-merge）
  // 行级 diff：维护 lastContent 基线，变更时算 insert/delete 行 + 上下 padding 上下文。
  if (deps.onModelContentChanged) {
    const EDIT_MERGE_MS = 400;
    const PAD = 3; // 每个 hunk 上下各保留 N 行上下文
    const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; content: string; uri: string }>();

    unsubs.push(
      deps.onModelContentChanged((e: { uri: string; filePath: string; content: string }) => {
        const key = e.filePath || e.uri;
        const existing = pending.get(key);
        if (existing) clearTimeout(existing.timer);
        pending.set(key, {
          uri: key,
          content: e.content ?? "",
          timer: setTimeout(() => {
            pending.delete(key);
            const before = lastContent.get(key) ?? "";
            const after = e.content ?? "";
            lastContent.set(key, after);
            const hunks = computeLineDiffHunks(before, after, PAD);
            guard(() => {
              deps.publish({
                type: "textChanged",
                uri: key,
                changes: hunks, // 行级 insert/delete + 上下文 padding
                beforeText: before || null,
                afterText: after || null,
                source: isAgentEditing() ? "agent" : "user",
                ts: Date.now(),
                fidelity: "frontend",
              });
              deps.count(`${SOURCE}:textChanged`);
            });
          }, EDIT_MERGE_MS),
        });
      }),
    );
    // dispose 时冲刷未触发定时器
    const origDispose = unsubs[unsubs.length - 1];
    unsubs[unsubs.length - 1] = () => {
      pending.forEach((p) => clearTimeout(p.timer));
      origDispose();
    };
  }

  // textChanged（补充）—— editor:file:saved（若有，payload {index, content}）
  unsubs.push(
    deps.globalEventBus.on("editor:file:saved", (payload: any) => {
      guard(() => {
        const uri = resolveUri(payload);
        if (!uri) return;
        deps.publish({
          type: "textChanged",
          uri,
          changes: payload?.changes ?? null,
          beforeText: null,
          afterText: payload?.content ?? null,
          ts: payload?.ts ?? Date.now(),
          fidelity: "frontend",
          saved: true,
        });
        deps.count(`${SOURCE}:textChanged:saved`);
      });
    }),
  );

  // activeEditorChanged —— 近似用 editor:file:opened（降级；精确 tab 切换待 Monaco 补发）
  unsubs.push(
    deps.globalEventBus.on("editor:file:opened", (payload: any) => {
      guard(() => {
        const uri = resolveUri(payload);
        if (!uri) return;
        deps.publish({
          type: "activeEditorChanged",
          uri,
          editorKind: "monaco",
          ts: payload?.ts ?? Date.now(),
          fidelity: "frontend",
        });
        deps.count(`${SOURCE}:activeEditorChanged`);
      });
    }),
  );

  // terminalCommand —— terminal_event（Tauri IPC，附加 listener 补发）
  // 聚合：CommandStarted 记 start(command)；Data 累积 output（strip ANSI）；
  // CommandFinished 记 end(output)。按 command_id / session 维护缓冲。
  const stripAnsi = (s: string): string =>
    typeof s === "string" ? s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "") : s;
  const termBuf = new Map<string, { cmd: string; output: string }>();

  unsubs.push(
    deps.api.listen("terminal_event", (e: any) => {
      // Tauri listen 回调包装为 { event, payload, id }；真正的事件数据在 e.payload
      const payload = e?.payload ?? e;
      guard(() => {
        const sessionId = String(payload?.session_id ?? payload?.sessionId ?? "unknown");
        // Data 事件不含 command_id，故全程用 sessionId 作聚合 key
        const key = sessionId;

        // Bitfun terminal_event 顶层无 type 字段；按特征字段判别：
        //  - command 存在        -> CommandStarted
        //  - exit_code 存在       -> CommandFinished
        //  - data 存在            -> Data（累积 output）
        //  - 其余（pid/cwd/cols/rows 等）忽略
        if (payload?.command != null) {
          const cmd = payload.command ?? "";
          termBuf.set(key, { cmd, output: "" });
          deps.publish({
            type: "terminalCommand",
            processId: sessionId,
            cmd,
            output: null,
            phase: "start",
            exitCode: null,
            ts: payload?.ts ?? Date.now(),
            fidelity: "frontend",
          });
          deps.count(`${SOURCE}:terminalCommand`);
          return;
        }

        if (payload?.data != null) {
          const buf = termBuf.get(key) ?? { cmd: "", output: "" };
          buf.output += stripAnsi(payload.data ?? "");
          termBuf.set(key, buf);
          return; // Data 本身不 publish，等 Finished 时带 output
        }

        if (payload?.exit_code != null || payload?.exitCode != null) {
          const buf = termBuf.get(key) ?? { cmd: "", output: "" };
          termBuf.delete(key);
          deps.publish({
            type: "terminalCommand",
            processId: sessionId,
            cmd: buf.cmd,
            output: buf.output || null,
            phase: "end",
            exitCode: payload?.exit_code ?? payload?.exitCode ?? null,
            ts: payload?.ts ?? Date.now(),
            fidelity: "frontend",
          });
          deps.count(`${SOURCE}:terminalCommand`);
          return;
        }

        // 其余（pid/cwd/cols/rows 等）忽略
        deps.count(`${SOURCE}:terminal:skip`);
      });
    }),
  );

  // textScrolled / selectionChanged —— 若调用方提供 Monaco 实例获取器，挂附加 listener 补发。
  // editor 实例在文件打开后才可用，故初始化尝试一次，并在 editor:file:opened 时重新尝试挂。
  /**
   * 已挂载监听的 editor 实例集合。
   * Bitfun 每个 tab 是**独立 editor 实例**，只挂 `getEditors()[0]` 会导致
   * "只有第一个文件的 scroll 被采集"。故改为遍历全部实例逐个挂载（幂等）。
   */
  const attachedEditors = new Set<any>();

  /** 对单个 editor 实例挂 scroll/selection（已挂过则跳过） */
  const attachToEditor = (ed: any) => {
    if (!ed?.onDidScrollChange || attachedEditors.has(ed)) return;
    attachedEditors.add(ed);
    console.log("[credit] tryAttachScroll editor attached");
    // 事件参数（IScrollEvent/ISelectionChangedEvent）不含 uri/行号；
    // uri 每次从 editor 实例动态取（tab 切换后仍正确），视口用 getVisibleRanges()。
    const uriOf = (): string => {
      try {
        return ed.getModel?.()?.uri?.toString() ?? "unknown";
      } catch {
        return "unknown";
      }
    };
    // scroll 节流（trailing 200ms）：onDidScrollChange 触发极频繁
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    if (ed.onDidScrollChange) {
      unsubs.push(
        wrapMonaco(ed.onDidScrollChange, () => {
          if (scrollTimer) return;
          scrollTimer = setTimeout(() => {
            scrollTimer = null;
            guard(() => {
              const ranges = ed.getVisibleRanges?.() ?? [];
              const first = ranges[0]?.startLineNumber ?? 0;
              const last = ranges[ranges.length - 1]?.endLineNumber ?? 0;
              if (!first && !last) return; // 视口为空（未布局/隐藏 tab）不产出
              deps.publish({
                type: "textScrolled",
                uri: uriOf(),
                viewport: { firstLine: first, lastLine: last },
                editorKind: "monaco",
                ts: Date.now(),
                fidelity: "frontend",
              });
              deps.count(`${SOURCE}:textScrolled`);
            });
          }, 200);
        }, deps),
      );
      unsubs.push(() => {
        if (scrollTimer) clearTimeout(scrollTimer);
      });
    }
    if (ed.onDidChangeCursorSelection) {
      // 每个 editor 实例独立挂 cursor/selection（uri 从该实例的 model 动态取）
      unsubs.push(
        wrapMonaco(ed.onDidChangeCursorSelection, (e: any) => {
          guard(() => {
            const sel = e?.selection;
            const uri = uriOf();
            if (uri === "unknown") return;
            deps.publish({
              type: "selectionChanged",
              uri,
              kind: sel && !sel.isEmpty() ? "select" : "cursor",
              line: sel?.positionLineNumber ?? sel?.startLineNumber ?? 0,
              column: sel?.positionColumn ?? sel?.startColumn ?? 0,
              selection: sel && !sel.isEmpty() ? sel?.toString?.() ?? null : null,
              ts: Date.now(),
              fidelity: "frontend",
            });
            deps.count(`${SOURCE}:selectionChanged`);
          });
        }, deps),
      );
    }
  };

  /** 遍历全部 editor 实例挂载（宿主提供 getMonacoEditors 时用之，否则回退单实例获取器） */
  const tryAttachScroll = (verbose = false) => {
    const list = deps.getMonacoEditors?.() ?? [];
    const single = deps.getMonacoInstance?.();
    const all: any[] = list.length > 0 ? list : single ? [single] : [];
    if (verbose && all.length === 0) {
      console.warn("[credit] scroll not attached", { hasEditor: false, hasScrollApi: false });
    }
    for (const ed of all) attachToEditor(ed);
  };

  try {
    tryAttachScroll();
  } catch (e) {
    console.error("[credit] tryAttachScroll init failed", { error: String(e) });
  }
  unsubs.push(
    deps.globalEventBus.on("editor:file:opened", () => {
      // 打开文件时 active editor 已就绪，尝试补挂 scroll/selection
      try {
        tryAttachScroll(true);
      } catch (e) {
        console.error("[credit] tryAttachScroll re-attach failed", { error: String(e) });
      }
    }),
  );

  // 新 editor 实例创建 → 立即补挂（切 tab/新开文件场景，避免只采到第一个文件的 scroll）
  const unsubCreate = deps.onEditorCreated?.(() => {
    try {
      tryAttachScroll(true);
    } catch {
      /* noop */
    }
  });
  if (unsubCreate) unsubs.push(unsubCreate);

  // 轮询挂载（P1）：Bitfun 打开文件**不发** editor:file:opened，且文件已建过 model 时
  // 不再触发 modelCreated/contentReady —— 仅靠事件驱动会永远挂不上 scroll。
  // 改为 1s 轮询探测；editor 实例随 tab 切换重建，tryAttachScroll 内部按引用变化重挂。
  const attachTimer = setInterval(() => {
    try {
      tryAttachScroll(false);
    } catch {
      /* 轮询异常不冒泡（§5 旁路纪律） */
    }
  }, 300);
  unsubs.push(() => clearInterval(attachTimer));

  return {
    dispose() {
      unsubs.forEach((u) => {
        try {
          u();
        } catch {
          /* noop */
        }
      });
    },
  };
}

/** Monaco emitter 包装为可退订（返回 unsub 推入 unsubs） */
function wrapMonaco(
  on: (h: (e: any) => void) => unknown,
  handler: (e: any) => void,
  deps: ForeshadowDeps,
): () => void {
  try {
    on(handler);
    // Monaco 不返回 unsub，用标记避免重复；dispose 时无法精确退订，记录日志
    deps.logError(`${SOURCE} monaco listener attached (no explicit unsub)`);
    return () => {
      /* Monaco 无显式 unsub；进程级生命周期 */
    };
  } catch (e) {
    deps.logError(`${SOURCE} monaco attach failed`, { error: String(e) });
    return () => {};
  }
}

/**
 * 行级 diff：基于 LCS 计算 insert/delete 行，并在每个 hunk 上下各 padding N 行上下文。
 * 返回 hunk 数组，每个 hunk：
 *  { op, startLine, endLine, lines (受影响行), contextBefore[], contextAfter[] }
 * 兼容 CreditTextChange 扩展结构，供 foreshadow L2 消费。
 */
interface DiffHunk {
  op: "insert" | "delete";
  startLine: number; // 1-based，变更块在 after 文本中的起始行
  endLine: number;
  lines: string[]; // 受影响行（insert 或 delete 的文本）
  contextBefore: string[];
  contextAfter: string[];
}
function computeLineDiffHunks(beforeText: string, afterText: string, pad: number): DiffHunk[] {
  const a = beforeText.length ? beforeText.split(/\r?\n/) : [];
  const b = afterText.length ? afterText.split(/\r?\n/) : [];
  const n = a.length;
  const m = b.length;
  // LCS DP
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // delete a[i]
      pushHunk(hunks, "delete", a, b, i, i + 1, j, pad);
      i++;
    } else {
      // insert b[j]
      pushHunk(hunks, "insert", a, b, j, j + 1, j, pad);
      j++;
    }
  }
  while (i < n) {
    pushHunk(hunks, "delete", a, b, i, i + 1, j, pad);
    i++;
  }
  while (j < m) {
    pushHunk(hunks, "insert", a, b, j, j + 1, j, pad);
    j++;
  }
  return hunks;
}
function pushHunk(
  hunks: DiffHunk[],
  op: "insert" | "delete",
  a: string[],
  b: string[],
  lineIdx: number,
  lineEnd: number,
  afterLine: number,
  pad: number,
) {
  const lines = (op === "insert" ? b : a).slice(lineIdx, lineEnd);
  const src = op === "insert" ? b : a;
  const ctxStart = Math.max(0, lineIdx - pad);
  const ctxEnd = Math.min(src.length, lineEnd + pad);
  const contextBefore = src.slice(ctxStart, lineIdx);
  const contextAfter = src.slice(lineEnd, ctxEnd);
  // after 文本中的行号（1-based）：insert 落在 afterLine 之前，delete 在 after 中已被移除，近似用 afterLine
  const startLine = op === "insert" ? afterLine + 1 : lineIdx + 1;
  const endLine = startLine + lines.length - 1;
  hunks.push({ op, startLine, endLine, lines, contextBefore, contextAfter });
}
