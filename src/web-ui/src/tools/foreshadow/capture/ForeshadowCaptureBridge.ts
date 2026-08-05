/**
 * Host-side activity capture for Foreshadow (P2–P4).
 *
 * Publishes RawHostEvent to RuntimeMap without modifying Monaco / TerminalService cores:
 * - textChanged / selectionChanged via EditorExtension hooks
 * - activeEditorChanged via canvas store subscriptions
 * - fileRenamed via FileSystemService.watchFileChanges
 * - terminalCommand via raw terminal_event correlator (bypasses TerminalService drop path)
 * - Markdown/TipTap after-only textChanged via notifyMarkdownTextChanged (empty changes)
 */
import * as monaco from 'monaco-editor';
import type { RawHostEvent } from '@foreshadow/core';
import { createLogger } from '@/shared/utils/logger';
import {
  useAgentCanvasStore,
  useGitCanvasStore,
  useProjectCanvasStore,
} from '@/app/components/panels/content-canvas/stores/canvasStore';
import {
  editorExtensionManager,
  type EditorExtension,
  type EditorExtensionContext,
} from '@/tools/editor/services/EditorExtensionManager';
import { ExtensionPriority } from '@/tools/editor/extensions/types';
import { monacoModelManager } from '@/tools/editor/services/MonacoModelManager';
import { fileSystemService } from '@/tools/file-system/services/FileSystemService';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { foreshadowRuntimeMap } from '../runtimeMap';
import {
  extractActiveFilePath,
  pickPreferredActiveFilePath,
  type CanvasActiveSlice,
} from './activeEditorPath';
import { mapMonacoContentChanges, mapMonacoSelection } from './monacoChanges';
import { MarkdownTextChangedDebouncer } from './markdownTextChanged';
import { TerminalCorrelator } from './TerminalCorrelator';
import { normalizeFsPath, toFsUri } from './uri';

const log = createLogger('ForeshadowCaptureBridge');

const SELECTION_DEBOUNCE_MS = 100;

type PublishFn = (event: RawHostEvent) => Promise<boolean>;

class ForeshadowCaptureBridge {
  private started = false;
  private unsubscribers: Array<() => void> = [];
  private lastActiveUriKey: string | null = null;
  private selectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private terminalCorrelator: TerminalCorrelator | null = null;
  private markdownDebouncer: MarkdownTextChangedDebouncer | null = null;
  private publishImpl: PublishFn = (event) => foreshadowRuntimeMap.publish(event);

  /** Test seam */
  setPublishImpl(publish: PublishFn): void {
    this.publishImpl = publish;
  }

  /**
   * TipTap / Markdown after-only textChanged (empty changes + afterText).
   * Safe to call when bridge is not started; events are dropped until start().
   */
  notifyMarkdownTextChanged(filePath: string | undefined | null, afterText: string): void {
    if (!filePath || !this.started || !this.markdownDebouncer) {
      return;
    }
    this.markdownDebouncer.notify(filePath, afterText);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    this.markdownDebouncer = new MarkdownTextChangedDebouncer({
      publish: (event) => this.publish(event),
    });
    this.registerEditorExtension();
    this.subscribeActiveEditor();
    this.subscribeWorkspaceRenameWatch();
    this.subscribeTerminalEvents();
    this.emitActiveEditorFromStores();

    log.info('Foreshadow capture bridge started');
  }

  stop(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch (error) {
        log.warn('Failed to unsubscribe foreshadow capture listener', { error });
      }
    }
    this.unsubscribers = [];

    if (this.terminalCorrelator) {
      this.terminalCorrelator.dispose();
      this.terminalCorrelator = null;
    }

    if (this.markdownDebouncer) {
      // Flush pending keystrokes so the last edit is not lost on stop.
      this.markdownDebouncer.flushAll();
      this.markdownDebouncer.dispose();
      this.markdownDebouncer = null;
    }

    for (const timer of this.selectionTimers.values()) {
      clearTimeout(timer);
    }
    this.selectionTimers.clear();
    this.lastActiveUriKey = null;
    this.started = false;
  }

  private async publish(event: RawHostEvent): Promise<void> {
    try {
      await this.publishImpl(event);
    } catch (error) {
      log.error('Failed to publish foreshadow capture event', {
        type: (event as { type?: string }).type,
        error,
      });
    }
  }

  private registerEditorExtension(): void {
    const extension: EditorExtension = {
      id: 'bitfun.foreshadow.capture',
      name: 'Foreshadow Capture',
      priority: ExtensionPriority.LOW,

      onEditorCreated: (editor, model, context) => {
        return this.bindEditor(editor, model, context);
      },

      onContentChanged: (_editor, model, event, context) => {
        void this.handleContentChanged(model, event, context);
      },
    };

    const unregister = editorExtensionManager.register(extension);
    this.unsubscribers.push(unregister);
  }

  private bindEditor(
    editor: monaco.editor.IStandaloneCodeEditor,
    model: monaco.editor.ITextModel,
    context: EditorExtensionContext,
  ): () => void {
    const filePath = context.filePath || this.resolveFilePath(model);
    if (!filePath) {
      return () => {};
    }

    const publishSelection = () => {
      const selection = editor.getSelection();
      const position = editor.getPosition();
      if (!selection || !position) {
        return;
      }
      const mapped = mapMonacoSelection(selection, position);
      const key = normalizeFsPath(filePath);
      const existing = this.selectionTimers.get(key);
      if (existing) {
        clearTimeout(existing);
      }
      this.selectionTimers.set(
        key,
        setTimeout(() => {
          this.selectionTimers.delete(key);
          void this.publish({
            type: 'selectionChanged',
            uri: toFsUri(filePath),
            selections: mapped.selections,
            active: mapped.active,
            kind: mapped.kind,
          });
        }, SELECTION_DEBOUNCE_MS),
      );
    };

    const selectionDisposable = editor.onDidChangeCursorSelection(() => {
      publishSelection();
    });

    // Initial selection for newly focused editors.
    publishSelection();

    return () => {
      selectionDisposable.dispose();
      const key = normalizeFsPath(filePath);
      const timer = this.selectionTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.selectionTimers.delete(key);
      }
    };
  }

  private async handleContentChanged(
    model: monaco.editor.ITextModel,
    event: monaco.editor.IModelContentChangedEvent,
    context: EditorExtensionContext,
  ): Promise<void> {
    const filePath = context.filePath || this.resolveFilePath(model);
    if (!filePath || !event.changes?.length) {
      return;
    }

    await this.publish({
      type: 'textChanged',
      uri: toFsUri(filePath),
      changes: mapMonacoContentChanges(event.changes),
      afterText: model.getValue(),
    });
  }

  private resolveFilePath(model: monaco.editor.ITextModel): string | null {
    const fsPath = model.uri.fsPath || model.uri.path;
    if (!fsPath) {
      return null;
    }
    const metadata = monacoModelManager.getModelMetadata(fsPath);
    return metadata?.filePath ?? fsPath;
  }

  private subscribeActiveEditor(): void {
    const onCanvasChange = () => {
      this.emitActiveEditorFromStores();
    };

    this.unsubscribers.push(useAgentCanvasStore.subscribe(onCanvasChange));
    this.unsubscribers.push(useProjectCanvasStore.subscribe(onCanvasChange));
    this.unsubscribers.push(useGitCanvasStore.subscribe(onCanvasChange));
  }

  private emitActiveEditorFromStores(): void {
    const agentPath = extractActiveFilePath(useAgentCanvasStore.getState() as CanvasActiveSlice);
    const projectPath = extractActiveFilePath(useProjectCanvasStore.getState() as CanvasActiveSlice);
    const gitPath = extractActiveFilePath(useGitCanvasStore.getState() as CanvasActiveSlice);
    const nextPath = pickPreferredActiveFilePath([agentPath, projectPath, gitPath]);
    const nextKey = nextPath ? normalizeFsPath(nextPath) : null;

    if (nextKey === this.lastActiveUriKey) {
      return;
    }

    const previousUri =
      this.lastActiveUriKey != null ? toFsUri(this.lastActiveUriKey) : undefined;
    this.lastActiveUriKey = nextKey;

    const nextUri = nextPath ? toFsUri(nextPath) : null;
    let lineCount: number | undefined;
    if (nextPath) {
      const model = monacoModelManager.getModel(nextPath);
      if (model) {
        lineCount = model.getLineCount();
      }
    }

    void this.publish({
      type: 'activeEditorChanged',
      uri: nextUri,
      previousUri,
      lineCount,
    });
  }

  private subscribeWorkspaceRenameWatch(): void {
    let currentUnwatch: (() => void) | null = null;

    const attach = (rootPath: string | null | undefined) => {
      if (currentUnwatch) {
        currentUnwatch();
        currentUnwatch = null;
      }
      if (!rootPath) {
        return;
      }

      currentUnwatch = fileSystemService.watchFileChanges(rootPath, (event) => {
        if (event.type !== 'renamed') {
          return;
        }
        const oldPath = event.oldPath;
        const newPath = event.path;
        if (!oldPath || !newPath) {
          return;
        }
        void this.publish({
          type: 'fileRenamed',
          oldUri: toFsUri(oldPath),
          newUri: toFsUri(newPath),
        });
      });
    };

    const workspace = workspaceManager.getState().currentWorkspace;
    attach(workspace?.rootPath);

    this.unsubscribers.push(
      workspaceManager.addEventListener((event) => {
        if (
          event.type === 'workspace:opened' ||
          event.type === 'workspace:switched' ||
          event.type === 'workspace:active-changed' ||
          event.type === 'workspace:closed' ||
          event.type === 'workspace:removed'
        ) {
          const current = workspaceManager.getState().currentWorkspace;
          attach(current?.rootPath);
          // Workspace switch may also change active editor identity.
          this.lastActiveUriKey = null;
          this.emitActiveEditorFromStores();
        }
      }),
    );

    this.unsubscribers.push(() => {
      if (currentUnwatch) {
        currentUnwatch();
        currentUnwatch = null;
      }
    });
  }

  /**
   * TerminalService drops CommandStarted/CommandFinished, so Foreshadow listens
   * to the raw `terminal_event` bus and correlates SI-backed commands only.
   */
  private subscribeTerminalEvents(): void {
    this.terminalCorrelator = new TerminalCorrelator({
      publish: (event) => this.publish(event),
    });

    try {
      const unlisten = api.listen('terminal_event', (payload) => {
        this.terminalCorrelator?.handleRawEvent(payload);
      });
      this.unsubscribers.push(() => {
        try {
          unlisten();
        } catch (error) {
          log.warn('Failed to unlisten terminal_event for foreshadow', { error });
        }
      });
    } catch (error) {
      log.warn('Failed to subscribe foreshadow terminal_event listener', { error });
    }
  }
}

export const foreshadowCaptureBridge = new ForeshadowCaptureBridge();

export async function initializeForeshadowCaptureBridge(): Promise<void> {
  await foreshadowCaptureBridge.start();
}
