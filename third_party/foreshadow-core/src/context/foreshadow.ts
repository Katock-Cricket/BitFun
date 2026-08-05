import { cursorContextSize, kwContextUpdateInterval, maxQuerykw } from '../foundation/config/constants';
import { mergeEditLogs } from '../foundation/log/edit-merge';
import { Artifact } from '../foundation/domain/artifact';
import {
  ArtifactContext,
  ArtifactContextItem,
  CursorContext,
} from '../foundation/domain/artifact-context';
import { EventType } from '../foundation/domain/event-types';
import { LogItem } from '../foundation/domain/log-item';
import { Task } from '../foundation/domain/task';
import {
  FsUri,
  Position,
  makeLocation,
  makePosition,
  makeRange,
  makeUri,
} from '../foundation/domain/geometry';
import { ContextQueryService } from '../foundation/ports/context-query';
import {
  Keyword,
  summonKeywordsFromCursorContext,
  summonKeywordsFromHistory,
} from '../foundation/kw/kw-summon';
import { sortKeywords } from '../foundation/kw/kw-sort';

const EventTypesCanAdd2History: EventType[] = [
  EventType.EditTextDocument,
  EventType.SelectText,
  EventType.ExecuteTerminalCommand,
];

/**
 * Foreshadow ??????L3?
 * ???CursorContext / AttentionZone / SoftRelContext / KeywordContext / LastArtifactContext / History / Task
 */
export class Foreshadow {
  private cursorContext: CursorContext | undefined = undefined;
  private lastArtifactContext: ArtifactContext[] | undefined = undefined;
  private task: Task | undefined = undefined;
  private history: LogItem[] | undefined = undefined;
  private softRelContext: ArtifactContextItem[] | undefined = undefined;
  private attentionZone: ArtifactContextItem[] | undefined = undefined;
  private keywordContext: ArtifactContextItem[] | undefined = undefined;
  private lastKeywordContextUpdateTime: number = 0;

  constructor(private readonly query: ContextQueryService) {}

  checkCompleteness(): number {
    let completeness = 1;
    if (!this.cursorContext || !this.cursorContext.codeSnippet) completeness -= 1;
    if (!this.attentionZone || this.attentionZone.length === 0) completeness -= 0.1;
    if (!this.softRelContext || this.softRelContext.length === 0) completeness -= 0.1;
    if (!this.lastArtifactContext || this.lastArtifactContext.length === 0) completeness -= 0.1;
    if (!this.history || this.history.length === 0) completeness -= 0.5;
    if (!this.task || !this.task.description) completeness -= 0.1;
    if (!this.keywordContext || this.keywordContext.length === 0) completeness -= 0.1;
    return completeness;
  }

  updateByTask(globTasks: Task[]) {
    if (!globTasks || globTasks.length === 0) return;
    this.task = globTasks[globTasks.length - 1];
  }

  updateByLog(globLogs: LogItem[]) {
    if (!globLogs || globLogs.length === 0) {
      console.warn('No logs provided to update history, keeping old history instead');
      return;
    }
    this.history = mergeEditLogs(globLogs)
      .filter(log => EventTypesCanAdd2History.includes(log.eventType))
      .slice(-5);

    let lastArtifact: Artifact | undefined = undefined;
    if (this.history && this.history.length > 0) {
      for (let i = this.history.length - 1; i >= 0; i--) {
        const log = this.history[i];
        if (!log.artifact || !log.artifact.location) continue;
        // terminal does not participate in lastArtifact
        if (log.eventType === EventType.ExecuteTerminalCommand) continue;
        lastArtifact = log.artifact;
        break;
      }
    }

    this.updateLastArtifactContext(lastArtifact).catch(error => {
      console.error('Failed to update last artifact context:', error);
    });
    this.updateSoftRelContext(lastArtifact).catch(error => {
      console.error('Failed to update soft rel context:', error);
    });
  }

  async updateByCursor(uriFsPath: string, cursorPosition: Position, _lineCount?: number) {
    const uri = makeUri(uriFsPath);
    const cursorContextLocation = makeLocation(uri, makeRange(cursorPosition, cursorPosition));
    const curCodeWindow = await this.query.getCodeSnippet(
      cursorContextLocation,
      true,
      cursorContextSize.upToLines,
      cursorContextSize.downToLines,
    );
    const doc = await this.query.getDocFromUri(uri);
    this.cursorContext = new CursorContext(
      cursorContextLocation,
      curCodeWindow,
      cursorContextSize.upToLines,
      cursorContextSize.downToLines,
      doc,
    );
    this.updateAttentionZone(uri, cursorPosition).catch(error => {
      console.error('Failed to update attention zone:', error);
    });
    this.updateKeywordContext().catch(error => {
      console.error('Failed to update keyword context:', error);
    });
  }

  toAbstract(): string {
    this.deduplicate();
    let abs = '';
    if (this.task) abs += `#User's current task and intention\n${this.task.toAbstract()}\n`;
    if (this.cursorContext) abs += `#User's current cursor context\n${this.cursorContext.toAbstract()}\n`;
    if (this.attentionZone && this.attentionZone.length > 0) {
      abs += `#User's attention zone\n${this.attentionZone.map(c => c.toAbstract()).join('\n')}\n`;
    }
    if (this.history && this.history.length > 0) {
      abs += `#User's recent edit history\n${this.history.map(log => log.toAbstract()).join('\n')}\n`;
    }
    if (this.softRelContext && this.softRelContext.length > 0) {
      abs += `#Relevant contexts\n${this.softRelContext.map(c => c.toAbstract()).join('\n')}\n`;
    }
    if (this.lastArtifactContext && this.lastArtifactContext.length > 0) {
      abs += `#User's recent edited artifact context\n${this.lastArtifactContext.map(c => c.toAbstract()).join('\n')}\n`;
    }
    if (this.keywordContext && this.keywordContext.length > 0) {
      abs += `#User's keyword context\n${this.keywordContext.map(c => c.toAbstract()).join('\n')}\n`;
    }
    return abs;
  }

  toJSONObject(): any {
    this.deduplicate();
    return {
      task: this.task?.toAbstract(),
      cursorContext: this.cursorContext?.toJSONObject(),
      attentionZone: this.attentionZone?.map(c => c.toJSONObject()),
      history: this.history?.map(log => log.toAbstract()).join('\n'),
      softRelContext: this.softRelContext?.map(c => c.toJSONObject()),
      lastArtifactContext: this.lastArtifactContext?.map(c => c.toJSONObject()),
      keywordContext: this.keywordContext?.map(c => c.toJSONObject()),
    };
  }

  getCursorContext(): CursorContext | undefined {
    return this.cursorContext;
  }

  clone(): Foreshadow {
    const cloned = new Foreshadow(this.query);
    if (this.cursorContext) {
      const cursorPos = this.cursorContext.getCursorPosition();
      const cursorLoc = makeLocation(
        this.cursorContext.loc.uri,
        makeRange(cursorPos, cursorPos),
      );
      cloned.cursorContext = new CursorContext(
        cursorLoc,
        this.cursorContext.codeSnippet,
        cursorContextSize.upToLines,
        cursorContextSize.downToLines,
        this.cursorContext.doc,
      );
    }
    if (this.lastArtifactContext) cloned.lastArtifactContext = [...this.lastArtifactContext];
    if (this.softRelContext) cloned.softRelContext = [...this.softRelContext];
    if (this.task) cloned.task = new Task(this.task.name, this.task.description, [...this.task.logs]);
    if (this.history) cloned.history = [...this.history];
    if (this.attentionZone) cloned.attentionZone = [...this.attentionZone];
    if (this.keywordContext) cloned.keywordContext = [...this.keywordContext];
    return cloned;
  }

  private async updateKeywordContext(): Promise<void> {
    const now = Date.now();
    if (now - this.lastKeywordContextUpdateTime < kwContextUpdateInterval) return;
    this.lastKeywordContextUpdateTime = now;
    if (!this.keywordContext) this.keywordContext = [];
    let keywords: Keyword[] = [];
    if (this.cursorContext) keywords.push(...summonKeywordsFromCursorContext(this.cursorContext));
    if (this.history) keywords.push(...summonKeywordsFromHistory(this.history));
    keywords = sortKeywords(keywords).slice(0, maxQuerykw);
    this.keywordContext = [];
    try {
      const searchResults = await Promise.all(keywords.map(kw => this.query.grepAsContextItems(kw.keyword)));
      for (const items of searchResults) this.keywordContext.push(...items);
      this.keywordContext = ArtifactContext.deduplicateFieldArray(this.keywordContext);
    } catch (error) {
      console.error('Failed to search keywords:', error);
    }
  }

  private async updateAttentionZone(uri: FsUri, cursorPosition: Position): Promise<void> {
    if (!this.attentionZone) this.attentionZone = [];
    try {
      const cursorContextLocation = makeLocation(uri, makeRange(cursorPosition, cursorPosition));
      const codeSnippet = await this.query.getCodeSnippet(cursorContextLocation, true);
      this.attentionZone.push(new ArtifactContextItem(cursorContextLocation, codeSnippet));
    } catch (error) {
      console.error('Failed to update attention zone:', error);
      throw error;
    }
    ArtifactContext.deduplicateFieldArray(this.attentionZone);
    ArtifactContext.trimFieldArray(this.attentionZone);
  }

  private async updateSoftRelContext(lastArtifact: Artifact | undefined) {
    const [lastArtRels, cursorRels] = await Promise.all([
      this.updateLastArtifactRels(lastArtifact),
      this.updateCursorRels(),
    ]);
    if (!this.softRelContext) this.softRelContext = [];
    this.softRelContext.push(...lastArtRels, ...cursorRels);
    ArtifactContext.trimFieldArray(this.softRelContext);
  }

  private async updateCursorRels(): Promise<ArtifactContextItem[]> {
    if (!this.cursorContext) return [];
    const doc = await this.query.getDocFromUri(this.cursorContext.loc.uri);
    if (!doc) return [];
    const rels = await this.query.getSoftRelations(doc, this.cursorContext.getCursorPosition().line);
    const ret: ArtifactContextItem[] = [];
    for (const rel of rels) {
      const relDoc = await this.query.getDocFromUri(rel.targetNode.fsPath);
      if (!relDoc) continue;
      const artifact = await this.query.getArtifactFromRange(
        relDoc.uri,
        makePosition(rel.targetNode.startLine, 0),
        makePosition(rel.targetNode.endLine, 0),
        doc.lineCount,
      );
      if (!artifact || !artifact.location) continue;
      const codeSnippet = await this.query.getCodeSnippet(
        makeLocation(artifact.location.uri, artifact.location.range),
        true,
      );
      ret.push(new ArtifactContextItem(artifact.location, codeSnippet));
    }
    return ret;
  }

  private async updateLastArtifactRels(lastArtifact: Artifact | undefined): Promise<ArtifactContextItem[]> {
    if (!lastArtifact || !lastArtifact.location?.uri) return [];
    const doc = await this.query.getDocFromUri(lastArtifact.location.uri);
    if (!doc) return [];
    const rels = await this.query.getSoftRelations(doc, lastArtifact.location.range.start.line);
    const ret: ArtifactContextItem[] = [];
    for (const rel of rels) {
      const relDoc = await this.query.getDocFromUri(rel.targetNode.fsPath);
      if (!relDoc) continue;
      const artifact = await this.query.getArtifactFromRange(
        relDoc.uri,
        makePosition(rel.targetNode.startLine, 0),
        makePosition(rel.targetNode.endLine, 0),
        doc.lineCount,
      );
      if (!artifact || !artifact.location) continue;
      const codeSnippet = await this.query.getCodeSnippet(
        makeLocation(artifact.location.uri, artifact.location.range),
        true,
      );
      ret.push(new ArtifactContextItem(artifact.location, codeSnippet));
    }
    return ret;
  }

  private async updateLastArtifactContext(lastArtifact: Artifact | undefined) {
    if (!lastArtifact) return;
    const lastArtifactContext = await this.query.getArtifactContext(lastArtifact);
    if (!lastArtifactContext || lastArtifactContext.length === 0) return;
    this.lastArtifactContext = lastArtifactContext;
    this.lastArtifactContext.forEach(ac => ac.trim());
  }

  private deduplicate() {
    if (this.attentionZone && this.attentionZone.length > 0) {
      this.attentionZone = ArtifactContext.deduplicateFieldArray(this.attentionZone);
    }
    if (this.softRelContext && this.softRelContext.length > 0) {
      this.softRelContext = ArtifactContext.deduplicateFieldArray(this.softRelContext);
    }
    if (this.lastArtifactContext && this.lastArtifactContext.length > 0) {
      for (const ac of this.lastArtifactContext) ac.deduplicateInternal();
    }

    // priority: CursorContext > AttentionZone > SoftRelContext > KeywordContext > LastArtifactContext
    const globalSeenItems: ArtifactContextItem[] = [];
    if (this.cursorContext) globalSeenItems.push(this.cursorContext);

    if (this.attentionZone) {
      const itemsToRemove: ArtifactContextItem[] = [];
      for (const item of this.attentionZone) {
        for (const seenItem of globalSeenItems) {
          if (seenItem.epualsTo(item)) {
            seenItem.fusion(item);
            itemsToRemove.push(item);
          }
        }
      }
      if (itemsToRemove.length > 0) {
        this.attentionZone = this.attentionZone.filter(item => !itemsToRemove.includes(item));
      }
      globalSeenItems.push(...this.attentionZone);
    }

    if (this.softRelContext) {
      const itemsToRemove: ArtifactContextItem[] = [];
      for (const item of this.softRelContext) {
        for (const seenItem of globalSeenItems) {
          if (seenItem.epualsTo(item)) {
            seenItem.fusion(item);
            itemsToRemove.push(item);
          }
        }
      }
      if (itemsToRemove.length > 0) {
        this.softRelContext = this.softRelContext.filter(item => !itemsToRemove.includes(item));
      }
      globalSeenItems.push(...this.softRelContext);
    }

    if (this.keywordContext) {
      const itemsToRemove: ArtifactContextItem[] = [];
      for (const item of this.keywordContext) {
        for (const seenItem of globalSeenItems) {
          if (seenItem.epualsTo(item)) {
            seenItem.fusion(item);
            itemsToRemove.push(item);
          }
        }
      }
      if (itemsToRemove.length > 0) {
        this.keywordContext = this.keywordContext.filter(item => !itemsToRemove.includes(item));
      }
      globalSeenItems.push(...this.keywordContext);
    }

    if (!this.lastArtifactContext || this.lastArtifactContext.length === 0) return;
    for (const ac of this.lastArtifactContext) {
      const allItems = ac.getAllItems();
      const itemsToRemove: ArtifactContextItem[] = [];
      for (const item of allItems) {
        for (const seenItem of globalSeenItems) {
          if (seenItem.epualsTo(item)) {
            seenItem.fusion(item);
            itemsToRemove.push(item);
            break;
          }
        }
      }
      if (itemsToRemove.length > 0) ac.removeItems(itemsToRemove);
      globalSeenItems.push(...ac.getAllItems());
    }
    for (const ac of this.lastArtifactContext) ac.deduplicateInternal();
  }
}
