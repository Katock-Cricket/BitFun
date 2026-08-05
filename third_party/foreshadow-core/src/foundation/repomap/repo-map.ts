import { Artifact } from '../domain/artifact';
import { ArtifactContext, ArtifactContextItem, ArtifactContextType } from '../domain/artifact-context';
import { FsUri, Location, makeLocation, makePosition, makeRange, makeUri } from '../domain/geometry';
import { codeSnippetSize, softRelSaveInterval } from '../config/constants';
import { DocumentPort, TextDocumentSnapshot } from '../ports/document-port';
import { LanguageIntelPort } from '../ports/language-intel-port';
import { WorkspacePort } from '../ports/workspace-port';
import { WorkspaceSearchPort } from '../ports/workspace-search-port';
import { FileSystemPort } from '../ports/filesystem-port';
import { SchedulerPort } from '../ports/scheduler-port';
import { ContextQueryService } from '../ports/context-query';
import { SoftRelQueryResult } from './soft-rel/types';
import { SoftRelationMap } from './soft-rel/soft-rel';
import { ArtifactContextProvider } from './artifact-cxt-provider';
import { EdgeQuerier } from './edge-querier';
import { EdgeType } from './edge-types';
import { getArtifactFromRange } from '../log/context-process';

export class RepoMap implements ContextQueryService {
  private edgeQuerier: EdgeQuerier;
  private codeContextProvider: ArtifactContextProvider;
  private softRelationMap: SoftRelationMap;
  private disposables: Array<{ dispose(): void }> = [];

  constructor(
    documents: DocumentPort,
    private readonly languageIntel: LanguageIntelPort,
    workspace: WorkspacePort,
    private readonly search: WorkspaceSearchPort,
    fs: FileSystemPort,
    scheduler: SchedulerPort,
  ) {
    this.edgeQuerier = new EdgeQuerier(languageIntel);
    this.codeContextProvider = new ArtifactContextProvider(documents, languageIntel, workspace);
    this.softRelationMap = new SoftRelationMap(
      fs,
      workspace,
      languageIntel,
      (a, b) => this.getEdgeType(a, b).then(s => new Set(Array.from(s).map(String))),
      scheduler,
    );
    this.disposables.push(
      scheduler.setInterval(() => {
        this.saveSoftRelations().catch(e => console.error(e));
      }, softRelSaveInterval),
    );
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.saveSoftRelations().catch(e => console.error(e));
  }

  public async getEdgeType(a: Artifact, b: Artifact): Promise<Set<EdgeType>> {
    return this.edgeQuerier.getEdgeType(a, b);
  }

  public async getArtifactContext(artifact: Artifact): Promise<ArtifactContext[]> {
    return this.codeContextProvider.getArtifactContext(artifact);
  }

  public async getCodeSnippet(
    location: Location,
    forceLatest: boolean = false,
    upToLines: number = codeSnippetSize.upToLines,
    downToLines: number = codeSnippetSize.downToLines,
  ): Promise<string> {
    return this.codeContextProvider.getCodeSnippet(location, forceLatest, upToLines, downToLines);
  }

  public async getContextCustomly(
    artifact: Artifact,
    contextField: ArtifactContextType,
    forceLatest: boolean = true,
  ): Promise<ArtifactContextItem[] | undefined> {
    if (!artifact.location) return undefined;
    const allLocations: Location[] = [];
    switch (contextField) {
      case ArtifactContextType.Callers: {
        const callers = await this.codeContextProvider.getCallers(artifact);
        if (callers) allLocations.push(...callers);
        break;
      }
      case ArtifactContextType.Implementations: {
        const implementations = await this.codeContextProvider.getImplementations(artifact);
        if (implementations) allLocations.push(...implementations);
        break;
      }
      case ArtifactContextType.Members: {
        const members = await this.codeContextProvider.getMembers(artifact);
        if (members) allLocations.push(...members);
        break;
      }
      case ArtifactContextType.Callees: {
        const callees = await this.codeContextProvider.getCallees(artifact);
        if (callees) allLocations.push(...callees);
        break;
      }
      case ArtifactContextType.References: {
        const references = await this.codeContextProvider.getReferences(artifact);
        if (references) allLocations.push(...references);
        break;
      }
      case ArtifactContextType.TypeDefinition: {
        const typeDefinition = await this.codeContextProvider.getTypeDefinition(artifact);
        if (typeDefinition) allLocations.push(typeDefinition);
        break;
      }
      case ArtifactContextType.ImportBlock: {
        const fileContent = await this.getCodeSnippet(artifact.location, false, 0, 200);
        const importBlock = this.codeContextProvider.getImportBlock(artifact, fileContent);
        return importBlock ? [importBlock] : undefined;
      }
      case ArtifactContextType.Documentation: {
        const documentation = await this.codeContextProvider.getDoc(artifact);
        return documentation ? [new ArtifactContextItem(artifact.location, documentation)] : undefined;
      }
      default:
        return undefined;
    }
    const codeSnippets = await Promise.all(allLocations.map(loc => this.getCodeSnippet(loc, forceLatest)));
    return allLocations.map((location, index) => new ArtifactContextItem(location, codeSnippets[index]));
  }

  public async getSoftRelations(
    doc: TextDocumentSnapshot | FsUri | string,
    line: number,
    topK: number = 3,
  ): Promise<SoftRelQueryResult[]> {
    let snapshot: TextDocumentSnapshot | undefined;
    if (typeof doc === 'string' || (doc as FsUri).fsPath) {
      snapshot = await this.getDocFromUri(doc as any);
    } else {
      snapshot = doc as TextDocumentSnapshot;
    }
    if (!snapshot) return [];
    return this.softRelationMap.getSoftRels(snapshot, line, topK);
  }

  public async updateSoftRel(
    docA: TextDocumentSnapshot,
    lineA: number,
    docB: TextDocumentSnapshot,
    lineB: number,
  ): Promise<void> {
    return this.softRelationMap.updateSoftRel(docA, lineA, docB, lineB);
  }

  public observeCursorMove(doc: TextDocumentSnapshot, line: number) {
    this.softRelationMap.observeCursorMove(doc, line);
  }

  async saveSoftRelations(): Promise<void> {
    await this.softRelationMap.save();
  }

  public async getDocFromUri(uri: FsUri | string): Promise<TextDocumentSnapshot | undefined> {
    return this.codeContextProvider.getDocFromUri(uri);
  }

  public async getArtifactFromRange(
    uri: FsUri,
    start: { line: number; character: number },
    end: { line: number; character: number },
    fileLineCount?: number,
    isEdit?: boolean,
  ): Promise<Artifact> {
    return getArtifactFromRange(this.languageIntel, uri, start, end, fileLineCount ?? 0, isEdit ?? false);
  }

  public async grepAsContextItems(query: string): Promise<ArtifactContextItem[]> {
    const result = await this.search.search({ query, fixedStrings: true, smartCase: true, maxResults: 20 });
    if (!result.success || result.matches.length === 0) {
      if (!result.success) console.warn(`[grepAsContextItems] search failed for "${query}":`, result.error);
      return [];
    }
    const locations = result.matches.map(match =>
      makeLocation(
        makeUri(match.file),
        makeRange(makePosition(match.line - 1, match.column - 1), makePosition(match.line - 1, match.column - 1)),
      ),
    );
    const snippetResults = await Promise.allSettled(locations.map(loc => this.getCodeSnippet(loc, true)));
    const items: ArtifactContextItem[] = [];
    for (let i = 0; i < locations.length; i++) {
      const sr = snippetResults[i];
      if (sr.status === 'fulfilled' && sr.value) {
        items.push(new ArtifactContextItem(locations[i], sr.value));
      }
    }
    return items;
  }
}
