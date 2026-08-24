import { describe, expect, it } from 'vitest';
import { sanitizeTerminalOutput } from './sanitizeTerminalOutput';

describe('sanitizeTerminalOutput', () => {
  it('returns empty input unchanged', () => {
    expect(sanitizeTerminalOutput('')).toBe('');
  });

  it('keeps plain text and newlines untouched', () => {
    expect(sanitizeTerminalOutput('hello\nworld\n')).toBe('hello\nworld\n');
  });

  it('applies backspaces like a terminal (typo correction)', () => {
    expect(sanitizeTerminalOutput('abc\bd')).toBe('abd');
    // c → backspace → "" then "cd"; trailing backspace drops the "d".
    expect(sanitizeTerminalOutput('c\bcd\b')).toBe('c');
  });

  it('does not go negative on leading backspaces', () => {
    expect(sanitizeTerminalOutput('\b\bhello')).toBe('hello');
  });

  it('strips ANSI color and cursor sequences', () => {
    expect(
      sanitizeTerminalOutput('\u001B[31mERROR\u001B[0m: done\u001B[2K'),
    ).toBe('ERROR: done');
    expect(sanitizeTerminalOutput('\u001B[1;32mok\u001B[0m')).toBe('ok');
  });

  it('strips OSC sequences (both BEL and ST terminators)', () => {
    expect(
      sanitizeTerminalOutput('\u001B]0;window title\u0007body'),
    ).toBe('body');
    expect(
      sanitizeTerminalOutput('\u001B]2;title\u001B\\body'),
    ).toBe('body');
  });

  it('collapses \\r\\n into one newline and maps standalone \\r to newline', () => {
    expect(sanitizeTerminalOutput('a\r\nb')).toBe('a\nb');
    expect(sanitizeTerminalOutput('a\rb')).toBe('a\nb');
  });

  it('keeps tabs but drops other C0 controls', () => {
    expect(sanitizeTerminalOutput('a\tb\u0007c\u000Cd')).toBe('a\tbcd');
  });

  it('preserves multibyte text (CJK, emoji)', () => {
    expect(sanitizeTerminalOutput('你好\u001B[0m😀')).toBe('你好😀');
  });

  it('handles the smoke-test backspace sample end to end', () => {
    const raw = 'PS C:\\> c\bcdcd cd fcd focd';
    const clean = sanitizeTerminalOutput(raw);
    expect(clean).not.toContain('\b');
    expect(clean).toContain('cdcd cd fcd focd');
  });
});
