/**
 * Per-workspace Foreshadow Runtime map with host gate checks.
 *
 * Gates (SPEC D10/D12/D13/D14):
 * - no workspace → NO_WORKSPACE
 * - remote workspace / peer mode → REMOTE_UNSUPPORTED
 * - foreshadow.enabled !== true → NOT_AUTHORIZED
 */
import {
  FoundationRuntime,
  type RawHostEvent,
} from '@foreshadow/core';
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
  enabled: false,
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

export function evaluateForeshadowGate(options: {
  workspace: WorkspaceInfo | null;
  config: ForeshadowConfig;
  peerModeActive?: boolean;
}): ForeshadowRuntimeStatus {
  const { workspace, config } = options;
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

  if (!config.enabled) {
    return {
      kind: 'unavailable',
      code: 'NOT_AUTHORIZED',
      message: 'Foreshadow capture is disabled; enable it in Settings',
    };
  }

  return {
    kind: 'ready',
    workspaceKey: workspace.id || workspace.rootPath,
    workspacePath: workspace.rootPath,
    dataDir: joinDataDir(workspace.rootPath),
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

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

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

    // MCP/tool request bridge: always listen so gated/error payloads can be returned.
    try {
      const { startForeshadowContextBridge } = await import('./contextBridge');
      startForeshadowContextBridge();
    } catch (error) {
      log.error('Failed to start foreshadow context bridge', { error });
    }

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
