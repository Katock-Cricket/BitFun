/**
 * accept-bridge：订阅 SnapshotEventBus 的 user_accept_file，归一化为 userAccept。
 * 全部为附加 listener；异常自捕获 + log + 计数，绝不向事件源抛错（§5 纪律）。
 */
import type { CreditRawEvent, UserAcceptEvent } from "@credit/protocol";
import type { BridgeSink } from "@credit/core";

export interface AcceptDeps {
  snapshotBus: {
    on(eventType: string, listener: (event: any) => void): () => void;
    getInstance?: () => { on(eventType: string, listener: (event: any) => void): () => void };
  };
  publish: (evt: CreditRawEvent) => void;
  count: (key: string) => void;
  logError: (msg: string, meta?: unknown) => void;
}

const SOURCE = "accept-bridge";

export function createAcceptBridge(deps: AcceptDeps): { dispose(): void } {
  const bus =
    "getInstance" in deps.snapshotBus && deps.snapshotBus.getInstance
      ? deps.snapshotBus.getInstance()
      : deps.snapshotBus;

  const handleAccept = (eventType: string, event: any) => {
    try {
      const payload = event?.payload ?? event ?? {};
      const filePath = event?.filePath ?? payload?.filePath ?? payload?.uri;
      const fileUris = filePath ? [String(filePath)] : (payload?.fileUris ?? []);
      // 事件名 -> kind 映射
      const kind: "file" | "block" | "session" =
        eventType === "user_accept_block" ? "block" : eventType === "user_accept_session" ? "session" : "file";
      const evt: UserAcceptEvent = {
        type: "userAccept",
        kind,
        // block/session 也尽量带出涉及的文件（block 含 filePath，session 可能无）
        fileUris: Array.isArray(fileUris) ? fileUris.map(String) : fileUris ? [String(fileUris)] : [],
        // diff 行数 P0 降级为 null（经 analyzer git Port 在 P1 补取，架构 §7）
        diffStats: null,
        totalAdded: null,
        totalDeleted: null,
        sessionId: event?.sessionId ?? payload?.sessionId ?? null,
        fidelity: "frontend",
        ts: event?.timestamp ?? Date.now(),
      };
      deps.publish(evt);
      deps.count(`${SOURCE}:userAccept:${kind}`);
    } catch (e) {
      deps.logError(`${SOURCE} handler failed`, { error: String(e) });
      deps.count(`${SOURCE}:error`);
    }
  };

  const unsubs = [
    bus.on("user_accept_file", (e: any) => handleAccept("user_accept_file", e)),
    bus.on("user_accept_block", (e: any) => handleAccept("user_accept_block", e)),
    bus.on("user_accept_session", (e: any) => handleAccept("user_accept_session", e)),
  ];

  return {
    dispose() {
      unsubs.forEach((u) => {
        try {
          u();
        } catch {
          /* noop */
        }
      });
    },
  };
}
