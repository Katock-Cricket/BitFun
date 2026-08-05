import { isFileViewerType } from '@/app/components/panels/content-canvas/types';
import type { EditorGroupId, EditorGroupState } from '@/app/components/panels/content-canvas/types';

export interface CanvasActiveSlice {
  activeGroupId: EditorGroupId;
  primaryGroup: EditorGroupState;
  secondaryGroup: EditorGroupState;
  tertiaryGroup: EditorGroupState;
}

function getGroup(state: CanvasActiveSlice, groupId: EditorGroupId): EditorGroupState {
  if (groupId === 'primary') return state.primaryGroup;
  if (groupId === 'secondary') return state.secondaryGroup;
  return state.tertiaryGroup;
}

/**
 * Resolve the active file path from a canvas store slice.
 * Only file-viewer tabs contribute; terminal/session tabs return null.
 */
export function extractActiveFilePath(state: CanvasActiveSlice): string | null {
  const group = getGroup(state, state.activeGroupId);
  if (!group.activeTabId) {
    return null;
  }
  const tab = group.tabs.find((item) => item.id === group.activeTabId && !item.isHidden);
  if (!tab) {
    return null;
  }
  if (!isFileViewerType(tab.content.type)) {
    return null;
  }
  const filePath = tab.content.data?.filePath;
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return null;
  }
  return filePath;
}

/**
 * Prefer agent canvas, then project, then git (main file-editing surfaces).
 */
export function pickPreferredActiveFilePath(
  candidates: Array<string | null | undefined>,
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}
