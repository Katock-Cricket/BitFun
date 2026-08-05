import { describe, expect, it } from 'vitest';
import { hasConfiguredAiModel, resolveForeshadowTaskModelId } from './modelResolve';

describe('resolveForeshadowTaskModelId', () => {
  it('uses explicit model id when set', () => {
    expect(
      resolveForeshadowTaskModelId(
        { task_model: 'my-model' },
        { fast: 'fast-id', primary: 'primary-id' },
      ),
    ).toBe('my-model');
  });

  it('prefers fast then primary when task_model is empty', () => {
    expect(
      resolveForeshadowTaskModelId(
        { task_model: null },
        { fast: 'fast-id', primary: 'primary-id' },
      ),
    ).toBe('fast-id');
    expect(
      resolveForeshadowTaskModelId(
        { task_model: '' },
        { fast: null, primary: 'primary-id' },
      ),
    ).toBe('primary-id');
  });

  it('resolves alias tokens', () => {
    expect(
      resolveForeshadowTaskModelId(
        { task_model: 'fast' },
        { fast: null, primary: 'primary-id' },
      ),
    ).toBe('primary-id');
  });
});

describe('hasConfiguredAiModel', () => {
  it('requires enabled models', () => {
    expect(hasConfiguredAiModel({ models: [{ id: 'a', enabled: false }], defaults: { primary: 'a' } })).toBe(false);
    expect(hasConfiguredAiModel({ models: [{ id: 'a', enabled: true }], defaults: { primary: 'a' } })).toBe(true);
  });
});
