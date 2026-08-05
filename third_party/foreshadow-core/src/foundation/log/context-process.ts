import * as logItem from '../domain/log-item';
import { EventType } from '../domain/event-types';
import { Artifact, ArtifactType, ArtifactTypeCanLogInEdit, SymbolRef } from '../domain/artifact';
import { FsUri, Position, makeLocation, makePosition, makeRange, makeUri } from '../domain/geometry';
import { LanguageIntelPort } from '../ports/language-intel-port';
import { TextChange } from '../domain/raw-events';

function mapKind(kind: ArtifactType | number | string): ArtifactType {
  if (typeof kind === 'string' && Object.values(ArtifactType).includes(kind as ArtifactType)) {
    return kind as ArtifactType;
  }
  // vscode.SymbolKind numeric fallbacks
  const map: Record<number, ArtifactType> = {
    0: ArtifactType.File,
    1: ArtifactType.Module,
    2: ArtifactType.Namespace,
    3: ArtifactType.Package,
    4: ArtifactType.Class,
    5: ArtifactType.Method,
    6: ArtifactType.Property,
    7: ArtifactType.Field,
    8: ArtifactType.Constructor,
    9: ArtifactType.Enum,
    10: ArtifactType.Interface,
    11: ArtifactType.Function,
    12: ArtifactType.Variable,
    13: ArtifactType.Constant,
    14: ArtifactType.String,
    15: ArtifactType.Number,
    16: ArtifactType.Boolean,
    17: ArtifactType.Array,
    18: ArtifactType.Object,
    19: ArtifactType.Key,
    20: ArtifactType.Null,
    21: ArtifactType.EnumMember,
    22: ArtifactType.Struct,
    23: ArtifactType.Event,
    24: ArtifactType.Operator,
    25: ArtifactType.TypeParameter,
  };
  if (typeof kind === 'number') {
    return map[kind] ?? ArtifactType.Unknown;
  }
  return ArtifactType.Unknown;
}

export async function getArtifactFromRange(
  languageIntel: LanguageIntelPort,
  uri: FsUri,
  start: Position,
  end: Position,
  fileLineCount: number = 0,
  isEdit: boolean = false,
): Promise<Artifact> {
  const fileUri = typeof uri === 'string' ? makeUri(uri as any) : uri;
  const hierarchy: Artifact[] = [
    new Artifact(
      fileUri.fsPath,
      ArtifactType.File,
      makeLocation(fileUri, makeRange(makePosition(0, 0), makePosition(fileLineCount, 0))),
      {
        name: fileUri.fsPath,
        kind: ArtifactType.File,
        selectionStart: makePosition(0, 0),
        range: makeRange(makePosition(0, 0), makePosition(fileLineCount, 0)),
      },
    ),
  ];

  const symbols = await languageIntel.getDocumentSymbols(fileUri);
  if (!symbols || symbols.length === 0) {
    return hierarchy[0];
  }

  let curSymbols: SymbolRef[] = symbols;
  while (curSymbols.length > 0) {
    let isFind = false;
    for (const symbol of curSymbols) {
      const artifactType = mapKind(symbol.kind as any);
      if (isEdit && !ArtifactTypeCanLogInEdit.includes(artifactType)) {
        continue;
      }
      const afterOrEqual =
        symbol.range.end.line > start.line ||
        (symbol.range.end.line === start.line && symbol.range.end.character >= start.character);
      const beforeOrEqual =
        symbol.range.start.line < end.line ||
        (symbol.range.start.line === end.line && symbol.range.start.character <= end.character);
      if (afterOrEqual && beforeOrEqual) {
        hierarchy.push(
          new Artifact(
            symbol.name,
            artifactType,
            makeLocation(fileUri, makeRange(symbol.range.start, symbol.range.end)),
            symbol,
          ),
        );
        curSymbols = (symbol as any).children || [];
        // if SymbolRef doesn't have children nested, flatten search stops
        if (!Array.isArray(curSymbols) || curSymbols.length === 0) {
          // keep looking for nested via recursive search in original tree not available; stop
          curSymbols = [];
        }
        isFind = true;
        break;
      }
    }
    if (!isFind) break;
  }

  const artifactSelf = hierarchy[hierarchy.length - 1];
  return new Artifact(
    artifactSelf.name,
    artifactSelf.type,
    artifactSelf.location,
    artifactSelf.symbol,
    hierarchy,
  );
}

export async function getLogItemFromSelectedText(
  languageIntel: LanguageIntelPort,
  uri: FsUri,
  text: string,
  start: Position,
  end: Position,
  lineCount: number,
): Promise<logItem.LogItem> {
  const artifact = await getArtifactFromRange(languageIntel, uri, start, end, lineCount);
  const context = new logItem.Context(
    logItem.ContextType.Select,
    { before: '', after: text },
    { line: start.line + 1, character: start.character + 1 },
    { line: end.line + 1, character: end.character + 1 },
  );
  return new logItem.LogItem(EventType.SelectText, artifact, context);
}

/**
 * Build per-change before/after strings for Edit History.
 * Prefers full beforeText when provided; otherwise falls back to afterText reverse-apply,
 * then to local change text only (BitFun incremental path).
 */
function resolveChangeBeforeAfter(
  change: TextChange,
  beforeText: string | undefined,
  afterText: string | undefined,
): { before: string; after: string } {
  if (typeof beforeText === 'string') {
    const before = beforeText;
    const after =
      before.substring(0, change.rangeOffset) +
      change.text +
      before.substring(change.rangeOffset + change.rangeLength);
    return { before, after };
  }

  if (typeof afterText === 'string' && change.rangeOffset >= 0) {
    // Reverse a single replacement: after = prefix + text + suffix
    const prefix = afterText.substring(0, change.rangeOffset);
    const suffix = afterText.substring(change.rangeOffset + change.text.length);
    // Prefer reconstructing deleted span length only when rangeLength is known;
    // without beforeText we cannot recover exact deleted content — use empty delete span.
    const beforeExact = prefix + suffix; // approximate when deleted text unknown
    // If rangeLength > 0 but content unknown, keep markers meaningful via empty middle.
    const recoveredBefore =
      change.rangeLength > 0
        ? prefix + `[${change.rangeLength} chars]` + suffix
        : beforeExact;
    return { before: recoveredBefore, after: afterText };
  }

  // Local-only fallback: treat the inserted text as the after side of a tiny edit window.
  return {
    before: '',
    after: change.text ?? '',
  };
}

export async function getLogItemsFromChangedText(
  languageIntel: LanguageIntelPort,
  uri: FsUri,
  lineCount: number,
  beforeText: string | undefined,
  changes: TextChange[],
  afterText?: string,
): Promise<logItem.LogItem[]> {
  const logItems: logItem.LogItem[] = [];
  const list = Array.isArray(changes) ? changes : [];

  // No granular changes but full after snapshot — still record a file-level edit.
  if (list.length === 0 && (typeof beforeText === 'string' || typeof afterText === 'string')) {
    const start = { line: 0, character: 0 };
    const end = { line: Math.max(0, lineCount - 1), character: 0 };
    const artifact = await getArtifactFromRange(languageIntel, uri, start, end, lineCount, true);
    const before = beforeText ?? '';
    const after = afterText ?? beforeText ?? '';
    if (before !== after) {
      const context = new logItem.Context(
        logItem.ContextType.Edit,
        { before, after },
        { line: 1, character: 0 },
        { line: Math.max(1, lineCount), character: 0 },
      );
      logItems.push(new logItem.LogItem(EventType.EditTextDocument, artifact, context));
    }
    return logItems;
  }

  for (const change of list) {
    const editPosStart = change.range.start;
    const editPosEnd = change.range.end;
    const artifact = await getArtifactFromRange(languageIntel, uri, editPosStart, editPosEnd, lineCount, true);
    // File-level Artifact always carries a symbol; keep guard for safety.
    if (!artifact) {
      console.error('getArtifactFromRange failed');
      continue;
    }
    const { before, after } = resolveChangeBeforeAfter(change, beforeText, afterText);
    const context = new logItem.Context(
      logItem.ContextType.Edit,
      { before, after },
      { line: editPosStart.line + 1, character: 0 },
      { line: editPosEnd.line + 1, character: 0 },
    );
    logItems.push(new logItem.LogItem(EventType.EditTextDocument, artifact, context));
  }
  return logItems;
}
