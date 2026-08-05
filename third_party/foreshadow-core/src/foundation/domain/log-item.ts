import { getFormattedTime } from '../utils/time';
import { EventType } from './event-types';
import { Artifact } from './artifact';
import { getDiffWithMarkers } from '../log/edit-merge';
import { Position, isSameFsPath } from './geometry';
import { TextDocumentSnapshot } from '../ports/document-port';

export enum ContextType {
  Edit = 'Edit',
  Select = 'Select',
  Hover = 'Hover',
  Terminal = 'Terminal',
  Lint = 'Lint',
  CursorJump = 'CursorJump',
  Unknown = 'Unknown',
}

const InformativeEventTypes = [
  EventType.EditTextDocument,
  EventType.ExecuteTerminalCommand,
  EventType.SelectText,
  EventType.OpenTextDocument,
  EventType.ChangeTextDocument,
  EventType.CreateFile,
  EventType.DeleteFile,
  EventType.RenameFile,
  EventType.MoveFile,
];

export class Context {
  constructor(
    public type: ContextType,
    public content: { before: string; after: string },
    public start: { line: number; character: number },
    public end: { line: number; character: number },
  ) {}

  toJSONObject(): any {
    if (this.type === ContextType.Edit) {
      return {
        type: this.type,
        content: getDiffWithMarkers(this.content.before, this.content.after),
        position: `${this.start.line}-${this.end.line}`,
      };
    }
    return {
      type: this.type,
      content: this.content,
      position: `${this.start.line}-${this.end.line}`,
    };
  }

  checkHit(pos: Position): boolean {
    if (this.type !== ContextType.Edit) {
      return false;
    }
    if (pos.line < this.start.line || pos.line > this.end.line) {
      return false;
    }
    return true;
  }

  private getContentWithLimitTokens(content: string): string {
    if (content.length > 1000) {
      return content.substring(0, 500) + ' ... ' + content.substring(content.length - 500);
    }
    return content;
  }

  private toEditAbstract(): string {
    const diffContent = getDiffWithMarkers(this.content.before, this.content.after);
    return `...\n${diffContent}\n...`;
  }

  private toSelectOrHoverAbstract(): string {
    return this.getContentWithLimitTokens(this.content.after);
  }

  private toTerminalAbstract(): string {
    return `Command(WithTag): ${this.getContentWithLimitTokens(this.content.before)}\n\`\`\`\n\`\`\`\nOutput: ${this.getContentWithLimitTokens(this.content.after)}`;
  }

  toAbstract(): string {
    switch (this.type) {
      case ContextType.Edit:
        return this.toEditAbstract();
      case ContextType.Select:
      case ContextType.Hover:
        return this.toSelectOrHoverAbstract();
      case ContextType.Terminal:
        return this.toTerminalAbstract();
      default:
        return '';
    }
  }
}

export class LogItem {
  timeStamp: string;
  eventType: EventType;
  artifact: Artifact;
  context?: Context;

  constructor(eventType: EventType, artifact: Artifact, context?: Context, timeStamp?: string) {
    this.timeStamp = timeStamp ?? getFormattedTime();
    this.eventType = eventType;
    this.artifact = artifact;
    this.context = context;
  }

  checkHit(doc: TextDocumentSnapshot, pos: Position): boolean {
    if (!this.artifact.location) {
      return false;
    }
    if (!isSameFsPath(this.artifact.location.uri, doc.uri)) {
      return false;
    }
    if (!this.context) {
      return false;
    }
    return this.context.checkHit(pos);
  }

  equals(other: LogItem): boolean {
    return (
      this.timeStamp === other.timeStamp &&
      this.eventType === other.eventType &&
      this.artifact.equals(other.artifact)
    );
  }

  toJSONObject(): any {
    return {
      timeStamp: this.timeStamp,
      eventType: this.eventType,
      artifact: this.artifact.toJSONObject(),
      context: this.context?.toJSONObject(),
    };
  }

  toAbstract(): string {
    if (!InformativeEventTypes.includes(this.eventType)) {
      return '';
    }
    let abs = `${this.eventType} ${this.artifact.toAbstract()}`;
    if (this.context) {
      abs += `\n\`\`\`\n${this.context.toAbstract()}\n\`\`\`\n`;
    }
    return abs;
  }
}
