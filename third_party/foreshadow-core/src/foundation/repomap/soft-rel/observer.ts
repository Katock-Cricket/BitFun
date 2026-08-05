import { TextDocumentSnapshot } from '../../ports/document-port';
import {
  codeSnippetSize,
  softRelDwellThreshold,
  softRelLoopTimeWindow,
  softRelMinOverlapRatio,
} from '../../config/constants';
import { makePosition } from '../../domain/geometry';
import { LanguageIntelPort } from '../../ports/language-intel-port';
import { getArtifactFromRange } from '../../log/context-process';
import { EdgeType } from '../edge-types';
import { isSameFsPath } from '../../domain/geometry';

interface TracePoint {
  fsPath: string;
  line: number;
  timestamp: number;
  document: TextDocumentSnapshot;
}

const hardRelTypes = [
  EdgeType.DEFINITION,
  EdgeType.IMPLEMENTS,
  EdgeType.TYPE,
  EdgeType.CALLS,
  EdgeType.CONTAINS,
];

export class SoftRelObserver {
  private dwellTimer: any = null;
  private traceStack: TracePoint[] = [];

  constructor(
    private readonly updateCallback: (
      docA: TextDocumentSnapshot,
      lineA: number,
      docB: TextDocumentSnapshot,
      lineB: number,
    ) => Promise<void>,
    private readonly languageIntel: LanguageIntelPort,
    private readonly getEdgeType?: (a: any, b: any) => Promise<Set<string>>,
    private readonly scheduleTimeout?: (handler: () => void, ms: number) => { dispose(): void },
  ) {}

  public observe(doc: TextDocumentSnapshot, line: number) {
    if (this.dwellTimer?.dispose) this.dwellTimer.dispose();
    else if (this.dwellTimer) clearTimeout(this.dwellTimer);

    if (this.scheduleTimeout) {
      this.dwellTimer = this.scheduleTimeout(() => {
        this.handleStablePoint(doc, line).catch(error =>
          console.error('Error in SoftRelObserver handleStablePoint: ', error),
        );
      }, softRelDwellThreshold);
    } else {
      this.dwellTimer = setTimeout(() => {
        this.handleStablePoint(doc, line).catch(error =>
          console.error('Error in SoftRelObserver handleStablePoint: ', error),
        );
      }, softRelDwellThreshold);
    }
  }

  private async handleStablePoint(doc: TextDocumentSnapshot, line: number): Promise<void> {
    const currentPoint: TracePoint = {
      fsPath: doc.uri.fsPath,
      line,
      timestamp: Date.now(),
      document: doc,
    };
    try {
      if (this.traceStack.length >= 2) {
        const pointA = this.traceStack[this.traceStack.length - 2];
        const pointB = this.traceStack[this.traceStack.length - 1];
        if (this.isLoopPattern(pointA, pointB, currentPoint)) {
          console.log(
            `SoftRelObserver: detect loop pattern: ${pointA.fsPath}:${pointA.line} <-> ${pointB.fsPath}:${pointB.line}`,
          );
          await this.processPotentialSoftRel(pointA, pointB);
        }
      }
      this.updateTraceStack(currentPoint);
    } catch (error) {
      console.error('Error in SoftRelObserver handleStablePoint: ', error);
    }
  }

  private isLoopPattern(pointA: TracePoint, pointB: TracePoint, current: TracePoint): boolean {
    if (current.timestamp - pointA.timestamp > softRelLoopTimeWindow) return false;
    if (!this.isSignificantDistance(pointA, pointB)) return false;
    return this.isNear(pointA, current);
  }

  private async processPotentialSoftRel(pointA: TracePoint, pointB: TracePoint) {
    const artifactA = await getArtifactFromRange(
      this.languageIntel,
      pointA.document.uri,
      makePosition(pointA.line, 0),
      makePosition(pointA.line, 0),
      pointA.document.lineCount,
    );
    const artifactB = await getArtifactFromRange(
      this.languageIntel,
      pointB.document.uri,
      makePosition(pointB.line, 0),
      makePosition(pointB.line, 0),
      pointB.document.lineCount,
    );
    if (!artifactA || !artifactB) return;

    let edgeTypes: Set<string> = new Set([EdgeType.UNKNOWN]);
    if (this.getEdgeType) {
      try {
        edgeTypes = await this.getEdgeType(artifactA, artifactB);
      } catch (error) {
        console.error('Error in SoftRelObserver processPotentialSoftRel: ', error);
      }
    }

    const isHardRel = edgeTypes.size > 0 && hardRelTypes.some(type => edgeTypes.has(type));
    if (!isHardRel) {
      await this.updateCallback(pointA.document, pointA.line, pointB.document, pointB.line);
    }
  }

  private updateTraceStack(newPoint: TracePoint) {
    this.traceStack.push(newPoint);
    if (this.traceStack.length > 5) this.traceStack.shift();
  }

  private isSignificantDistance(p1: TracePoint, p2: TracePoint): boolean {
    if (!isSameFsPath(p1.fsPath, p2.fsPath)) return true;
    return Math.abs(p1.line - p2.line) > codeSnippetSize.upToLines + codeSnippetSize.downToLines;
  }

  private isNear(p1: TracePoint, p2: TracePoint): boolean {
    if (!isSameFsPath(p1.fsPath, p2.fsPath)) return false;
    return (
      Math.abs(p1.line - p2.line) <=
      Math.floor(softRelMinOverlapRatio * (codeSnippetSize.upToLines + codeSnippetSize.downToLines))
    );
  }
}
