/**
 * BitFun FileSystemPort over WorkspaceAPI.
 *
 * exists() is sync in the Port contract (VS Code uses existsSync). SoftRelationMap
 * relies on exists before readFile. Uncached paths return true so loaders attempt
 * readFile; missing files resolve to empty content without failing runtime start.
 */
import type { FileSystemPort } from '@foreshadow/core';
import { createLogger } from '@/shared/utils/logger';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { normalizeFsPath } from '../capture/uri';

const log = createLogger('ForeshadowFileSystemPort');

function parentDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) {
    return filePath;
  }
  // Preserve Windows drive root style when original used backslashes.
  const parent = normalized.slice(0, idx);
  if (filePath.includes('\\') && !filePath.includes('/')) {
    return parent.replace(/\//g, '\\');
  }
  return parent;
}

export function createFileSystemPort(): FileSystemPort {
  const existence = new Map<string, boolean>();

  const keyOf = (p: string) => normalizeFsPath(p);

  return {
    exists(path: string): boolean {
      const key = keyOf(path);
      if (existence.has(key)) {
        return existence.get(key) === true;
      }
      // Optimistic default: allow SoftRelationMap/load paths to attempt readFile.
      return true;
    },

    async readFile(path: string): Promise<string> {
      const key = keyOf(path);
      try {
        const content = await workspaceAPI.readFileContent(path);
        existence.set(key, true);
        return content;
      } catch (error) {
        existence.set(key, false);
        log.debug('readFile failed; treating as empty', { path, error });
        return '';
      }
    },

    async writeFile(path: string, content: string): Promise<void> {
      const key = keyOf(path);
      try {
        await this.mkdirp(parentDir(path));
        await workspaceAPI.writeFile(path, content);
        existence.set(key, true);
      } catch (error) {
        log.error('writeFile failed', { path, error });
        throw error;
      }
    },

    async mkdirp(path: string): Promise<void> {
      if (!path) {
        return;
      }
      const key = keyOf(path);
      try {
        await workspaceAPI.createDirectory(path);
        existence.set(key, true);
      } catch (error) {
        // Directory may already exist; probe metadata as a soft success.
        try {
          const meta = await workspaceAPI.getFileMetadata(path);
          if (meta.isDir || meta.isFile) {
            existence.set(key, true);
            return;
          }
        } catch {
          // fall through
        }
        log.debug('mkdirp soft-failed', { path, error });
      }
    },
  };
}
