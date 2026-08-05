/**
 * Library entry for hosts that are not the VS Code extension shell
 * (e.g. BitFun). Does not import vscode.
 */

export { FoundationRuntime } from './foundation/runtime';
export type { FoundationPorts } from './foundation/runtime';

export type { RawHostEvent, TextChange } from './foundation/domain/raw-events';
export {
  makeUri,
  makePosition,
  makeRange,
  makeLocation,
  isSameFsPath,
} from './foundation/domain/geometry';
export type { FsUri, Position, Range, Location } from './foundation/domain/geometry';

export type {
  DocumentPort,
  TextDocumentSnapshot,
  LanguageIntelPort,
  WorkspaceSearchPort,
  RgOptions,
  RgMatch,
  RgResult,
  WorkspacePort,
  FileSystemPort,
  ConfigPort,
  SchedulerPort,
  LLMPort,
  LLMMessage,
  LLMToolCall,
  LLMToolDefinition,
  LLMChatResult,
  ContextQueryService,
} from './foundation/ports';

export {
  NoopLanguageIntelPort,
  noopLanguageIntelPort,
} from './foundation/ports/noop-language-intel-port';

export { Foreshadow } from './context/foreshadow';
export { EventIngress } from './foundation/ingress/event-ingress';
export type { ForeshadowUpdater } from './foundation/ingress/event-ingress';
