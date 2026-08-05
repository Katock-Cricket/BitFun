export interface FsUri {
  fsPath: string;
  scheme?: string;
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: FsUri;
  range: Range;
}

export function makeUri(fsPath: string, scheme: string = 'file'): FsUri {
  return { fsPath, scheme };
}

export function makePosition(line: number, character: number): Position {
  return { line, character };
}

export function makeRange(start: Position, end: Position): Range {
  return { start, end };
}

export function makeLocation(uri: FsUri, range: Range): Location {
  return { uri, range };
}

export function positionCompare(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

export function rangeContains(outer: Range, inner: Range): boolean {
  return positionCompare(outer.start, inner.start) <= 0 && positionCompare(outer.end, inner.end) >= 0;
}

export function isSameFsPath(a: FsUri | string, b: FsUri | string): boolean {
  const ap = typeof a === 'string' ? a : a.fsPath;
  const bp = typeof b === 'string' ? b : b.fsPath;
  return ap.replace(/\\/g, '/').toLowerCase() === bp.replace(/\\/g, '/').toLowerCase();
}
