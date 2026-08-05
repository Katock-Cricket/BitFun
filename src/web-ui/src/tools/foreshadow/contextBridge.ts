/**
 * FE ↔ Rust bridge for foreshadow_get_context.
 *
 * Rust tool emits BackendEvent::Custom on FORESHADOW_GET_CONTEXT_EVENT;
 * FE builds the RuntimeMap snapshot payload and replies through the existing
 * submit_user_answers / UserInputManager oneshot channel (same as AskUserQuestion).
 */
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { toolAPI } from '@/infrastructure/api/service-api/ToolAPI';
import { createLogger } from '@/shared/utils/logger';
import { buildForeshadowContextPayload } from './contextPayload';

const log = createLogger('ForeshadowContextBridge');

/** Must match the Rust tool constant. */
export const FORESHADOW_GET_CONTEXT_EVENT = 'agentic://foreshadow-get-context';

export interface ForeshadowGetContextRequest {
  toolId: string;
  sessionId?: string;
  workspacePath?: string | null;
}

let unlisten: (() => void) | null = null;
let started = false;

async function handleRequest(payload: ForeshadowGetContextRequest): Promise<void> {
  const toolId = payload?.toolId?.trim();
  if (!toolId) {
    log.warn('Ignoring foreshadow get-context request without toolId', { payload });
    return;
  }

  const response = buildForeshadowContextPayload(payload.workspacePath);
  try {
    // UserInputManager accepts any JSON Value as answers; the Rust tool
    // treats the whole value as the FE response envelope.
    await toolAPI.submitUserAnswers(toolId, response);
    log.debug('Replied foreshadow get-context', {
      toolId,
      ok: !('ok' in response && response.ok === false),
    });
  } catch (error) {
    log.error('Failed to submit foreshadow get-context reply', { toolId, error });
  }
}

export function startForeshadowContextBridge(): void {
  if (started) {
    return;
  }
  started = true;

  unlisten = api.listen<ForeshadowGetContextRequest>(FORESHADOW_GET_CONTEXT_EVENT, (data) => {
    void handleRequest(data);
  });

  log.info('Foreshadow context bridge started', { event: FORESHADOW_GET_CONTEXT_EVENT });
}

export function stopForeshadowContextBridge(): void {
  if (unlisten) {
    try {
      unlisten();
    } catch (error) {
      log.warn('Failed to stop foreshadow context bridge listener', { error });
    }
    unlisten = null;
  }
  started = false;
}
