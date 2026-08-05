import { LogItem } from '../domain/log-item';
import { Task } from '../domain/task';
import { cluster, prune, EdgeTypeResolver } from './relation-utils';
import { ConfigPort } from '../ports/config-port';
import { DocumentPort } from '../ports/document-port';
import { LLMPort, LLMMessage, LLMToolDefinition } from '../ports/llm-port';
import { SchedulerPort } from '../ports/scheduler-port';
import { autoRecognizeTaskInterval } from '../config/constants';
import { parseAIResponseWithDetails } from '../utils/json-parser';
import { makePosition, makeRange } from '../domain/geometry';

const recPrompt = `
?????????????????????
??????????
1. ????
2. ?????????????????????????????????
3. ??????????????????????????????????????????????????????????????????

?????
1. ??????????????????
2. ????????????(????????)????????????????????????read_code?????????????????????????????????????
3. ????????????

?????
- read_code: ???????????????filepath(????)?startLine(????)?endLine(????)

???????
1. ????(????????20?)
2. ????(??????????????200?)
3. ?????

?JSON?????
{
  "taskName": "????",
  "taskDescription": "????"
}

?????
`;

export class TaskRecognizer {
  private isRecognizing = false;
  private lastRecognizeTimestamp = 0;
  private disposables: Array<{ dispose(): void }> = [];

  constructor(
    private readonly llm: LLMPort,
    private readonly documents: DocumentPort,
    private readonly config: ConfigPort,
    private readonly scheduler: SchedulerPort,
    private readonly getEdgeType: EdgeTypeResolver,
    private readonly getLogs: () => LogItem[],
    private readonly onTasks: (tasks: Task[]) => void,
  ) {}

  start() {
    this.disposables.push(
      this.scheduler.setInterval(() => {
        if (!this.config.get<boolean>('foreshadow.control.taskRecognize', true)) return;
        this.recognizeTask([...this.getLogs()])
          .then(r => {
            if (r.length > 0) this.onTasks(r);
          })
          .catch(error => console.error(error));
      }, autoRecognizeTaskInterval),
    );
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  private createReadCodeTool(): LLMToolDefinition {
    return {
      name: 'read_code',
      description: '????????????????????',
      schema: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: '????' },
          startLine: { type: 'number', description: '????(1-based)' },
          endLine: { type: 'number', description: '????(1-based)' },
        },
        required: ['filepath', 'startLine', 'endLine'],
      },
      func: async ({ filepath, startLine, endLine }) => {
        const doc = await this.documents.openDocument(filepath);
        if (!doc) return `Cannot open file: ${filepath}`;
        const start = Math.max(0, (startLine || 1) - 1);
        const end = Math.min(doc.lineCount - 1, (endLine || startLine || 1) - 1);
        return doc.getText(makeRange(makePosition(start, 0), makePosition(end, Number.MAX_SAFE_INTEGER)));
      },
    };
  }

  private async recognizeTaskFromCluster(clusterLogs: LogItem[]): Promise<Task> {
    let taskName = '????';
    let taskDescription = new Date().toLocaleString();
    if (!this.llm.isConfigured()) {
      return new Task('unconfigured', 'TaskRecognizer LLM not configured', clusterLogs);
    }
    try {
      const logAbs = clusterLogs.map(log => log.toAbstract()).join('\n');
      const messages: LLMMessage[] = [{ role: 'system', content: recPrompt + logAbs }];
      const tools = [this.createReadCodeTool()];
      let response = await this.llm.chat(messages, tools);
      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const toolCall of response.tool_calls) {
          if (toolCall.name === 'read_code') {
            try {
              const codeContent = await tools[0].func(toolCall.args);
              messages.push({ role: 'assistant', content: response.content || '' });
              messages.push({
                role: 'tool',
                content: `?? ${toolCall.args.filepath} ?${toolCall.args.startLine}-${toolCall.args.endLine}??????\n\`\`\`\n${codeContent}\n\`\`\``,
                tool_call_id: toolCall.id,
              });
            } catch (error) {
              messages.push({
                role: 'tool',
                content: `??????: ${error instanceof Error ? error.message : '????'}`,
                tool_call_id: toolCall.id,
              });
            }
          }
        }
        messages.push({
          role: 'user',
          content: '?????????????????????????JSON?????',
        });
        response = await this.llm.chat(messages, tools);
      }
      const content = response.content as string;
      const parseResult = parseAIResponseWithDetails(content, 'TaskRecognizer');
      if (parseResult.success && parseResult.data) {
        const parsed = parseResult.data as any;
        taskName = parsed.taskName || taskName;
        taskDescription = parsed.taskDescription || taskDescription;
      } else {
        taskDescription = `????: ${String(content).substring(0, 200)}...`;
      }
      return new Task(taskName, taskDescription, clusterLogs);
    } catch (error: any) {
      console.error('Error in recognizeTaskFromCluster:', error);
      return new Task(taskName, `${taskDescription} (${error?.message || error})`, clusterLogs);
    }
  }

  async recognizeTask(logs: LogItem[]): Promise<Task[]> {
    if (!this.config.get<boolean>('foreshadow.control.taskRecognize', true)) {
      return [];
    }
    if (!this.llm.isConfigured()) {
      console.warn('TaskRecognizer LLM not configured, skip');
      return [];
    }
    logs = logs.filter(log => Date.parse(log.timeStamp) > this.lastRecognizeTimestamp);
    if (logs.length === 0 || this.isRecognizing) return [];
    this.isRecognizing = true;
    try {
      logs = await prune(logs);
      const clustersAll = await cluster(logs, this.getEdgeType);
      const clusters = clustersAll.filter(c => c.length > 0);
      if (clusters.length === 0) return [];
      const results = await Promise.allSettled(clusters.map(c => this.recognizeTaskFromCluster(c)));
      const tasks = results
        .filter((result): result is PromiseFulfilledResult<Task> => result.status === 'fulfilled')
        .map(result => result.value);
      this.lastRecognizeTimestamp = Math.max(
        this.lastRecognizeTimestamp,
        Date.parse(logs[logs.length - 1].timeStamp),
      );
      return tasks;
    } finally {
      this.isRecognizing = false;
    }
  }
}
