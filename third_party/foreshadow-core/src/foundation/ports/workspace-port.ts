import { FsUri } from '../domain/geometry';

export interface WorkspacePort {
  getWorkspaceRoots(): FsUri[];
  getPrimaryRoot(): FsUri | undefined;
  resolvePath(...parts: string[]): string;
  getDataDir(): string;
  getExtensionPath(): string;
  isInWorkspace(fsPath: string): boolean;
}
