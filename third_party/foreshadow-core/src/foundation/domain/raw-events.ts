import { FsUri, Position, Range } from './geometry';

export type TextChange = {
  range: Range;
  rangeOffset: number;
  rangeLength: number;
  text: string;
};

export type RawHostEvent =
  | {
      type: 'textChanged';
      uri: FsUri;
      /** Preferred path: incremental Monaco/VS Code changes. */
      changes: TextChange[];
      /** Optional full-file text before the edit batch (VS Code bridge may still send). */
      beforeText?: string;
      /** Optional full-file text after the edit batch. */
      afterText?: string;
    }
  | {
      type: 'selectionChanged';
      uri: FsUri;
      selections: Range[];
      active: Position;
      kind?: 'select' | 'cursor';
    }
  | {
      type: 'activeEditorChanged';
      uri: FsUri | null;
      previousUri?: FsUri;
      lineCount?: number;
    }
  | {
      type: 'fileRenamed';
      oldUri: FsUri;
      newUri: FsUri;
    }
  | {
      type: 'terminalCommand';
      processId: string;
      cmd: string;
      output: string;
      phase: 'start' | 'end';
    };
