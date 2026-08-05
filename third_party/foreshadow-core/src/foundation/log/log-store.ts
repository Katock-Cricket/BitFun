import { LogItem } from '../domain/log-item';
import { maxLogItemsNum } from '../config/constants';
import { FileSystemPort } from '../ports/filesystem-port';
import { WorkspacePort } from '../ports/workspace-port';
import { getFormattedTime } from '../utils/time';
import { plugin_version } from '../config/constants';
import { mergeEditLogs } from './edit-merge';
import * as path from 'path';

export class LogStore {
  private logs: LogItem[] = [];
  private listeners: Array<(logs: LogItem[]) => void> = [];

  constructor(
    private readonly fs: FileSystemPort,
    private readonly workspace: WorkspacePort,
  ) {}

  getAll(): LogItem[] {
    return [...this.logs];
  }

  onChange(listener: (logs: LogItem[]) => void) {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter(l => l !== listener);
      },
    };
  }

  private notify() {
    for (const l of this.listeners) {
      try {
        l(this.getAll());
      } catch (e) {
        console.error(e);
      }
    }
  }

  add(newLog: LogItem | LogItem[]) {
    if (Array.isArray(newLog)) {
      this.logs = this.logs.concat(newLog);
    } else {
      this.logs.push(newLog);
    }
    this.notify();
    if (this.logs.length > maxLogItemsNum) {
      this.save().catch(e => console.error(e));
    }
  }

  set(newLogs: LogItem[] = []) {
    this.logs = newLogs;
    this.notify();
  }

  async save(): Promise<void> {
    const dataDir = this.workspace.getDataDir();
    const logsDir = path.join(dataDir, 'logs');
    await this.fs.mkdirp(logsDir);
    const fileName = plugin_version + '_' + getFormattedTime(true) + '.jsonl';
    const filePath = path.join(logsDir, fileName);
    const merged = mergeEditLogs(this.logs);
    const content = merged.map(l => JSON.stringify(l.toJSONObject())).join('\n');
    await this.fs.writeFile(filePath, content);
    this.logs = [];
    this.notify();
  }
}
