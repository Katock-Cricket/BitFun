/**
 * agent 编辑状态共享模块（模块级单例，foreshadow-bridge 与 agent-bridge 共用同一份）。
 *
 * 设计：文件级精确标记 + 全局兜底标志，消除"全局 15s 窗口 vs 多文件顺序编辑"的竞态。
 * - markAgentEditingFile(uri)：agent Edit 工具针对某文件落盘时登记，带 TTL（默认 20s）。
 *   文件级标记使得"agent 改 A、再改 B、CodeEditor 异步 reload A"这类跨文件时序也能正确判定。
 * - isAgentEditingFile(uri)：textChanged 时按 uri 精确判定 actor=agent。
 * - 全局 isAgentEditing()：兜底（任意 agent 编辑进行中），用于无 uri 场景。
 *
 * 时序背景：agent Edit 工具 complete 时文件已落盘，但 CodeEditor 靠轮询检测外部修改并
 * reload model（数秒延迟）。故清除带 TTL 滞后窗口，避免随后的 textChanged 被误标 dev。
 */
const FILE_HOLD_MS = 20_000;

const editingTimers = new Map<string, ReturnType<typeof setTimeout>>();
let globalEditing = false;
let globalTimer: ReturnType<typeof setTimeout> | null = null;

/** agent Edit 工具针对某文件开始/进行中：登记该 uri（覆盖续期） */
export function markAgentEditingFile(uri: string): void {
  if (!uri) return;
  const key = normalizeUri(uri);
  const existing = editingTimers.get(key);
  if (existing) clearTimeout(existing);
  editingTimers.set(
    key,
    setTimeout(() => {
      editingTimers.delete(key);
    }, FILE_HOLD_MS),
  );
  globalEditing = true;
}

/** 全局标记（任意 agent 编辑进行中），带 TTL 滞后 */
export function setAgentEditing(v: boolean): void {
  if (globalTimer) {
    clearTimeout(globalTimer);
    globalTimer = null;
  }
  if (v) {
    globalEditing = true;
  } else {
    globalTimer = setTimeout(() => {
      globalEditing = false;
      globalTimer = null;
    }, FILE_HOLD_MS);
  }
}

/** 按 uri 精确判定是否 agent 正在编辑该文件 */
export function isAgentEditingFile(uri: string): boolean {
  if (!uri) return false;
  return editingTimers.has(normalizeUri(uri));
}

/** 兜底：任意 agent 编辑进行中 */
export function isAgentEditing(): boolean {
  return globalEditing || editingTimers.size > 0;
}

function normalizeUri(uri: string): string {
  // 统一路径表示：去 file:// 前缀、转小写、去尾部斜杠，便于跨桥比对
  return uri
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/\/+$/, "");
}
