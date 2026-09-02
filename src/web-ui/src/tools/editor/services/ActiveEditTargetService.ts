import type * as monaco from 'monaco-editor';
import { createLogger } from '@/shared/utils/logger';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';

const log = createLogger('ActiveEditTargetService');

export type MacosEditMenuMode = 'system' | 'renderer';
export type EditMenuAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';
export type EditTargetKind = 'monaco' | 'markdown-ir' | 'markdown-textarea' | 'markdown-preview';

export interface EditTarget {
  id: string;
  kind: EditTargetKind;
  focus: () => void;
  hasTextFocus: () => boolean;
  undo: () => boolean;
  redo: () => boolean;
  cut?: () => boolean;
  copy?: () => boolean;
  paste?: () => boolean;
  selectAll?: () => boolean;
  /** Monaco: open the in-editor find widget (Ctrl/Cmd+F). */
  findInEditor?: () => boolean;
  containsElement?: (element: Element | null) => boolean;
  /**
   * CREDIT（P1）：绑定的 Monaco editor 实例引用。
   * Bitfun 存在多个 monaco 副本，`monacoApi.editor.getEditors()` 恒为空、
   * `getActiveEditor()` 只返回内部集合第一个元素，导致外部无法枚举全部 tab 的 editor。
   * 此处在注册 EditTarget 时保留实例引用，供 CREDIT 采集桥全量挂载 scroll/selection。
   * 仅新增可选字段，不改变既有行为。
   */
  editor?: monaco.editor.IStandaloneCodeEditor;
  /**
   * CREDIT（B-012）：非 Monaco 编辑器实例（TipTap/MEditor）。
   * `getEditorType()` 把 `.md` 路由到 `markdown-editor`（TipTap 渲染），而采集桥
   * 事件源全部绑在 Monaco 上，导致 TipTap 打开的文件完全不可见 —— 无 fileOpened /
   * 无 scroll / 无 edit，SPEC 审阅行为整体丢失。此处仅新增可选字段，不改变既有行为。
   */
  tiptapEditor?: unknown;
  /**
   * CREDIT（B-012）：markdown **源码模式**的 textarea 元素（MEditor 的 textarea/split/source 模式）。
   * 实测 md 文件默认就是以 textarea 承载（`kind: 'markdown-textarea'`），
   * 页面里并不存在 ProseMirror —— 不暴露它，md 的阅读与编辑行为无从采集。
   */
  textarea?: unknown;
  /**
   * CREDIT（B-012）：**预览模式**的滚动容器元素（`.m-editor-preview`）。
   * 预览态是纯渲染（MarkdownRenderer），既无 textarea 也无 ProseMirror；而预览正是
   * md 的**默认模式** —— 不暴露容器，"打开就看"的阅读行为将全部丢失。
   */
  previewElement?: unknown;
  /**
   * CREDIT（B-012）：预览内容的**源码总行数**。
   * 预览是渲染后的 HTML，与源码行不是 1:1，只能按"滚动比例 × 总行数"估算阅读位置；
   * 没有总行数就无法换算成源码行区间。
   */
  previewLineCount?: number;
  /** CREDIT（B-012）：编辑器绑定的文件路径（用于标注事件 uri） */
  editorFilePath?: string;
}

const MENU_EVENT_ACTIONS: Array<{ eventName: string; action: EditMenuAction }> = [
  { eventName: 'bitfun_menu_edit_undo', action: 'undo' },
  { eventName: 'bitfun_menu_edit_redo', action: 'redo' },
  { eventName: 'bitfun_menu_edit_cut', action: 'cut' },
  { eventName: 'bitfun_menu_edit_copy', action: 'copy' },
  { eventName: 'bitfun_menu_edit_paste', action: 'paste' },
  { eventName: 'bitfun_menu_edit_select_all', action: 'selectAll' },
];

let monacoTargetCounter = 0;

function isMacOSDesktop(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const isTauri = '__TAURI__' in window;
  return isTauri && typeof navigator.platform === 'string' && navigator.platform.toUpperCase().includes('MAC');
}

function isEditableInput(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    return false;
  }

  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  const nonTextInputTypes = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ]);

  return !nonTextInputTypes.has((element.type || 'text').toLowerCase());
}

function isNativeTextInput(element: Element | null): element is HTMLElement {
  if (!element) {
    return false;
  }

  if (isEditableInput(element)) {
    return !element.readOnly && !element.disabled;
  }

  return element instanceof HTMLElement && element.isContentEditable;
}

function executeNativeEditActionOnElement(
  element: Element | null,
  action: EditMenuAction,
): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (!isNativeTextInput(element)) {
    return false;
  }

  element.focus();

  if (action === 'selectAll') {
    if (isEditableInput(element)) {
      element.select();
      return true;
    }

    return document.execCommand('selectAll');
  }

  const commandMap: Record<Exclude<EditMenuAction, 'selectAll'>, string> = {
    undo: 'undo',
    redo: 'redo',
    cut: 'cut',
    copy: 'copy',
    paste: 'paste',
  };

  return document.execCommand(commandMap[action]);
}

async function readClipboardText(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (error) {
    log.warn('Failed to read clipboard via navigator.clipboard', { error });
  }

  if (!isMacOSDesktop()) {
    return null;
  }

  try {
    return await systemAPI.getClipboard();
  } catch (error) {
    log.warn('Failed to read clipboard via system API', { error });
    return null;
  }
}

function insertTextIntoElement(element: Element | null, text: string): boolean {
  if (!text) {
    return false;
  }

  if (isEditableInput(element)) {
    if (element.readOnly || element.disabled) {
      return false;
    }

    element.focus();
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;

    element.setRangeText(text, start, end, 'end');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  if (!(element instanceof HTMLElement) || !element.isContentEditable) {
    return false;
  }

  element.focus();

  const selection = window.getSelection();
  if (!selection) {
    return false;
  }

  if (document.execCommand('insertText', false, text)) {
    return true;
  }

  if (selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function canPasteIntoElement(element: Element | null): boolean {
  if (isEditableInput(element)) {
    return !element.readOnly && !element.disabled;
  }

  return element instanceof HTMLElement && element.isContentEditable;
}

export function createMonacoEditTarget(editor: monaco.editor.IStandaloneCodeEditor): EditTarget {
  const id = `monaco-${++monacoTargetCounter}`;

  return {
    id,
    kind: 'monaco',
    // CREDIT（P1）：保留实例引用，供采集桥枚举所有 tab 的 editor
    editor,
    focus: () => {
      editor.focus();
    },
    hasTextFocus: () => editor.hasTextFocus(),
    undo: () => {
      editor.trigger('edit-target', 'undo', null);
      return true;
    },
    redo: () => {
      editor.trigger('edit-target', 'redo', null);
      return true;
    },
    cut: () => {
      editor.trigger('edit-target', 'editor.action.clipboardCutAction', null);
      return true;
    },
    copy: () => {
      editor.trigger('edit-target', 'editor.action.clipboardCopyAction', null);
      return true;
    },
    paste: () => {
      editor.trigger('edit-target', 'editor.action.clipboardPasteAction', null);
      return true;
    },
    selectAll: () => {
      editor.trigger('edit-target', 'editor.action.selectAll', null);
      return true;
    },
    findInEditor: () => {
      const findAction = editor.getAction('actions.find');
      if (findAction) {
        void findAction.run();
        return true;
      }
      editor.trigger('edit-target', 'editor.action.startFindWidget', null);
      return true;
    },
    containsElement: (element: Element | null) => {
      const domNode = editor.getDomNode();
      return !!domNode && !!element && domNode.contains(element);
    },
  };
}

export class ActiveEditTargetService {
  private activeTargetId: string | null = null;
  private targets = new Map<string, EditTarget>();
  private menuBridgePromise: Promise<void> | null = null;
  private lastRequestedMenuMode: MacosEditMenuMode | null = null;

  bindTarget(target: EditTarget): () => void {
    this.targets.set(target.id, target);
    void this.ensureMacOSMenuBridge();

    if (target.hasTextFocus()) {
      this.setActiveTarget(target.id);
    }

    return () => {
      this.unregisterTarget(target.id);
    };
  }

  setActiveTarget(targetId: string): void {
    if (!this.targets.has(targetId)) {
      return;
    }

    this.activeTargetId = targetId;
    void this.setMenuMode('renderer');
  }

  clearActiveTarget(targetId: string): void {
    if (this.activeTargetId !== targetId) {
      return;
    }

    this.activeTargetId = null;
    void this.setMenuMode('system');
  }

  /**
   * Open Monaco find in the currently focused code editor, if any.
   * Used by the editor shortcut scope (data-shortcut-scope="editor") via ShortcutManager.
   */
  openMonacoFind(): void {
    const focused = this.findFocusedTarget();
    if (focused?.findInEditor) {
      focused.findInEditor();
      return;
    }
    for (const target of this.targets.values()) {
      if (target.hasTextFocus() && target.findInEditor) {
        target.findInEditor();
        return;
      }
    }
  }

  executeAction(action: EditMenuAction): boolean {
    const focusedTarget = this.findFocusedTarget();
    if (focusedTarget) {
      focusedTarget.focus();

      if (action === 'paste') {
        const activeElement = document.activeElement;
        if (focusedTarget.containsElement?.(activeElement) && this.pasteIntoElement(activeElement)) {
          return true;
        }
      }

      if (this.dispatchToTarget(focusedTarget, action)) {
        return true;
      }

      if (action === 'cut' || action === 'copy' || action === 'selectAll') {
        const activeElement = document.activeElement;
        if (focusedTarget.containsElement?.(activeElement) && executeNativeEditActionOnElement(activeElement, action)) {
          return true;
        }
      }
    }

    const nativeElement = this.getFocusedNativeTextInput();
    if (action === 'paste' && this.pasteIntoElement(nativeElement)) {
      void this.setMenuMode('system');
      return true;
    }

    if (executeNativeEditActionOnElement(nativeElement, action)) {
      void this.setMenuMode('system');
      return true;
    }

    const target = this.getLastActiveTarget();
    if (target) {
      target.focus();

      if (action === 'paste') {
        const activeElement = document.activeElement;
        if (target.containsElement?.(activeElement) && this.pasteIntoElement(activeElement)) {
          return true;
        }
      }

      if (this.dispatchToTarget(target, action)) {
        return true;
      }

      if (action === 'cut' || action === 'copy' || action === 'selectAll') {
        const activeElement = document.activeElement;
        if (target.containsElement?.(activeElement) && executeNativeEditActionOnElement(activeElement, action)) {
          return true;
        }
      }
    }

    void this.setMenuMode(target ? 'renderer' : 'system');
    return false;
  }

  private pasteIntoElement(element: Element | null): boolean {
    if (!canPasteIntoElement(element)) {
      return false;
    }

    void (async () => {
      const text = await readClipboardText();
      if (!text) {
        return;
      }

      insertTextIntoElement(element, text);
    })();

    return true;
  }

  private dispatchToTarget(target: EditTarget, action: EditMenuAction): boolean {
    switch (action) {
      case 'undo':
        return target.undo();
      case 'redo':
        return target.redo();
      case 'cut':
        return target.cut?.() ?? false;
      case 'copy':
        return target.copy?.() ?? false;
      case 'paste':
        return target.paste?.() ?? false;
      case 'selectAll':
        return target.selectAll?.() ?? false;
      default:
        return false;
    }
  }

  private getLastActiveTarget(): EditTarget | null {
    if (!this.activeTargetId) {
      return null;
    }

    const target = this.targets.get(this.activeTargetId);
    if (!target) {
      this.activeTargetId = null;
      return null;
    }

    return target;
  }

  private findFocusedTarget(): EditTarget | null {
    const activeTarget = this.getLastActiveTarget();
    if (activeTarget?.hasTextFocus()) {
      return activeTarget;
    }

    for (const target of this.targets.values()) {
      if (!target.hasTextFocus()) {
        continue;
      }

      if (this.activeTargetId !== target.id) {
        this.activeTargetId = target.id;
        void this.setMenuMode('renderer');
      }

      return target;
    }

    return null;
  }

  private getFocusedNativeTextInput(): HTMLElement | null {
    if (typeof document === 'undefined') {
      return null;
    }

    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return null;
    }

    if (this.isInsideRegisteredTarget(activeElement)) {
      return null;
    }

    return isNativeTextInput(activeElement) ? activeElement : null;
  }

  private isInsideRegisteredTarget(element: Element | null): boolean {
    if (!element) {
      return false;
    }

    for (const target of this.targets.values()) {
      if (target.containsElement?.(element)) {
        return true;
      }
    }

    return false;
  }

  private unregisterTarget(targetId: string): void {
    this.targets.delete(targetId);

    if (this.activeTargetId === targetId) {
      this.activeTargetId = null;
      void this.setMenuMode('system');
    }
  }

  private async ensureMacOSMenuBridge(): Promise<void> {
    if (!isMacOSDesktop()) {
      return;
    }

    if (this.menuBridgePromise) {
      return this.menuBridgePromise;
    }

    this.menuBridgePromise = (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        await Promise.all(
          MENU_EVENT_ACTIONS.map(async ({ eventName, action }) =>
            listen(eventName, () => {
              this.executeAction(action);
            }),
          ),
        );
      } catch (error) {
        log.warn('Failed to initialize macOS edit menu bridge', { error });
        this.menuBridgePromise = null;
      }
    })();

    return this.menuBridgePromise;
  }

  private async setMenuMode(mode: MacosEditMenuMode): Promise<void> {
    if (!isMacOSDesktop()) {
      return;
    }

    if (this.lastRequestedMenuMode === mode) {
      return;
    }

    this.lastRequestedMenuMode = mode;

    try {
      await systemAPI.setMacosEditMenuMode(mode);
    } catch (error) {
      if (this.lastRequestedMenuMode === mode) {
        this.lastRequestedMenuMode = null;
      }
      log.warn('Failed to switch macOS edit menu mode', { mode, error });
    }
  }
}

export const activeEditTargetService = new ActiveEditTargetService();
