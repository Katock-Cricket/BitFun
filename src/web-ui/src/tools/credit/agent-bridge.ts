/**
 * agent-bridge：订阅 agentic:// 事件（经 AgentAPI 方法），归一化为
 * promptSubmitted / agentToolUse / agentMessage。
 * 全部为附加 listener；异常自捕获 + log + 计数，绝不向事件源抛错（§5 纪律）。
 *
 * 注意：api.listen 不解包 Tauri 事件，回调收到的是 { event, payload, id }，
 * 真实数据在 e.payload。各 handler 统一用 unwrap() 处理。
 */
import type { CreditRawEvent } from "@credit/protocol";
import type { BridgeSink } from "@credit/core";
import { setAgentEditing } from "./agent-edit-state";

export interface AgentDeps {
  agentAPI: {
    onDialogTurnStarted(cb: (e: any) => void): () => void;
    onToolEvent(cb: (e: any) => void): () => void;
    onTextChunk(cb: (e: any) => void): () => void;
    onDialogTurnCompleted(cb: (e: any) => void): () => void;
  };
  publish: (evt: CreditRawEvent) => void;
  count: (key: string) => void;
  logError: (msg: string, meta?: unknown) => void;
}

const SOURCE = "agent-bridge";

/** Tauri listen 包装为 { event, payload, id }；解包出真实 payload */
function unwrap(e: any): any {
  return e && e.payload !== undefined ? e.payload : e;
}

export function createAgentBridge(deps: AgentDeps): { dispose(): void } {
  const unsubs: Array<() => void> = [];

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      deps.logError(`${SOURCE} handler failed`, { error: String(e) });
      deps.count(`${SOURCE}:error`);
    }
  };

  // agent 回复文本累积（按 turnId 聚合 text-chunk，completed 时 flush 一条 agentMessage）
  const replyBuffers = new Map<string, { sessionId: string; text: string }>();

  // promptSubmitted —— dialog-turn-started（降级：前端无专用 prompt 事件）
  unsubs.push(
    deps.agentAPI.onDialogTurnStarted((raw: any) => {
      const e = unwrap(raw);
      guard(() => {
        const promptText = e?.userInput ?? e?.prompt ?? e?.text ?? e?.input ?? "";
        if (!promptText) return; // 跳过空 prompt（如内部子事件）
        deps.publish({
          type: "promptSubmitted",
          sessionId: e?.sessionId ?? "unknown",
          promptText,
          attachmentRefs: e?.attachments ?? null,
          fidelity: "frontend",
          ts: e?.ts ?? Date.now(),
        });
        deps.count(`${SOURCE}:promptSubmitted`);
      });
    }),
  );

  // agentToolUse —— tool-event（完全可得）。同一 tool 调用分多阶段事件（start/streaming/complete），
  // 按 tool_id 聚合：start 累积 input，complete（含 result）时 publish 一条完整记录（去重）。
  const toolBuf = new Map<string, { sessionId: string; toolName: string; input: any }>();
  unsubs.push(
    deps.agentAPI.onToolEvent((raw: any) => {
      const e = unwrap(raw);
      const tool = e?.toolEvent ?? e ?? {};
      const toolName = tool?.toolName ?? tool?.name ?? tool?.tool_name ?? tool?.tool;
      if (!toolName) return; // 跳过空 toolCall（聚合态）
      // agent 用 Edit 工具改文件期间，标记全局状态供 textChanged 标 source="agent"
      if (toolName === "Edit" || toolName === "EditTool") {
        const isComplete = tool?.result != null || tool?.result_for_assistant != null || tool?.event_type === "complete";
        setAgentEditing(!isComplete);
      }
      const toolId = String(tool?.tool_id ?? e?.toolId ?? toolName + ":" + (e?.turnId ?? ""));
      const isComplete = tool?.result != null || tool?.result_for_assistant != null || tool?.event_type === "complete" || tool?.event_type === "tool_complete";
      guard(() => {
        if (!isComplete) {
          // start/streaming 阶段：仅缓存 input，不 publish（避免重复）
          const buf = toolBuf.get(toolId) ?? { sessionId: e?.sessionId ?? "unknown", toolName, input: null };
          buf.sessionId = e?.sessionId ?? buf.sessionId;
          buf.input = tool?.params ?? tool?.toolInput ?? tool?.input ?? buf.input;
          toolBuf.set(toolId, buf);
          return;
        }
        // complete 阶段：publish 一条完整记录
        const buf = toolBuf.get(toolId);
        toolBuf.delete(toolId);
        deps.publish({
          type: "agentToolUse",
          sessionId: e?.sessionId ?? buf?.sessionId ?? "unknown",
          toolName,
          toolInput: buf?.input ?? tool?.params ?? tool?.toolInput ?? null,
          outputSummary: tool?.result_for_assistant ?? tool?.result ?? tool?.outputSummary ?? null,
          exitCode: tool?.exitCode ?? null,
          phase: "end",
          durationMs: tool?.duration_ms ?? tool?.execution_ms ?? null,
          fidelity: "frontend",
          ts: e?.ts ?? Date.now(),
        });
        deps.count(`${SOURCE}:agentToolUse`);
      });
    }),
  );

  // agentMessage —— text-chunk 累积（按 turnId），completed 时 flush 一条完整回复
  unsubs.push(
    deps.agentAPI.onTextChunk((raw: any) => {
      const e = unwrap(raw);
      guard(() => {
        const turnId = e?.turnId ?? e?.sessionId ?? "unknown";
        const chunk = e?.text ?? "";
        if (!chunk) return;
        const buf = replyBuffers.get(turnId) ?? { sessionId: e?.sessionId ?? "unknown", text: "" };
        buf.sessionId = e?.sessionId ?? buf.sessionId;
        buf.text += chunk;
        replyBuffers.set(turnId, buf);
      });
    }),
  );

  unsubs.push(
    deps.agentAPI.onDialogTurnCompleted((raw: any) => {
      const e = unwrap(raw);
      guard(() => {
        const turnId = e?.turnId ?? e?.sessionId ?? "unknown";
        const buf = replyBuffers.get(turnId);
        if (!buf || !buf.text) return; // 无回复文本则不记
        replyBuffers.delete(turnId);
        deps.publish({
          type: "agentMessage",
          sessionId: buf.sessionId,
          role: "assistant",
          text: buf.text,
          fidelity: "frontend",
          ts: e?.ts ?? Date.now(),
        });
        deps.count(`${SOURCE}:agentMessage`);
      });
    }),
  );

  return {
    dispose() {
      replyBuffers.clear();
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
