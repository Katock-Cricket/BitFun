import { Artifact } from '../domain/artifact';
import { ArtifactContext, ArtifactContextItem, ArtifactContextType } from '../domain/artifact-context';
import { FsUri, Location, Position } from '../domain/geometry';
import { SoftRelQueryResult } from '../repomap/soft-rel/types';
import { TextDocumentSnapshot } from './document-port';

export interface ContextQueryService {
  getCodeSnippet(
    location: Location,
    forceLatest?: boolean,
    upToLines?: number,
    downToLines?: number,
  ): Promise<string>;
  getArtifactContext(artifact: Artifact): Promise<ArtifactContext[]>;
  getSoftRelations(doc: TextDocumentSnapshot | FsUri | string, line: number, topK?: number): Promise<SoftRelQueryResult[]>;
  grepAsContextItems(query: string): Promise<ArtifactContextItem[]>;
  getArtifactFromRange(
    uri: FsUri,
    start: Position,
    end: Position,
    fileLineCount?: number,
    isEdit?: boolean,
  ): Promise<Artifact>;
  getDocFromUri(uri: FsUri | string): Promise<TextDocumentSnapshot | undefined>;
  getContextCustomly?(
    artifact: Artifact,
    contextField: ArtifactContextType,
    forceLatest?: boolean,
  ): Promise<ArtifactContextItem[] | undefined>;
  getEdgeType?(a: Artifact, b: Artifact): Promise<Set<string>>;
  observeCursorMove?(doc: TextDocumentSnapshot, line: number): void;
  updateSoftRel?(docA: TextDocumentSnapshot, lineA: number, docB: TextDocumentSnapshot, lineB: number): Promise<void>;
}
