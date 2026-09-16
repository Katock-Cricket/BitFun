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
  /**
   * 冲刷治理层暂存并落盘（finish / end 后调用）。
   *
   * 必须性：治理层会暂存编辑/滚动/光标事件，直到注意力转移或命令触发才产出。
   * 用户点"结束并保存"时若不冲刷，这些暂存的事件就**不会落盘**（只改了会话状态），
   * 表现为"明明操作了，最后一段行为却丢失"。
   */
  flush?: () => Promise<void>;
  /**
   * 丢弃治理层暂存（reset 后调用）。
   * 放弃本轮记录时暂存内容属于要丢弃的数据，绝不能冲刷落盘。
   */
  discard?: () => void;
}

const METHODS: ControlMethod[] = [
  "credit.control.start",
  "credit.control.end",
  "credit.control.finish",
  "credit.control.getStatus",
  "credit.control.reset",
];

export function createControlApi(deps: ControlDeps): void {
  for (const method of METHODS) {
    const short = method.replace("credit.control.", "credit.");
    deps.registerMethod(short, async (params: any) => {
      try {
        const explicit = params?.prId ?? params?.payload?.prId;
        // end/finish 允许省略 prId（作用于当前会话）；start/getStatus 保持原语义
        const prId =
          method === "credit.control.getStatus" || method === "credit.control.start"
            ? explicit
            : explicit ?? deps.session.current?.prId;
        const session = await deps.session.handle(method, prId);

        // 生命周期命令后处理治理层暂存：
        // - end/finish → 冲刷暂存并落盘（否则最后一段编辑/滚动/光标会丢失）
        // - reset      → 丢弃暂存（放弃的数据不应落盘）
        if (method === "credit.control.end" || method === "credit.control.finish") {
          await deps.flush?.();
        } else if (method === "credit.control.reset") {
          deps.discard?.();
        }

        const resp: ControlResponse = {
          ok: true,
          reqId: params?.reqId ?? String(Date.now()),
          session: session ?? undefined,
          status: session ? { state: session.state, counts: session.counts } : undefined,
        };
        return resp;
      } catch (e) {
        /**
         * **错误上报必须自防护**：曾出现"真正的原因被日志层自己的异常顶掉"——
         * handler 抛出 A，`deps.logError` 内部再抛 `ReferenceError: process is not defined`（B），
         * 调用方只看到 B，A 永久丢失（P4 冒烟：`credit.reset` 的真实错误被掩盖）。
         * 故：logError 自身异常只计数不逸出；返回给 UI 的错误附带**栈首行**便于定位。
         */
        const detail = String(e);
        const stackTop = (e as { stack?: string })?.stack?.split("\n").slice(0, 3).join(" | ");
        try {
          deps.logError(`control-api ${method} failed`, { error: detail, stack: stackTop });
        } catch {
          /* 日志层异常绝不覆盖原始错误 */
        }
        const resp: ControlResponse = {
          ok: false,
          reqId: params?.reqId ?? String(Date.now()),
          error: stackTop ? `${detail} ⧉ ${stackTop}` : detail,
        };
        return resp;
      }
    });
  }
}
