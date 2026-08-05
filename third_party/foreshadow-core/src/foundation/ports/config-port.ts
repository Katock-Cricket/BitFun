export interface ConfigPort {
  get<T = unknown>(key: string, defaultValue?: T): T;
  onDidChange(listener: () => void): { dispose(): void };
}
