//! foreshadow_get_context — read the UI-process Foreshadow Runtime snapshot.
//!
//! Runtime lives in the Web UI process. This tool requests a snapshot over the
//! existing FE request/response channel (UserInputManager + submit_user_answers)
//! and returns the SPEC §4 payload shell.

use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext,
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

/// Env var: inline static foreshadow context text (headless / benchmark fallback).
pub const BITFUN_FORESHADOW_STATIC_CONTEXT: &str = "BITFUN_FORESHADOW_STATIC_CONTEXT";

/// Env var: path to a file whose content is the static foreshadow context text.
/// Prefer this for long / multi-line context that is unwieldy in an env var.
pub const BITFUN_FORESHADOW_STATIC_CONTEXT_FILE: &str = "BITFUN_FORESHADOW_STATIC_CONTEXT_FILE";

/// Env var: context source mode, toggles between the SPEC dynamic path and
/// the static (benchmark / headless) path without recompiling.
///
/// - `dynamic` (default, unset): request the Foreshadow snapshot from the FE
///   RuntimeMap over the existing event channel (SPEC §4). This is the path
///   used when running the desktop app / demos.
/// - `static`: skip the FE round-trip and serve the abstract directly from
///   `BITFUN_FORESHADOW_STATIC_CONTEXT_FILE` / `BITFUN_FORESHADOW_STATIC_CONTEXT`.
///   Used by the SWE-Bench Pro benchmark harness so headless CLI runs return
///   the pre-annotated context instantly without waiting on a UI process.
pub const BITFUN_FORESHADOW_CONTEXT_MODE: &str = "BITFUN_FORESHADOW_CONTEXT_MODE";

#[derive(Clone, Copy, PartialEq, Eq)]
enum ForeshadowContextMode {
    Dynamic,
    Static,
}

fn resolve_context_mode() -> ForeshadowContextMode {
    match std::env::var(BITFUN_FORESHADOW_CONTEXT_MODE)
        .ok()
        .map(|raw| raw.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("static") => ForeshadowContextMode::Static,
        _ => ForeshadowContextMode::Dynamic,
    }
}

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
        // Abstract-only contract: hand the model the human-readable Foreshadow
        // abstract verbatim instead of the raw JSON shell. The raw context/logs/
        // tasks bodies bloat the tool result without adding grounding signal.
        let assistant_text = payload
            .get("abstract")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                serde_json::to_string(&payload).unwrap_or_else(|_| {
                    "Foreshadow context snapshot returned but could not be serialized."
                        .to_string()
                })
            });
        ToolResult::Result {
            data: payload,
            result_for_assistant: Some(assistant_text),
            image_attachments: None,
        }
    }

    /// Read static foreshadow context from env vars (headless / benchmark fallback).
    ///
    /// `BITFUN_FORESHADOW_STATIC_CONTEXT_FILE` takes precedence: if set, its
    /// content is read and returned as the foreshadow abstract. If it is not set,
    /// fall back to the inline `BITFUN_FORESHADOW_STATIC_CONTEXT` value.
    ///
    /// Returns `None` when neither env var is set.
    fn try_read_static_context_abstract() -> Option<String> {
        // Prefer the file-based variant — avoids PowerShell quoting nightmares
        // with multi-line text in env vars.
        if let Ok(path) = std::env::var(BITFUN_FORESHADOW_STATIC_CONTEXT_FILE) {
            let path = path.trim();
            if !path.is_empty() {
                match std::fs::read_to_string(path) {
                    Ok(text) => {
                        let trimmed = text.trim().to_string();
                        if !trimmed.is_empty() {
                            debug!(
                                "foreshadow_get_context: loaded static context from file ({} bytes)",
                                trimmed.len()
                            );
                            return Some(trimmed);
                        }
                        warn!(
                            "foreshadow_get_context: {} is set but file is empty: {path}",
                            BITFUN_FORESHADOW_STATIC_CONTEXT_FILE
                        );
                    }
                    Err(error) => {
                        warn!(
                            "foreshadow_get_context: failed to read {}={path}: {error}",
                            BITFUN_FORESHADOW_STATIC_CONTEXT_FILE
                        );
                    }
                }
            }
        }

        // Fall back to the inline env var.
        if let Ok(text) = std::env::var(BITFUN_FORESHADOW_STATIC_CONTEXT) {
            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() {
                debug!(
                    "foreshadow_get_context: loaded static context from env var ({} bytes)",
                    trimmed.len()
                );
                return Some(trimmed);
            }
        }

        None
    }

    /// Build a success result for a given static abstract text.
    fn build_static_context_result(abstract_text: String) -> ToolResult {
        let now = chrono::Utc::now().to_rfc3339();
        let payload = json!({
            "ok": true,
            "schemaVersion": 1,
            "workspacePath": "(static)",
            "generatedAt": now,
            "abstract": abstract_text,
            "source": "static",
        });
        Self::build_success_result(payload)
    }
}

#[async_trait]
impl Tool for ForeshadowGetContextTool {
    fn name(&self) -> &str {
        FORESHADOW_GET_CONTEXT_TOOL_NAME
    }

    async fn description(&self) -> BitFunResult<String> {
        Ok(r#"Read user's current activity context for this workspace.

Use this when you need the user's recent editor/terminal activity context. This tool is always available and requires no user configuration — the agent can call it autonomously at any time.

Args:
- workspacePath (optional): target workspace root; defaults to the current agent workspace / active workspace.

Limitations:
- Remote / peer workspaces are unsupported (local only)

Errors are returned as structured soft failures with code:
NO_WORKSPACE | REMOTE_UNSUPPORTED | NOT_READY | INTERNAL_ERROR."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Read user's recent activities and contexts when the user's intent is unclear or you don't know where to start exploring.".to_string()
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
        output
            .get("abstract")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                serde_json::to_string(output).unwrap_or_else(|_| {
                    "Foreshadow context snapshot returned but could not be serialized."
                        .to_string()
                })
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

        // --- Static mode: serve the pre-annotated abstract directly (benchmark). ---
        if resolve_context_mode() == ForeshadowContextMode::Static {
            if let Some(abstract_text) = Self::try_read_static_context_abstract() {
                debug!(
                    "foreshadow_get_context: serving static context ({} bytes, mode=static)",
                    abstract_text.len()
                );
                return Ok(vec![Self::build_static_context_result(abstract_text)]);
            }
            warn!(
                "foreshadow_get_context: static mode requested but no static context provided \
                 (set {} or {})",
                BITFUN_FORESHADOW_STATIC_CONTEXT_FILE, BITFUN_FORESHADOW_STATIC_CONTEXT
            );
            return Ok(vec![Self::build_error_result(
                "NOT_READY",
                "Foreshadow static context mode is active but no context file/env was provided",
            )]);
        }

        // --- Dynamic mode (SPEC §4): request snapshot from the FE RuntimeMap. ---
        let event_system = get_global_event_system();
        if !event_system.has_emitter().await {
            // Backend event bridge has not been wired up yet (early desktop startup
            // or headless run without a transport emitter). Fail fast instead of
            // making the agent wait out the full FE_RESPONSE_TIMEOUT.
            warn!(
                "foreshadow_get_context: event emitter not initialized; returning NOT_READY \
                 (mode=dynamic, tool_id={})",
                tool_id
            );
            return Ok(vec![Self::build_error_result(
                "NOT_READY",
                "Foreshadow event bridge is not initialized yet",
            )]);
        }

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

        if let Err(error) = event_system.emit(event).await {
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

                if answers.get("schemaVersion").is_some() && answers.get("abstract").is_some() {
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
                    "foreshadow_get_context timed out waiting for FE reply: tool_id={}",
                    tool_id
                );

                // Dynamic mode keeps the SPEC contract pure: a timeout means the FE
                // RuntimeMap did not reply in time. Static context is only served when
                // BITFUN_FORESHADOW_CONTEXT_MODE=static (handled at the top of call_impl),
                // so a timeout here surfaces as NOT_READY rather than silently masking a
                // missing UI bridge with a stale static file.
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
    fn foreshadow_tool_has_no_permission_intents_by_default() {
        let tool = ForeshadowGetContextTool::new();
        let context = empty_context();
        // Default trait impl: readonly tools return empty Vec (no permission gate).
        let intents = tool
            .permission_intents(&json!({ "workspacePath": "D:/ws" }), &context)
            .expect("permission intents");
        assert!(intents.is_empty(), "readonly tools should skip the permission pipeline");
    }

    #[test]
    fn foreshadow_success_result_returns_abstract_only_for_assistant() {
        let payload = json!({
            "schemaVersion": 1,
            "workspacePath": "D:/ws",
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "abstract": "#User's current task and intention\nsample abstract"
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
                assert_eq!(
                    text, "#User's current task and intention\nsample abstract",
                    "assistant must see only the abstract, not the JSON shell"
                );
            }
            other => panic!("expected Result variant, got {other:?}"),
        }
    }

    #[test]
    fn foreshadow_success_result_falls_back_to_json_without_abstract() {
        let payload = json!({
            "schemaVersion": 1,
            "workspacePath": "D:/ws",
            "generatedAt": "2026-01-01T00:00:00.000Z"
        });
        let result = ForeshadowGetContextTool::build_success_result(payload.clone());
        match result {
            crate::agentic::tools::framework::ToolResult::Result {
                result_for_assistant,
                ..
            } => {
                let text = result_for_assistant.expect("assistant text");
                assert!(
                    text.contains("schemaVersion"),
                    "fallback must still surface payload: {text}"
                );
            }
            other => panic!("expected Result variant, got {other:?}"),
        }
    }
}
