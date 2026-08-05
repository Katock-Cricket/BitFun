import * as logItem from '../domain/log-item';
import { EventType } from '../domain/event-types';
import { Artifact, ArtifactType } from '../domain/artifact';

export const skippedFileTypes = new Set([
  'git/', 'dist/', 'out/', 'tmp/', 'coverage/', 'logs/',
  '.virtualme/', '.virtualme', '.foreshadow/', '.foreshadow',
  '.repomap/', '.repomap', 'node_modules/', 'package-lock.json',
  'pnpm-lock.yaml', '__pycache__', 'venv/', '.vscode', '.git',
  '.DS_Store', 'build/', 'vendor/',
]);

const FileEventTypes = [
  EventType.CreateFile,
  EventType.DeleteFile,
  EventType.RenameFile,
  EventType.MoveFile,
  EventType.OpenTextDocument,
  EventType.CloseTextDocument,
  EventType.ChangeTextDocument,
  EventType.SaveFile,
];

export function isFileSkipped(uri: string): boolean {
  const convertedUri = uri.replace(/\\/g, '/');
  for (const fileType of skippedFileTypes) {
    if (convertedUri.includes(fileType)) {
      return true;
    }
  }
  return false;
}

export function getLogItemFromOpenTextDocument(uri: string) {
  return new logItem.LogItem(EventType.OpenTextDocument, new Artifact(uri, ArtifactType.File));
}

export function getLogItemFromChangeTextDocument(uri: string) {
  return new logItem.LogItem(EventType.ChangeTextDocument, new Artifact(uri, ArtifactType.File));
}

export function getLogItemFromRenameFile(_oldUri: string, newUri: string) {
  return new logItem.LogItem(EventType.RenameFile, new Artifact(newUri, ArtifactType.File));
}

function mergeArtifact(artifacts: Artifact[]): Artifact {
  let name = '';
  for (let i = 0; i < artifacts.length && i < 4; i++) {
    name += artifacts[i].name + ',';
  }
  name = name.slice(0, -1) + '...';
  return new Artifact(name, artifacts[0].type);
}

export function mergeContinuousFileEvents(logs: logItem.LogItem[]): logItem.LogItem[] {
  if (!logs || logs.length === 0) return [];
  let result: logItem.LogItem[] = [];
  let firstIdx = 0;
  while (firstIdx < logs.length) {
    const currentLog = logs[firstIdx];
    if (!FileEventTypes.includes(currentLog.eventType)) {
      result.push(currentLog);
      firstIdx++;
      continue;
    }
    let lastIdx = firstIdx;
    let artifacts: Artifact[] = [];
    if (currentLog.artifact) artifacts.push(currentLog.artifact);
    while (
      lastIdx < logs.length &&
      logs[lastIdx].eventType === currentLog.eventType &&
      FileEventTypes.includes(logs[lastIdx].eventType)
    ) {
      lastIdx++;
      if (lastIdx < logs.length && logs[lastIdx].artifact) {
        artifacts.push(logs[lastIdx].artifact);
      }
    }
    if (lastIdx - firstIdx === 1) {
      result.push(currentLog);
    } else {
      result.push(new logItem.LogItem(currentLog.eventType, mergeArtifact(artifacts)));
    }
    firstIdx = lastIdx;
  }
  return result;
}
