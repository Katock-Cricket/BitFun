/**
 * Sanitize raw PTY output before it reaches the Foreshadow log store (B4 smoke fix).
 *
 * ConPTY/xterm streams deliver the literal byte stream the terminal renders,
 * including:
 * - ANSI escape sequences (colors, cursor movement, erase directives)
 * - backspace (`\b`) + typed echo, e.g. `c\bcd` meaning the user typed then corrected
 * - carriage returns (`\r`) from progress lines and prompts
 * - other C0 control bytes (bell, etc.)
 *
 * None of that is useful context for the agent. We fold the stream into the
 * text a human would actually see.
 */

/** Matches CSI sequences, OSC sequences, and the two-byte escapes we care about. */
const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\[[0-9;?]*[A-Za-z]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[()][0-9A-B]|[@-Z\\-_])/g;

/**
 * Fold a raw PTY chunk stream into human-readable text.
 *
 * - Strips ANSI/VT escape sequences.
 * - Applies backspaces (deletes the previous character, like a real terminal).
 * - Treats `\r\n` as a single newline; a standalone `\r` also becomes a newline
 *   (progress-line overwrite semantics are not worth modeling).
 * - Keeps `\n` and `\t`; drops all other C0/C1 control characters.
 */
export function sanitizeTerminalOutput(raw: string): string {
  if (!raw) {
    return '';
  }

  const withoutEscapes = raw.replace(ANSI_ESCAPE_PATTERN, '');

  let out = '';
  for (let i = 0; i < withoutEscapes.length; i++) {
    const ch = withoutEscapes[i];
    const code = withoutEscapes.charCodeAt(i);

    if (ch === '\b' || code === 0x7f) {
      // Backspace / DEL: erase the previous visible character.
      if (out.length > 0) {
        out = out.slice(0, -1);
      }
      continue;
    }

    if (ch === '\r') {
      // `\r\n` collapses to one newline; standalone `\r` ends the line too.
      if (withoutEscapes[i + 1] === '\n') {
        i++;
      }
      out += '\n';
      continue;
    }

    if (ch === '\n' || ch === '\t') {
      out += ch;
      continue;
    }

    // Drop remaining C0 controls (bell, form feed, vertical tab, ...) and
    // lone C1 bytes, keep everything printable including multibyte text.
    if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) {
      continue;
    }

    out += ch;
  }

  return out;
}
