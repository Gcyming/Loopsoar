/**
 * 通知接线：把渲染层事件、ask_user、回合完成和定时任务统一接到 Notifier。
 *
 * 放在独立模块里，index.ts 只保留一行装配；配置目录要等 app.whenReady 后才可知，
 * 因此这里用 getConfigDir 惰性读取，首个通知到达时才创建 Notifier。
 */
import type { NotifyWindow } from "./desktopNotify.js";
import { createNotifier, type Notifier, type NotifyAskInput } from "./notifications.js";

export interface NotificationRuntimeInput {
  getConfigDir: () => string;
  /** 主窗口（结构类型：本层不碰 electron，Electron 原语留在 desktopNotify）。 */
  getWindow: () => NotifyWindow | null;
  sendToRenderer: (event: string, payload: unknown) => void;
}

export interface NotificationRuntime {
  /** 包装后的渲染层 pusher：额外识别 chat:stream:error（stream reject 的异常中断）。 */
  pushToRenderer: (event: string, payload: unknown) => void;
  ask: (payload: NotifyAskInput) => void;
  turn: (input: {
    sessionId?: string;
    userText: string;
    result: { status: string; reason?: string; finalText?: string };
  }) => void;
  system: (title: string, body: string, sessionId?: string) => void;
}

/**
 * 惰性版本：配置目录要等 app.whenReady 之后才知道，而通知器又要在更早的常量位置创建。
 * 把「可变目录 + 惰性 Notifier」封在这里，组合根不必再持有这类生命周期变量。
 */
export interface LazyNotificationRuntime extends NotificationRuntime {
  setConfigDir(dir: string): void;
}

export function createLazyNotificationRuntime(input: {
  getWindow: () => NotifyWindow | null;
  sendToRenderer: (event: string, payload: unknown) => void;
}): LazyNotificationRuntime {
  let configDir = "";
  const runtime = createNotificationRuntime({
    getConfigDir: () => configDir,
    getWindow: input.getWindow,
    sendToRenderer: input.sendToRenderer,
  });
  return { ...runtime, setConfigDir: (dir: string) => { configDir = dir; } };
}

export function createNotificationRuntime(input: NotificationRuntimeInput): NotificationRuntime {
  let notifier: Notifier | null = null;
  const get = (): Notifier =>
    (notifier ??= createNotifier({ configDir: input.getConfigDir(), getWindow: input.getWindow }));

  return {
    pushToRenderer(event: string, payload: unknown): void {
      // 流式请求在 ChatService 之外抛出时 onTurnComplete 不会执行；
      // 这里补一条异常通知，Notifier 内部按 session 与回合通知去重。
      if (event === "chat:stream:error") {
        const p = payload as { sessionId?: string; message?: string; content?: string };
        get().turn({ sessionId: p.sessionId, userText: "", status: "error", reason: p.message || p.content });
      }
      input.sendToRenderer(event, payload);
    },
    ask(payload: NotifyAskInput): void {
      get().ask(payload);
    },
    turn({ sessionId, userText, result }): void {
      get().turn({ sessionId, userText, status: result.status, reason: result.reason, finalText: result.finalText });
    },
    system(title: string, body: string, sessionId?: string): void {
      get().system(title, body, sessionId);
    },
  };
}
