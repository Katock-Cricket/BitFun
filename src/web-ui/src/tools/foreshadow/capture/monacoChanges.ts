import type { TextChange } from '@foreshadow/core';
import { makePosition, makeRange } from '@foreshadow/core';

/** Minimal Monaco change shape used by capture (avoids hard coupling in tests). */
export interface MonacoLikeContentChange {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/**
 * Map Monaco 1-based ranges to Foreshadow 0-based TextChange list.
 */
export function mapMonacoContentChanges(
  changes: readonly MonacoLikeContentChange[],
): TextChange[] {
  return changes.map((change) => ({
    range: makeRange(
      makePosition(change.range.startLineNumber - 1, change.range.startColumn - 1),
      makePosition(change.range.endLineNumber - 1, change.range.endColumn - 1),
    ),
    rangeOffset: change.rangeOffset,
    rangeLength: change.rangeLength,
    text: change.text,
  }));
}

export function mapMonacoSelection(
  selection: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  },
  position: { lineNumber: number; column: number },
): {
  selections: ReturnType<typeof makeRange>[];
  active: ReturnType<typeof makePosition>;
  kind: 'select' | 'cursor';
} {
  const range = makeRange(
    makePosition(selection.startLineNumber - 1, selection.startColumn - 1),
    makePosition(selection.endLineNumber - 1, selection.endColumn - 1),
  );
  const isCursor =
    selection.startLineNumber === selection.endLineNumber &&
    selection.startColumn === selection.endColumn;
  return {
    selections: [range],
    active: makePosition(position.lineNumber - 1, position.column - 1),
    kind: isCursor ? 'cursor' : 'select',
  };
}
