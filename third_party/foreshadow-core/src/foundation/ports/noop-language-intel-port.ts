import { FsUri, Location, Position } from '../domain/geometry';
import { SymbolRef } from '../domain/artifact';
import {
  CallHierarchyIncomingCall,
  CallHierarchyItemRef,
  CallHierarchyOutgoingCall,
  LanguageIntelPort,
} from './language-intel-port';

/**
 * No-op LanguageIntelPort for hosts without LSP (e.g. BitFun v1).
 * Safe empty results; never throws.
 */
export class NoopLanguageIntelPort implements LanguageIntelPort {
  async getDocumentSymbols(_uri: FsUri): Promise<SymbolRef[]> {
    return [];
  }

  async getDefinition(_uri: FsUri, _position: Position): Promise<Location[]> {
    return [];
  }

  async getTypeDefinition(_uri: FsUri, _position: Position): Promise<Location[]> {
    return [];
  }

  async getReferences(
    _uri: FsUri,
    _position: Position,
    _includeDeclaration?: boolean,
  ): Promise<Location[]> {
    return [];
  }

  async getImplementations(_uri: FsUri, _position: Position): Promise<Location[]> {
    return [];
  }

  async prepareCallHierarchy(
    _uri: FsUri,
    _position: Position,
  ): Promise<CallHierarchyItemRef[]> {
    return [];
  }

  async provideIncomingCalls(_item: CallHierarchyItemRef): Promise<CallHierarchyIncomingCall[]> {
    return [];
  }

  async provideOutgoingCalls(_item: CallHierarchyItemRef): Promise<CallHierarchyOutgoingCall[]> {
    return [];
  }

  async getHoverText(_uri: FsUri, _position: Position): Promise<string | undefined> {
    return undefined;
  }
}

export const noopLanguageIntelPort = new NoopLanguageIntelPort();
