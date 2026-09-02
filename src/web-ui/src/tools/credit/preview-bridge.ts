/**
 * preview-bridge（B-012）：补采 Bitfun markdown **预览模式**的阅读行为。
 *
 * **为什么单独一桥**：预览是 md 的**默认模式**，却是纯渲染（`MarkdownRenderer`）——
 * 既无 textarea 也无 ProseMirror。textarea 桥与 tiptap 桥在此场景下都无从挂载。
 *
 * **精度**：预览渲染的是 HTML，与源码行**不是 1:1**。只能按 "滚动比例 × 源码总行数"
 * 估算阅读位置，事件标 `approximate: true`。它给出**阅读进度**而非精确行号 ——
 * 足以支撑"是否通读、关注哪个区段"，不足以支撑"精确审阅到第几行"。
 *
 * **何时记为"打开"**：不在挂载时记，而在轮询的**活跃判定**里记，且要求元素确实可见。
 * 原因：MEditor 默认 `mode='ir'`，初始化会短暂渲染 TipTap 再切到预览 —— 若在挂载时
 * 就发 open，会产生用户并未看到的假事件。
 *
 * 纪律：附加 listener、异常自捕获 + log + 计数，绝不向事件源抛错（§5）。
 */
import type { CreditRawEvent } from "@credit/protocol";
import { createScrollThrottle, domVisible, OpenedDedup } from "./dom-shared.js";

export interface PreviewEntry {
  /** 预览滚动容器元素（`.m-editor-preview`） */
  el: any;
  /** 对应的文件路径；缺失时降级为合成 uri */
  filePath?: string | null;
  /** 源码总行数（用于把滚动比例换算为行区间） */
  lineCount?: number | null;
  /** 是否为宿主判定的活跃目标（仅作辅助信号） */
  active?: boolean;
}

export interface PreviewDeps {
  getMarkdownPreviews?: () => PreviewEntry[];
  /** 跨桥共享的 fileOpened 去重器（由 index.ts 注入） */
  openedDedup?: OpenedDedup;
  pollMs?: number;
  publish: (evt: CreditRawEvent) => void;
  count: (key: string) => void;
  logError: (msg: string, meta?: unknown) => void;
}

const SOURCE = "preview-bridge";
const SCROLL_THROTTLE_MS = 200;

export interface DisposableBridge {
  dispose(): void;
}

/** 由滚动比例估算源码行区间（1-based） */
function estimatedLines(el: any, total: number): { first: number; last: number } | null {
  try {
    const scrollH = el?.scrollHeight ?? 0;
    const clientH = el?.clientHeight ?? 0;
    if (scrollH <= 0 || clientH <= 0 || total <= 0) return null;
    const top = el?.scrollTop ?? 0;
    const first = Math.max(1, Math.floor((top / scrollH) * total) + 1);
    const last = Math.min(total, Math.max(first, Math.ceil(((top + clientH) / scrollH) * total)));
    return { first, last };
  } catch {
    return null;
  }
}

export function createPreviewBridge(deps: PreviewDeps): DisposableBridge {
  const unsubs: Array<() => void> = [];
  const attached = new Set<any>();
  // 未注入共享去重器时（单测等）退化为本地去重
  const dedup = deps.openedDedup ?? new OpenedDedup();
  // uri 计算集中在两处复用（挂载与活跃判定），避免同一元素出现两个不同 uri
  const uriOf = (e: { filePath?: string | null }): string =>
    e?.filePath ? String(e.filePath) : "preview://untitled";

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
        editorKind: "preview",
        ts: Date.now(),
        fidelity: "frontend",
      });
      deps.count(`${SOURCE}:activeEditorChanged`);
    });
  };

  const attach = (entry: PreviewEntry) => {
    const el = entry?.el;
    if (!el || attached.has(el)) return;
    attached.add(el);

    const uri = uriOf(entry);
    const total = Math.max(0, Number(entry.lineCount ?? 0));

    // 滚动 —— 首尾节流（leading 捕获起点、trailing 捕获终点）
    const throttle = createScrollThrottle(SCROLL_THROTTLE_MS, () =>
      guard(() => {
        const range = estimatedLines(el, total);
        if (!range) {
          deps.count(`${SOURCE}:scroll:empty`);
          return;
        }
        deps.publish({
          type: "textScrolled",
          uri,
          viewport: { firstLine: range.first, lastLine: range.last },
          editorKind: "preview",
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

    console.log("[credit] preview attached", { uri, lines: total });
  };

  let lastActive: any = null;

  const tryAttach = () => {
    // 失效清理：容器脱离文档后移出 attached，否则再次打开会被"已挂载"跳过。
    // 同时重置 lastActive —— 它仍指向旧元素会让重新挂载后的实例被判为"未切换"而静默。
    for (const el of Array.from(attached)) {
      if (!el || el.isConnected === false) {
        attached.delete(el);
        if (el === lastActive) lastActive = null;
      }
    }

    const list = deps.getMarkdownPreviews?.() ?? [];
    for (const entry of list) attach(entry);

    // 仅当元素**确实可见**时才记为打开/切换，避免默认 ir 模式短暂渲染造成的假事件
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
