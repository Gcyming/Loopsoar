/**
 * chat 域：真实接线 ChatService（T3）。
 * 事件映射：ChatService 的 ChunkItem.meta.type → chat:stream:<type> 推送（chunk/reasoning/tool/progress/done/error/heartbeat）；
 * perm:respond 结算挂起确认；chat:stop 中止进行中的流。
 * 依赖注入：ChatService 实例由 index.ts 装配（本文件不 import electron，可无壳测试）。
 */
import type { ChatService } from "loopsoar-services/chat";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export interface ChatDeps extends TrustedIpcDeps {
  chatService: ChatService;
  push(event: string, payload: unknown): void;
}

/** 启动一次流式对话（后台跑，handler 先返回 accepted）。 */
function startStream(
  deps: ChatDeps,
  payload: { message: string; sessionId?: string },
): { accepted: boolean; sessionId: string } {
  const sessionId = payload.sessionId ?? `sess-${Date.now()}`;
  void deps.chatService
    .stream({ message: payload.message, sessionId }, (item) => {
      const type = String(item.meta?.type ?? "chunk");
      deps.push(`chat:stream:${type}`, {
        sessionId,
        content: item.content,
        meta: item.meta,
      });
    })
    .catch((err: unknown) => {
      deps.push("chat:stream:error", {
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  return { accepted: true, sessionId };
}

export function registerChatDomain(deps: ChatDeps): void {
  handleTrusted(deps, "chat:stream", (payload) =>
    startStream(deps, payload as { message: string; sessionId?: string }),
  );

  handleTrusted(deps, "chat:send", (payload) =>
    startStream(deps, payload as { message: string; sessionId?: string }),
  );

  handleTrusted(deps, "chat:stop", (payload) => {
    const p = payload as { sessionId: string };
    const stopped = deps.chatService.stop(p.sessionId);
    deps.push("chat:stream:done", { sessionId: p.sessionId, stopped });
    return { stopped };
  });

  handleTrusted(deps, "perm:respond", (payload) => {
    const p = payload as {
      requestId: string;
      choice: "allow-once" | "allow-session" | "deny";
    };
    const received = deps.chatService.resolvePermission(p.requestId, p.choice);
    return { received };
  });
}
