/**
 * Correlates raw BitFun terminal_event payloads into Foreshadow terminalCommand events.
 *
 * Rules (SPEC §5.4):
 * - Only correlate when shell integration emits CommandStarted / CommandFinished.
 * - Without SI events, never fabricate command boundaries.
 * - Multi-session buckets keyed by session_id; processId = session_id.
 * - phase:end output is joined Data chunks with 64KB head/tail truncation.
 * - ConPTY may deliver late Data after CommandFinished; settle briefly before end publish.
 */
import type { RawHostEvent } from '@foreshadow/core';
import { createLogger } from '@/shared/utils/logger';
import { truncateTerminalOutput } from './truncateTerminalOutput';

const log = createLogger('ForeshadowTerminalCorrelator');

/** Wait for late ConPTY Data after CommandFinished before publishing end. */
export const FORESHADOW_TERMINAL_FINISH_SETTLE_MS = 80;

export type TerminalCorrelatorPublish = (
  event: Extract<RawHostEvent, { type: 'terminalCommand' }>,
) => void | Promise<void>;

export type TerminalCorrelatorOptions = {
  publish: TerminalCorrelatorPublish;
  /** Override settle window (tests). */
  finishSettleMs?: number;
  /** Override timer APIs (tests). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

type ActiveCommand = {
  commandId: string;
  cmd: string;
  chunks: string[];
  finishTimer: ReturnType<typeof setTimeout> | null;
};

/** Backend wire shape: { type, payload: { session_id, ... } } */
export type RawTerminalEventWire = {
  type?: string;
  payload?: Record<string, unknown> | null;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asOptionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class TerminalCorrelator {
  private readonly publishImpl: TerminalCorrelatorPublish;
  private readonly finishSettleMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly activeBySession = new Map<string, ActiveCommand>();

  constructor(options: TerminalCorrelatorOptions) {
    this.publishImpl = options.publish;
    this.finishSettleMs = options.finishSettleMs ?? FORESHADOW_TERMINAL_FINISH_SETTLE_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  handleRawEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') {
      return;
    }
    const event = raw as RawTerminalEventWire;
    const type = event.type;
    const payload = event.payload ?? {};
    if (!type || typeof payload !== 'object' || payload === null) {
      return;
    }

    switch (type) {
      case 'CommandStarted':
        this.onCommandStarted(payload);
        break;
      case 'Data':
        this.onData(payload);
        break;
      case 'CommandFinished':
        this.onCommandFinished(payload);
        break;
      case 'Exit':
      case 'SessionDestroyed':
        this.onSessionClosed(payload);
        break;
      default:
        break;
    }
  }

  dispose(): void {
    for (const [sessionId, active] of this.activeBySession) {
      this.clearFinishTimer(active);
      // Drop in-flight buffers without fabricating end if dispose races shutdown.
      log.debug('Dropping active terminal command buffer on dispose', {
        sessionId,
        commandId: active.commandId,
      });
    }
    this.activeBySession.clear();
  }

  /** Test seam: number of sessions with an active command buffer. */
  get activeSessionCount(): number {
    return this.activeBySession.size;
  }

  private onCommandStarted(payload: Record<string, unknown>): void {
    const sessionId = asString(payload.session_id);
    const commandId = asString(payload.command_id);
    if (!sessionId || !commandId) {
      return;
    }
    const cmd = asOptionalString(payload.command);

    // New start supersedes any unfinished buffer for this session.
    const previous = this.activeBySession.get(sessionId);
    if (previous) {
      this.clearFinishTimer(previous);
      this.flushEnd(sessionId, previous);
    }

    this.activeBySession.set(sessionId, {
      commandId,
      cmd,
      chunks: [],
      finishTimer: null,
    });

    void this.safePublish({
      type: 'terminalCommand',
      processId: sessionId,
      cmd,
      output: '',
      phase: 'start',
    });
  }

  private onData(payload: Record<string, unknown>): void {
    const sessionId = asString(payload.session_id);
    if (!sessionId) {
      return;
    }
    const active = this.activeBySession.get(sessionId);
    if (!active) {
      // No SI-started command: do not invent boundaries from raw stream data.
      return;
    }
    const data = asOptionalString(payload.data);
    if (data.length === 0) {
      return;
    }
    active.chunks.push(data);
  }

  private onCommandFinished(payload: Record<string, unknown>): void {
    const sessionId = asString(payload.session_id);
    const commandId = asString(payload.command_id);
    if (!sessionId || !commandId) {
      return;
    }
    const active = this.activeBySession.get(sessionId);
    if (!active) {
      return;
    }
    // Ignore finished for a different command_id (stale / out-of-order).
    if (active.commandId !== commandId) {
      log.debug('Ignoring CommandFinished for non-active command', {
        sessionId,
        expected: active.commandId,
        got: commandId,
      });
      return;
    }

    this.clearFinishTimer(active);
    if (this.finishSettleMs <= 0) {
      this.flushEnd(sessionId, active);
      return;
    }

    active.finishTimer = this.setTimeoutFn(() => {
      const current = this.activeBySession.get(sessionId);
      if (!current || current.commandId !== commandId) {
        return;
      }
      current.finishTimer = null;
      this.flushEnd(sessionId, current);
    }, this.finishSettleMs);
  }

  private onSessionClosed(payload: Record<string, unknown>): void {
    const sessionId = asString(payload.session_id);
    if (!sessionId) {
      return;
    }
    const active = this.activeBySession.get(sessionId);
    if (!active) {
      return;
    }
    this.clearFinishTimer(active);
    // Session died mid-command: publish whatever output we buffered.
    this.flushEnd(sessionId, active);
  }

  private flushEnd(sessionId: string, active: ActiveCommand): void {
    this.clearFinishTimer(active);
    this.activeBySession.delete(sessionId);
    const joined = active.chunks.join('');
    const output = truncateTerminalOutput(joined);
    void this.safePublish({
      type: 'terminalCommand',
      processId: sessionId,
      cmd: active.cmd,
      output,
      phase: 'end',
    });
  }

  private clearFinishTimer(active: ActiveCommand): void {
    if (active.finishTimer != null) {
      this.clearTimeoutFn(active.finishTimer);
      active.finishTimer = null;
    }
  }

  private async safePublish(
    event: Extract<RawHostEvent, { type: 'terminalCommand' }>,
  ): Promise<void> {
    try {
      await this.publishImpl(event);
    } catch (error) {
      log.error('Failed to publish terminalCommand event', {
        processId: event.processId,
        phase: event.phase,
        error,
      });
    }
  }
}
