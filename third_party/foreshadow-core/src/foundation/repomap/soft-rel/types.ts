import { codeSnippetSize, softRelExpireDays, softRelFreqSize } from '../../config/constants';
import { TextDocumentSnapshot } from '../../ports/document-port';

export interface SoftRelQueryResult {
  relation: SoftRelation;
  targetNode: SoftRelNode;
  overlap: number;
  overlapRatio: number;
  weight: number;
  score: number;
}

export class DayFreq {
  constructor(public day: number, public count: number) {}
  static fromJSONObject(obj: any) {
    return new DayFreq(obj.day, obj.count);
  }
  toJSONObject() {
    return { day: this.day, count: this.count };
  }
}

export class SoftRelNode {
  constructor(
    public fsPath: string,
    public startLine: number,
    public endLine: number,
  ) {}

  static fromJSONObject(obj: any) {
    return new SoftRelNode(obj.uri, obj.startLine, obj.endLine);
  }

  static fromDocLine(document: TextDocumentSnapshot, line: number) {
    return new SoftRelNode(
      document.uri.fsPath,
      Math.max(line - codeSnippetSize.upToLines, 0),
      Math.min(line + codeSnippetSize.downToLines, document.lineCount),
    );
  }

  toJSONObject() {
    return {
      uri: this.fsPath,
      startLine: this.startLine,
      endLine: this.endLine,
    };
  }
}

export class SoftRelation {
  constructor(
    public nodeA: SoftRelNode,
    public nodeB: SoftRelNode,
    public freq: DayFreq[],
  ) {}

  getWeight(): number {
    if (this.freq.length === 0) return 0;
    let weight = 0.0;
    for (const f of this.freq) weight += f.count;
    return weight / this.freq.length;
  }

  updateFreq() {
    const now = new Date();
    const day = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    for (const f of this.freq) {
      if (f.day === day) {
        f.count += 1;
        return;
      }
    }
    this.freq.push(new DayFreq(day, 1));
    if (this.freq.length > softRelFreqSize) {
      this.freq.shift();
    }
  }

  getLastTriggerDay(): number {
    if (this.freq.length === 0) return 0;
    return this.freq[this.freq.length - 1].day;
  }

  isExpired(expireDays: number = softRelExpireDays): boolean {
    const lastDay = this.getLastTriggerDay();
    if (lastDay === 0) return true;
    const now = new Date();
    const today = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    return this.calculateDaysDiff(lastDay, today) > expireDays;
  }

  private calculateDaysDiff(day1: number, day2: number): number {
    const year1 = Math.floor(day1 / 10000);
    const month1 = Math.floor((day1 % 10000) / 100);
    const date1 = day1 % 100;
    const year2 = Math.floor(day2 / 10000);
    const month2 = Math.floor((day2 % 10000) / 100);
    const date2 = day2 % 100;
    const d1 = new Date(year1, month1 - 1, date1);
    const d2 = new Date(year2, month2 - 1, date2);
    const diffTime = Math.abs(d2.getTime() - d1.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  static fromJSONObject(obj: any) {
    return new SoftRelation(
      SoftRelNode.fromJSONObject(obj.nodeA),
      SoftRelNode.fromJSONObject(obj.nodeB),
      obj.freq.map((f: any) => new DayFreq(f.day, f.count)),
    );
  }

  toJSONObject() {
    return {
      nodeA: this.nodeA.toJSONObject(),
      nodeB: this.nodeB.toJSONObject(),
      freq: this.freq.map(f => f.toJSONObject()),
    };
  }
}
