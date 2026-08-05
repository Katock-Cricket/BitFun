import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import {
  ConfigPageLoading,
  IconButton,
  Select,
  Switch,
  type SelectOption,
} from '@/component-library';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { isRemoteWorkspace } from '@/shared/types';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import {
  FORESHADOW_DATA_DIR_NAME,
  FORESHADOW_MCP_TOOL_NAME,
  foreshadowRuntimeMap,
  normalizeForeshadowConfig,
  type ForeshadowRuntimeStatus,
} from '@/tools/foreshadow';
import { configManager } from '../services/ConfigManager';
import { getModelDisplayName } from '../services/modelConfigs';
import type { AIModelConfig, ForeshadowConfig as ForeshadowConfigShape } from '../types';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection,
} from './common';

const log = createLogger('ForeshadowConfig');

const DEFAULT_FORESHADOW_CONFIG: ForeshadowConfigShape = {
  enabled: false,
  task_recognize: true,
  task_model: null,
};

function normalizeSelectValue(value: string | number | (string | number)[]): string {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved == null ? '' : String(resolved);
}

function joinDataDir(workspaceRoot: string): string {
  const sep = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/';
  return `${workspaceRoot.replace(/[\\/]+$/, '')}${sep}${FORESHADOW_DATA_DIR_NAME}`;
}

const ForeshadowConfig: React.FC = () => {
  const { t } = useTranslation('settings/foreshadow');
  const { error: notifyError, success: notifySuccess } = useNotification();
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<ForeshadowConfigShape>(DEFAULT_FORESHADOW_CONFIG);
  const [models, setModels] = useState<AIModelConfig[]>([]);
  const [savingKey, setSavingKey] = useState<keyof ForeshadowConfigShape | null>(null);
  const [actionBusy, setActionBusy] = useState<'reset-settings' | null>(null);
  const [status, setStatus] = useState<ForeshadowRuntimeStatus>(() => foreshadowRuntimeMap.getStatus());

  const refreshStatus = useCallback(() => {
    setStatus(foreshadowRuntimeMap.getStatus());
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [loadedConfig, loadedModels] = await Promise.all([
        configManager.getConfig<Partial<ForeshadowConfigShape>>('foreshadow'),
        configManager.getConfig<AIModelConfig[]>('ai.models'),
      ]);
      setConfig(normalizeForeshadowConfig(loadedConfig));
      setModels(Array.isArray(loadedModels) ? loadedModels : []);
      refreshStatus();
    } catch (error) {
      log.error('Failed to load foreshadow config', error);
      notifyError(error instanceof Error ? error.message : t('messages.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [notifyError, refreshStatus, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const unsubscribeConfig = configManager.onConfigChange((path) => {
      if (path === 'foreshadow' || path.startsWith('foreshadow.')) {
        refreshStatus();
      }
    });
    const unsubscribeWorkspace = workspaceManager.addEventListener((event) => {
      if (
        event.type === 'workspace:opened' ||
        event.type === 'workspace:switched' ||
        event.type === 'workspace:active-changed' ||
        event.type === 'workspace:closed' ||
        event.type === 'workspace:removed'
      ) {
        refreshStatus();
      }
    });
    return () => {
      unsubscribeConfig();
      unsubscribeWorkspace();
    };
  }, [refreshStatus]);

  const enabledModels = useMemo(() => models.filter((model) => model.enabled && model.id), [models]);

  const modelOptions = useMemo<SelectOption[]>(() => [
    { value: '', label: t('models.followDefault') },
    { value: 'primary', label: t('models.primary') },
    { value: 'fast', label: t('models.fast') },
    ...enabledModels.map((model) => ({
      value: model.id as string,
      label: getModelDisplayName(model),
    })),
  ], [enabledModels, t]);

  const workspace = workspaceManager.getState().currentWorkspace;
  const dataDir = workspace?.rootPath ? joinDataDir(workspace.rootPath) : null;
  const remoteOrPeer = Boolean(
    isPeerDeviceModeActive() || (workspace ? isRemoteWorkspace(workspace) : false),
  );

  const statusLabel = useMemo(() => {
    if (status.kind === 'ready') {
      return t('status.ready');
    }
    switch (status.code) {
      case 'NO_WORKSPACE':
        return t('status.noWorkspace');
      case 'REMOTE_UNSUPPORTED':
        return t('status.remoteUnsupported');
      case 'NOT_AUTHORIZED':
        return t('status.notAuthorized');
      case 'NOT_READY':
        return t('status.notReady');
      default:
        return t('status.internalError');
    }
  }, [status, t]);

  const updateConfig = useCallback(async <K extends keyof ForeshadowConfigShape>(
    key: K,
    value: ForeshadowConfigShape[K],
  ) => {
    const previous = config;
    const next = {
      ...config,
      [key]: value,
    };
    setSavingKey(key);
    setConfig(next);
    try {
      await configManager.setConfig('foreshadow', next);
      notifySuccess(t('messages.saved'));
      refreshStatus();
    } catch (error) {
      log.error('Failed to save foreshadow config', { key, error });
      setConfig(previous);
      notifyError(error instanceof Error ? error.message : t('messages.saveFailed'));
    } finally {
      setSavingKey(null);
    }
  }, [config, notifyError, notifySuccess, refreshStatus, t]);

  const handleResetSettings = useCallback(async () => {
    setActionBusy('reset-settings');
    try {
      await configManager.resetConfig('foreshadow');
      await loadData();
      notifySuccess(t('messages.settingsReset'));
    } catch (error) {
      log.error('Failed to reset foreshadow settings', error);
      notifyError(error instanceof Error ? error.message : t('messages.settingsResetFailed'));
    } finally {
      setActionBusy(null);
    }
  }, [loadData, notifyError, notifySuccess, t]);

  if (loading) {
    return (
      <ConfigPageLayout>
        <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />
        <ConfigPageContent>
          <ConfigPageLoading text={t('messages.loading')} />
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  const captureDisabled = !config.enabled;

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        extra={(
          <IconButton
            type="button"
            variant="ghost"
            size="small"
            onClick={() => void handleResetSettings()}
            isLoading={actionBusy === 'reset-settings'}
            disabled={actionBusy !== null}
            tooltip={t('actions.resetSettings')}
            tooltipPlacement="bottom"
            aria-label={t('actions.resetSettings')}
          >
            <RotateCcw />
          </IconButton>
        )}
      />
      <ConfigPageContent>
        <ConfigPageSection title={t('sections.capture.title')} description={t('sections.capture.description')}>
          <ConfigPageRow
            label={t('fields.enabled.label')}
            description={t('fields.enabled.description')}
            align="center"
          >
            <Switch
              checked={config.enabled}
              onChange={(event) => void updateConfig('enabled', event.target.checked)}
              disabled={savingKey === 'enabled' || remoteOrPeer}
              size="small"
            />
          </ConfigPageRow>

          {remoteOrPeer && (
            <ConfigPageRow
              label={t('fields.remoteNotice.label')}
              description={t('fields.remoteNotice.description')}
            >
              <span />
            </ConfigPageRow>
          )}

          <ConfigPageRow
            label={t('fields.status.label')}
            description={statusLabel}
          >
            <span data-testid="foreshadow-runtime-status">
              {status.kind === 'ready' ? t('status.badgeReady') : t('status.badgeUnavailable')}
            </span>
          </ConfigPageRow>

          <ConfigPageRow
            label={t('fields.dataDir.label')}
            description={dataDir ?? t('fields.dataDir.noWorkspace')}
          >
            <code>{FORESHADOW_DATA_DIR_NAME}</code>
          </ConfigPageRow>

          <ConfigPageRow
            label={t('fields.mcpTool.label')}
            description={t('fields.mcpTool.description')}
          >
            <code>{FORESHADOW_MCP_TOOL_NAME}</code>
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection title={t('sections.task.title')} description={t('sections.task.description')}>
          <ConfigPageRow
            label={t('fields.taskRecognize.label')}
            description={t('fields.taskRecognize.description')}
            align="center"
          >
            <Switch
              checked={config.task_recognize}
              onChange={(event) => void updateConfig('task_recognize', event.target.checked)}
              disabled={savingKey === 'task_recognize' || captureDisabled}
              size="small"
            />
          </ConfigPageRow>

          <ConfigPageRow
            label={t('fields.taskModel.label')}
            description={t('fields.taskModel.description')}
            align="center"
          >
            <Select
              value={config.task_model ?? ''}
              onChange={(value) => {
                const selector = normalizeSelectValue(value).trim();
                void updateConfig('task_model', selector ? selector : null);
              }}
              options={modelOptions}
              size="small"
              disabled={savingKey === 'task_model' || captureDisabled || !config.task_recognize}
            />
          </ConfigPageRow>
        </ConfigPageSection>
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default ForeshadowConfig;
