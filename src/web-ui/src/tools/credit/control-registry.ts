/**
 * CREDIT 控制域方法注册表（架构 §2.3 改动 ③）。
 *
 * **为什么需要它**：MiniApp iframe 的 `app.call('credit.*')` 会被
 * `useMiniAppBridge` 路由到 **Worker**（`worker.call` 分支），而采集桥常驻 WebUI 主进程 ——
 * iframe 无法直接触达桥。桥原本把方法注册到 `globalEventBus`，但
 * `globalEventBus.emit()` **不返回 handler 的返回值**（`EventBus.emit` 仅返回 boolean），
 * 无法承载请求/响应语义。
 *
 * 由于挂载点（`mount.ts`）与 MiniApp 桥（`useMiniAppBridge`）**同处 WebUI 进程**，
 * 这里用一个模块级注册表直连：桥注册 handler → MiniApp 桥调用 handler。
 * 语义与 `@credit/protocol/control.ts` 的请求/响应类型一致，切换实现（如改走
 * 文件信号 ADR-8）时上层零改动。
 */

type CreditControlHandler = (params: any) => unknown;

const handlers = new Map<string, CreditControlHandler>();

/** 桥侧注册（由 `mount.ts` 的 `registerMethod` 调用） */
export function registerCreditControlMethod(method: string, handler: CreditControlHandler): void {
  handlers.set(method, handler);
}

/**
 * 控制域方法名（与 `@credit/protocol` 的 `ControlMethod` 短名对齐：
 * `credit.control.start` → `credit.start`）。`useMiniAppBridge` 据此判定是否
 * 需要转交桥而不是 Worker。
 */
export const CREDIT_CONTROL_METHODS = new Set<string>([
  'credit.start',
  'credit.finish',
  'credit.end',
  'credit.getStatus',
  'credit.reset',
]);

export function isCreditControlMethod(method: string): boolean {
  return CREDIT_CONTROL_METHODS.has(method);
}

/** MiniApp 桥侧调用；未注册时抛错（由桥的 `replyError` 转成 iframe 侧拒绝） */
export async function invokeCreditControl(method: string, params: any): Promise<unknown> {
  const handler = handlers.get(method);
  if (!handler) {
    throw new Error(`CREDIT 控制方法未注册：${method}（采集桥可能未挂载）`);
  }
  return await handler(params);
}
