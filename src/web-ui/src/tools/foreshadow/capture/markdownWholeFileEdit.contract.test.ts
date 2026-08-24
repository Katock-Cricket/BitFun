/**
 * Contract tests against the installed @foreshadow/core, driving the REAL
 * FoundationRuntime pipeline (publish -> EventIngress -> getLogItemsFromChangedText
 * -> LogStore -> mergeEditLogs -> Foreshadow.updateByLog -> toAbstract).
 *
 * These reproduce the BitFun Markdown "after-only whole-file" edit path (empty
 * changes[] + beforeText/afterText snapshots) and lock in the expected diff /
 * merge behavior for the agent-facing abstract.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FoundationRuntime,
  noopLanguageIntelPort,
  type ConfigPort,
  type DocumentPort,
  type FileSystemPort,
  type FoundationPorts,
  type LLMPort,
  type SchedulerPort,
  type TextDocumentSnapshot,
  type WorkspacePort,
  type WorkspaceSearchPort,
  makeUri,
} from '@foreshadow/core';

const FILE = 'D:/Workspace/bitfun_x_foreshadow/foreshadow/docs/架构说明书.md';
const RAW = readFileSync(FILE, 'utf8');
const LC = RAW.split(/\n/).length;

function makeSnapshot(text: string): TextDocumentSnapshot {
  const uri = makeUri(FILE);
  const lines = text.split(/\n/);
  return {
    uri,
    fsPath: FILE,
    lineCount: lines.length,
    languageId: 'markdown',
    getText: () => text,
    lineAt: (line: number) => lines[line] ?? '',
  };
}

function buildPorts(docText: () => string): FoundationPorts {
  const documents: DocumentPort = {
    getOpenDocument: () => makeSnapshot(docText()),
    openDocument: async () => makeSnapshot(docText()),
    getActiveDocument: () => makeSnapshot(docText()),
    getText: async () => docText(),
  };
  const workspace: WorkspacePort = {
    getWorkspaceRoots: () => [makeUri('D:/Workspace/bitfun_x_foreshadow')],
    getPrimaryRoot: () => makeUri('D:/Workspace/bitfun_x_foreshadow'),
    resolvePath: (...parts: string[]) => parts.join('/'),
    getDataDir: () => 'D:/Workspace/bitfun_x_foreshadow/.foreshadow',
    getExtensionPath: () => '',
    isInWorkspace: () => true,
  };
  const search: WorkspaceSearchPort = {
    search: async () => ({ success: false, matches: [], error: 'stub' }),
  };
  const fs: FileSystemPort = {
    exists: () => false,
    readFile: async () => '',
    writeFile: async () => undefined,
    mkdirp: async () => undefined,
  };
  const config: ConfigPort = {
    get: (_key, defaultValue) => defaultValue as never,
    onDidChange: () => ({ dispose: () => undefined }),
  };
  const scheduler: SchedulerPort = {
    setInterval: () => ({ dispose: () => undefined }),
    setTimeout: () => ({ dispose: () => undefined }),
  };
  const llm: LLMPort = {
    isConfigured: () => false,
    chat: async () => ({ content: '' }),
  };
  return {
    documents,
    languageIntel: noopLanguageIntelPort,
    workspace,
    search,
    fs,
    config,
    scheduler,
    llm,
  };
}

function insertMarker(text: string, lineIdx: number, marker = '测试内容'): string {
  const lines = text.split(/\n/);
  return [
    ...lines.slice(0, lineIdx),
    lines[lineIdx] + marker,
    ...lines.slice(lineIdx + 1),
  ].join('\n');
}

async function publishEdit(runtime: FoundationRuntime, beforeText: string, afterText: string): Promise<void> {
  await runtime.publish({
    type: 'textChanged',
    uri: makeUri(FILE),
    changes: [],
    beforeText,
    afterText,
  });
}

describe('markdown whole-file edit contract (@foreshadow/core)', () => {
  it('add-then-delete (net zero) is NOT recorded in the abstract', async () => {
    let current = RAW;
    const runtime = new FoundationRuntime(buildPorts(() => current));

    const added = insertMarker(RAW, 200);
    current = added;
    await publishEdit(runtime, RAW, added);
    current = RAW;
    await publishEdit(runtime, added, RAW);

    const abstract = runtime.foreshadow.toAbstract();
    expect(abstract).not.toContain('EditTextDocument');
    expect(abstract).not.toContain('<|Insert|>');
    expect(abstract).not.toContain('<|Delete|>');
  });

  it('a single real edit yields a localized hunk with padding only', async () => {
    let current = RAW;
    const runtime = new FoundationRuntime(buildPorts(() => current));

    const added = insertMarker(RAW, 200);
    current = added;
    await publishEdit(runtime, RAW, added);

    const abstract = runtime.foreshadow.toAbstract();
    expect(abstract).toContain('EditTextDocument');
    expect(abstract).toContain('<|Insert|>');
    // Localized: the abstract must not contain the whole file. It should be far
    // shorter than the full file and contain a bounded number of lines.
    const lineCount = abstract.split('\n').length;
    expect(lineCount).toBeLessThan(60);
    expect(abstract.length).toBeLessThan(RAW.length / 4);
  });

  it('two far-apart real edits yield two hunks separated by "...", not a giant window', async () => {
    let current = RAW;
    const runtime = new FoundationRuntime(buildPorts(() => current));

    const edit1 = insertMarker(RAW, 50, 'AAAA');
    current = edit1;
    await publishEdit(runtime, RAW, edit1);

    const edit2 = insertMarker(edit1, 400, 'BBBB');
    current = edit2;
    await publishEdit(runtime, edit1, edit2);

    const abstract = runtime.foreshadow.toAbstract();
    expect(abstract).toContain('<|Insert|>');
    // Far-apart hunks must be separated by a "..." marker (hunk windowing).
    expect(abstract).toContain('...');
    // Must NOT dump the whole middle of the file. Bound total lines.
    const lineCount = abstract.split('\n').length;
    expect(lineCount).toBeLessThan(80);
  });

  it('CRLF before vs LF after does not produce a whole-file phantom diff', async () => {
    const crlf = RAW.replace(/\n/g, '\r\n');
    let current = RAW;
    const runtime = new FoundationRuntime(buildPorts(() => current));

    // Content is semantically identical except line endings; after normalization
    // there is no real change, so nothing should be recorded.
    current = RAW;
    await publishEdit(runtime, crlf, RAW);

    const abstract = runtime.foreshadow.toAbstract();
    expect(abstract).not.toContain('<|Insert|>');
    expect(abstract).not.toContain('<|Delete|>');
  });

  it('CRLF before with a real LF edit still records only the localized change', async () => {
    const crlf = RAW.replace(/\n/g, '\r\n');
    const added = insertMarker(RAW, 200, 'REAL');
    let current = added;
    const runtime = new FoundationRuntime(buildPorts(() => current));

    await publishEdit(runtime, crlf, added);

    const abstract = runtime.foreshadow.toAbstract();
    expect(abstract).toContain('EditTextDocument');
    expect(abstract).toContain('<|Insert|>');
    const lineCount = abstract.split('\n').length;
    expect(lineCount).toBeLessThan(60);
  });
});