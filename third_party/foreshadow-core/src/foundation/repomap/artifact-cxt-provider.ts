import { Artifact, ArtifactType, SymbolRef } from '../domain/artifact';
import { ArtifactContext, ArtifactContextItem } from '../domain/artifact-context';
import {
  FsUri,
  Location,
  isSameFsPath,
  makeLocation,
  makePosition,
  makeRange,
  rangeContains,
} from '../domain/geometry';
import { codeSnippetSize } from '../config/constants';
import { DocumentPort, TextDocumentSnapshot } from '../ports/document-port';
import { LanguageIntelPort } from '../ports/language-intel-port';
import { WorkspacePort } from '../ports/workspace-port';
import { ArtifactContextCache, CodeSnippetCache } from './cache';
import { extractImportBlock } from './import-parser';

export class ArtifactContextProvider {
  private readonly cache = new ArtifactContextCache();
  private readonly snippetCache = new CodeSnippetCache();

  constructor(
    private readonly documents: DocumentPort,
    private readonly languageIntel: LanguageIntelPort,
    private readonly workspace: WorkspacePort,
  ) {}

  public async getArtifactContext(artifact: Artifact): Promise<ArtifactContext[]> {
    if (!artifact.location) {
      console.error('Artifact must have location');
      return [];
    }
    await this.cache.updateByChangedLocation(artifact.location);
    const path = [...(artifact.hierarchy ?? [artifact])];
    const results = await Promise.all(path.map(async node => (node.location ? this.computeContext(node) : null)));
    return results.filter((ctx): ctx is ArtifactContext => ctx !== null);
  }

  private async computeContext(artifact: Artifact): Promise<ArtifactContext> {
    const cached = this.cache.get(artifact);
    if (cached) return cached;

    const artifactContext = new ArtifactContext(artifact);
    let allLocations: Location[] = [];

    if (artifact.type === ArtifactType.File) {
      const fileContent = await this.getCodeSnippet(artifact.location!, false, 0, 200);
      const importBlock = this.getImportBlock(artifact, fileContent);
      if (importBlock) artifactContext.setImportBlock(importBlock);
    } else if (
      artifact.type === ArtifactType.Function ||
      artifact.type === ArtifactType.Method ||
      artifact.type === ArtifactType.Constructor
    ) {
      let [doc, references, implementations, callers, callees] = await Promise.all([
        this.getDoc(artifact),
        this.getReferences(artifact),
        this.getImplementations(artifact),
        this.getCallers(artifact),
        this.getCallees(artifact),
      ]);
      if (callers && references) {
        references = references.filter(reference => !callers.some(caller => this.isSameLocation(caller, reference)));
      }
      if (implementations && references) {
        references = references.filter(
          reference => !implementations.some(implementation => this.isSameLocation(implementation, reference)),
        );
      }
      if (doc) artifactContext.setDocumentation(doc);
      if (references) allLocations.push(...references);
      if (implementations) allLocations.push(...implementations);
      if (callers) allLocations.push(...callers);
      if (callees) allLocations.push(...callees);
      const codeSnippets = await Promise.all(allLocations.map(loc => this.getCodeSnippet(loc)));
      let snippetIndex = 0;
      if (references) {
        artifactContext.setReferences(references.map(r => new ArtifactContextItem(r, codeSnippets[snippetIndex++])));
      }
      if (implementations) {
        artifactContext.setImplementations(
          implementations.map(r => new ArtifactContextItem(r, codeSnippets[snippetIndex++])),
        );
      }
      if (callers) {
        artifactContext.setCallers(callers.map(r => new ArtifactContextItem(r, codeSnippets[snippetIndex++])));
      }
      if (callees) {
        artifactContext.setCallees(callees.map(r => new ArtifactContextItem(r, codeSnippets[snippetIndex++])));
      }
    } else if (
      [
        ArtifactType.Class,
        ArtifactType.Interface,
        ArtifactType.Enum,
        ArtifactType.Struct,
        ArtifactType.Namespace,
        ArtifactType.Package,
        ArtifactType.Module,
      ].includes(artifact.type)
    ) {
      const [doc, references, members] = await Promise.all([
        this.getDoc(artifact),
        this.getReferences(artifact),
        this.getMembers(artifact),
      ]);
      if (doc) artifactContext.setDocumentation(doc);
      if (references) allLocations.push(...references);
      if (members) allLocations.push(...members);
      const codeSnippets = await Promise.all(allLocations.map(loc => this.getCodeSnippet(loc)));
      let snippetIndex = 0;
      if (references) {
        artifactContext.setReferences(references.map(r => new ArtifactContextItem(r, codeSnippets[snippetIndex++])));
      }
      if (members) {
        artifactContext.setMembers(members.map(r => new ArtifactContextItem(r, codeSnippets[snippetIndex++])));
      }
    } else if (
      [ArtifactType.Property, ArtifactType.Field, ArtifactType.EnumMember].includes(artifact.type)
    ) {
      let [doc, references, typeDefinition] = await Promise.all([
        this.getDoc(artifact),
        this.getReferences(artifact),
        this.getTypeDefinition(artifact),
      ]);
      if (doc) artifactContext.setDocumentation(doc);
      if (references) allLocations.push(...references);
      if (typeDefinition) allLocations.push(typeDefinition);
      const codeSnippets = await Promise.all(allLocations.map(loc => this.getCodeSnippet(loc)));
      let snippetIndex = 0;
      if (references) {
        artifactContext.setReferences(references.map(r => new ArtifactContextItem(r, codeSnippets[snippetIndex++])));
      }
      if (typeDefinition) {
        artifactContext.setTypeDefinition(new ArtifactContextItem(typeDefinition, codeSnippets[snippetIndex++]));
      }
    } else {
      const [doc, references] = await Promise.all([this.getDoc(artifact), this.getReferences(artifact)]);
      if (doc) artifactContext.setDocumentation(doc);
      if (references) allLocations.push(...references);
      const codeSnippets = await Promise.all(allLocations.map(loc => this.getCodeSnippet(loc)));
      let snippetIndex = 0;
      if (references) {
        artifactContext.setReferences(references.map(r => new ArtifactContextItem(r, codeSnippets[snippetIndex++])));
      }
    }

    this.cache.set(artifact, artifactContext);
    return artifactContext;
  }

  public async getCodeSnippet(
    loc: Location,
    forceLatest: boolean = false,
    upToLines: number = codeSnippetSize.upToLines,
    downToLines: number = codeSnippetSize.downToLines,
  ): Promise<string> {
    const cached = this.snippetCache.get(loc);
    if (cached !== undefined && !forceLatest) return cached;
    const doc = await this.getDocFromUri(loc.uri);
    if (!doc) return '';
    const range = makeRange(
      makePosition(Math.max(0, loc.range.start.line - upToLines), 0),
      makePosition(Math.min(doc.lineCount - 1, loc.range.end.line + downToLines), Number.MAX_SAFE_INTEGER),
    );
    const text = doc.getText(range);
    const snippet = text ? text.trimEnd() : '';
    this.snippetCache.set(loc, snippet);
    return snippet;
  }

  public async getDocFromUri(uri: FsUri | string): Promise<TextDocumentSnapshot | undefined> {
    try {
      const opened = this.documents.getOpenDocument(uri);
      if (opened) return opened;
      return await this.documents.openDocument(uri);
    } catch (e) {
      console.error('getDocFromUri failed', e);
      return undefined;
    }
  }

  private async isWholeFile(location: Location): Promise<boolean> {
    if (location.range.start.line !== 0 || location.range.start.character !== 0) return false;
    if (location.range.end.line === 0 && location.range.end.character === 0) return true;
    const doc = await this.getDocFromUri(location.uri);
    if (!doc) return false;
    const lastLine = doc.lineCount - 1;
    const lastLineLength = doc.lineAt(lastLine).length;
    return location.range.end.line === lastLine && location.range.end.character === lastLineLength;
  }

  private isInWorkspace(location: Location): boolean {
    return this.workspace.isInWorkspace(location.uri.fsPath);
  }

  private isSameLocation(loc1: Location, loc2: Location, ambiguous: boolean = false): boolean {
    if (!isSameFsPath(loc1.uri, loc2.uri)) return false;
    if (ambiguous) return loc1.range.start.line === loc2.range.start.line;
    return (
      loc1.range.start.line === loc2.range.start.line &&
      loc1.range.start.character === loc2.range.start.character &&
      loc1.range.end.line === loc2.range.end.line &&
      loc1.range.end.character === loc2.range.end.character
    );
  }

  public getImportBlock(artifact: Artifact, fileContent: string): ArtifactContextItem | undefined {
    return extractImportBlock(artifact.location!, fileContent);
  }

  public async getTypeDefinition(artifact: Artifact): Promise<Location | undefined> {
    if (!artifact.location) return undefined;
    try {
      let typeDef = await this.languageIntel.getTypeDefinition(artifact.location.uri, artifact.namePosition());
      typeDef = typeDef.filter(location => this.isInWorkspace(location));
      return typeDef[0];
    } catch {
      return undefined;
    }
  }

  public async getDoc(artifact: Artifact): Promise<string | undefined> {
    if (!artifact.location) return undefined;
    try {
      return await this.languageIntel.getHoverText(artifact.location.uri, artifact.namePosition());
    } catch {
      return undefined;
    }
  }

  public async getReferences(artifact: Artifact): Promise<Location[] | undefined> {
    if (!artifact.location) return undefined;
    try {
      let references = await this.languageIntel.getReferences(artifact.location.uri, artifact.namePosition(), false);
      if (references) {
        const checks = await Promise.all(references.map(reference => this.isWholeFile(reference)));
        references = references.filter((_, index) => !checks[index]);
        references = references.filter(reference => !this.isSameLocation(reference, artifact.location!, true));
        references = references.filter(location => this.isInWorkspace(location));
      }
      return references;
    } catch {
      return undefined;
    }
  }

  public async getImplementations(artifact: Artifact): Promise<Location[] | undefined> {
    if (!artifact.location) return undefined;
    try {
      let implementations = await this.languageIntel.getImplementations(artifact.location.uri, artifact.namePosition());
      if (implementations) implementations = implementations.filter(location => this.isInWorkspace(location));
      return implementations;
    } catch {
      return undefined;
    }
  }

  public async getCallers(artifact: Artifact): Promise<Location[] | undefined> {
    if (!artifact.location) return undefined;
    try {
      const items = await this.languageIntel.prepareCallHierarchy(artifact.location.uri, artifact.namePosition());
      if (!items?.[0]) return undefined;
      const incoming = await this.languageIntel.provideIncomingCalls(items[0]);
      let locations = incoming?.map(call => makeLocation(call.from.uri, call.from.range));
      if (locations) {
        const checks = await Promise.all(locations.map(location => this.isWholeFile(location)));
        locations = locations.filter((_, index) => !checks[index]).filter(location => this.isInWorkspace(location));
      }
      return locations;
    } catch {
      return undefined;
    }
  }

  public async getCallees(artifact: Artifact): Promise<Location[] | undefined> {
    if (!artifact.location) return undefined;
    try {
      const items = await this.languageIntel.prepareCallHierarchy(artifact.location.uri, artifact.namePosition());
      if (!items?.[0]) return undefined;
      const outgoing = await this.languageIntel.provideOutgoingCalls(items[0]);
      let locations = outgoing?.map(call => makeLocation(call.to.uri, call.to.range));
      if (locations) {
        const checks = await Promise.all(locations.map(location => this.isWholeFile(location)));
        locations = locations.filter((_, index) => !checks[index]).filter(location => this.isInWorkspace(location));
      }
      return locations;
    } catch {
      return undefined;
    }
  }

  public async getMembers(artifact: Artifact): Promise<Location[] | undefined> {
    if (!artifact.location) return undefined;
    try {
      const symbols = await this.languageIntel.getDocumentSymbols(artifact.location.uri);
      if (!symbols) return undefined;
      let children = this.findDirectChildren(symbols, artifact.location.range, artifact.location.uri);
      children = children.filter(location => this.isInWorkspace(location));
      return children.length > 0 ? children : undefined;
    } catch {
      return undefined;
    }
  }

  private findDirectChildren(symbols: SymbolRef[], parentRange: Location['range'], uri: FsUri): Location[] {
    const children: Location[] = [];
    for (const sym of symbols) {
      if (rangeContains(parentRange, sym.range)) {
        const equal =
          sym.range.start.line === parentRange.start.line &&
          sym.range.start.character === parentRange.start.character &&
          sym.range.end.line === parentRange.end.line &&
          sym.range.end.character === parentRange.end.character;
        if (!equal) {
          children.push(makeLocation(uri, makeRange(sym.selectionStart, sym.selectionStart)));
        }
        if (sym.children && sym.children.length > 0) {
          children.push(...this.findDirectChildren(sym.children, parentRange, uri));
        }
      }
    }
    return children;
  }
}
