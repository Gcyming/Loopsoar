/**
 * chat 域：chat:stream / chat:stop / chat:send / perm:respond。
 * 当前为占位实现（事件推送走 deps.push）；P1 接入 services 的 ChatService：
 * buildSystemSegments → ModelRouter → runToolLoop → 每轮声称核验 → 事件归一。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export interface ChatDeps extends TrustedIpcDeps {
  push(event: string, payload: unknown): void;
}

export function registerChatDomain(deps: ChatDeps): void {
  handleTrusted(deps, "chat:send", (payload) => {
    const p = payload as { message: string; sessionId?: string };
    deps.push("chat:stream:done", {
      sessionId: p.sessionId,
      stub: true,
      content: "引擎装配未完成（P1 接入 ChatService）",
    });
    return { accepted: true };
  });

  handleTrusted(deps, "chat:stream", (payload) => {
    const p = payload as { message: string; sessionId?: string };
    deps.push("chat:stream:chunk", {
      sessionId: p.sessionId,
      content: "（占位）引擎装配未完成（P1 接入 ChatService）",
    });
    deps.push("chat:stream:done", { sessionId: p.sessionId });
    return { accepted: true };
  });

  handleTrusted(deps, "chat:stop", (payload) => {
    const p = payload as { sessionId: string };
    deps.push("chat:stream:done", { sessionId: p.sessionId, stopped: true });
    return { stopped: true };
  });

  handleTrusted(deps, "perm:respond", (payload) => {
    const p = payload as { requestId: string; choice: string };
    // P1：转发给 PermRequestBus（300s 超时按拒绝结算）；当前占位记录
    deps.push("chat:stream:heartbeat", {
      requestId: p.requestId,
      note: `perm:respond ${p.choice} 已接收（占位）`,
    });
    return { received: true };
  });
}
