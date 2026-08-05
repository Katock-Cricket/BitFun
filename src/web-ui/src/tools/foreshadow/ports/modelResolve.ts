import type { DefaultModelsConfig, ForeshadowConfig } from '@/infrastructure/config/types';

/**
 * Resolve TaskRecognizer model selector.
 * SPEC D7: prefer configured task_model; otherwise fast → primary.
 */
export function resolveForeshadowTaskModelId(
  foreshadow: Pick<ForeshadowConfig, 'task_model'>,
  defaults?: Pick<DefaultModelsConfig, 'fast' | 'primary'> | null,
): string {
  const explicit = foreshadow.task_model?.trim();
  if (explicit) {
    if (explicit === 'fast' || explicit === 'primary') {
      return resolveAlias(explicit, defaults);
    }
    return explicit;
  }
  return resolveAlias('fast', defaults);
}

function resolveAlias(
  alias: 'fast' | 'primary',
  defaults?: Pick<DefaultModelsConfig, 'fast' | 'primary'> | null,
): string {
  if (alias === 'fast') {
    const fast = defaults?.fast?.trim();
    if (fast) {
      return fast;
    }
    const primary = defaults?.primary?.trim();
    if (primary) {
      return primary;
    }
    // Keep alias for backend get_client_resolved which also understands "fast".
    return 'fast';
  }
  const primary = defaults?.primary?.trim();
  return primary || 'primary';
}

export function hasConfiguredAiModel(options: {
  models?: Array<{ id?: string; enabled?: boolean }> | null;
  defaults?: Pick<DefaultModelsConfig, 'fast' | 'primary'> | null;
}): boolean {
  const models = options.models ?? [];
  const enabled = models.filter((m) => m.enabled !== false && !!m.id);
  if (enabled.length === 0) {
    return false;
  }
  const defaults = options.defaults;
  if (defaults?.fast || defaults?.primary) {
    return true;
  }
  return enabled.some((m) => !!m.id);
}
