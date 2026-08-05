//! foreshadow_get_context — read the UI-process Foreshadow Runtime snapshot.
//!
//! Runtime lives in the Web UI process. This tool requests a snapshot over the
//! existing FE request/response channel (UserInputManager + submit_user_answers)
//! and returns the SPEC §4 payload shell.

use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext,
};
use crate::agentic::tools::user_input_manager::get_user_input_manager;
use crate::infrastructure::events::event_system::{get_global_event_system, BackendEvent};
use crate::util::errors::BitFunResult;
use async_trait::async_trait;
use log::{debug, warn};
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

/// Stable tool name (SPEC §4 / FORESHADOW_MCP_TOOL_NAME).
pub const FORESHADOW_GET_CONTEXT_TOOL_NAME: &str = "foreshadow_get_context";

/// FE listens on this custom backend event name.
const FORESHADOW_GET_CONTEXT_EVENT: &str = "agentic://foreshadow-get-context";

/// How long to wait for the FE RuntimeMap reply.
const FE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

pub struct ForeshadowGetContextTool;

impl Default for ForeshadowGetContextTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ForeshadowGetContextTool {
    pub fn new() -> Self {
        Self
    }

    fn generate_tool_id(context: &ToolUseContext) -> String {
        if let Some(tool_call_id) = &context.tool_call_id {
            return tool_call_id.clone();
        }
        warn!("Unable to get tool_call_id, using UUID for foreshadow_get_context");
        format!("foreshadow_get_context_{}", Uuid::new_v4())
    }

    fn request_workspace_path(input: &Value, context: &ToolUseContext) -> Option<String> {
        input
            .get("workspacePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                context
                    .workspace_root()
                    .map(|path| path.to_string_lossy().to_string())
            })
    }

    fn build_error_result(code: &str, message: &str) -> ToolResult {
        ToolResult::Result {
            data: json!({
                "ok": false,
                "code": code,
                "message": message,
            }),
            result_for_assistant: Some(format!(
                "foreshadow_get_context failed: {code} — {message}"
            )),
            image_attachments: None,
        }
    }

    fn build_success_result(payload: Value) -> ToolResult {
        // Pipeline prefers result_for_assistant when set. A one-line summary would hide
        // the full context object from the model — always serialize the payload JSON.
        let assistant_text = serde_json::to_string_pretty(&payload)
            .or_else(|_| serde_json::to_string(&payload))
            .unwrap_or_else(|_| {
                "Foreshadow context snapshot returned but could not be serialized.".to_string()
            });
        ToolResult::Result {
            data: payload,
            result_for_assistant: Some(assistant_text),
            image_attachments: None,
        }
    }
}

#[async_trait]
impl Tool for ForeshadowGetContextTool {
    fn name(&self) -> &str {
        FORESHADOW_GET_CONTEXT_TOOL_NAME
    }

    async fn description(&self) -> BitFunResult<String> {
        Ok(r#"Read the current Foreshadow IDE activity context snapshot for the active local workspace.

Use this when you need the user's recent editor/terminal activity context maintained by Foreshadow (history, cursor, active editor, tasks, etc.). The payload body is the Foreshadow `toJSONObject()` context object, wrapped with schemaVersion, workspacePath, and generatedAt.

Requirements:
- Local workspace only (remote / peer workspaces are unsupported)
- User must enable Foreshadow capture in Settings
- Tool permission defaults to ask

Args:
- workspacePath (optional): target workspace root; defaults to the current agent workspace / active workspace.

Errors are returned as structured soft failures with code:
NO_WORKSPACE | REMOTE_UNSUPPORTED | NOT_AUTHORIZED | NOT_READY | INTERNAL_ERROR."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Read the Foreshadow IDE activity context snapshot.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "workspacePath": {
                    "type": "string",
                    "description": "Optional workspace root path. Defaults to the current/active workspace."
                }
            },
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> BitFunResult<Vec<PermissionIntent>> {
        let resource = Self::request_workspace_path(input, context)
            .unwrap_or_else(|| "active-workspace".to_string());
        // Explicit intent so default Ask preset requires user authorization (D14).
        // Readonly tools would otherwise skip the permission pipeline.
        Ok(vec![PermissionIntent::new(
            "foreshadow",
            vec![format!("get_context:{resource}")],
        )])
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        match input
            .get("workspacePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(path) => format!("Get Foreshadow context ({path})"),
            None => "Get Foreshadow context".to_string(),
        }
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        if output.get("ok") == Some(&json!(false)) {
            let code = output
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("INTERNAL_ERROR");
            let message = output
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return format!("foreshadow_get_context failed: {code} — {message}");
        }
        serde_json::to_string_pretty(output)
            .or_else(|_| serde_json::to_string(output))
            .unwrap_or_else(|_| {
                "Foreshadow context snapshot returned but could not be serialized.".to_string()
            })
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> BitFunResult<Vec<ToolResult>> {
        let tool_id = Self::generate_tool_id(context);
        let workspace_path = Self::request_workspace_path(input, context);
        let session_id = context
            .session_id
            .clone()
            .unwrap_or_else(|| "unknown".to_string());

        let (tx, rx) = tokio::sync::oneshot::channel();
        let manager = get_user_input_manager();
        manager.register_channel(tool_id.clone(), tx);

        let event = BackendEvent::Custom {
            event_name: FORESHADOW_GET_CONTEXT_EVENT.to_string(),
            payload: json!({
                "toolId": tool_id,
                "sessionId": session_id,
                "workspacePath": workspace_path,
            }),
        };

        if let Err(error) = get_global_event_system().emit(event).await {
            manager.cancel(&tool_id);
            warn!(
                "Failed to emit foreshadow get-context request: tool_id={}, error={}",
                tool_id, error
            );
            return Ok(vec![Self::build_error_result(
                "INTERNAL_ERROR",
                &format!("Failed to request foreshadow context from UI: {error}"),
            )]);
        }

        debug!(
            "foreshadow_get_context waiting for FE reply: tool_id={}",
            tool_id
        );

        match tokio::time::timeout(FE_RESPONSE_TIMEOUT, rx).await {
            Ok(Ok(response)) => {
                let answers = response.answers;
                if answers.get("ok") == Some(&json!(false)) {
                    let code = answers
                        .get("code")
                        .and_then(Value::as_str)
                        .unwrap_or("INTERNAL_ERROR");
                    let message = answers
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Foreshadow context unavailable");
                    return Ok(vec![Self::build_error_result(code, message)]);
                }

                if answers.get("schemaVersion").is_some() && answers.get("context").is_some() {
                    return Ok(vec![Self::build_success_result(answers)]);
                }

                // Unexpected envelope shape from FE.
                Ok(vec![Self::build_error_result(
                    "INTERNAL_ERROR",
                    "Invalid foreshadow context payload from UI",
                )])
            }
            Ok(Err(_)) => {
                warn!(
                    "foreshadow_get_context channel closed without reply: tool_id={}",
                    tool_id
                );
                Ok(vec![Self::build_error_result(
                    "INTERNAL_ERROR",
                    "Foreshadow context request was cancelled",
                )])
            }
            Err(_) => {
                manager.cancel(&tool_id);
                warn!(
                    "foreshadow_get_context timed out waiting for FE: tool_id={}",
                    tool_id
                );
                Ok(vec![Self::build_error_result(
                    "NOT_READY",
                    "Timed out waiting for Foreshadow UI runtime reply",
                )])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ForeshadowGetContextTool, FORESHADOW_GET_CONTEXT_TOOL_NAME};
    use crate::agentic::tools::framework::{Tool, ToolExposure, ToolUseContext};
    use serde_json::json;
    use std::collections::HashMap;

    fn empty_context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: Some("tool-1".to_string()),
            agent_type: None,
            session_id: Some("session-1".to_string()),
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: bitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[test]
    fn foreshadow_tool_is_deferred_readonly_and_named_per_spec() {
        let tool = ForeshadowGetContextTool::new();
        assert_eq!(tool.name(), FORESHADOW_GET_CONTEXT_TOOL_NAME);
        assert_eq!(tool.default_exposure(), ToolExposure::Deferred);
        assert!(tool.is_readonly());
        assert!(tool.is_concurrency_safe(None));
    }

    #[test]
    fn foreshadow_tool_emits_explicit_permission_intent() {
        let tool = ForeshadowGetContextTool::new();
        let context = empty_context();
        let intents = tool
            .permission_intents(&json!({ "workspacePath": "D:/ws" }), &context)
            .expect("permission intents");
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].action, "foreshadow");
        assert_eq!(intents[0].resources, ["get_context:D:/ws".to_string()]);
    }

    #[test]
    fn foreshadow_success_result_includes_full_payload_for_assistant() {
        let payload = json!({
            "schemaVersion": 1,
            "workspacePath": "D:/ws",
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "context": {
                "history": "edit note",
                "cursorContext": { "path": "a.md" }
            },
            "completeness": 0.4,
            "logs": [],
            "abstract": "sample abstract"
        });
        let result = ForeshadowGetContextTool::build_success_result(payload.clone());
        match result {
            crate::agentic::tools::framework::ToolResult::Result {
                data,
                result_for_assistant,
                ..
            } => {
                assert_eq!(data, payload);
                let text = result_for_assistant.expect("assistant text");
                assert!(text.contains("cursorContext"), "assistant must see context body: {text}");
                assert!(text.contains("sample abstract"), "assistant must see abstract: {text}");
                assert!(
                    !text.starts_with("Foreshadow context snapshot for workspace"),
                    "must not collapse to one-line summary: {text}"
                );
            }
            other => panic!("expected Result variant, got {other:?}"),
        }
    }
}
