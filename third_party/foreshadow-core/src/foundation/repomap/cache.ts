import { Artifact } from '../domain/artifact';
import { ArtifactContext } from '../domain/artifact-context';
import { Location } from '../domain/geometry';
import { EdgeType } from './edge-types';
import { vmRepoMapCacheValidTime } from '../config/constants';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class EdgeQCache {
  private cache = new Map<string, CacheEntry<Set<EdgeType>>>();
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  private getEdgeKey(keyA: string, keyB: string): string {
    return keyA < keyB ? `${keyA}||${keyB}` : `${keyB}||${keyA}`;
  }

  get(keyA: string, keyB: string): Set<EdgeType> | undefined {
    const edgeKey = this.getEdgeKey(keyA, keyB);
    const entry = this.cache.get(edgeKey);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > vmRepoMapCacheValidTime) {
      this.cache.delete(edgeKey);
      return undefined;
    }
    return entry.data;
  }

  add(keyA: string, keyB: string, type: EdgeType): void {
    const edgeKey = this.getEdgeKey(keyA, keyB);
    const entry = this.cache.get(edgeKey);
    if (!entry) {
      const set = new Set<EdgeType>([type]);
      this.cache.set(edgeKey, { data: set, timestamp: Date.now() });
    } else {
      entry.data.add(type);
      entry.timestamp = Date.now();
    }
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

export class ArtifactContextCache {
  private cache = new Map<string, CacheEntry<ArtifactContext>>();
  private readonly maxSize = 500;

  async updateByChangedLocation(changedLocation: Location): Promise<void> {
    for (const entry of this.cache.values()) {
      await entry.data.updateByChangedLocation(changedLocation);
    }
  }

  get(artifact: Artifact): ArtifactContext | undefined {
    if (!artifact.location) return undefined;
    const key = this.getKey(artifact);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > vmRepoMapCacheValidTime) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(artifact: Artifact, context: ArtifactContext): void {
    if (!artifact.location) return;
    const key = this.getKey(artifact);
    this.cache.set(key, { data: context, timestamp: Date.now() });
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  private getKey(artifact: Artifact): string {
    const loc = artifact.location!;
    const start = loc.range.start;
    return `${loc.uri.fsPath}|${start.line}|${start.character}|${artifact.type}`;
  }
}

export class CodeSnippetCache {
  private cache = new Map<string, CacheEntry<string>>();
  private readonly maxSize = 1000;

  get(location: Location): string | undefined {
    const key = this.getKey(location);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > vmRepoMapCacheValidTime) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(location: Location, snippet: string): void {
    const key = this.getKey(location);
    this.cache.set(key, { data: snippet, timestamp: Date.now() });
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  private getKey(location: Location): string {
    const start = location.range.start;
    return `${location.uri.fsPath}|${start.line}|${start.character}`;
  }
}
