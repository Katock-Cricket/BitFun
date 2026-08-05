import { SoftRelation, SoftRelNode } from './types';
import { softRelMinOverlapRatio, codeSnippetSize } from '../../config/constants';
import { TextDocumentSnapshot } from '../../ports/document-port';

export class SoftRelQuerier {
  private uriIndex: Map<string, Set<SoftRelation>> = new Map();

  getFromUri(uri: string): Set<SoftRelation> | undefined {
    return this.uriIndex.get(uri);
  }

  setIndexUri(uri: string, rel: Set<SoftRelation>) {
    this.uriIndex.set(uri, rel);
  }

  delIndexUri(uri: string) {
    this.uriIndex.delete(uri);
  }

  update(uri: string, softRel: SoftRelation) {
    const uriSet = this.getFromUri(uri);
    if (uriSet) {
      uriSet.add(softRel);
    } else {
      this.setIndexUri(uri, new Set([softRel]));
    }
  }

  remove(uri: string, softRel: SoftRelation) {
    const uriSet = this.getFromUri(uri);
    if (uriSet) {
      uriSet.delete(softRel);
      if (uriSet.size === 0) this.delIndexUri(uri);
    }
  }

  findExistingRelation(nodeA: SoftRelNode, nodeB: SoftRelNode): SoftRelation | undefined {
    const setA = this.uriIndex.get(nodeA.fsPath);
    const setB = this.uriIndex.get(nodeB.fsPath);
    if (!setA || !setB) return undefined;
    const candidates: SoftRelation[] = [];
    for (const rel of setA) {
      if (setB.has(rel)) candidates.push(rel);
    }
    if (candidates.length === 0) return undefined;
    let bestMatch: SoftRelation | undefined;
    let maxOverlapRatio = 0;
    for (const rel of candidates) {
      const overlapAARatio =
        this.calculateOverlap(nodeA.startLine, nodeA.endLine, rel.nodeA.startLine, rel.nodeA.endLine) /
        Math.max(1, nodeA.endLine - nodeA.startLine);
      const overlapABRatio =
        this.calculateOverlap(nodeA.startLine, nodeA.endLine, rel.nodeB.startLine, rel.nodeB.endLine) /
        Math.max(1, nodeA.endLine - nodeA.startLine);
      const overlapBARatio =
        this.calculateOverlap(nodeB.startLine, nodeB.endLine, rel.nodeA.startLine, rel.nodeA.endLine) /
        Math.max(1, nodeB.endLine - nodeB.startLine);
      const overlapBBRatio =
        this.calculateOverlap(nodeB.startLine, nodeB.endLine, rel.nodeB.startLine, rel.nodeB.endLine) /
        Math.max(1, nodeB.endLine - nodeB.startLine);
      const overlapPattern1 = Math.min(overlapAARatio, overlapBBRatio);
      const overlapPattern2 = Math.min(overlapABRatio, overlapBARatio);
      const overlapRatio = Math.max(overlapPattern1, overlapPattern2);
      if (overlapRatio === overlapPattern2) {
        const tmp = rel.nodeA;
        rel.nodeA = rel.nodeB;
        rel.nodeB = tmp;
      }
      if (overlapRatio >= softRelMinOverlapRatio && overlapRatio > maxOverlapRatio) {
        maxOverlapRatio = overlapRatio;
        bestMatch = rel;
      }
    }
    return bestMatch;
  }

  mergeNodes(existingNode: SoftRelNode, newNode: SoftRelNode, document: TextDocumentSnapshot): SoftRelNode {
    const overlapStart = Math.max(existingNode.startLine, newNode.startLine);
    const overlapEnd = Math.min(existingNode.endLine, newNode.endLine);
    const overlapCenter = Math.floor((overlapStart + overlapEnd) / 2);
    const mergedStart = Math.max(0, overlapCenter - codeSnippetSize.upToLines);
    const mergedEnd = Math.min(document.lineCount, overlapCenter + codeSnippetSize.downToLines);
    return new SoftRelNode(existingNode.fsPath, mergedStart, mergedEnd);
  }

  calculateOverlap(queryStart: number, queryEnd: number, nodeStart: number, nodeEnd: number): number {
    return Math.max(0, Math.min(queryEnd, nodeEnd) - Math.max(queryStart, nodeStart));
  }
}
