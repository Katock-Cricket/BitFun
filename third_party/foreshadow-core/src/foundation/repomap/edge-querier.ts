import { Artifact } from '../domain/artifact';
import { Location, isSameFsPath, rangeContains } from '../domain/geometry';
import { LanguageIntelPort } from '../ports/language-intel-port';
import { EdgeQCache } from './cache';
import { EdgeType } from './edge-types';

export class EdgeQuerier {
  private readonly cache: EdgeQCache;

  constructor(private readonly languageIntel: LanguageIntelPort) {
    this.cache = new EdgeQCache();
  }

  public async getEdgeType(a: Artifact, b: Artifact): Promise<Set<EdgeType>> {
    if (!a || !b || a.equals(b)) {
      return new Set<EdgeType>([EdgeType.UNKNOWN]);
    }
    const keyA = this.getArtifactKey(a);
    const keyB = this.getArtifactKey(b);
    const cachedResult = this.cache.get(keyA, keyB);
    if (cachedResult !== undefined) return cachedResult;

    const ret = new Set<EdgeType>();
    try {
      let edgeType = this.checkContainsRelation(a, b);
      if (edgeType !== EdgeType.UNKNOWN) {
        this.cache.add(keyA, keyB, edgeType);
        ret.add(edgeType);
      }
      edgeType = await this.checkDefinitionRelation(a, b);
      if (edgeType !== EdgeType.UNKNOWN) {
        this.cache.add(keyA, keyB, edgeType);
        ret.add(edgeType);
      }
      edgeType = await this.checkTypeRelation(a, b);
      if (edgeType !== EdgeType.UNKNOWN) {
        this.cache.add(keyA, keyB, edgeType);
        ret.add(edgeType);
      }
      edgeType = await this.checkImplementsRelation(a, b);
      if (edgeType !== EdgeType.UNKNOWN) {
        this.cache.add(keyA, keyB, edgeType);
        ret.add(edgeType);
      }
      edgeType = await this.checkCallsRelation(a, b);
      if (edgeType !== EdgeType.UNKNOWN) {
        this.cache.add(keyA, keyB, edgeType);
        ret.add(edgeType);
      }
      edgeType = this.checkSameFileRelation(a, b);
      if (edgeType !== EdgeType.UNKNOWN) {
        this.cache.add(keyA, keyB, edgeType);
        ret.add(edgeType);
      }
    } catch (error) {
      console.warn('Error detecting edge type:', error);
    }
    if (ret.size === 0) {
      ret.add(EdgeType.UNKNOWN);
      this.cache.add(keyA, keyB, EdgeType.UNKNOWN);
    }
    return ret;
  }

  private getArtifactKey(artifact: Artifact): string {
    return `${artifact.location?.uri.fsPath}|${artifact.startPosition()}|${artifact.endPosition()}`;
  }

  private checkContainsRelation(a: Artifact, b: Artifact): EdgeType {
    if (a.hierarchy) {
      for (const child of a.hierarchy) {
        if (child.equals(b) || this.isArtifactInHierarchy(b, child.hierarchy)) return EdgeType.CONTAINS;
      }
    }
    if (b.hierarchy) {
      for (const child of b.hierarchy) {
        if (child.equals(a) || this.isArtifactInHierarchy(a, child.hierarchy)) return EdgeType.CONTAINS;
      }
    }
    return EdgeType.UNKNOWN;
  }

  private isArtifactInHierarchy(target: Artifact, hierarchy?: Artifact[]): boolean {
    if (!hierarchy) return false;
    for (const artifact of hierarchy) {
      if (artifact.equals(target) || this.isArtifactInHierarchy(target, artifact.hierarchy)) return true;
    }
    return false;
  }

  private async checkDefinitionRelation(a: Artifact, b: Artifact): Promise<EdgeType> {
    if (!a.location || !b.location) return EdgeType.UNKNOWN;
    try {
      const definitionsFromA = await this.languageIntel.getDefinition(a.location.uri, a.namePosition());
      if (definitionsFromA && this.isLocationMatch(definitionsFromA, b.location)) return EdgeType.DEFINITION;
      const referencesFromB = await this.languageIntel.getReferences(b.location.uri, b.namePosition());
      if (referencesFromB && this.isLocationMatch(referencesFromB, a.location)) return EdgeType.DEFINITION;
      const definitionsFromB = await this.languageIntel.getDefinition(b.location.uri, b.namePosition());
      if (definitionsFromB && this.isLocationMatch(definitionsFromB, a.location)) return EdgeType.DEFINITION;
      const referencesFromA = await this.languageIntel.getReferences(a.location.uri, a.namePosition());
      if (referencesFromA && this.isLocationMatch(referencesFromA, b.location)) return EdgeType.DEFINITION;
    } catch (error) {
      console.warn('Error checking definition relation:', error);
    }
    return EdgeType.UNKNOWN;
  }

  private async checkTypeRelation(a: Artifact, b: Artifact): Promise<EdgeType> {
    if (!a.location || !b.location) return EdgeType.UNKNOWN;
    try {
      const typeDefinitionsFromA = await this.languageIntel.getTypeDefinition(a.location.uri, a.namePosition());
      if (typeDefinitionsFromA && this.isLocationMatch(typeDefinitionsFromA, b.location)) return EdgeType.TYPE;
      const typeDefinitionsFromB = await this.languageIntel.getTypeDefinition(b.location.uri, b.namePosition());
      if (typeDefinitionsFromB && this.isLocationMatch(typeDefinitionsFromB, a.location)) return EdgeType.TYPE;
    } catch (error) {
      console.warn('Error checking type relation:', error);
    }
    return EdgeType.UNKNOWN;
  }

  private async checkImplementsRelation(a: Artifact, b: Artifact): Promise<EdgeType> {
    if (!a.location || !b.location) return EdgeType.UNKNOWN;
    try {
      const implementationsFromA = await this.languageIntel.getImplementations(a.location.uri, a.namePosition());
      if (implementationsFromA && this.isLocationMatch(implementationsFromA, b.location)) return EdgeType.IMPLEMENTS;
      const implementationsFromB = await this.languageIntel.getImplementations(b.location.uri, b.namePosition());
      if (implementationsFromB && this.isLocationMatch(implementationsFromB, a.location)) return EdgeType.IMPLEMENTS;
    } catch (error) {
      console.warn('Error checking implements relation:', error);
    }
    return EdgeType.UNKNOWN;
  }

  private async checkCallsRelation(a: Artifact, b: Artifact): Promise<EdgeType> {
    if (!a.location || !b.location) return EdgeType.UNKNOWN;
    const callableTypes = ['Function', 'Method', 'Constructor'];
    if (!callableTypes.includes(a.type) && !callableTypes.includes(b.type)) return EdgeType.UNKNOWN;
    try {
      const callHierarchyFromA = await this.languageIntel.prepareCallHierarchy(a.location.uri, a.namePosition());
      if (callHierarchyFromA && callHierarchyFromA.length > 0) {
        const outgoingCalls = await this.languageIntel.provideOutgoingCalls(callHierarchyFromA[0]);
        if (outgoingCalls && this.isCallHierarchyMatch(outgoingCalls, b.location)) return EdgeType.CALLS;
      }
      const callHierarchyFromB = await this.languageIntel.prepareCallHierarchy(b.location.uri, b.namePosition());
      if (callHierarchyFromB && callHierarchyFromB.length > 0) {
        const incomingCalls = await this.languageIntel.provideIncomingCalls(callHierarchyFromB[0]);
        if (incomingCalls && this.isIncomingCallMatch(incomingCalls, a.location)) return EdgeType.CALLS;
      }
    } catch (error) {
      console.warn('Error checking calls relation:', error);
    }
    return EdgeType.UNKNOWN;
  }

  private checkSameFileRelation(a: Artifact, b: Artifact): EdgeType {
    if (!a.location || !b.location) return EdgeType.UNKNOWN;
    if (isSameFsPath(a.location.uri, b.location.uri)) return EdgeType.SAME_FILE;
    return EdgeType.UNKNOWN;
  }

  private isLocationMatch(locations: Location[], target: Location): boolean {
    return locations.some(
      loc => isSameFsPath(loc.uri, target.uri) && rangeContains(loc.range, target.range),
    );
  }

  private isCallHierarchyMatch(
    calls: Array<{ to: { uri: Location['uri']; range: Location['range'] } }>,
    target: Location,
  ): boolean {
    return calls.some(
      call => isSameFsPath(call.to.uri, target.uri) && rangeContains(call.to.range, target.range),
    );
  }

  private isIncomingCallMatch(
    calls: Array<{ from: { uri: Location['uri']; range: Location['range'] } }>,
    target: Location,
  ): boolean {
    return calls.some(
      call => isSameFsPath(call.from.uri, target.uri) && rangeContains(call.from.range, target.range),
    );
  }
}
