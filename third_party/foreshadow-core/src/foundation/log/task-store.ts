import { Task } from '../domain/task';
import { maxTasksNum, plugin_version } from '../config/constants';
import { FileSystemPort } from '../ports/filesystem-port';
import { WorkspacePort } from '../ports/workspace-port';
import { getFormattedTime } from '../utils/time';
import * as path from 'path';

export class TaskStore {
  private tasks: Task[] = [];
  private listeners: Array<(tasks: Task[]) => void> = [];

  constructor(
    private readonly fs: FileSystemPort,
    private readonly workspace: WorkspacePort,
  ) {}

  getAll(): Task[] {
    return [...this.tasks];
  }

  onChange(listener: (tasks: Task[]) => void) {
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

  add(newTask: Task | Task[]) {
    if (Array.isArray(newTask)) {
      this.tasks = this.tasks.concat(newTask);
    } else {
      this.tasks.push(newTask);
    }
    this.notify();
    if (this.tasks.length >= maxTasksNum) {
      this.save().catch(e => console.error(e));
    }
  }

  set(newTasks: Task[] = []) {
    this.tasks = newTasks;
    this.notify();
  }

  async save(): Promise<void> {
    const dataDir = this.workspace.getDataDir();
    const tasksDir = path.join(dataDir, 'tasks');
    await this.fs.mkdirp(tasksDir);
    const fileName = plugin_version + '_' + getFormattedTime(true) + '.jsonl';
    const filePath = path.join(tasksDir, fileName);
    const content = this.tasks.map(t => JSON.stringify(t.toJSONObject())).join('\n');
    await this.fs.writeFile(filePath, content);
    this.tasks = [];
    this.notify();
  }
}
