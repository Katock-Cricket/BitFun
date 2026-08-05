import { describe, expect, it } from 'vitest';
import { mapFileSearchResultsToRgMatches, toWorkspaceSearchFlags } from './searchMapping';

describe('searchMapping', () => {
  it('maps content hits and ignores fileName matches', () => {
    const matches = mapFileSearchResultsToRgMatches([
      {
        path: 'a.ts',
        name: 'a.ts',
        isDirectory: false,
        matchType: 'fileName',
      },
      {
        path: 'b.ts',
        name: 'b.ts',
        isDirectory: false,
        matchType: 'content',
        lineNumber: 12,
        matchedContent: 'const x = 1',
      },
    ]);
    expect(matches).toEqual([
      {
        file: 'b.ts',
        line: 12,
        column: 1,
        content: 'const x = 1',
      },
    ]);
  });

  it('derives case sensitivity from ignoreCase / smartCase', () => {
    expect(toWorkspaceSearchFlags({ query: 'foo', ignoreCase: true }).caseSensitive).toBe(false);
    expect(toWorkspaceSearchFlags({ query: 'Foo', smartCase: true }).caseSensitive).toBe(true);
    expect(toWorkspaceSearchFlags({ query: 'foo', smartCase: true }).caseSensitive).toBe(false);
  });
});
