import { LogItem } from './log-item';

export class Task {
  public duration: Date;
  constructor(
    public name: string,
    public description: string,
    public logs: LogItem[],
  ) {
    if (!this.logs || this.logs.length === 0) {
      this.duration = new Date(0);
      return;
    }
    const start = new Date(this.logs[0].timeStamp).getTime();
    const end = new Date(this.logs[this.logs.length - 1].timeStamp).getTime();
    this.duration = new Date(end - start);
  }

  public toJSONObject(): any {
    return {
      name: this.name,
      description: this.description,
      logs: this.logs.map(log => log.toJSONObject()),
    };
  }

  public toAbstract(): string {
    return `${this.name}\n${this.description}\n`;
  }
}
