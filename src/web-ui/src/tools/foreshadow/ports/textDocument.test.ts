import { describe, expect, it } from 'vitest';
import { makePosition, makeRange, makeUri } from '@foreshadow/core';
import { createTextDocumentSnapshot, extractRangeText } from './textDocument';

describe('createTextDocumentSnapshot', () => {
  it('exposes lineCount and lineAt', () => {
    const doc = createTextDocumentSnapshot(makeUri('D:/ws/a.ts'), 'alpha\nbeta\ngamma', 'typescript');
    expect(doc.lineCount).toBe(3);
    expect(doc.languageId).toBe('typescript');
    expect(doc.lineAt(1)).toBe('beta');
    expect(doc.getText()).toBe('alpha\nbeta\ngamma');
  });

  it('extracts multi-line range for read_code style calls', () => {
    const lines = ['one', 'two', 'three'];
    const text = extractRangeText(
      lines,
      makeRange(makePosition(0, 0), makePosition(1, Number.MAX_SAFE_INTEGER)),
    );
    expect(text).toBe('one\ntwo');
  });
});
