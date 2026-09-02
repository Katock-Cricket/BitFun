/**
 * 模块级共享标志：agent 是否正在通过 Edit 工具修改文件。
 * 用于让 foreshadow-bridge 在记录 textChanged 时区分 source="agent" vs "user"。
 * 解耦两桥（避免 foreshadow 依赖 agentAPI 的调用链，防止单桥初始化失败级联）。
 *
 * 时序注意：agent Edit 工具 complete 时文件已落盘，但 CodeEditor 靠轮询检测外部修改
 * 并 reload model（数秒延迟）。若 complete 即刻清标志，随后的 textChanged 会被误标
 * source="user"。故清除带 15s 滞后窗口。
 */
let agentEditing = false;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
const HOLD_AFTER_EDIT_MS = 15_000;

export function setAgentEditing(v: boolean): void {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  if (v) {
    agentEditing = true;
  } else {
    clearTimer = setTimeout(() => {
      agentEditing = false;
      clearTimer = null;
    }, HOLD_AFTER_EDIT_MS);
  }
}

export function isAgentEditing(): boolean {
  return agentEditing;
}
