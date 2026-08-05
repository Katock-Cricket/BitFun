/**
 * BitFun WorkspaceSearchPort via workspace content search.
 * Failures return empty Keyword matches (SPEC Ports / B15 soft-fail style).
 */
import type { RgOptions, RgResult, WorkspacePort, WorkspaceSearchPort } from '@foreshadow/core';
import { createLogger } from '@/shared/utils/logger';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import {
  emptySearchResult,
  mapFileSearchResultsToRgMatches,
  toWorkspaceSearchFlags,
} from './searchMapping';

const log = createLogger('ForeshadowSearchPort');

export function createSearchPort(workspace: WorkspacePort): WorkspaceSearchPort {
  return {
    async search(options: RgOptions): Promise<RgResult> {
      const query = options.query?.trim();
      if (!query) {
        return emptySearchResult();
      }

      const rootPath =
        options.path
        || workspace.getPrimaryRoot()?.fsPath
        || workspace.getWorkspaceRoots()[0]?.fsPath;

      if (!rootPath) {
        return emptySearchResult('No workspace root for search');
      }

      const flags = toWorkspaceSearchFlags(options);

      try {
        // Prefer literal search for Keyword-style queries unless fixedStrings is explicitly false.
        const useRegex = options.fixedStrings === false;
        const response = await workspaceAPI.searchContentOnlyDetailed(
          rootPath,
          query,
          flags.caseSensitive,
          useRegex,
          flags.wholeWord,
          undefined,
          flags.maxResults,
        );
        return {
          success: true,
          matches: mapFileSearchResultsToRgMatches(response.results ?? []),
        };
      } catch (error) {
        log.warn('Workspace search failed; returning empty matches', { error });
        return emptySearchResult(
          error instanceof Error ? error.message : 'Workspace search failed',
        );
      }
    },
  };
}
