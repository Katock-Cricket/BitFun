import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FORESHADOW_MARKDOWN_TEXT_DEBOUNCE_MS,
  MarkdownTextChangedDebouncer,
  buildMarkdownAfterOnlyTextChanged,
} from './markdownTextChanged';

describe('buildMarkdownAfterOnlyTextChanged', () => {
  it('builds after-only textChanged with empty changes', () => {
    const event = buildMarkdownAfterOnlyTextChanged('D:/ws/notes.md', '# Hello');
    expect(event.type).toBe('textChanged');
    expect(event.changes).toEqual([]);
    expect(event.afterText).toBe('# Hello');
    expect(event.beforeText).toBeUndefined();
    expect(event.uri.fsPath.replace(/\\/g, '/')).toContain('notes.md');
  });

  it('includes the before baseline when provided', () => {
    const event = buildMarkdownAfterOnlyTextChanged('D:/ws/notes.md', '# New', '# Old');
    expect(event.beforeText).toBe('# Old');
    expect(event.afterText).toBe('# New');
  });
});

describe('MarkdownTextChangedDebouncer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid updates into one publish', () => {
    vi.useFakeTimers();
    const published: Array<{ afterText?: string }> = [];
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: FORESHADOW_MARKDOWN_TEXT_DEBOUNCE_MS,
    });

    debouncer.notify('D:/ws/a.md', 'a');
    debouncer.notify('D:/ws/a.md', 'ab');
    debouncer.notify('D:/ws/a.md', 'abc');

    expect(published).toHaveLength(0);
    vi.advanceTimersByTime(FORESHADOW_MARKDOWN_TEXT_DEBOUNCE_MS);
    expect(published).toHaveLength(1);
    expect(published[0]?.afterText).toBe('abc');
  });

  it('isolates debounce buckets per file path', () => {
    vi.useFakeTimers();
    const published: Array<{ afterText?: string; uri: string }> = [];
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: 100,
    });

    debouncer.notify('D:/ws/a.md', 'A');
    debouncer.notify('D:/ws/b.md', 'B');
    vi.advanceTimersByTime(100);

    expect(published).toHaveLength(2);
    const texts = published.map((e) => e.afterText).sort();
    expect(texts).toEqual(['A', 'B']);
  });

  it('flushAll publishes immediately without waiting for timer', () => {
    vi.useFakeTimers();
    const published: Array<{ afterText?: string }> = [];
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: 500,
    });

    debouncer.notify('D:/ws/a.md', 'pending');
    debouncer.flushAll();
    expect(published).toEqual([
      expect.objectContaining({ afterText: 'pending' }),
    ]);
  });

  it('skips empty file paths', () => {
    const published: unknown[] = [];
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: 0,
    });
    debouncer.notify('   ', 'x');
    expect(published).toHaveLength(0);
  });

  it('suppresses notify when content is unchanged since last publish', () => {
    vi.useFakeTimers();
    const published: Array<{ afterText?: string }> = [];
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: 100,
    });

    // Real edit → publishes once.
    debouncer.notify('D:/ws/a.md', 'v1');
    vi.advanceTimersByTime(100);
    expect(published).toHaveLength(1);

    // Identical content re-notified (cursor churn / undo back to saved state).
    debouncer.notify('D:/ws/a.md', 'v1');
    vi.advanceTimersByTime(100);
    expect(published).toHaveLength(1);

    // Genuinely new content still publishes.
    debouncer.notify('D:/ws/a.md', 'v2');
    vi.advanceTimersByTime(100);
    expect(published).toHaveLength(2);
    expect(published[1]?.afterText).toBe('v2');
  });

  it('does not suppress after dispose clears the dedupe cache', () => {
    vi.useFakeTimers();
    const published: Array<{ afterText?: string }> = [];
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: 0,
    });

    debouncer.notify('D:/ws/a.md', 'v1');
    expect(published).toHaveLength(1);
    debouncer.dispose();
    debouncer.notify('D:/ws/a.md', 'v1');
    expect(published).toHaveLength(2);
  });

  it('does not throw Illegal invocation when using default timers', () => {
    vi.useFakeTimers();
    const published: Array<{ afterText?: string }> = [];
    // No custom setTimeoutFn/clearTimeoutFn — exercises the globalThis-bound defaults.
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: 50,
    });

    expect(() => debouncer.notify('D:/ws/a.md', 'safe')).not.toThrow();
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    expect(published).toEqual([expect.objectContaining({ afterText: 'safe' })]);
  });

  it('omits beforeText on the first publish, then carries the previous content', () => {
    vi.useFakeTimers();
    const published: Array<{ afterText?: string; beforeText?: string }> = [];
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: 100,
    });

    debouncer.notify('D:/ws/a.md', 'v1');
    vi.advanceTimersByTime(100);
    // First observed edit has no known baseline: L2 skips the Edit (no fabrication).
    expect(published[0]?.beforeText).toBeUndefined();

    debouncer.notify('D:/ws/a.md', 'v2');
    vi.advanceTimersByTime(100);
    // Second edit carries the real before/after diff.
    expect(published[1]?.beforeText).toBe('v1');
    expect(published[1]?.afterText).toBe('v2');
  });

  it('seedBaseline provides the before baseline for the next edit', () => {
    vi.useFakeTimers();
    const published: Array<{ afterText?: string; beforeText?: string }> = [];
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: 100,
    });

    debouncer.seedBaseline('D:/ws/a.md', 'disk-content');
    debouncer.notify('D:/ws/a.md', 'disk-content-edited');
    vi.advanceTimersByTime(100);

    expect(published).toHaveLength(1);
    expect(published[0]?.beforeText).toBe('disk-content');
    expect(published[0]?.afterText).toBe('disk-content-edited');
  });

  it('seedBaseline discards a pending edit computed against replaced content', () => {
    vi.useFakeTimers();
    const published: Array<{ afterText?: string; beforeText?: string }> = [];
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: 100,
    });

    debouncer.notify('D:/ws/a.md', 'stale-pending');
    // Disk reload replaces the content before the debounce timer fires.
    debouncer.seedBaseline('D:/ws/a.md', 'reloaded');
    vi.advanceTimersByTime(100);
    expect(published).toHaveLength(0);

    // Subsequent edit uses the reloaded content as its baseline.
    debouncer.notify('D:/ws/a.md', 'reloaded-v2');
    vi.advanceTimersByTime(100);
    expect(published).toHaveLength(1);
    expect(published[0]?.beforeText).toBe('reloaded');
  });

  it('seedBaseline ignores blank file paths', () => {
    const published: unknown[] = [];
    const debouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => {
        published.push(event);
      },
      debounceMs: 0,
    });
    expect(() => debouncer.seedBaseline('   ', 'x')).not.toThrow();
    expect(published).toHaveLength(0);
  });
});
