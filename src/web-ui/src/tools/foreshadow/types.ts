/** Availability / gate codes used by RuntimeMap and (later) MCP. */
export type ForeshadowUnavailableCode =
  | 'NO_WORKSPACE'
  | 'REMOTE_UNSUPPORTED'
  | 'NOT_AUTHORIZED'
  | 'NOT_READY'
  | 'INTERNAL_ERROR';

export type ForeshadowRuntimeStatus =
  | { kind: 'ready'; workspaceKey: string; workspacePath: string; dataDir: string }
  | { kind: 'unavailable'; code: ForeshadowUnavailableCode; message: string };

export const FORESHADOW_DATA_DIR_NAME = '.foreshadow';
export const FORESHADOW_MCP_TOOL_NAME = 'foreshadow_get_context';
