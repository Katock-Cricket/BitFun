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
    expect(event.uri.fsPath.replace(/\\/g, '/')).toContain('notes.md');
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
});
