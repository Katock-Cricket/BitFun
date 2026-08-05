import { RawHostEvent } from '../domain/raw-events';
import { LogItem } from '../domain/log-item';
import { LogStore } from '../log/log-store';
import { LanguageIntelPort } from '../ports/language-intel-port';
import { DocumentPort } from '../ports/document-port';
import { getLogItemsFromChangedText, getLogItemFromSelectedText } from '../log/context-process';
import { getLogItemFromChangeTextDocument, getLogItemFromRenameFile, isFileSkipped } from '../log/file-process';
import { getLogItemFromTerminalExecute } from '../log/terminal-process';
import { RepoMap } from '../repomap/repo-map';
import { Position } from '../domain/geometry';

export interface ForeshadowUpdater {
  updateByLog(logs: LogItem[]): void;
  updateByCursor(uriFsPath: string, position: Position, lineCount: number): Promise<void>;
}

export class EventIngress {
  constructor(
    private readonly logStore: LogStore,
    private readonly languageIntel: LanguageIntelPort,
    private readonly documents: DocumentPort,
    private readonly repoMap: RepoMap,
    private readonly foreshadow: ForeshadowUpdater,
  ) {}

  async publish(event: RawHostEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'textChanged': {
          if (isFileSkipped(event.uri.fsPath)) return;
          const doc = this.documents.getOpenDocument(event.uri) || (await this.documents.openDocument(event.uri));
          const lineCount =
            doc?.lineCount ??
            event.afterText?.split(/\r?\n/).length ??
            event.beforeText?.split(/\r?\n/).length ??
            0;
          const items = await getLogItemsFromChangedText(
            this.languageIntel,
            event.uri,
            lineCount,
            event.beforeText,
            event.changes ?? [],
            event.afterText,
          );
          if (items.length > 0) {
            this.logStore.add(items);
            this.foreshadow.updateByLog(this.logStore.getAll());
          }
          break;
        }
        case 'selectionChanged': {
          if (isFileSkipped(event.uri.fsPath)) return;
          const doc = this.documents.getOpenDocument(event.uri) || (await this.documents.openDocument(event.uri));
          if (!doc) return;
          // soft-rel observe
          this.repoMap.observeCursorMove(doc, event.active.line);
          // cursor route always
          await this.foreshadow.updateByCursor(event.uri.fsPath, event.active, doc.lineCount);
          // select log only when real selection
          const kind = event.kind ?? (this.isEmptySelection(event.selections) ? 'cursor' : 'select');
          if (kind === 'select' && event.selections.length > 0) {
            const sel = event.selections[0];
            const text = doc.getText(sel);
            if (text && text.length > 0) {
              const item = await getLogItemFromSelectedText(
                this.languageIntel,
                event.uri,
                text,
                sel.start,
                sel.end,
                doc.lineCount,
              );
              this.logStore.add(item);
              this.foreshadow.updateByLog(this.logStore.getAll());
            }
          }
          break;
        }
        case 'activeEditorChanged': {
          if (event.uri && !isFileSkipped(event.uri.fsPath)) {
            this.logStore.add(getLogItemFromChangeTextDocument(event.uri.fsPath));
            this.foreshadow.updateByLog(this.logStore.getAll());
          }
          break;
        }
        case 'fileRenamed': {
          if (isFileSkipped(event.newUri.fsPath) && isFileSkipped(event.oldUri.fsPath)) return;
          this.logStore.add(getLogItemFromRenameFile(event.oldUri.fsPath, event.newUri.fsPath));
          this.foreshadow.updateByLog(this.logStore.getAll());
          break;
        }
        case 'terminalCommand': {
          if (event.phase === 'end') {
            const item = getLogItemFromTerminalExecute(event.processId, event.cmd, event.output);
            this.logStore.add(item);
            this.foreshadow.updateByLog(this.logStore.getAll());
          }
          break;
        }
      }
    } catch (e) {
      console.error('EventIngress.publish failed', e);
    }
  }

  private isEmptySelection(selections: Array<{ start: Position; end: Position }>): boolean {
    if (!selections || selections.length === 0) return true;
    const s = selections[0];
    return s.start.line === s.end.line && s.start.character === s.end.character;
  }
}
