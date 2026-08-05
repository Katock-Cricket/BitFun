import { describe, expect, it } from 'vitest';
import { createEditorGroupState, createTab } from '@/app/components/panels/content-canvas/types';
import {
  extractActiveFilePath,
  pickPreferredActiveFilePath,
} from './activeEditorPath';

describe('extractActiveFilePath', () => {
  it('returns null when active tab is not a file viewer', () => {
    const terminalTab = createTab(
      {
        type: 'terminal',
        title: 'term',
        data: { sessionId: 's1' },
      },
      'active',
    );
    const group = createEditorGroupState();
    group.tabs = [terminalTab];
    group.activeTabId = terminalTab.id;

    expect(
      extractActiveFilePath({
        activeGroupId: 'primary',
        primaryGroup: group,
        secondaryGroup: createEditorGroupState(),
        tertiaryGroup: createEditorGroupState(),
      }),
    ).toBeNull();
  });

  it('returns filePath for active code-editor tab', () => {
    const codeTab = createTab(
      {
        type: 'code-editor',
        title: 'a.ts',
        data: { filePath: 'D:/ws/src/a.ts' },
      },
      'active',
    );
    const group = createEditorGroupState();
    group.tabs = [codeTab];
    group.activeTabId = codeTab.id;

    expect(
      extractActiveFilePath({
        activeGroupId: 'primary',
        primaryGroup: group,
        secondaryGroup: createEditorGroupState(),
        tertiaryGroup: createEditorGroupState(),
      }),
    ).toBe('D:/ws/src/a.ts');
  });
});

describe('pickPreferredActiveFilePath', () => {
  it('prefers the first non-empty candidate', () => {
    expect(pickPreferredActiveFilePath([null, '', 'a', 'b'])).toBe('a');
  });
});
