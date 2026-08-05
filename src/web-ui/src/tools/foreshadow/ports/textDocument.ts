import type { FsUri, Range, TextDocumentSnapshot } from '@foreshadow/core';

/**
 * Build a TextDocumentSnapshot from plain text.
 * Ranges are 0-based (Foreshadow geometry), matching TaskRecognizer read_code usage.
 */
export function createTextDocumentSnapshot(
  uri: FsUri,
  text: string,
  languageId?: string,
): TextDocumentSnapshot {
  const lines = text.split(/\r?\n/);

  return {
    uri,
    fsPath: uri.fsPath,
    lineCount: Math.max(lines.length, 1),
    languageId,
    getText(range?: Range) {
      if (!range) {
        return text;
      }
      return extractRangeText(lines, range);
    },
    lineAt(line: number) {
      if (line < 0 || line >= lines.length) {
        return '';
      }
      return lines[line] ?? '';
    },
  };
}

export function extractRangeText(lines: string[], range: Range): string {
  const startLine = Math.max(0, range.start.line);
  const endLine = Math.max(startLine, range.end.line);

  if (startLine >= lines.length) {
    return '';
  }

  const clampedEnd = Math.min(endLine, lines.length - 1);
  if (startLine === clampedEnd) {
    const line = lines[startLine] ?? '';
    const startChar = Math.max(0, range.start.character);
    const endChar = Math.min(line.length, Math.max(startChar, range.end.character));
    return line.slice(startChar, endChar);
  }

  const parts: string[] = [];
  for (let i = startLine; i <= clampedEnd; i++) {
    const line = lines[i] ?? '';
    if (i === startLine) {
      parts.push(line.slice(Math.max(0, range.start.character)));
    } else if (i === clampedEnd) {
      const endChar = Math.min(line.length, Math.max(0, range.end.character));
      // MAX_SAFE_INTEGER end character means "rest of line"
      parts.push(
        range.end.character >= Number.MAX_SAFE_INTEGER / 2 ? line : line.slice(0, endChar),
      );
    } else {
      parts.push(line);
    }
  }
  return parts.join('\n');
}
