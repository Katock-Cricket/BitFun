/**
 * Build the foreshadow_get_context tool payload (SPEC §4).
 *
 * Success shell:
 *   { schemaVersion: 1, workspacePath, generatedAt, abstract }
 * Error shell:
 *   { ok: false, code, message }
 *
 * The payload is abstract-only by design: the human-readable Foreshadow
 * `toAbstract()` summary is what grounds the agent; the raw `toJSONObject()`
 * context, logs, and tasks bloat the tool result without adding signal.
 */
import { foreshadowRuntimeMap } from './runtimeMap';
import type { ForeshadowUnavailableCode } from './types';

export const FORESHADOW_CONTEXT_SCHEMA_VERSION = 1 as const;

export type ForeshadowContextSuccessPayload = {
  schemaVersion: typeof FORESHADOW_CONTEXT_SCHEMA_VERSION;
  workspacePath: string;
  generatedAt: string;
  /** Human-readable abstract of current Foreshadow state (`toAbstract()`). */
  abstract: string;
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
    const abstract =
      typeof snapshot.abstract === 'string' ? snapshot.abstract : '';
    return {
      schemaVersion: FORESHADOW_CONTEXT_SCHEMA_VERSION,
      workspacePath: result.workspacePath,
      generatedAt: new Date().toISOString(),
      abstract,
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
