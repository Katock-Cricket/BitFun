/**
 * Shared Workspace/Config/Scheduler ports + optional stubs for tests.
 * Production runtime uses createBitfunFoundationPorts (hostPorts.ts).
 */
import type {
  ConfigPort,
  DocumentPort,
  FileSystemPort,
  FoundationPorts,
  FsUri,
  LLMPort,
  Range,
  SchedulerPort,
  TextDocumentSnapshot,
  WorkspacePort,
  WorkspaceSearchPort,
} from '@foreshadow/core';
import { makeUri, noopLanguageIntelPort } from '@foreshadow/core';
import type { ForeshadowConfig } from '@/infrastructure/config/types';
import { FORESHADOW_DATA_DIR_NAME } from '../types';

function joinPath(root: string, ...parts: string[]): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  let out = root.replace(/[\\/]+$/, '');
  for (const part of parts) {
    const cleaned = part.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    if (!cleaned) continue;
    out = `${out}${sep}${cleaned}`;
  }
  return out;
}

export function createStubDocumentPort(): DocumentPort {
  return {
    getOpenDocument() {
      return undefined;
    },
    async openDocument() {
      return undefined;
    },
    getActiveDocument() {
      return undefined;
    },
    async getText() {
      return '';
    },
  };
}

export function createWorkspacePort(workspaceRoot: string): WorkspacePort {
  const rootUri = makeUri(workspaceRoot);
  const dataDir = joinPath(workspaceRoot, FORESHADOW_DATA_DIR_NAME);
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').toLowerCase();

  return {
    getWorkspaceRoots(): FsUri[] {
      return [rootUri];
    },
    getPrimaryRoot(): FsUri | undefined {
      return rootUri;
    },
    resolvePath(...parts: string[]): string {
      return joinPath(workspaceRoot, ...parts);
    },
    getDataDir(): string {
      return dataDir;
    },
    getExtensionPath(): string {
      return workspaceRoot;
    },
    isInWorkspace(fsPath: string): boolean {
      const normalized = fsPath.replace(/\\/g, '/').toLowerCase();
      return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
    },
  };
}

export function createStubFileSystemPort(): FileSystemPort {
  const memory = new Map<string, string>();

  return {
    exists(path: string): boolean {
      return memory.has(path);
    },
    async readFile(path: string): Promise<string> {
      return memory.get(path) ?? '';
    },
    async writeFile(path: string, content: string): Promise<void> {
      memory.set(path, content);
    },
    async mkdirp(_path: string): Promise<void> {
      // no-op for in-memory stub
    },
  };
}

export function createConfigPort(
  getConfig: () => ForeshadowConfig,
  subscribe?: (listener: () => void) => () => void,
): ConfigPort {
  return {
    get<T = unknown>(key: string, defaultValue?: T): T {
      const config = getConfig();
      if (key === 'foreshadow.control.taskRecognize') {
        return (config.task_recognize as T) ?? (defaultValue as T);
      }
      if (key === 'foreshadow.control.enabled') {
        return (config.enabled as T) ?? (defaultValue as T);
      }
      if (key === 'foreshadow.control.taskModel') {
        return ((config.task_model ?? null) as T) ?? (defaultValue as T);
      }
      return defaultValue as T;
    },
    onDidChange(listener: () => void) {
      if (!subscribe) {
        return { dispose() {} };
      }
      const unsubscribe = subscribe(listener);
      return {
        dispose() {
          unsubscribe();
        },
      };
    },
  };
}

export function createSchedulerPort(): SchedulerPort {
  return {
    setInterval(handler: () => void, ms: number) {
      const id = globalThis.setInterval(handler, ms);
      return {
        dispose() {
          globalThis.clearInterval(id);
        },
      };
    },
    setTimeout(handler: () => void, ms: number) {
      const id = globalThis.setTimeout(handler, ms);
      return {
        dispose() {
          globalThis.clearTimeout(id);
        },
      };
    },
  };
}

export function createStubSearchPort(): WorkspaceSearchPort {
  return {
    async search() {
      return { success: true, matches: [] };
    },
  };
}

export function createStubLlmPort(): LLMPort {
  return {
    isConfigured() {
      return false;
    },
    async chat() {
      return { content: '' };
    },
  };
}

export function createStubFoundationPorts(options: {
  workspaceRoot: string;
  getConfig: () => ForeshadowConfig;
  subscribeConfig?: (listener: () => void) => () => void;
}): FoundationPorts {
  return {
    documents: createStubDocumentPort(),
    languageIntel: noopLanguageIntelPort,
    workspace: createWorkspacePort(options.workspaceRoot),
    search: createStubSearchPort(),
    fs: createStubFileSystemPort(),
    config: createConfigPort(options.getConfig, options.subscribeConfig),
    scheduler: createSchedulerPort(),
    llm: createStubLlmPort(),
  };
}

/** Helper kept for future DocumentPort implementations. */
export function emptyTextDocument(uri: FsUri, languageId?: string): TextDocumentSnapshot {
  return {
    uri,
    fsPath: uri.fsPath,
    lineCount: 0,
    languageId,
    getText(_range?: Range) {
      return '';
    },
    lineAt() {
      return '';
    },
  };
}
