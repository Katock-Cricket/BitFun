import { describe, expect, it } from 'vitest';
import {
  FORESHADOW_TERMINAL_OUTPUT_HALF_CHARS,
  FORESHADOW_TERMINAL_OUTPUT_MAX_CHARS,
  FORESHADOW_TERMINAL_OUTPUT_TRUNCATION_MARKER,
  truncateTerminalOutput,
} from './truncateTerminalOutput';

describe('truncateTerminalOutput', () => {
  it('returns short output unchanged', () => {
    expect(truncateTerminalOutput('hello')).toBe('hello');
  });

  it('returns output at the max boundary unchanged', () => {
    const exact = 'a'.repeat(FORESHADOW_TERMINAL_OUTPUT_MAX_CHARS);
    expect(truncateTerminalOutput(exact)).toBe(exact);
  });

  it('keeps head 32KB + tail 32KB with SPEC marker when over budget', () => {
    const head = 'H'.repeat(FORESHADOW_TERMINAL_OUTPUT_HALF_CHARS);
    const middle = 'M'.repeat(10_000);
    const tail = 'T'.repeat(FORESHADOW_TERMINAL_OUTPUT_HALF_CHARS);
    const input = `${head}${middle}${tail}`;

    const rendered = truncateTerminalOutput(input);
    expect(rendered.startsWith(head)).toBe(true);
    expect(rendered.endsWith(tail)).toBe(true);
    expect(rendered).toContain(FORESHADOW_TERMINAL_OUTPUT_TRUNCATION_MARKER);
    expect(rendered).not.toContain('M');
    expect(rendered).toBe(
      `${head}${FORESHADOW_TERMINAL_OUTPUT_TRUNCATION_MARKER}${tail}`,
    );
  });

  it('uses UTF-16 code unit length (JS string length)', () => {
    // Each emoji is 2 UTF-16 code units.
    const emoji = '😀';
    const halfUnits = 4; // 2 emojis
    const max = halfUnits * 2; // 8 code units
    const input = emoji.repeat(6); // 12 code units
    const rendered = truncateTerminalOutput(input, max);
    expect(rendered.startsWith(emoji.repeat(2))).toBe(true);
    expect(rendered.endsWith(emoji.repeat(2))).toBe(true);
    expect(rendered).toContain(FORESHADOW_TERMINAL_OUTPUT_TRUNCATION_MARKER);
  });
});
