import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStatus = vi.fn();
const getSnapshot = vi.fn();

vi.mock('./runtimeMap', () => ({
  foreshadowRuntimeMap: {
    getStatus: (...args: unknown[]) => getStatus(...args),
    getSnapshot: (...args: unknown[]) => getSnapshot(...args),
  },
}));

import { buildForeshadowContextPayload } from './contextPayload';

describe('buildForeshadowContextPayload', () => {
  beforeEach(() => {
    getStatus.mockReset();
    getSnapshot.mockReset();
  });

  it('returns success shell with only the abstract from getSnapshot', () => {
    getSnapshot.mockReturnValue({
      ok: true,
      workspacePath: 'D:/ws',
      snapshot: {
        context: {
          history: [],
          cursor: null,
        },
        completeness: 0.3,
        logs: [{ event: 'edit' }],
        tasks: [],
        abstract: "#User's current task and intention\nedit a file",
      },
    });

    const payload = buildForeshadowContextPayload();
    expect(payload).toMatchObject({
      schemaVersion: 1,
      workspacePath: 'D:/ws',
      abstract: "#User's current task and intention\nedit a file",
    });
    expect('generatedAt' in payload && typeof payload.generatedAt).toBe('string');
    // Abstract-only contract: no raw context / logs / tasks leak into the payload.
    if (!('ok' in payload && payload.ok === false)) {
      expect(payload).not.toHaveProperty('context');
      expect(payload).not.toHaveProperty('logs');
      expect(payload).not.toHaveProperty('tasks');
      expect(payload).not.toHaveProperty('completeness');
    }
  });

  it('falls back to an empty abstract when snapshot has none', () => {
    getSnapshot.mockReturnValue({
      ok: true,
      workspacePath: 'D:/ws',
      snapshot: { context: { history: [] } },
    });

    const payload = buildForeshadowContextPayload();
    expect(payload).toMatchObject({
      schemaVersion: 1,
      workspacePath: 'D:/ws',
      abstract: '',
    });
  });

  it('propagates gate errors from getSnapshot', () => {
    getSnapshot.mockReturnValue({
      ok: false,
      code: 'NO_WORKSPACE',
      message: 'no active workspace',
    });

    expect(buildForeshadowContextPayload()).toEqual({
      ok: false,
      code: 'NO_WORKSPACE',
      message: 'no active workspace',
    });
  });

  it('rejects non-active workspacePath with NOT_READY', () => {
    getStatus.mockReturnValue({
      kind: 'ready',
      workspaceKey: 'ws-a',
      workspacePath: 'D:/ws-a',
      dataDir: 'D:/ws-a/.foreshadow',
    });

    expect(buildForeshadowContextPayload('D:/ws-b')).toEqual({
      ok: false,
      code: 'NOT_READY',
      message:
        'Foreshadow runtime is only available for the active workspace; requested workspace is not ready',
    });
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('accepts matching workspacePath with path separator normalization', () => {
    getStatus.mockReturnValue({
      kind: 'ready',
      workspaceKey: 'ws-a',
      workspacePath: 'D:\\ws-a',
      dataDir: 'D:\\ws-a\\.foreshadow',
    });
    getSnapshot.mockReturnValue({
      ok: true,
      workspacePath: 'D:\\ws-a',
      snapshot: { context: { ok: true }, abstract: 'abs-a' },
    });

    const payload = buildForeshadowContextPayload('D:/ws-a/');
    expect(payload).toMatchObject({
      schemaVersion: 1,
      workspacePath: 'D:\\ws-a',
      abstract: 'abs-a',
    });
  });
});
