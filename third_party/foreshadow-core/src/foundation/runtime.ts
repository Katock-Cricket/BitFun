import { setArtifactContextQueryService } from './domain/artifact-context';
import { LogStore } from './log/log-store';
import { TaskStore } from './log/task-store';
import { RepoMap } from './repomap/repo-map';
import { EventIngress } from './ingress/event-ingress';
import { TaskRecognizer } from './task/task-recognizer';
import {
  ConfigPort,
  DocumentPort,
  FileSystemPort,
  LanguageIntelPort,
  LLMPort,
  SchedulerPort,
  WorkspacePort,
  WorkspaceSearchPort,
} from './ports';
import { Foreshadow } from '../context/foreshadow';
import { LogItem } from './domain/log-item';
import { Task } from './domain/task';
import { RawHostEvent } from './domain/raw-events';

export interface FoundationPorts {
  documents: DocumentPort;
  languageIntel: LanguageIntelPort;
  workspace: WorkspacePort;
  search: WorkspaceSearchPort;
  fs: FileSystemPort;
  config: ConfigPort;
  scheduler: SchedulerPort;
  llm: LLMPort;
}

export class FoundationRuntime {
  readonly logStore: LogStore;
  readonly taskStore: TaskStore;
  readonly repoMap: RepoMap;
  readonly foreshadow: Foreshadow;
  readonly ingress: EventIngress;
  readonly taskRecognizer: TaskRecognizer;
  private disposables: Array<{ dispose(): void }> = [];

  constructor(ports: FoundationPorts) {
    this.logStore = new LogStore(ports.fs, ports.workspace);
    this.taskStore = new TaskStore(ports.fs, ports.workspace);
    this.repoMap = new RepoMap(
      ports.documents,
      ports.languageIntel,
      ports.workspace,
      ports.search,
      ports.fs,
      ports.scheduler,
    );
    setArtifactContextQueryService(this.repoMap);
    this.foreshadow = new Foreshadow(this.repoMap);
    this.ingress = new EventIngress(
      this.logStore,
      ports.languageIntel,
      ports.documents,
      this.repoMap,
      this.foreshadow,
    );
    this.taskRecognizer = new TaskRecognizer(
      ports.llm,
      ports.documents,
      ports.config,
      ports.scheduler,
      (a, b) => this.repoMap.getEdgeType(a, b),
      () => this.logStore.getAll(),
      (tasks: Task[]) => {
        this.taskStore.add(tasks);
        this.foreshadow.updateByTask(this.taskStore.getAll());
      },
    );
    this.disposables.push(
      this.logStore.onChange((logs: LogItem[]) => {
        this.foreshadow.updateByLog(logs);
      }),
      this.taskStore.onChange((tasks: Task[]) => {
        this.foreshadow.updateByTask(tasks);
      }),
    );
  }

  start() {
    this.taskRecognizer.start();
  }

  async publish(event: RawHostEvent) {
    await this.ingress.publish(event);
  }

  getSnapshot() {
    return {
      context: this.foreshadow.toJSONObject(),
      completeness: this.foreshadow.checkCompleteness(),
      logs: this.logStore.getAll().slice(-20).map(l => l.toJSONObject()),
      tasks: this.taskStore.getAll().slice(-5).map(t => t.toJSONObject()),
      abstract: this.foreshadow.toAbstract(),
    };
  }

  async exportContextJson(): Promise<string> {
    return JSON.stringify(this.foreshadow.toJSONObject(), null, 2);
  }

  dispose() {
    this.taskRecognizer.dispose();
    this.repoMap.dispose();
    for (const d of this.disposables) d.dispose();
    setArtifactContextQueryService(undefined);
  }
}
