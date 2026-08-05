import { FsUri, Position, Range } from '../domain/geometry';

export interface TextDocumentSnapshot {
  uri: FsUri;
  fsPath: string;
  lineCount: number;
  languageId?: string;
  getText(range?: Range): string;
  lineAt(line: number): string;
  offsetAt?(position: Position): number;
  positionAt?(offset: number): Position;
}

export interface DocumentPort {
  getOpenDocument(uri: FsUri | string): TextDocumentSnapshot | undefined;
  openDocument(uri: FsUri | string): Promise<TextDocumentSnapshot | undefined>;
  getActiveDocument(): TextDocumentSnapshot | undefined;
  getText(uri: FsUri | string, range?: Range): Promise<string>;
}
