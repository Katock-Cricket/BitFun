import { describe, expect, it } from 'vitest';
import { mapMonacoContentChanges, mapMonacoSelection } from './monacoChanges';

describe('mapMonacoContentChanges', () => {
  it('maps Monaco 1-based ranges to 0-based TextChange', () => {
    const changes = mapMonacoContentChanges([
      {
        range: {
          startLineNumber: 2,
          startColumn: 3,
          endLineNumber: 2,
          endColumn: 5,
        },
        rangeOffset: 10,
        rangeLength: 2,
        text: 'xy',
      },
    ]);

    expect(changes).toEqual([
      {
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 4 },
        },
        rangeOffset: 10,
        rangeLength: 2,
        text: 'xy',
      },
    ]);
  });
});

describe('mapMonacoSelection', () => {
  it('marks collapsed selection as cursor', () => {
    const mapped = mapMonacoSelection(
      {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      },
      { lineNumber: 1, column: 1 },
    );
    expect(mapped.kind).toBe('cursor');
    expect(mapped.active).toEqual({ line: 0, character: 0 });
  });

  it('marks non-empty range as select', () => {
    const mapped = mapMonacoSelection(
      {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 4,
      },
      { lineNumber: 1, column: 4 },
    );
    expect(mapped.kind).toBe('select');
    expect(mapped.selections[0]).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 3 },
    });
  });
});
