/**
 * TipTap / Markdown after-only textChanged helpers (SPEC P4 / B14).
 *
 * Markdown has no fine-grained Monaco-style TextChange batches.
 * L2 accepts empty `changes` + optional `afterText`.
 */
import type { RawHostEvent } from '@foreshadow/core';
import { normalizeFsPath, toFsUri } from './uri';

/** Debounce keystrokes into one Edit-friendly event (SPEC 300–800ms). */
export const FORESHADOW_MARKDOWN_TEXT_DEBOUNCE_MS = 400;

/**
 * Build a Foreshadow textChanged event for Markdown full-document updates.
 */
export function buildMarkdownAfterOnlyTextChanged(
  filePath: string,
  afterText: string,
): Extract<RawHostEvent, { type: 'textChanged' }> {
  return {
    type: 'textChanged',
    uri: toFsUri(filePath),
    changes: [],
    afterText,
  };
}

export type MarkdownDebouncePublish = (
  event: Extract<RawHostEvent, { type: 'textChanged' }>,
) => void | Promise<void>;

export type MarkdownTextChangedDebouncerOptions = {
  publish: MarkdownDebouncePublish;
  debounceMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

/**
 * Per-file debounce for Markdown after-only textChanged events.
 * Coalesces rapid TipTap/textarea updates into a single publish.
 */
export class MarkdownTextChangedDebouncer {
  private readonly publishImpl: MarkdownDebouncePublish;
  private readonly debounceMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, { filePath: string; afterText: string }>();

  constructor(options: MarkdownTextChangedDebouncerOptions) {
    this.publishImpl = options.publish;
    this.debounceMs = options.debounceMs ?? FORESHADOW_MARKDOWN_TEXT_DEBOUNCE_MS;
    // Never store bare `window.setTimeout` / `clearTimeout` references: calling them as
    // free functions can throw `TypeError: Illegal invocation` in browser/webview hosts.
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((handler, timeout, ...args) =>
        globalThis.setTimeout(handler as never, timeout as never, ...(args as never[])));
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((id) => {
        globalThis.clearTimeout(id as never);
      });
  }

  notify(filePath: string, afterText: string): void {
    if (!filePath.trim()) {
      return;
    }
    const key = normalizeFsPath(filePath);
    this.pending.set(key, { filePath, afterText });

    const existing = this.timers.get(key);
    if (existing) {
      this.clearTimeoutFn(existing);
    }

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
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private flushKey(key: string): void {
    const item = this.pending.get(key);
    if (!item) {
      return;
    }
    this.pending.delete(key);
    void this.publishImpl(
      buildMarkdownAfterOnlyTextChanged(item.filePath, item.afterText),
    );
  }
}
