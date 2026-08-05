/**
 * Build the foreshadow_get_context tool payload (SPEC §4).
 *
 * Success shell:
 *   { schemaVersion: 1, workspacePath, generatedAt, context: toJSONObject() }
 * Error shell:
 *   { ok: false, code, message }
 */
import { foreshadowRuntimeMap } from './runtimeMap';
import type { ForeshadowUnavailableCode } from './types';

export const FORESHADOW_CONTEXT_SCHEMA_VERSION = 1 as const;

export type ForeshadowContextSuccessPayload = {
  schemaVersion: typeof FORESHADOW_CONTEXT_SCHEMA_VERSION;
  workspacePath: string;
  generatedAt: string;
  /** Foreshadow L3 `toJSONObject()` body (SPEC §4). */
  context: unknown;
  /** 0–1 completeness score from core (helps diagnose empty capture). */
  completeness?: number;
  /** Recent raw log items (last ~20) for richer agent grounding. */
  logs?: unknown;
  /** Recent tasks (last ~5). */
  tasks?: unknown;
  /** Human-readable abstract of current Foreshadow state. */
  abstract?: string;
};

export type ForeshadowContextErrorPayload = {
  ok: false;
  code: ForeshadowUnavailableCode;
  message: string;
};

export type ForeshadowContextPayload =
  | ForeshadowContextSuccessPayload
  | ForeshadowContextErrorPayload;

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Resolve the MCP/tool payload for the active (or requested) workspace runtime.
 * RuntimeMap currently retains only the active workspace runtime (P1).
 */
export function buildForeshadowContextPayload(
  workspacePath?: string | null,
): ForeshadowContextPayload {
  const requested = workspacePath?.trim() || null;

  try {
    if (requested) {
      const status = foreshadowRuntimeMap.getStatus();
      if (status.kind !== 'ready') {
        return { ok: false, code: status.code, message: status.message };
      }
      if (
        normalizePathForCompare(status.workspacePath) !==
        normalizePathForCompare(requested)
      ) {
        // Multi-ws isolation: only the active workspace runtime is retained in v1.
        return {
          ok: false,
          code: 'NOT_READY',
          message:
            'Foreshadow runtime is only available for the active workspace; requested workspace is not ready',
        };
      }
    }

    const result = foreshadowRuntimeMap.getSnapshot();
    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message };
    }

    const { snapshot } = result;
    return {
      schemaVersion: FORESHADOW_CONTEXT_SCHEMA_VERSION,
      workspacePath: result.workspacePath,
      generatedAt: new Date().toISOString(),
      context: snapshot.context,
      // Extra diagnostic / grounding fields from FoundationRuntime.getSnapshot().
      // Keep `context` as the SPEC primary body; these help when context is sparse.
      completeness: snapshot.completeness,
      logs: snapshot.logs,
      tasks: snapshot.tasks,
      abstract: snapshot.abstract,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to build foreshadow context';
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message,
    };
  }
}
