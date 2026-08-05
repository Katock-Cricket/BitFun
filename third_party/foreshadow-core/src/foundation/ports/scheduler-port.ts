export interface DisposableLike {
  dispose(): void;
}

export interface SchedulerPort {
  setInterval(handler: () => void, ms: number): DisposableLike;
  setTimeout(handler: () => void, ms: number): DisposableLike;
  clear?(handle: DisposableLike): void;
}
