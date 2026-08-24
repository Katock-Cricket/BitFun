/**
 * TipTap / Markdown after-only textChanged helpers (SPEC P4 / B14).
 *
 * Markdown has no fine-grained Monaco-style TextChange batches.
 * L2 accepts empty `changes` + optional `beforeText` / `afterText`.
 * The debouncer attaches the last known content as `beforeText` so L2 can record
 * a real file-level Edit; without a baseline L2 skips the Edit instead of
 * fabricating a whole-file diff from '' → afterText.
 */
import type { RawHostEvent } from '@foreshadow/core';
import { normalizeFsPath, toFsUri } from './uri';

/** Debounce keystrokes into one Edit-friendly event (SPEC 300–800ms). */
export const FORESHADOW_MARKDOWN_TEXT_DEBOUNCE_MS = 400;

/**
 * Build a Foreshadow textChanged event for Markdown full-document updates.
 * `beforeText` is the last known content (omitted for the first observed edit).
 */
export function buildMarkdownAfterOnlyTextChanged(
  filePath: string,
  afterText: string,
  beforeText?: string,
): Extract<RawHostEvent, { type: 'textChanged' }> {
  return {
    type: 'textChanged',
    uri: toFsUri(filePath),
    changes: [],
    beforeText,
    afterText,
  };
}

export type MarkdownDebouncePublish = (
  event: Extract<RawHostEvent, { type: 'textChanged' }>,
) => void | Promise<void>;

/** Timer handle shared by DOM (`number`) and Node (`NodeJS.Timeout`) hosts. */
export type ForeshadowTimerHandle = ReturnType<typeof setTimeout>;

/**
 * Narrow timer function contracts. Do NOT type these as `typeof setTimeout`:
 * Node's `setTimeout` overloads carry `__promisify__`, which plain function
 * fallbacks cannot satisfy, and the parameters would fall back to implicit `any`.
 */
export type ForeshadowSetTimeoutFn = (
  handler: () => void,
  timeout?: number,
) => ForeshadowTimerHandle;

export type ForeshadowClearTimeoutFn = (handle: ForeshadowTimerHandle) => void;

export type MarkdownTextChangedDebouncerOptions = {
  publish: MarkdownDebouncePublish;
  debounceMs?: number;
  setTimeoutFn?: ForeshadowSetTimeoutFn;
  clearTimeoutFn?: ForeshadowClearTimeoutFn;
};

/**
 * Per-file debounce for Markdown after-only textChanged events.
 * Coalesces rapid TipTap/textarea updates into a single publish.
 */
export class MarkdownTextChangedDebouncer {
  private readonly publishImpl: MarkdownDebouncePublish;
  private readonly debounceMs: number;
  private readonly setTimeoutFn: ForeshadowSetTimeoutFn;
  private readonly clearTimeoutFn: ForeshadowClearTimeoutFn;
  private readonly timers = new Map<string, ForeshadowTimerHandle>();
  private readonly pending = new Map<string, { filePath: string; afterText: string }>();
  /**
   * Last known content per normalized path. Doubles as the no-op dedupe cache and
   * as the `beforeText` baseline for the next published Edit.
   */
  private readonly lastPublished = new Map<string, string>();

  constructor(options: MarkdownTextChangedDebouncerOptions) {
    this.publishImpl = options.publish;
    this.debounceMs = options.debounceMs ?? FORESHADOW_MARKDOWN_TEXT_DEBOUNCE_MS;
    // Never store bare `window.setTimeout` / `clearTimeout` references: calling them as
    // free functions can throw `TypeError: Illegal invocation` in browser/webview hosts.
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((handler, timeout) => globalThis.setTimeout(handler, timeout));
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => {
        globalThis.clearTimeout(handle);
      });
  }

  notify(filePath: string, afterText: string): void {
    if (!filePath.trim()) {
      return;
    }
    const key = normalizeFsPath(filePath);

    const existing = this.timers.get(key);
    if (existing) {
      this.clearTimeoutFn(existing);
      this.timers.delete(key);
    }

    // Content unchanged since the last publish (cursor/selection churn, undo back
    // to the saved state, external re-sync): do not fabricate an Edit event.
    if (this.lastPublished.get(key) === afterText) {
      this.pending.delete(key);
      return;
    }

    this.pending.set(key, { filePath, afterText });

    if (this.debounceMs <= 0) {
      this.flushKey(key);
      return;
    }

    this.timers.set(
      key,
      this.setTimeoutFn(() => {
        this.timers.delete(key);
        this.flushKey(key);
      }, this.debounceMs),
    );
  }

  /** Flush all pending files immediately (e.g. on stop). */
  flushAll(): void {
    const keys = [...this.pending.keys()];
    for (const key of keys) {
      const timer = this.timers.get(key);
      if (timer) {
        this.clearTimeoutFn(timer);
        this.timers.delete(key);
      }
      this.flushKey(key);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      this.clearTimeoutFn(timer);
    }
    this.timers.clear();
    this.pending.clear();
    this.lastPublished.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Record the current content of a file as the `beforeText` baseline, e.g. when
   * the editor loads or reloads content from disk. Any pending debounced edit for
   * the path is discarded because it was computed against the replaced content.
   */
  seedBaseline(filePath: string, content: string): void {
    if (!filePath.trim()) {
      return;
    }
    const key = normalizeFsPath(filePath);
    const timer = this.timers.get(key);
    if (timer) {
      this.clearTimeoutFn(timer);
      this.timers.delete(key);
    }
    this.pending.delete(key);
    this.lastPublished.set(key, content);
  }

  private flushKey(key: string): void {
    const item = this.pending.get(key);
    if (!item) {
      return;
    }
    this.pending.delete(key);
    // Snapshot the baseline before overwriting it with the new content.
    const beforeText = this.lastPublished.get(key);
    this.lastPublished.set(key, item.afterText);
    void this.publishImpl(
      buildMarkdownAfterOnlyTextChanged(item.filePath, item.afterText, beforeText),
    );
  }
}
