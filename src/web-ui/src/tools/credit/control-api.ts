/**
 * control-api：注册 credit.* 方法域路由（Spike S3 主选）。
 * 通过注入的 registerMethod（Bitfun 的 app.call / worker.call 路由注册器）
 * 暴露 credit.start / credit.end / credit.getStatus / credit.reset。
 * 全部异常自捕获，绝不向宿主抛错（§5 纪律）。
 */
import type { ControlMethod, ControlResponse } from "@credit/protocol";
import type { SessionManager } from "@credit/core";

export interface ControlDeps {
  /** Bitfun 路由注册器（app.call / worker.call） */
  registerMethod: (method: string, handler: (params: any) => unknown) => void;
  session: SessionManager;
  logError: (msg: string, meta?: unknown) => void;
}

const METHODS: ControlMethod[] = [
  "credit.control.start",
  "credit.control.end",
  "credit.control.getStatus",
  "credit.control.reset",
];

export function createControlApi(deps: ControlDeps): void {
  for (const method of METHODS) {
    const short = method.replace("credit.control.", "credit.");
    deps.registerMethod(short, async (params: any) => {
      try {
        const prId = params?.prId ?? params?.payload?.prId;
        const session = await deps.session.handle(method, prId);
        const resp: ControlResponse = {
          ok: true,
          reqId: params?.reqId ?? String(Date.now()),
          session: session ?? undefined,
          status: session ? { state: session.state, counts: session.counts } : undefined,
        };
        return resp;
      } catch (e) {
        deps.logError(`control-api ${method} failed`, { error: String(e) });
        const resp: ControlResponse = {
          ok: false,
          reqId: params?.reqId ?? String(Date.now()),
          error: String(e),
        };
        return resp;
      }
    });
  }
}
