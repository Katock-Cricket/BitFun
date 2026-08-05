import { ArtifactType, SymbolRef } from '../domain/artifact';
import { FsUri, Location, Position } from '../domain/geometry';

export interface CallHierarchyItemRef {
  name: string;
  uri: FsUri;
  range: Location['range'];
  selectionRange: Location['range'];
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItemRef;
  fromRanges: Location['range'][];
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItemRef;
  fromRanges: Location['range'][];
}

export interface LanguageIntelPort {
  getDocumentSymbols(uri: FsUri): Promise<SymbolRef[]>;
  getDefinition(uri: FsUri, position: Position): Promise<Location[]>;
  getTypeDefinition(uri: FsUri, position: Position): Promise<Location[]>;
  getReferences(uri: FsUri, position: Position, includeDeclaration?: boolean): Promise<Location[]>;
  getImplementations(uri: FsUri, position: Position): Promise<Location[]>;
  prepareCallHierarchy(uri: FsUri, position: Position): Promise<CallHierarchyItemRef[]>;
  provideIncomingCalls(item: CallHierarchyItemRef): Promise<CallHierarchyIncomingCall[]>;
  provideOutgoingCalls(item: CallHierarchyItemRef): Promise<CallHierarchyOutgoingCall[]>;
  getHoverText(uri: FsUri, position: Position): Promise<string | undefined>;
  mapSymbolKind?(kind: number): ArtifactType;
}
