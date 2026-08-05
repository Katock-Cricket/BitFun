import * as logItem from '../domain/log-item';
import { EventType } from '../domain/event-types';
import { Artifact, ArtifactType } from '../domain/artifact';
import * as os from 'os';

const platform = os.platform();

let stripAnsi: any;
(async () => {
  try {
    stripAnsi = (await import('strip-ansi')).default;
  } catch {
    stripAnsi = (s: string) => s;
  }
})();

export class TerminalInfo {
  constructor(
    public readonly processId: string,
    public cmd: string,
    public output: string,
  ) {}

  public equals(other: TerminalInfo): boolean {
    return this.processId === other.processId && this.cmd === other.cmd && this.output === other.output;
  }
}

export function removeAnsi(input: string) {
  if (!stripAnsi) return input;
  return stripAnsi(input);
}

function getCmdType(cmd: string): [string, string] {
  const cmdArr = cmd.split(' ');
  for (const c of cmdArr) {
    if (c.startsWith('-') || c.startsWith('\\') || c.startsWith('/')) continue;
    const known = ['npm', 'pnpm', 'yarn', 'python', 'pip', 'node', 'git', 'cd', 'ls', 'dir', 'make', 'mvn', 'gradle', 'cargo'];
    for (const k of known) {
      if (c.includes(k)) return ['CrossPlatform', k];
    }
    if (platform === 'win32' && ['dir', 'copy', 'del', 'type'].some(k => c.includes(k))) {
      return ['Windows', c];
    }
  }
  return ['Unknown', cmd];
}

export function getLogItemFromTerminalExecute(processId: string, cmd: string, output: string): logItem.LogItem {
  const artifact = new Artifact(processId, ArtifactType.Terminal);
  output = removeAnsi(output);
  const [cmdType, cmdFeature] = getCmdType(cmd);
  cmd = `<|${cmdType}|><|${cmdFeature}|>${cmd}`;
  const context = new logItem.Context(
    logItem.ContextType.Terminal,
    { before: cmd, after: output },
    { line: 0, character: 0 },
    { line: 0, character: 0 },
  );
  return new logItem.LogItem(EventType.ExecuteTerminalCommand, artifact, context);
}
