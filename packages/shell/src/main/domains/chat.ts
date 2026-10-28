/**
 * chat 域：流式对话（真实 ChatService）+ 会话持久化 + 记忆自动汇总 + 历史读取。
 * 事件映射：ChunkItem.meta.type → chat:stream:<type>；perm:respond 结算挂起确认；chat:stop 中止。
 */
import type { ChatService } from "loopsoar-services/chat";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { MemoryService } from "../memoryService.js";
import type { SessionStore } from "../sessionStore.js";

export interface ChatDeps extends TrustedIpcDeps {
  chatService: ChatService;
  push(event: string, payload: unknown): void;
  memory?: MemoryService;
  sessions?: SessionStore;
  /** 是否自动从会话抽取记忆（来自「通用」偏好）。 */
  shouldAutoCapture?: () => boolean;
}

/** 启动一次流式对话（后台跑，handler 先返回 accepted）。 */
function startStream(
  deps: ChatDeps,
  payload: { message: string; sessionId?: string },
): { accepted: boolean; sessionId: string } {
  const sessionId = payload.sessionId ?? `sess-${Date.now()}`;
  let assistantText = "";

  void deps.chatService
    .stream({ message: payload.message, sessionId }, (item) => {
      const type = String(item.meta?.type ?? "chunk");
      if (type === "chunk") assistantText += item.content;
      deps.push(`chat:stream:${type}`, {
        sessionId,
        content: item.content,
        meta: item.meta,
      });
    })
    .then(async (result) => {
      const finalText = result.finalText || assistantText;
      // 会话持久化（恢复上次会话的数据来源）
      deps.sessions?.append(sessionId, payload.message, finalText);
      // 记忆自动汇总：抽取候选 → 五门治理 → 落盘（失败不阻断对话）
      if (deps.memory && (deps.shouldAutoCapture?.() ?? true) && finalText.trim()) {
        try {
          const captured = await deps.memory.captureFromTurn({
            userMessage: payload.message,
            assistantReply: finalText,
          });
          if (captured.added || captured.merged || captured.deduped) {
            deps.push("memory:updated", {
              action: "capture",
              ...captured,
              total: deps.memory.stats().total,
            });
          }
        } catch (err) {
          console.warn("[Loopsoar] 记忆汇总失败（已忽略）：", err);
        }
      }
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

  // 历史会话（恢复上次会话；UI 启动时读取）
  handleTrusted(deps, "chat:history", () => {
    const session = deps.sessions?.load() ?? null;
    return { session };
  });
}
