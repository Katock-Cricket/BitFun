/**
 * Real BitFun FoundationPorts assembly (P5).
 * Replaces createStubFoundationPorts for Document/FS/Search/LLM while reusing
 * Workspace/Config/Scheduler + No-op LanguageIntel.
 */
import type { FoundationPorts } from '@foreshadow/core';
import { noopLanguageIntelPort } from '@foreshadow/core';
import type { ForeshadowConfig } from '@/infrastructure/config/types';
import { createDocumentPort } from './documentPort';
import { createFileSystemPort } from './fileSystemPort';
import { createLlmPort } from './llmPort';
import { createSearchPort } from './searchPort';
import {
  createConfigPort,
  createSchedulerPort,
  createWorkspacePort,
} from './stubPorts';

export function createBitfunFoundationPorts(options: {
  workspaceRoot: string;
  getConfig: () => ForeshadowConfig;
  subscribeConfig?: (listener: () => void) => () => void;
}): FoundationPorts {
  const workspace = createWorkspacePort(options.workspaceRoot);
  const config = createConfigPort(options.getConfig, options.subscribeConfig);

  return {
    documents: createDocumentPort(),
    languageIntel: noopLanguageIntelPort,
    workspace,
    search: createSearchPort(workspace),
    fs: createFileSystemPort(),
    config,
    scheduler: createSchedulerPort(),
    llm: createLlmPort({
      getConfig: options.getConfig,
      configPort: config,
    }),
  };
}
