import * as path from 'path';
import { codeSnippetSize, softRelExpireDays, softRelMinOverlapRatio } from '../../config/constants';
import { SoftRelation, SoftRelNode, SoftRelQueryResult, DayFreq } from './types';
import { SoftRelObserver } from './observer';
import { SoftRelQuerier } from './rel-querier';
import { FileSystemPort } from '../../ports/filesystem-port';
import { WorkspacePort } from '../../ports/workspace-port';
import { TextDocumentSnapshot } from '../../ports/document-port';
import { LanguageIntelPort } from '../../ports/language-intel-port';
import { SchedulerPort } from '../../ports/scheduler-port';

export class SoftRelationMap {
  private isInitialized = false;
  private dbPath: string = '';
  private softRelations: Set<SoftRelation> = new Set();
  private querier: SoftRelQuerier = new SoftRelQuerier();
  private observer: SoftRelObserver;

  constructor(
    private readonly fs: FileSystemPort,
    private readonly workspace: WorkspacePort,
    languageIntel: LanguageIntelPort,
    getEdgeType?: (a: any, b: any) => Promise<Set<string>>,
    scheduler?: SchedulerPort,
  ) {
    this.init().catch(error => console.error(error));
    this.observer = new SoftRelObserver(
      this.updateSoftRel.bind(this),
      languageIntel,
      getEdgeType,
      scheduler ? (h, ms) => scheduler.setTimeout(h, ms) : undefined,
    );
  }

  public observeCursorMove(doc: TextDocumentSnapshot, line: number) {
    this.observer.observe(doc, line);
  }

  public async save(): Promise<void> {
    if (!this.isInitialized) {
      console.error('SoftRelationMap not initialized. Cannot save.');
      return;
    }
    this.cleanExpiredRelations();
    const dir = path.dirname(this.dbPath);
    await this.fs.mkdirp(dir);
    const lines = Array.from(this.softRelations)
      .map(rel => JSON.stringify(rel.toJSONObject()))
      .join('\n');
    await this.fs.writeFile(this.dbPath, lines);
    console.log(`Saved ${this.softRelations.size} soft relations to ${this.dbPath}`);
  }

  public async getSoftRels(doc: TextDocumentSnapshot, line: number, topK: number = 5): Promise<SoftRelQueryResult[]> {
    if (!this.isInitialized) {
      return [];
    }
    const queryNode = SoftRelNode.fromDocLine(doc, line);
    const uri = queryNode.fsPath;
    const queryStart = queryNode.startLine;
    const queryEnd = queryNode.endLine;
    const queryRange = Math.max(1, queryEnd - queryStart);
    const relatedRels = this.querier.getFromUri(uri);
    if (!relatedRels || relatedRels.size === 0) return [];
    const results: SoftRelQueryResult[] = [];
    for (const rel of relatedRels) {
      const matchA = this.matchNode(rel.nodeA, uri, queryStart, queryEnd);
      const matchB = this.matchNode(rel.nodeB, uri, queryStart, queryEnd);
      let overlap = 0;
      let targetNode: SoftRelNode | null = null;
      if (matchA.matched && !matchB.matched) {
        overlap = matchA.overlapRatio;
        targetNode = rel.nodeB;
      } else if (matchB.matched && !matchA.matched) {
        overlap = matchB.overlapRatio;
        targetNode = rel.nodeA;
      } else if (matchA.matched && matchB.matched) {
        if (matchA.overlapRatio < matchB.overlapRatio) {
          overlap = matchA.overlapRatio;
          targetNode = rel.nodeB;
        } else {
          overlap = matchB.overlapRatio;
          targetNode = rel.nodeA;
        }
      }
      if (targetNode && overlap > 0) {
        const overlapRatio = overlap / queryRange;
        const weight = rel.getWeight();
        results.push({
          relation: rel,
          targetNode,
          overlap,
          overlapRatio,
          weight,
          score: overlapRatio * weight,
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  public async updateSoftRel(
    docA: TextDocumentSnapshot,
    lineA: number,
    docB: TextDocumentSnapshot,
    lineB: number,
  ): Promise<void> {
    if (
      docA.uri.fsPath === docB.uri.fsPath &&
      Math.abs(lineA - lineB) <= codeSnippetSize.upToLines + codeSnippetSize.downToLines
    ) {
      return;
    }
    const nodeA = SoftRelNode.fromDocLine(docA, lineA);
    const nodeB = SoftRelNode.fromDocLine(docB, lineB);
    const existing = this.querier.findExistingRelation(nodeA, nodeB);
    if (existing) {
      const mergedNodeA = this.querier.mergeNodes(existing.nodeA, nodeA, docA);
      const mergedNodeB = this.querier.mergeNodes(existing.nodeB, nodeB, docB);
      this.querier.remove(existing.nodeA.fsPath, existing);
      this.querier.remove(existing.nodeB.fsPath, existing);
      this.softRelations.delete(existing);
      existing.nodeA = mergedNodeA;
      existing.nodeB = mergedNodeB;
      existing.updateFreq();
      this.softRelations.add(existing);
      this.querier.update(mergedNodeA.fsPath, existing);
      this.querier.update(mergedNodeB.fsPath, existing);
      return;
    }
    const now = new Date();
    const day = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const softRel = new SoftRelation(nodeA, nodeB, [new DayFreq(day, 1)]);
    this.softRelations.add(softRel);
    this.querier.update(nodeA.fsPath, softRel);
    this.querier.update(nodeB.fsPath, softRel);
  }

  private async init(): Promise<void> {
    const root = this.workspace.getPrimaryRoot();
    if (!root) {
      console.warn('No workspace folder found. SoftRelationMap not initialized.');
      return;
    }
    this.dbPath = path.join(this.workspace.getDataDir(), 'soft-rel.jsonl');
    try {
      await this.load2RAM();
      this.cleanExpiredRelations();
      this.isInitialized = true;
    } catch (error) {
      console.error('Failed to load soft relations from file.', error);
    }
  }

  private async load2RAM() {
    if (!this.fs.exists(this.dbPath)) {
      console.log(`No soft relations file found at ${this.dbPath}, init empty soft relations.`);
      return;
    }
    const fileContent = await this.fs.readFile(this.dbPath);
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');
    for (const line of lines) {
      const obj = JSON.parse(line);
      const softRel = SoftRelation.fromJSONObject(obj);
      this.softRelations.add(softRel);
      this.querier.update(softRel.nodeA.fsPath, softRel);
      this.querier.update(softRel.nodeB.fsPath, softRel);
    }
    console.log(`Loaded ${this.softRelations.size} soft relations from ${this.dbPath}`);
  }

  private matchNode(
    node: SoftRelNode,
    uri: string,
    startLine: number,
    endLine: number,
  ): { matched: boolean; overlapRatio: number } {
    if (node.fsPath !== uri) return { matched: false, overlapRatio: 0 };
    const overlap = this.querier.calculateOverlap(startLine, endLine, node.startLine, node.endLine);
    const overlapRatioA = overlap / Math.max(1, endLine - startLine);
    const overlapRatioB = overlap / Math.max(1, node.endLine - node.startLine);
    const overlapRatio = Math.min(overlapRatioA, overlapRatioB);
    return { matched: overlapRatio >= softRelMinOverlapRatio, overlapRatio };
  }

  private cleanExpiredRelations(expireDays: number = softRelExpireDays): number {
    const expiredRelations: SoftRelation[] = [];
    for (const rel of this.softRelations) {
      if (rel.isExpired(expireDays)) expiredRelations.push(rel);
    }
    for (const rel of expiredRelations) {
      this.softRelations.delete(rel);
      this.querier.remove(rel.nodeA.fsPath, rel);
      this.querier.remove(rel.nodeB.fsPath, rel);
    }
    return expiredRelations.length;
  }
}
