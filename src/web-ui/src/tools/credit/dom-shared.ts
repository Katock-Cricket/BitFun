/**
 * markdown 采集三桥（tiptap / textarea / preview）的共享工具。
 *
 * 抽出原因：三者结构高度一致（轮询探测 → 挂载 → 活跃切换 → 发事件），
 * 而**去重与节流必须跨桥共享/统一**：
 * - 去重不共享 → 同一文件被两个桥各发一次 fileOpened（2026-09-02 实测：
 *   MEditor 默认 mode='ir' 会短暂渲染 TipTap，随后切预览，导致 tiptap 与 preview
 *   两个桥在同一秒内各产一次 open）。
 * - 节流若为纯 trailing → 快速滚动时"起点"被吞掉，只剩尾段（实测滚动起点丢失）。
 */
/** 元素是否对用户可见（已连接 + 有实际尺寸） */
export function domVisible(el: any): boolean {
  try {
    if (!el || el.isConnected === false) return false;
    const r = el.getBoundingClientRect();
    return (r?.width ?? 0) > 0 && (r?.height ?? 0) > 0;
  } catch {
    return false;
  }
}

/** fileOpened 去重窗口（与 monaco 桥一致） */
export const OPENED_DEDUP_MS = 10_000;

/**
 * 跨桥共享的 fileOpened 去重器。
 * 由 index.ts 统一构造并注入三个桥，避免同一文件被多个桥重复记为"打开"。
 */
export class OpenedDedup {
  private recent = new Map<string, number>();

  mark(uri: string): boolean {
    const now = Date.now();
    const last = this.recent.get(uri) ?? 0;
    if (now - last < OPENED_DEDUP_MS) return false;
    this.recent.set(uri, now);
    return true;
  }
}

/**
 * 滚动节流（**leading + trailing**）：
 * - leading：首次滚动立即发一次 —— 捕获**起点**（纯 trailing 会把起点吞掉，
 *   表现为"从头滑到底"却从中间行号开始记录）。
 * - trailing：窗口结束时若期间又有滚动，再发一次 —— 捕获**终点**。
 */
export function createScrollThrottle(ms: number, emit: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  return {
    /** 每次滚动事件调用 */
    hit(): void {
      if (timer === null) {
        emit(); // leading
        timer = setTimeout(() => {
          timer = null;
          if (dirty) {
            dirty = false;
            emit(); // trailing
          }
        }, ms);
        return;
      }
      dirty = true;
    },
    /** dispose 时清理 */
    clear(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      dirty = false;
    },
  };
}
