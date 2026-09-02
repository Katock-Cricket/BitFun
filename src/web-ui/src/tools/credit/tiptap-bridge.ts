/**
 * tiptap-bridge（B-012）：补采 Bitfun markdown 编辑器（MEditor / TipTap）的行为事件。
 *
 * **背景（补采动因）**：Bitfun 把 `.md` 路由到 `markdown-editor`，由 MEditor
 * （TipTap / ProseMirror）渲染；而既有采集桥的全部事件源 —— `MonacoModelManager`
 * 的 modelCreated/contentReady/contentChanged、`EditTarget.editor`（类型写死 monaco）、
 * monaco `onDidCreateEditor` —— **全部绑死在 Monaco 上**。结果：TipTap 打开的文件
 * 此前完全不可见。项目 SPEC 文档均为 md，直接导致"审阅SPEC"类指标的数据源缺失。
 *
 * **精度**：TipTap 是所见即所得 + 软换行，**没有真实行号**。本桥以**顶层块索引**
 * （blockIndex）作为行号的近似，事件标 `approximate: true`，下游按降级处理（R7）。
 * 编辑内容本身是精确的（`editor.getText()` 取全文，diff 由 core 治理层重算）。
 *
 * **事件产出机制（关键设计，2026-09-02 两次实测修正）**：
 * - 滚动：**IntersectionObserver 为主，容器 scroll 为辅**。单纯监听 scroll 需要
 *   先定位到真正的滚动体，而 Bitfun 的编辑器布局里滚动体可能是 window、更外层容器，
 *   或用 transform 滚动 —— 定位失败就**一条事件都没有**（这正是首版失败的原因）。
 *   IntersectionObserver 以"块元素进出视口"为判据，不依赖滚动容器定位。
 * - 打开/切换：**DOM 可见性**为主，宿主 active 标记为辅。TipTap 无激活事件，
 *   而 `activeTargetId` 只在编辑器**获得焦点**时更新 —— 切换 tab 却不点内容时不会
 *   更新，导致"切回已打开的 md 无任何事件"（第二版失败的原因）。
 *
 * 纪律：全部为附加 listener；异常自捕获 + log + 计数，绝不向事件源抛错（§5）。
 */
import type { CreditRawEvent } from "@credit/protocol";
import { createScrollThrottle, domVisible, OpenedDedup } from "./dom-shared.js";

/** 宿主提供的 TipTap 编辑器条目（由 Bitfun ActiveEditTargetService 枚举而来） */
export interface TiptapEditorEntry {
  /** TipTap Editor 实例（结构随宿主版本变化，故用 any + 特性检测） */
  editor: any;
  /** 对应的文件路径；缺失时降级为合成 uri */
  filePath?: string | null;
  /**
   * 是否为当前活跃编辑目标（宿主从 ActiveEditTargetService 判定）。
   * 仅作**辅助**信号：它只在编辑器获得焦点时更新，切 tab 而不点内容时不更新，
   * 故本桥以 DOM 可见性为主判据。
   */
  active?: boolean;
}

export interface TiptapDeps {
  /** 枚举当前全部 TipTap 编辑器实例（每个 markdown tab 一个） */
  getTiptapEditors?: () => TiptapEditorEntry[];
  /** 新实例探测轮询间隔（ms，默认 300） */
  pollMs?: number;
  /** 跨桥共享的 fileOpened 去重器（由 index.ts 注入） */
  openedDedup?: OpenedDedup;
  publish: (evt: CreditRawEvent) => void;
  count: (key: string) => void;
  logError: (msg: string, meta?: unknown) => void;
}

const SOURCE = "tiptap-bridge";
/** scroll 节流（对齐 monaco 桥的 200ms） */
const SCROLL_THROTTLE_MS = 200;
/** 连续编辑合并窗口 */
const EDIT_MERGE_MS = 400;
export interface DisposableBridge {
  dispose(): void;
}

/** 取编辑器全文（块间以 \n 分隔，贴近 Markdown 源文本） */
function editorText(ed: any): string {
  try {
    return typeof ed?.getText === "function" ? ed.getText({ blockSeparator: "\n" }) ?? "" : "";
  } catch {
    return "";
  }
}

/** 光标所在顶层块索引（作为"行号"的近似） */
function blockIndexOf(ed: any): number {
  try {
    const $from = ed?.state?.selection?.$from;
    if (!$from) return 0;
    return $from.depth >= 1 ? $from.index(0) : 0;
  } catch {
    return 0;
  }
}

/** 编辑器根 DOM（ProseMirror 容器） */
function domOf(ed: any): HTMLElement | null {
  return (ed?.view?.dom ?? null) as HTMLElement | null;
}

/** 向上找可滚动容器（含自身）—— 仅作为 scroll 监听的**辅助**触发源 */
function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  let cur = el ?? null;
  let hops = 0;
  while (cur && hops < 8) {
    try {
      const oy = getComputedStyle(cur).overflowY;
      if ((oy === "auto" || oy === "scroll") && cur.scrollHeight > cur.clientHeight + 1) return cur;
    } catch {
      return null;
    }
    cur = cur.parentElement;
    hops++;
  }
  return null;
}

/**
 * 可见的顶层块索引区间（作为"视口行区间"的近似）。
 *
 * 两点关键：
 * 1. **块元素来源用 ProseMirror 的直接子元素**（每个顶层 node 渲染为一个直接子元素，
 *    顺序即 doc 顶层块顺序），而非 `[data-block-id]` —— 后者由 BlockIdExtension 渲染
 *    且只覆盖 paragraph，标题/表格/代码块没有，会让以标题为主的文档整体丢事件。
 * 2. **可见性以浏览器视口判定**，而非滚动容器的 rect —— 容器定位不可靠（滚动体可能
 *    是 window 或更外层容器），以其 rect 为基准会算出空区间而丢弃全部事件。
 *    无 window 时（node 单测）退化为"全部可见"。
 */
function blockRangeInViewport(dom: HTMLElement | null): { first: number; last: number } | null {
  if (!dom) return null;
  const blocks = Array.from(dom.children ?? []) as HTMLElement[];
  if (blocks.length === 0) return null;
  const vh = typeof window !== "undefined" ? window.innerHeight || 0 : 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < blocks.length; i++) {
    let r: { top: number; bottom: number; height: number } | null = null;
    try {
      r = blocks[i].getBoundingClientRect();
    } catch {
      continue;
    }
    if (!r || r.height <= 0) continue; // 未布局/隐藏块跳过
    if (vh === 0 || (r.bottom >= 0 && r.top <= vh)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : { first, last };
}

export function createTiptapBridge(deps: TiptapDeps): DisposableBridge {
  const unsubs: Array<() => void> = [];
  /** 已挂载监听的 editor 实例（按引用去重，tab 重建实例会重新挂载） */
  const attached = new Set<any>();
  /** 每个 editor 的内容快照（textChanged 的 before 依据） */
  const lastText = new WeakMap<any, string>();
  // 跨桥共享去重（未注入时退化为本地）
  const dedup = deps.openedDedup ?? new OpenedDedup();
  // uri 计算集中复用（挂载与活跃判定），避免同一元素出现两个不同 uri
  const uriOf = (e: { filePath?: string | null }): string =>
    e?.filePath ? String(e.filePath) : "tiptap://untitled";

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
        editorKind: "tiptap",
        ts: Date.now(),
        fidelity: "frontend",
      });
      deps.count(`${SOURCE}:activeEditorChanged`);
    });
  };

  /** 对单个 TipTap 实例挂载 fileOpened / edit / selection / scroll（幂等） */
  const attach = (entry: TiptapEditorEntry) => {
    const ed = entry?.editor;
    if (!ed || attached.has(ed)) return;
    attached.add(ed);

    const uri = uriOf(entry);
    const dom = domOf(ed);

    // 注：打开/切换事件**不在挂载时发**，改由 tryAttach 的活跃判定统一发
    // （仅当元素确实可见时才记为打开），避免"挂载即记"产生用户没看到的假事件。

    // 内容基线（首次无 before → 治理层按 D-007 建基线、不产出 edit）
    lastText.set(ed, editorText(ed));

    // ② 编辑 —— editor.on('update')
    if (typeof ed?.on === "function") {
      let editTimer: ReturnType<typeof setTimeout> | null = null;
      unsubs.push(() => {
        if (editTimer) clearTimeout(editTimer);
      });
      ed.on("update", () => {
        if (editTimer) clearTimeout(editTimer);
        editTimer = setTimeout(() => {
          editTimer = null;
          guard(() => {
            const before = lastText.get(ed) ?? null;
            const after = editorText(ed);
            lastText.set(ed, after);
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
      });

      // ③ 光标/选区 —— editor.on('selectionUpdate')；行号为块索引近似
      ed.on("selectionUpdate", () => {
        guard(() => {
          const sel = ed?.state?.selection;
          const empty = sel ? sel.empty : true;
          const text = empty ? null : (ed.state.doc.textBetween?.(sel.from, sel.to, "\n") ?? null);
          deps.publish({
            type: "selectionChanged",
            uri,
            kind: empty ? "cursor" : "select",
            line: blockIndexOf(ed),
            column: 0,
            selection: text,
            ts: Date.now(),
            fidelity: "frontend",
            approximate: true,
          });
          deps.count(`${SOURCE}:selectionChanged`);
        });
      });
    }

    // ④ 滚动 —— 双触发源：IntersectionObserver（主）+ 容器 scroll（辅）
    // 首尾节流：leading 捕获滚动起点、trailing 捕获终点（纯 trailing 会吞掉起点）
    const throttle = createScrollThrottle(SCROLL_THROTTLE_MS, () =>
      guard(() => {
        const range = blockRangeInViewport(dom);
        if (!range) {
          deps.count(`${SOURCE}:scroll:empty`); // 诊断：区间为空（未布局/隐藏 tab）
          return;
        }
        deps.publish({
          type: "textScrolled",
          uri,
          viewport: { firstLine: range.first, lastLine: range.last },
          editorKind: "tiptap",
          ts: Date.now(),
          fidelity: "frontend",
          approximate: true,
        });
        deps.count(`${SOURCE}:textScrolled`);
      }),
    );
    const scheduleScroll = (tag: string) => {
      deps.count(`${SOURCE}:scroll:${tag}`); // 诊断：区分是哪个触发源在起作用
      throttle.hit();
    };
    unsubs.push(() => throttle.clear());

    if (dom) {
      // 主：块元素进出视口即触发（不依赖滚动容器定位）
      if (typeof IntersectionObserver !== "undefined") {
        try {
          const io = new IntersectionObserver(() => scheduleScroll("io"), { threshold: 0 });
          for (const el of Array.from(dom.children ?? [])) io.observe(el);
          unsubs.push(() => io.disconnect());
        } catch (e) {
          deps.logError(`${SOURCE} IntersectionObserver attach failed`, { error: String(e) });
        }
      }
      // 辅：容器 scroll（覆盖 IO 不可用或块未重建的场景）
      const container = findScrollContainer(dom) ?? dom;
      const onScroll = () => scheduleScroll("container");
      container.addEventListener("scroll", onScroll, { passive: true });
      unsubs.push(() => container.removeEventListener("scroll", onScroll));

      // 文档结构变化（增删块）后重新观察：children 会随编辑而改变
      if (typeof MutationObserver !== "undefined") {
        try {
          const mo = new MutationObserver(() => {
            // 重新 observe 新增的块（IntersectionObserver 不会自动跟随 DOM 变化）
            for (const el of Array.from(dom.children ?? [])) {
              if (!(el as any).__creditObserved) {
                (el as any).__creditObserved = true;
                try {
                  new IntersectionObserver(() => scheduleScroll("io"), { threshold: 0 }).observe(el);
                } catch {
                  /* noop */
                }
              }
            }
          });
          mo.observe(dom, { childList: true });
          unsubs.push(() => mo.disconnect());
        } catch {
          /* MutationObserver 不可用不影响主流程 */
        }
      }

      console.log("[credit] tiptap attached", {
        uri,
        blocks: dom?.children?.length ?? 0,
        container: container?.tagName ?? null,
        io: typeof IntersectionObserver !== "undefined",
      });
    }
  };

  /** 上次判定的活跃实例（用于检测切换） */
  let lastActive: any = null;

  /** 遍历全部实例挂载 + 活跃切换补发 open/view */
  const tryAttach = () => {
    // **失效清理（关键）**：编辑器实例被卸载后（切换预览/IR/源码模式、关闭 tab），
    // 其 view.dom 会脱离文档，但 JS 引用仍在本桥的 attached 集合里 —— 若不清理，
    // 用户再次打开同一文件时会被"已挂载"判定跳过，表现为
    // "第一次能记录，之后再打开就完全没反应"（2026-09-02 实测）。
    for (const ed of Array.from(attached)) {
      const d = domOf(ed);
      if (!d || d.isConnected === false) {
        attached.delete(ed);
        // 同时重置 lastActive：它仍指向旧实例会让重新挂载后的实例被判为"未切换"而静默
        if (ed === lastActive) lastActive = null;
      }
    }

    const list = deps.getTiptapEditors?.() ?? [];
    for (const entry of list) attach(entry);

    // 活跃判定：优先宿主 active 标记（需确实可见），否则用 DOM 可见性推断。
    // 不依赖 focus —— 切 tab 而不点内容时 focus 不变，会导致切回已打开的 md 无事件。
    const visibleEntries = list.filter((e) => domVisible(domOf(e.editor)));
    const active =
      visibleEntries.find((e) => e.active) ?? visibleEntries[0] ?? null;
    const ed = active?.editor;
    if (!ed || ed === lastActive) return;
    lastActive = ed;
    attach(active); // 幂等：确保监听已挂上
    publishOpened(uriOf(active));
  };

  try {
    tryAttach();
  } catch (e) {
    deps.logError(`${SOURCE} initial attach failed`, { error: String(e) });
  }

  // 轮询探测：TipTap 实例随 tab 打开/切换而创建，无全局创建事件可订阅
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
