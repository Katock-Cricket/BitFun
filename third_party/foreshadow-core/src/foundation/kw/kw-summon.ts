import * as path from 'path';
import { kwCursorCxtPadding } from '../config/constants';
import { getDiffLines, mergeEditLogs } from '../log/edit-merge';
import { CursorContext } from '../domain/artifact-context';
import { EventType } from '../domain/event-types';
import { LogItem } from '../domain/log-item';
import { extractKeywordsFromLine } from './kw-extract';
import { Artifact, ArtifactType } from '../domain/artifact';

export interface Keyword {
  keyword: string;
  weight: number;
  sources: Set<KeywordSource>;
}

export enum KeywordSource {
  CursorContext = 'CursorContext',
  Edit = 'Edit',
  Select = 'Select',
  AST = 'AST',
}

export function summonKeywordsFromCursorContext(cursorContext: CursorContext): Keyword[] {
  const docSuffix = path.extname(cursorContext.loc.uri.fsPath).slice(1).toLowerCase();
  const lines = cursorContext.codeSnippet.split('\n');
  const cursorLineIdx = Math.max(0, cursorContext.getCursorPosition().line - cursorContext.loc.range.start.line);
  const linesToSearch = lines.slice(
    Math.max(0, cursorLineIdx - kwCursorCxtPadding.upToLines),
    Math.min(lines.length, cursorLineIdx + kwCursorCxtPadding.downToLines),
  );
  const keywords = linesToSearch.flatMap(line => extractKeywordsFromLine(line, docSuffix));
  const keywordSet = new Set(keywords);
  return Array.from(keywordSet).map(keyword => ({
    keyword: keyword.toLowerCase(),
    weight: 1,
    sources: new Set([KeywordSource.CursorContext]),
  }));
}

export function summonKeywordsFromHistory(history: LogItem[]): Keyword[] {
  const editLogs = history.filter(log => log.eventType === EventType.EditTextDocument && log.context);
  const selectLogs = history.filter(log => log.eventType === EventType.SelectText);
  const editedArtifacts = editLogs.map(log => log.artifact);
  return [
    ...summonKeywordsFromEditLogs(editLogs),
    ...summonKeywordsFromSelectLogs(selectLogs),
    ...summonKeywordsFromAST(editedArtifacts),
  ];
}

function summonKeywordsFromEditLogs(editLogs: LogItem[]): Keyword[] {
  editLogs = mergeEditLogs(editLogs);
  return editLogs.flatMap(log => {
    if (!log.artifact.location) return [];
    const docSuffix = path.extname(log.artifact.location?.uri.fsPath).slice(1).toLowerCase();
    const editLines = getDiffLines(log.context?.content.before || '', log.context?.content.after || '');
    const keywords = editLines.flatMap(line => extractKeywordsFromLine(line, docSuffix));
    const keywordSet = new Set(keywords);
    return Array.from(keywordSet).map(keyword => ({
      keyword: keyword.toLowerCase(),
      weight: 1,
      sources: new Set([KeywordSource.Edit]),
    }));
  });
}

function summonKeywordsFromSelectLogs(selectLogs: LogItem[]): Keyword[] {
  return selectLogs.flatMap(log => {
    if (!log.artifact.location) return [];
    const docSuffix = path.extname(log.artifact.location?.uri.fsPath).slice(1).toLowerCase();
    const selectLines = log.context?.content.after?.split('\n') || [];
    const keywords = selectLines.flatMap(line => extractKeywordsFromLine(line, docSuffix));
    const keywordSet = new Set(keywords);
    return Array.from(keywordSet).map(keyword => ({
      keyword: keyword.toLowerCase(),
      weight: 1,
      sources: new Set([KeywordSource.Select]),
    }));
  });
}

function summonKeywordsFromAST(artifacts: Artifact[]): Keyword[] {
  const keywords = artifacts
    .filter(artifact => artifact.type !== ArtifactType.File && artifact.type !== ArtifactType.Terminal)
    .flatMap(artifact => {
      return (
        artifact.hierarchy?.filter(node => node.type !== ArtifactType.File).flatMap(node => node.name) || []
      );
    });
  const keywordSet = new Set(keywords);
  return Array.from(keywordSet).map(keyword => ({
    keyword: keyword.toLowerCase(),
    weight: 1,
    sources: new Set([KeywordSource.AST]),
  }));
}
