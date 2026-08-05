import { mergeContinuousFileEvents } from '../log/file-process';
import { Artifact } from '../domain/artifact';
import { LogItem } from '../domain/log-item';
import { EdgeType } from '../repomap/edge-types';
import { mergeEditLogs } from '../log/edit-merge';
import { EventType } from '../domain/event-types';

const meaningfullEventTypes: EventType[] = [
  EventType.EditTextDocument,
  EventType.SelectText,
  EventType.ExecuteTerminalCommand,
  EventType.CreateFile,
  EventType.DeleteFile,
  EventType.RenameFile,
  EventType.MoveFile,
];

export type EdgeTypeResolver = (a: Artifact, b: Artifact) => Promise<Set<string | EdgeType>>;

function dur2Sim(dur: number): number {
  let sim = 1.0;
  if (dur > 5 * 60 * 1000) return 0.0;
  sim -= dur / (30 * 1000);
  return sim;
}

async function artifact2Sim(
  artifactA: Artifact,
  artifactB: Artifact,
  getEdgeType: EdgeTypeResolver,
): Promise<number> {
  let sim = 1.0;
  let edgeTypes: Array<string | EdgeType> = [];
  try {
    edgeTypes = Array.from(await getEdgeType(artifactA, artifactB));
  } catch (error) {
    console.error('error getting edge types:', error);
  }
  for (const edgeType of edgeTypes) {
    switch (edgeType) {
      case EdgeType.DEFINITION:
      case EdgeType.TYPE:
      case EdgeType.IMPLEMENTS:
      case EdgeType.CALLS:
      case EdgeType.CONTAINS:
      case EdgeType.SAME_FILE:
      case 'definition':
      case 'type':
      case 'implements':
      case 'calls':
      case 'contains':
      case 'same_file':
        sim += 0.1;
        break;
      default:
        break;
    }
  }
  return sim;
}

async function log2Sim(logA: LogItem, logB: LogItem, getEdgeType: EdgeTypeResolver): Promise<number> {
  const dur = new Date(logB.timeStamp).getTime() - new Date(logA.timeStamp).getTime();
  let sim = dur2Sim(dur);
  if (!logA.artifact || !logB.artifact) return sim;
  let artifactSim = 1.0;
  try {
    artifactSim = await artifact2Sim(logA.artifact, logB.artifact, getEdgeType);
  } catch (error) {
    console.error('error getting artifact similarity:', error);
  }
  return sim * artifactSim;
}

export async function prune(logs: LogItem[]): Promise<LogItem[]> {
  if (logs.length === 0) return [];
  logs = logs.filter(log => meaningfullEventTypes.includes(log.eventType));
  logs = mergeContinuousFileEvents(logs);
  logs = mergeEditLogs(logs);
  return logs;
}

export async function cluster(
  logs: LogItem[],
  getEdgeType: EdgeTypeResolver,
  threshold: number = 0.3,
): Promise<LogItem[][]> {
  if (logs.length === 0) return [];
  if (logs.length === 1) return [logs];
  const clusters: LogItem[][] = [];
  let currentCluster: LogItem[] = [logs[0]];
  for (let i = 0; i < logs.length - 1; i++) {
    const logA = logs[i];
    const logB = logs[i + 1];
    const sim = await log2Sim(logA, logB, getEdgeType);
    if (sim >= threshold) {
      currentCluster.push(logB);
    } else {
      clusters.push(currentCluster);
      currentCluster = [logB];
    }
  }
  clusters.push(currentCluster);
  return clusters;
}
