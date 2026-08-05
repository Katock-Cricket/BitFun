import type { RgMatch, RgOptions, RgResult } from '@foreshadow/core';
import type { FileSearchResult } from '@/infrastructure/api/service-api/tauri-commands';

/** Map BitFun content search hits into Foreshadow RgMatch rows. */
export function mapFileSearchResultsToRgMatches(results: FileSearchResult[]): RgMatch[] {
  const matches: RgMatch[] = [];
  for (const result of results) {
    if (result.matchType !== 'content') {
      continue;
    }
    matches.push({
      file: result.path,
      line: result.lineNumber ?? 1,
      column: 1,
      content: result.matchedContent
        ?? [result.previewBefore, result.previewInside, result.previewAfter]
          .filter((part) => typeof part === 'string' && part.length > 0)
          .join('')
        ?? '',
    });
  }
  return matches;
}

export function emptySearchResult(error?: string): RgResult {
  return {
    success: !error,
    matches: [],
    ...(error ? { error } : {}),
  };
}

/** Derive WorkspaceAPI search flags from Foreshadow RgOptions. */
export function toWorkspaceSearchFlags(options: RgOptions): {
  caseSensitive: boolean;
  wholeWord: boolean;
  maxResults: number;
} {
  const caseSensitive = options.ignoreCase === true
    ? false
    : options.smartCase === true
      ? hasUpperCase(options.query)
      : options.ignoreCase === false;
  return {
    caseSensitive,
    wholeWord: options.wordMatch === true,
    maxResults: options.maxResults ?? 20,
  };
}

function hasUpperCase(query: string): boolean {
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch !== ch.toLowerCase() && ch === ch.toUpperCase()) {
      return true;
    }
  }
  return false;
}
