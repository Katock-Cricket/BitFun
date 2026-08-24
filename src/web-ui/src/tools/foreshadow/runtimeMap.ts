/**
 * Per-workspace Foreshadow Runtime map with host gate checks.
 *
 * Gates (SPEC D10/D12/D13):
 * - no workspace → NO_WORKSPACE
 * - remote workspace / peer mode → REMOTE_UNSUPPORTED
 *
 * The runtime is always-on: no user setting or authorization is required.
 */
import {
  FoundationRuntime,
  type RawHostEvent,
} from '@foreshadow/core';
import { homeDir, join } from '@tauri-apps/api/path';
import { createLogger } from '@/shared/utils/logger';
import { isRemoteWorkspace, type WorkspaceInfo } from '@/shared/types';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { ForeshadowConfig } from '@/infrastructure/config/types';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { createBitfunFoundationPorts } from './ports/hostPorts';
import {
  FORESHADOW_DATA_DIR_NAME,
  type ForeshadowRuntimeStatus,
  type ForeshadowUnavailableCode,
} from './types';

const log = createLogger('ForeshadowRuntimeMap');

const DEFAULT_FORESHADOW_CONFIG: ForeshadowConfig = {
  enabled: true,
  task_recognize: true,
  task_model: null,
};

export function normalizeForeshadowConfig(
  config: Partial<ForeshadowConfig> | null | undefined,
): ForeshadowConfig {
  return {
    ...DEFAULT_FORESHADOW_CONFIG,
    ...(config ?? {}),
    enabled: Boolean(config?.enabled),
    task_recognize: config?.task_recognize ?? DEFAULT_FORESHADOW_CONFIG.task_recognize,
    task_model: config?.task_model ?? null,
  };
}

function joinDataDir(workspaceRoot: string): string {
  const sep = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/';
  return `${workspaceRoot.replace(/[\\/]+$/, '')}${sep}${FORESHADOW_DATA_DIR_NAME}`;
}

function buildDataDir(workspaceRoot: string, homeDir?: string | null): string {
  if (homeDir) {
    const lastSeg = workspaceRoot.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'untitled';
    const sep = homeDir.includes('\\') && !homeDir.includes('/') ? '\\' : '/';
    return `${homeDir.replace(/[\\/]+$/, '')}${sep}${FORESHADOW_DATA_DIR_NAME}${sep}${lastSeg}`;
  }
  return joinDataDir(workspaceRoot);
}

export function evaluateForeshadowGate(options: {
  workspace: WorkspaceInfo | null;
  config: ForeshadowConfig;
  peerModeActive?: boolean;
  homeDir?: string | null;
}): ForeshadowRuntimeStatus {
  const { workspace } = options;
  const peerModeActive = options.peerModeActive ?? isPeerDeviceModeActive();

  if (!workspace?.rootPath) {
    return {
      kind: 'unavailable',
      code: 'NO_WORKSPACE',
      message: 'No active workspace',
    };
  }

  if (peerModeActive || isRemoteWorkspace(workspace)) {
    return {
      kind: 'unavailable',
      code: 'REMOTE_UNSUPPORTED',
      message: 'Foreshadow is unavailable for remote or peer workspaces',
    };
  }

  return {
    kind: 'ready',
    workspaceKey: workspace.id || workspace.rootPath,
    workspacePath: workspace.rootPath,
    dataDir: buildDataDir(workspace.rootPath, options.homeDir),
  };
}

interface RuntimeEntry {
  workspaceKey: string;
  workspacePath: string;
  dataDir: string;
  runtime: FoundationRuntime;
}

class ForeshadowRuntimeMap {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private config: ForeshadowConfig = DEFAULT_FORESHADOW_CONFIG;
  private configListeners = new Set<() => void>();
  private started = false;
  private unsubscribers: Array<() => void> = [];
  private bitfunHomeDir: string | null = null;

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    try {
      this.bitfunHomeDir = await join(await homeDir(), '.bitfun');
    } catch (error) {
      log.warn('Failed to resolve BitFun home directory; falling back to workspace-relative storage', { error });
    }

    try {
      const loaded = await configManager.getConfig<Partial<ForeshadowConfig>>('foreshadow');
      this.config = normalizeForeshadowConfig(loaded);
    } catch (error) {
      log.warn('Failed to load foreshadow config; using defaults', { error });
      this.config = DEFAULT_FORESHADOW_CONFIG;
    }

    this.unsubscribers.push(
      configManager.onConfigChange((path) => {
        if (path === 'foreshadow' || path.startsWith('foreshadow.')) {
          void this.reloadConfig();
        }
      }),
    );

    this.unsubscribers.push(
      workspaceManager.addEventListener((event) => {
        if (
          event.type === 'workspace:opened' ||
          event.type === 'workspace:switched' ||
          event.type === 'workspace:active-changed' ||
          event.type === 'workspace:closed' ||
          event.type === 'workspace:removed'
        ) {
          void this.syncActiveWorkspace();
        }
      }),
    );

    await this.syncActiveWorkspace();

    // Capture bridge is independent of gate state; publish() still no-ops when gated.
    try {
      const { initializeForeshadowCaptureBridge } = await import('./capture');
      await initializeForeshadowCaptureBridge();
    } catch (error) {
      log.error('Failed to start foreshadow capture bridge', { error });
    }

    // MCP/tool request bridge is started eagerly from App.tsx on mount (not
    // here) so the `agentic://foreshadow-get-context` listener is registered
    // as early as possible — before the deferred startup gate completes. This
    // prevents foreshadow_get_context tool calls from timing out (15s) when the
    // agent invokes the tool before deferred foreshadow initialization finishes.
    // The bridge replies with NO_WORKSPACE / NOT_READY when the runtime map is
    // not ready yet, which is a fast structured error instead of a silent hang.

    log.info('Foreshadow runtime map started', {
      enabled: this.config.enabled,
      runtimeCount: this.runtimes.size,
    });
  }

  stop(): void {
    void import('./contextBridge')
      .then(({ stopForeshadowContextBridge }) => {
        stopForeshadowContextBridge();
      })
      .catch((error) => {
        log.warn('Failed to stop foreshadow context bridge', { error });
      });

    void import('./capture')
      .then(({ foreshadowCaptureBridge }) => {
        foreshadowCaptureBridge.stop();
      })
      .catch((error) => {
        log.warn('Failed to stop foreshadow capture bridge', { error });
      });

    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch (error) {
        log.warn('Failed to unsubscribe foreshadow listener', { error });
      }
    }
    this.unsubscribers = [];

    for (const entry of this.runtimes.values()) {
      try {
        entry.runtime.dispose();
      } catch (error) {
        log.warn('Failed to dispose foreshadow runtime', {
          workspaceKey: entry.workspaceKey,
          error,
        });
      }
    }
    this.runtimes.clear();
    this.started = false;
  }

  getConfig(): ForeshadowConfig {
    return this.config;
  }

  getStatus(workspace?: WorkspaceInfo | null): ForeshadowRuntimeStatus {
    const resolved =
      workspace === undefined ? workspaceManager.getState().currentWorkspace : workspace;
    return evaluateForeshadowGate({
      workspace: resolved,
      config: this.config,
      homeDir: this.bitfunHomeDir,
    });
  }

  getActiveRuntime(): FoundationRuntime | null {
    const status = this.getStatus();
    if (status.kind !== 'ready') {
      return null;
    }
    return this.runtimes.get(status.workspaceKey)?.runtime ?? null;
  }

  getRuntimeByWorkspaceKey(workspaceKey: string): FoundationRuntime | null {
    return this.runtimes.get(workspaceKey)?.runtime ?? null;
  }

  /**
   * Publish a host event to the active workspace runtime when capture is allowed.
   * Silently no-ops when gated off.
   */
  async publish(event: RawHostEvent): Promise<boolean> {
    const runtime = this.getActiveRuntime();
    if (!runtime) {
      return false;
    }
    try {
      await runtime.publish(event);
      return true;
    } catch (error) {
      log.error('Failed to publish foreshadow host event', {
        type: (event as { type?: string }).type,
        error,
      });
      return false;
    }
  }

  getSnapshot():
    | { ok: true; workspacePath: string; snapshot: ReturnType<FoundationRuntime['getSnapshot']> }
    | { ok: false; code: ForeshadowUnavailableCode; message: string } {
    const status = this.getStatus();
    if (status.kind !== 'ready') {
      return { ok: false, code: status.code, message: status.message };
    }
    const entry = this.runtimes.get(status.workspaceKey);
    if (!entry) {
      return {
        ok: false,
        code: 'NOT_READY',
        message: 'Foreshadow runtime is not ready for the active workspace',
      };
    }
    return {
      ok: true,
      workspacePath: entry.workspacePath,
      snapshot: entry.runtime.getSnapshot(),
    };
  }

  /**
   * Get the real Foreshadow data directory for a workspace.
   * Uses BitFun home (~/.bitfun) when available, falling back to workspace-relative.
   */
  getDataDir(workspace?: WorkspaceInfo | null): string | null {
    const resolved =
      workspace === undefined ? workspaceManager.getState().currentWorkspace : workspace;
    if (!resolved?.rootPath) {
      return null;
    }
    return buildDataDir(resolved.rootPath, this.bitfunHomeDir);
  }

  private async reloadConfig(): Promise<void> {
    try {
      const loaded = await configManager.getConfig<Partial<ForeshadowConfig>>('foreshadow');
      this.config = normalizeForeshadowConfig(loaded);
      this.emitConfigChange();
      await this.syncActiveWorkspace();
      log.info('Foreshadow config reloaded', { enabled: this.config.enabled });
    } catch (error) {
      log.error('Failed to reload foreshadow config', { error });
    }
  }

  private emitConfigChange(): void {
    for (const listener of this.configListeners) {
      try {
        listener();
      } catch (error) {
        log.warn('Foreshadow config listener failed', { error });
      }
    }
  }

  private subscribeConfig(listener: () => void): () => void {
    this.configListeners.add(listener);
    return () => {
      this.configListeners.delete(listener);
    };
  }

  private async syncActiveWorkspace(): Promise<void> {
    const workspace = workspaceManager.getState().currentWorkspace;
    const status = evaluateForeshadowGate({
      workspace,
      config: this.config,
      homeDir: this.bitfunHomeDir,
    });

    if (status.kind !== 'ready') {
      // Tear down all runtimes when capture is not allowed for the active context.
      // Multi-workspace isolation still applies while enabled; closed workspaces are dropped.
      this.disposeAllExcept(new Set());
      log.debug('Foreshadow gate closed', { code: status.code, message: status.message });
      return;
    }

    this.ensureRuntime(status.workspaceKey, status.workspacePath, status.dataDir);

    // Keep only the active workspace runtime in P1 (multi-open isolation can retain more later).
    this.disposeAllExcept(new Set([status.workspaceKey]));
  }

  private ensureRuntime(workspaceKey: string, workspacePath: string, dataDir: string): void {
    const existing = this.runtimes.get(workspaceKey);
    if (existing && existing.workspacePath === workspacePath) {
      return;
    }
    if (existing) {
      existing.runtime.dispose();
      this.runtimes.delete(workspaceKey);
    }

    try {
      const ports = createBitfunFoundationPorts({
        workspaceRoot: workspacePath,
        homeDir: this.bitfunHomeDir ?? undefined,
        getConfig: () => this.config,
        subscribeConfig: (listener) => this.subscribeConfig(listener),
      });
      const runtime = new FoundationRuntime(ports);
      runtime.start();
      this.runtimes.set(workspaceKey, {
        workspaceKey,
        workspacePath,
        dataDir,
        runtime,
      });
      log.info('Foreshadow runtime created', { workspaceKey, dataDir });
    } catch (error) {
      log.error('Failed to create foreshadow runtime', { workspaceKey, error });
    }
  }

  private disposeAllExcept(keep: Set<string>): void {
    for (const [key, entry] of this.runtimes.entries()) {
      if (keep.has(key)) continue;
      try {
        entry.runtime.dispose();
      } catch (error) {
        log.warn('Failed to dispose foreshadow runtime', { workspaceKey: key, error });
      }
      this.runtimes.delete(key);
    }
  }
}

export const foreshadowRuntimeMap = new ForeshadowRuntimeMap();

export async function initializeForeshadowRuntimeMap(): Promise<void> {
  await foreshadowRuntimeMap.start();
}
