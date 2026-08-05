import { Artifact } from './artifact';
import {
  ArtifactContextItemMaxSize,
  codeSnippetSize,
  cursorContextSize,
} from '../config/constants';
import { FsUri, Location, Position, makeLocation, makePosition, makeRange, isSameFsPath } from './geometry';
import { TextDocumentSnapshot } from '../ports/document-port';
import { ContextQueryService } from '../ports/context-query';

export enum ArtifactContextType {
  Documentation = 'Documentation',
  TypeDefinition = 'TypeDefinition',
  References = 'References',
  Implementations = 'Implementations',
  Callers = 'Callers',
  Callees = 'Callees',
  Members = 'Members',
  ImportBlock = 'ImportBlock',
}

let contextQuery: ContextQueryService | undefined;

export function setArtifactContextQueryService(svc: ContextQueryService | undefined) {
  contextQuery = svc;
}

export class ArtifactContextItem {
  public preciseLoc: Location;
  public ratio: number = 0;

  constructor(
    public loc: Location,
    public codeSnippet: string,
    public upToLines: number = codeSnippetSize.upToLines,
    public downToLines: number = codeSnippetSize.downToLines,
    public doc: TextDocumentSnapshot | undefined = undefined,
  ) {
    this.preciseLoc = loc;
    this.loc = this.adjustLocByCodeSnippetSize(loc, upToLines, downToLines);
    this.updateRatio().catch((error: any) => {
      console.error('ArtifactContextItem init failed:', error);
    });
  }

  protected async updateRatio(): Promise<void> {
    if (!this.doc) {
      if (!contextQuery) {
        return;
      }
      this.doc = await contextQuery.getDocFromUri(this.loc.uri);
      if (!this.doc) {
        return;
      }
    }
    this.ratio = (this.loc.range.end.line - this.loc.range.start.line + 1) / Math.max(1, this.doc.lineCount);
  }

  protected adjustLocByCodeSnippetSize(loc: Location, upToLines: number, downToLines: number): Location {
    const startPos = makePosition(Math.max(0, loc.range.start.line - upToLines), 0);
    let endLine = loc.range.end.line + downToLines;
    if (this.doc) {
      endLine = Math.min(this.doc.lineCount - 1, endLine);
    }
    const endPos = makePosition(endLine, 0);
    return makeLocation(loc.uri, makeRange(startPos, endPos));
  }

  private getCodeSnippetWithLineNumbers(): string {
    return this.codeSnippet
      .split('\n')
      .map((line, index) => `${this.loc.range.start.line + index + 1} ${line}`)
      .join('\n');
  }

  toJSONObject(): any {
    return {
      file: this.loc.uri.fsPath,
      ratio: this.ratio,
      codeSnippet: this.getCodeSnippetWithLineNumbers(),
    };
  }

  toAbstract(): string {
    return `${this.loc.uri.fsPath}:\n${this.getCodeSnippetWithLineNumbers()}`;
  }

  epualsTo(other: ArtifactContextItem): boolean {
    if (!isSameFsPath(this.loc.uri, other.loc.uri)) {
      return false;
    }
    const thisStartLine = this.loc.range.start.line;
    const thisEndLine = thisStartLine + this.codeSnippet.split('\n').length - 1;
    const otherStartLine = other.loc.range.start.line;
    const otherEndLine = otherStartLine + other.codeSnippet.split('\n').length - 1;
    if (thisStartLine > otherEndLine || thisEndLine < otherStartLine) {
      return false;
    }
    return true;
  }

  fusion(other: ArtifactContextItem) {
    if (!isSameFsPath(this.loc.uri, other.loc.uri)) {
      console.error(`ArtifactContextItem fusion failed: ${this.loc.uri.fsPath} !== ${other.loc.uri.fsPath}`);
      return;
    }
    const thisStartLine = this.loc.range.start.line;
    const thisEndLine = this.loc.range.end.line;
    const otherStartLine = other.loc.range.start.line;
    const otherEndLine = other.loc.range.end.line;
    const newStartLine = Math.min(thisStartLine, otherStartLine);
    const newEndLine = Math.max(thisEndLine, otherEndLine);
    const thisLines = this.codeSnippet.split('\n');
    const otherLines = other.codeSnippet.split('\n');
    const mergedLinesMap = new Map<number, string>();
    for (let i = 0; i < thisLines.length; i++) {
      mergedLinesMap.set(thisStartLine + i, thisLines[i]);
    }
    for (let i = 0; i < otherLines.length; i++) {
      const lineNumber = otherStartLine + i;
      if (!mergedLinesMap.has(lineNumber)) {
        mergedLinesMap.set(lineNumber, otherLines[i]);
      }
    }
    const sortedLineNumbers = Array.from(mergedLinesMap.keys()).sort((a, b) => a - b);
    this.codeSnippet = sortedLineNumbers.map(lineNum => mergedLinesMap.get(lineNum)!).join('\n');
    this.loc = makeLocation(
      this.loc.uri,
      makeRange(
        makePosition(newStartLine, this.loc.range.start.character),
        makePosition(newEndLine, this.loc.range.end.character),
      ),
    );
    this.updateRatio();
  }

  checkHit(doc: TextDocumentSnapshot | FsUri | string, pos: Position): boolean {
    const uri = typeof doc === 'string' ? doc : 'uri' in (doc as any) ? (doc as TextDocumentSnapshot).uri : (doc as FsUri);
    if (!isSameFsPath(uri, this.loc.uri)) {
      return false;
    }
    if (pos.line < this.loc.range.start.line || pos.line > this.loc.range.end.line) {
      return false;
    }
    return true;
  }
}

export class CursorContext extends ArtifactContextItem {
  static readonly CURSOR_MARKER = '<|Cursor_Position|>';

  constructor(
    loc: Location,
    codeSnippet: string,
    upToLines: number = cursorContextSize.upToLines,
    downToLines: number = cursorContextSize.downToLines,
    doc: TextDocumentSnapshot | undefined = undefined,
  ) {
    super(loc, codeSnippet, upToLines, downToLines, doc);
    this.updateRatioSync();
  }

  public getCursorPosition(): Position {
    return this.preciseLoc.range.start;
  }

  private getCursorCodeSnippetWithMark(): string {
    const lines = this.codeSnippet.split('\n');
    const cursorLine = this.getCursorPosition().line;
    const cursorCol = this.getCursorPosition().character;
    const snippetStartLine = this.loc.range.start.line;
    const relativeLineIndex = cursorLine - snippetStartLine;
    if (relativeLineIndex >= 0 && relativeLineIndex < lines.length) {
      const targetLine = lines[relativeLineIndex];
      const before = targetLine.substring(0, cursorCol);
      const after = targetLine.substring(cursorCol);
      lines[relativeLineIndex] = before + CursorContext.CURSOR_MARKER + after;
    } else if (relativeLineIndex === lines.length) {
      lines.push(CursorContext.CURSOR_MARKER);
    }
    return lines.map((line, index) => `${snippetStartLine + index + 1} ${line}`).join('\n');
  }

  public updateRatioSync() {
    if (!this.doc) {
      return;
    }
    this.ratio = (this.loc.range.end.line - this.loc.range.start.line + 1) / Math.max(1, this.doc.lineCount);
  }

  public toJSONObject(): any {
    return {
      file: this.loc.uri.fsPath,
      ratio: this.ratio,
      codeSnippet: this.getCursorCodeSnippetWithMark(),
    };
  }

  public toAbstract(): string {
    return `${this.loc.uri.fsPath}:\n${this.getCursorCodeSnippetWithMark()}`;
  }
}

export class ArtifactContext {
  private artifact: Artifact;
  private documentation?: string;
  private typeDefinition?: ArtifactContextItem;
  private references?: ArtifactContextItem[];
  private implementations?: ArtifactContextItem[];
  private callers?: ArtifactContextItem[];
  private callees?: ArtifactContextItem[];
  private members?: ArtifactContextItem[];
  private importBlock?: ArtifactContextItem;
  /** Wall-clock capture time; retained for cache invalidation / debugging. */
  private readonly _fetchedAt: number;

  constructor(artifact: Artifact) {
    this.artifact = artifact;
    this._fetchedAt = Date.now();
  }

  getFetchedAt(): number {
    return this._fetchedAt;
  }

  getArtifact(): Artifact {
    return this.artifact;
  }

  setDocumentation(documentation: string): void {
    this.documentation = documentation;
  }
  setTypeDefinition(typeDefinition: ArtifactContextItem): void {
    this.typeDefinition = typeDefinition;
  }
  setReferences(references: ArtifactContextItem[]): void {
    this.references = references;
  }
  setImplementations(implementations: ArtifactContextItem[]): void {
    this.implementations = implementations;
  }
  setCallers(callers: ArtifactContextItem[]): void {
    this.callers = callers;
  }
  setCallees(callees: ArtifactContextItem[]): void {
    this.callees = callees;
  }
  setMembers(members: ArtifactContextItem[]): void {
    this.members = members;
  }
  setImportBlock(importBlock: ArtifactContextItem): void {
    this.importBlock = importBlock;
  }

  toJSONObject(): any {
    return {
      artifact: this.artifact.toAbstract(),
      documentation: this.documentation,
      typeDefinition: this.typeDefinition?.toJSONObject(),
      references: this.references?.map(item => item.toJSONObject()),
      implementations: this.implementations?.map(item => item.toJSONObject()),
      callers: this.callers?.map(item => item.toJSONObject()),
      callees: this.callees?.map(item => item.toJSONObject()),
      members: this.members?.map(item => item.toJSONObject()),
      importBlock: this.importBlock?.toJSONObject(),
    };
  }

  toAbstract(): string {
    let abs = '';
    if (this.artifact) {
      abs += `##Artifact\n${this.artifact.toAbstract()}\n`;
    }
    if (this.documentation && this.documentation.length > 0) {
      abs += `Documentation: \n${this.documentation}\n`;
    }
    if (this.typeDefinition) {
      abs += `TypeDefinition: \n${this.typeDefinition.toAbstract()}\n`;
    }
    if (this.references && this.references.length > 0) {
      abs += `References: \n${this.references.map(item => item.toAbstract()).join('\n')}\n`;
    }
    if (this.implementations && this.implementations.length > 0) {
      abs += `Implementations: \n${this.implementations.map(item => item.toAbstract()).join('\n')}\n`;
    }
    if (this.callers && this.callers.length > 0) {
      abs += `Callers: \n${this.callers.map(item => item.toAbstract()).join('\n')}\n`;
    }
    if (this.callees && this.callees.length > 0) {
      abs += `Callees: \n${this.callees.map(item => item.toAbstract()).join('\n')}\n`;
    }
    if (this.members && this.members.length > 0) {
      abs += `Members: \n${this.members.map(item => item.toAbstract()).join('\n')}\n`;
    }
    if (this.importBlock) {
      abs += `ImportBlock: \n${this.importBlock.toAbstract()}\n`;
    }
    return abs;
  }

  private isAffectedByChangedLocation(context: ArtifactContextItem[], changedLocation: Location): boolean {
    return context.some(
      item =>
        item.loc.range.start.line <= changedLocation.range.start.line &&
        item.loc.range.end.line >= changedLocation.range.end.line,
    );
  }

  async updateByChangedLocation(changedLocation: Location): Promise<void> {
    const fields = this.getFieldsInPriorityOrder();
    const affectedFields: Array<{ name: ArtifactContextType; items: ArtifactContextItem[] }> = [];
    for (const field of fields) {
      if (this.isAffectedByChangedLocation(field.items, changedLocation)) {
        affectedFields.push({ name: field.name as ArtifactContextType, items: field.items });
      }
    }
    const promises = affectedFields.map(async field => {
      if (!contextQuery?.getContextCustomly) {
        return;
      }
      const items = await contextQuery.getContextCustomly(this.artifact, field.name);
      field.items = items ?? [];
    });
    await Promise.all(promises);
    for (const af of affectedFields) {
      const targetField = fields.find(f => f.name === af.name);
      if (targetField && af.items.length > 0) {
        targetField.setter(af.items);
      }
    }
  }

  private getFieldsInPriorityOrder(): Array<{
    name: ArtifactContextType;
    items: ArtifactContextItem[];
    getter: () => ArtifactContextItem[] | undefined;
    setter: (items: ArtifactContextItem[]) => void;
  }> {
    const fields: Array<{
      name: ArtifactContextType;
      items: ArtifactContextItem[];
      getter: () => ArtifactContextItem[] | undefined;
      setter: (items: ArtifactContextItem[]) => void;
    }> = [];
    if (this.typeDefinition) {
      fields.push({
        name: ArtifactContextType.TypeDefinition,
        items: [this.typeDefinition],
        getter: () => (this.typeDefinition ? [this.typeDefinition] : undefined),
        setter: (items: ArtifactContextItem[]) => {
          this.typeDefinition = items.length > 0 ? items[0] : undefined;
        },
      });
    }
    if (this.members && this.members.length > 0) {
      fields.push({
        name: ArtifactContextType.Members,
        items: this.members,
        getter: () => this.members,
        setter: (items: ArtifactContextItem[]) => {
          this.members = items.length > 0 ? items : undefined;
        },
      });
    }
    if (this.implementations && this.implementations.length > 0) {
      fields.push({
        name: ArtifactContextType.Implementations,
        items: this.implementations,
        getter: () => this.implementations,
        setter: (items: ArtifactContextItem[]) => {
          this.implementations = items.length > 0 ? items : undefined;
        },
      });
    }
    if (this.callers && this.callers.length > 0) {
      fields.push({
        name: ArtifactContextType.Callers,
        items: this.callers,
        getter: () => this.callers,
        setter: (items: ArtifactContextItem[]) => {
          this.callers = items.length > 0 ? items : undefined;
        },
      });
    }
    if (this.callees && this.callees.length > 0) {
      fields.push({
        name: ArtifactContextType.Callees,
        items: this.callees,
        getter: () => this.callees,
        setter: (items: ArtifactContextItem[]) => {
          this.callees = items.length > 0 ? items : undefined;
        },
      });
    }
    if (this.references && this.references.length > 0) {
      fields.push({
        name: ArtifactContextType.References,
        items: this.references,
        getter: () => this.references,
        setter: (items: ArtifactContextItem[]) => {
          this.references = items.length > 0 ? items : undefined;
        },
      });
    }
    if (this.importBlock) {
      fields.push({
        name: ArtifactContextType.ImportBlock,
        items: [this.importBlock],
        getter: () => (this.importBlock ? [this.importBlock] : undefined),
        setter: (items: ArtifactContextItem[]) => {
          this.importBlock = items.length > 0 ? items[0] : undefined;
        },
      });
    }
    return fields;
  }

  trim(): void {
    if (this.members) this.members = ArtifactContext.trimFieldArray(this.members);
    if (this.implementations) this.implementations = ArtifactContext.trimFieldArray(this.implementations);
    if (this.callers) this.callers = ArtifactContext.trimFieldArray(this.callers);
    if (this.callees) this.callees = ArtifactContext.trimFieldArray(this.callees);
    if (this.references) this.references = ArtifactContext.trimFieldArray(this.references);
  }

  static trimFieldArray(items: ArtifactContextItem[], size: number = ArtifactContextItemMaxSize): ArtifactContextItem[] {
    if (!items || items.length <= size) {
      return items;
    }
    return items.slice(0, size - 1);
  }

  static deduplicateFieldArray(items: ArtifactContextItem[]): ArtifactContextItem[] {
    if (!items || items.length === 0) {
      return items;
    }
    const deduplicatedItems: ArtifactContextItem[] = [];
    for (const item of items) {
      let found = false;
      for (const existing of deduplicatedItems) {
        if (existing.epualsTo(item)) {
          existing.fusion(item);
          found = true;
          break;
        }
      }
      if (!found) {
        deduplicatedItems.push(item);
      }
    }
    return deduplicatedItems;
  }

  deduplicateFields(): void {
    if (this.references && this.references.length > 0) {
      this.references = ArtifactContext.deduplicateFieldArray(this.references);
    }
    if (this.implementations && this.implementations.length > 0) {
      this.implementations = ArtifactContext.deduplicateFieldArray(this.implementations);
    }
    if (this.callers && this.callers.length > 0) {
      this.callers = ArtifactContext.deduplicateFieldArray(this.callers);
    }
    if (this.callees && this.callees.length > 0) {
      this.callees = ArtifactContext.deduplicateFieldArray(this.callees);
    }
    if (this.members && this.members.length > 0) {
      this.members = ArtifactContext.deduplicateFieldArray(this.members);
    }
  }

  deduplicateInternal(): void {
    this.deduplicateFields();
    const fields = this.getFieldsInPriorityOrder();
    const seenItems: ArtifactContextItem[] = [];
    for (const field of fields) {
      const itemsToKeep: ArtifactContextItem[] = [];
      for (const item of field.items) {
        let isDuplicate = false;
        let duplicateIndex = -1;
        for (let i = 0; i < seenItems.length; i++) {
          if (seenItems[i].epualsTo(item)) {
            isDuplicate = true;
            duplicateIndex = i;
            break;
          }
        }
        if (isDuplicate) {
          seenItems[duplicateIndex].fusion(item);
        } else {
          itemsToKeep.push(item);
          seenItems.push(item);
        }
      }
      field.setter(itemsToKeep);
    }
  }

  getAllItems(): ArtifactContextItem[] {
    const items: ArtifactContextItem[] = [];
    if (this.typeDefinition) items.push(this.typeDefinition);
    if (this.members) items.push(...this.members);
    if (this.implementations) items.push(...this.implementations);
    if (this.callers) items.push(...this.callers);
    if (this.callees) items.push(...this.callees);
    if (this.references) items.push(...this.references);
    return items;
  }

  removeItems(itemsToRemove: ArtifactContextItem[]): void {
    if (!itemsToRemove || itemsToRemove.length === 0) return;
    const itemsToRemoveSet = new Set(itemsToRemove);
    if (this.typeDefinition && itemsToRemoveSet.has(this.typeDefinition)) {
      this.typeDefinition = undefined;
    }
    if (this.members) {
      this.members = this.members.filter(item => !itemsToRemoveSet.has(item));
      if (this.members.length === 0) this.members = undefined;
    }
    if (this.implementations) {
      this.implementations = this.implementations.filter(item => !itemsToRemoveSet.has(item));
      if (this.implementations.length === 0) this.implementations = undefined;
    }
    if (this.callers) {
      this.callers = this.callers.filter(item => !itemsToRemoveSet.has(item));
      if (this.callers.length === 0) this.callers = undefined;
    }
    if (this.callees) {
      this.callees = this.callees.filter(item => !itemsToRemoveSet.has(item));
      if (this.callees.length === 0) this.callees = undefined;
    }
    if (this.references) {
      this.references = this.references.filter(item => !itemsToRemoveSet.has(item));
      if (this.references.length === 0) this.references = undefined;
    }
    if (this.importBlock && itemsToRemoveSet.has(this.importBlock)) {
      this.importBlock = undefined;
    }
  }
}
