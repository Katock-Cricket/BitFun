/**
 * BitFun DocumentPort: Monaco open buffers + canvas active tab + disk fallback.
 */
import type { DocumentPort, FsUri, Range, TextDocumentSnapshot } from '@foreshadow/core';
import { createLogger } from '@/shared/utils/logger';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import {
  useAgentCanvasStore,
  useGitCanvasStore,
  useProjectCanvasStore,
} from '@/app/components/panels/content-canvas/stores/canvasStore';
import { monacoModelManager } from '@/tools/editor/services/MonacoModelManager';
import {
  extractActiveFilePath,
  pickPreferredActiveFilePath,
  type CanvasActiveSlice,
} from '../capture/activeEditorPath';
import { normalizeFsPath, toFsUri } from '../capture/uri';
import { createTextDocumentSnapshot } from './textDocument';

const log = createLogger('ForeshadowDocumentPort');

function resolveFsPath(uri: FsUri | string): string {
  return typeof uri === 'string' ? uri : uri.fsPath;
}

function wrapMonacoModel(filePath: string): TextDocumentSnapshot | undefined {
  const model = monacoModelManager.getModel(filePath);
  if (!model) {
    return undefined;
  }
  const metadata = monacoModelManager.getModelMetadata(filePath);
  const resolvedPath = metadata?.filePath ?? filePath;
  const uri = toFsUri(resolvedPath);
  const text = model.getValue();
  return createTextDocumentSnapshot(uri, text, metadata?.languageId ?? model.getLanguageId());
}

function resolveActiveFilePath(): string | null {
  return pickPreferredActiveFilePath([
    extractActiveFilePath(useAgentCanvasStore.getState() as CanvasActiveSlice),
    extractActiveFilePath(useProjectCanvasStore.getState() as CanvasActiveSlice),
    extractActiveFilePath(useGitCanvasStore.getState() as CanvasActiveSlice),
  ]);
}

export function createDocumentPort(): DocumentPort {
  return {
    getOpenDocument(uri: FsUri | string): TextDocumentSnapshot | undefined {
      const fsPath = resolveFsPath(uri);
      return wrapMonacoModel(fsPath) ?? wrapMonacoModel(normalizeFsPath(fsPath));
    },

    async openDocument(uri: FsUri | string): Promise<TextDocumentSnapshot | undefined> {
      const fsPath = resolveFsPath(uri);
      const open = wrapMonacoModel(fsPath) ?? wrapMonacoModel(normalizeFsPath(fsPath));
      if (open) {
        return open;
      }

      try {
        const content = await workspaceAPI.readFileContent(fsPath);
        return createTextDocumentSnapshot(toFsUri(fsPath), content);
      } catch (error) {
        log.debug('openDocument disk fallback failed', { fsPath, error });
        return undefined;
      }
    },

    getActiveDocument(): TextDocumentSnapshot | undefined {
      const activePath = resolveActiveFilePath();
      if (!activePath) {
        return undefined;
      }
      return wrapMonacoModel(activePath) ?? createTextDocumentSnapshot(toFsUri(activePath), '');
    },

    async getText(uri: FsUri | string, range?: Range): Promise<string> {
      const doc = await this.openDocument(uri);
      if (!doc) {
        return '';
      }
      return doc.getText(range);
    },
  };
}
