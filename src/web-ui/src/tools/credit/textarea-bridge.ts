/**
 * textarea-bridge（B-012）：补采 Bitfun markdown **源码模式**（MEditor 的 textarea）的行为。
 *
 * **关键事实（2026-09-02 实测）**：md 文件在 Bitfun 中由 `<textarea class="m-editor-textarea">`
 * 承载（ActiveEditTargetService 中 `kind = 'markdown-textarea'`），页面上并不存在
 * ProseMirror。textarea 比 TipTap 更好采集：`value` / `scrollTop` / `selectionStart`
 * 可直接算出**真实行号**（TipTap 只能块索引近似）。仅"可见行区间"因行高估算带误差，
 * 标 `approximate: true`；光标行号是精确的，不标。
 *
 * **何时记为"打开"**：在轮询的**活跃判定**里记，且要求元素确实可见 —— 挂载即记会
 * 产生用户并未看到的假事件（MEditor 默认 mode='ir' 会短暂渲染 TipTap 再切换）。
 *
 * 纪律：附加 listener、异常自捕获 + log + 计数，绝不向事件源抛错（§5）。
 */
import type { CreditRawEvent } from "@credit/protocol";
import { createScrollThrottle, domVisible, OpenedDedup } from "./dom-shared.js";

export interface TextareaEntry {
  /** textarea 元素（结构随宿主版本变化，故用 any + 特性检测） */
  el: any;
  /** 对应的文件路径；缺失时降级为合成 uri */
  filePath?: string | null;
  /** 是否为宿主判定的活跃目标（仅作辅助信号） */
  active?: boolean;
}

export interface TextareaDeps {
  /** 枚举当前全部 markdown textarea（每个 md tab 一个） */
  getMarkdownTextareas?: () => TextareaEntry[];
  /** 跨桥共享的 fileOpened 去重器（由 index.ts 注入） */
  openedDedup?: OpenedDedup;
  /** 轮询间隔（ms，默认 300） */
  pollMs?: number;
  publish: (evt: CreditRawEvent) => void;
  count: (key: string) => void;
  logError: (msg: string, meta?: unknown) => void;
}

const SOURCE = "textarea-bridge";
const SCROLL_THROTTLE_MS = 200;
const EDIT_MERGE_MS = 400;

export interface DisposableBridge {
  dispose(): void;
}

/** 1-based 行号（按换行符计数） */
function lineAt(value: string, index: number): number {
  let line = 1;
  const n = Math.min(Math.max(index, 0), value.length);
  for (let i = 0; i < n; i++) if (value.charCodeAt(i) === 10) line++;
  return line;
}

/** 1-based 列号 */
function columnAt(value: string, index: number): number {
  const last = value.lastIndexOf("\n", Math.max(0, index - 1));
  return index - last;
}

/** 单行高（px）：优先 computedStyle.line-height，兜底 scrollHeight/总行数 */
function lineHeightOf(el: any): number {
  try {
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    if (Number.isFinite(lh) && lh > 0) return lh;
  } catch {
    /* 样式不可读时走兜底 */
  }
  try {
    const total = String(el?.value ?? "").split("\n").length || 1;
    const h = (el?.scrollHeight ?? 0) / total;
    return Number.isFinite(h) && h > 0 ? h : 0;
  } catch {
    return 0;
  }
}

/** 可见行区间（1-based） */
function visibleLines(el: any): { first: number; last: number } | null {
  try {
    const total = String(el?.value ?? "").split("\n").length || 1;
    const lh = lineHeightOf(el);
    if (lh <= 0) return null;
    const top = el?.scrollTop ?? 0;
    const h = el?.clientHeight ?? 0;
    if (!h) return null;
    const first = Math.max(1, Math.floor(top / lh) + 1);
    const last = Math.min(total, Math.max(first, Math.ceil((top + h) / lh)));
    return { first, last };
  } catch {
    return null;
  }
}

export function createTextareaBridge(deps: TextareaDeps): DisposableBridge {
  const unsubs: Array<() => void> = [];
  const attached = new Set<any>();
  /** 每个 textarea 的内容快照（textChanged 的 before 依据） */
  const lastValue = new WeakMap<any, string>();
  const dedup = deps.openedDedup ?? new OpenedDedup();
  // uri 计算集中复用（挂载与活跃判定），避免同一元素出现两个不同 uri
  const uriOf = (e: { filePath?: string | null }): string =>
    e?.filePath ? String(e.filePath) : "textarea://untitled";

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      deps.logError(`${SOURCE} handler failed`, { error: String(e) });
      deps.count(`${SOURCE}:error`);
    }
  };

  const publishOpened = (uri: string) => {
    guard(() => {
      if (dedup.mark(uri)) {
        deps.publish({ type: "fileOpened", uri, ts: Date.now(), fidelity: "frontend" });
        deps.count(`${SOURCE}:fileOpened`);
      }
      deps.publish({
        type: "activeEditorChanged",
        uri,
        editorKind: "textarea",
        ts: Date.now(),
        fidelity: "frontend",
      });
      deps.count(`${SOURCE}:activeEditorChanged`);
    });
  };

  const attach = (entry: TextareaEntry) => {
    const el = entry?.el;
    if (!el || attached.has(el)) return;
    attached.add(el);

    const uri = uriOf(entry);
    lastValue.set(el, String(el?.value ?? ""));

    // ① 编辑 —— input 事件，合并窗口内连续输入 debounce 为一条
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    const onInput = () => {
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(() => {
        editTimer = null;
        guard(() => {
          const before = lastValue.get(el) ?? null;
          const after = String(el?.value ?? "");
          lastValue.set(el, after);
          if (before === after) return; // 净零编辑不产出
          deps.publish({
            type: "textChanged",
            uri,
            changes: null, // 行级 diff 由 core 治理层按 before/after 重算
            beforeText: before,
            afterText: after,
            source: "user",
            ts: Date.now(),
            fidelity: "frontend",
          });
          deps.count(`${SOURCE}:textChanged`);
        });
      }, EDIT_MERGE_MS);
    };
    el.addEventListener?.("input", onInput);
    unsubs.push(() => {
      if (editTimer) clearTimeout(editTimer);
      el.removeEventListener?.("input", onInput);
    });

    // ② 滚动 —— 首尾节流；visibleLines 按行高估算，故标 approximate
    const throttle = createScrollThrottle(SCROLL_THROTTLE_MS, () =>
      guard(() => {
        const range = visibleLines(el);
        if (!range) {
          deps.count(`${SOURCE}:scroll:empty`);
          return;
        }
        deps.publish({
          type: "textScrolled",
          uri,
          viewport: { firstLine: range.first, lastLine: range.last },
          editorKind: "textarea",
          ts: Date.now(),
          fidelity: "frontend",
          approximate: true,
        });
        deps.count(`${SOURCE}:textScrolled`);
      }),
    );
    const onScroll = () => {
      deps.count(`${SOURCE}:scroll:hit`);
      throttle.hit();
    };
    el.addEventListener?.("scroll", onScroll, { passive: true });
    unsubs.push(() => {
      throttle.clear();
      el.removeEventListener?.("scroll", onScroll);
    });

    // ③ 光标/选区 —— selectionchange 覆盖点击/键盘/拖动各种移动方式；
    //    行号由 selectionStart 精确计算
    const onSelectionChange = () => {
      guard(() => {
        if (typeof document === "undefined") return;
        if (document.activeElement !== el) return;
        const value = String(el?.value ?? "");
        const start = el?.selectionStart ?? 0;
        const end = el?.selectionEnd ?? start;
        if (start === end && (el as any).__creditLastPos === start) return; // 位置未变跳过
        (el as any).__creditLastPos = start;
        deps.publish({
          type: "selectionChanged",
          uri,
          kind: start === end ? "cursor" : "select",
          line: lineAt(value, start),
          column: columnAt(value, start),
          selection: start === end ? null : value.slice(start, end),
          ts: Date.now(),
          fidelity: "frontend",
        });
        deps.count(`${SOURCE}:selectionChanged`);
      });
    };
    if (typeof document !== "undefined") {
      document.addEventListener?.("selectionchange", onSelectionChange);
      unsubs.push(() => document.removeEventListener?.("selectionchange", onSelectionChange));
    }

    console.log("[credit] textarea attached", { uri, lines: String(el?.value ?? "").split("\n").length });
  };

  let lastActive: any = null;

  const tryAttach = () => {
    // 失效清理：元素脱离文档后移出 attached，否则再次打开会被"已挂载"跳过。
    // 同时重置 lastActive —— 它仍指向旧元素会让重新挂载后的实例被判为"未切换"而静默。
    for (const el of Array.from(attached)) {
      if (!el || el.isConnected === false) {
        attached.delete(el);
        if (el === lastActive) lastActive = null;
      }
    }

    const list = deps.getMarkdownTextareas?.() ?? [];
    for (const entry of list) attach(entry);

    // 仅当元素**确实可见**时才记为打开/切换
    const visibleEntries = list.filter((e) => domVisible(e.el));
    const active = visibleEntries.find((e) => e.active) ?? visibleEntries[0] ?? null;
    const el = active?.el;
    if (!el || el === lastActive) return;
    lastActive = el;
    attach(active); // 幂等：确保监听已挂上
    publishOpened(uriOf(active));
  };

  try {
    tryAttach();
  } catch (e) {
    deps.logError(`${SOURCE} initial attach failed`, { error: String(e) });
  }

  const pollMs = deps.pollMs ?? 300;
  const timer = setInterval(() => {
    try {
      tryAttach();
    } catch {
      /* 轮询异常不冒泡（§5 旁路纪律） */
    }
  }, pollMs);
  unsubs.push(() => clearInterval(timer));

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
