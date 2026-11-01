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
  /** 当前生成本轮回复的供应商/模型（流开始瞬间快照，避免中途切换污染历史）。 */
  getModelInfo?: () => { provider?: string; model?: string } | undefined;
}

/** 错误清洗：解开多层 JSON 转义，提取 error.message，去控制字符并截断。 */
export function sanitizeErrorMessage(raw: string): string {
  let text = String(raw ?? "");
  for (let i = 0; i < 3; i += 1) {
    if (!text.includes('\\"') && !text.includes("\\n")) break;
    text = text
      .replace(/\\"/g, '"')
      .replace(/\\n/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\\\/g, "\\");
  }
  const tryExtract = (obj: unknown): string | null => {
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    const direct = o.message ?? o.error;
    if (typeof direct === "string") return direct;
    if (direct && typeof direct === "object") {
      const nested = (direct as Record<string, unknown>).message;
      if (typeof nested === "string") return nested;
    }
    return null;
  };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const extracted = tryExtract(JSON.parse(text.slice(start, end + 1)));
      if (extracted) text = extracted;
    } catch {
      // 保留原文
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 320 ? `${text.slice(0, 320)}…` : text;
}

/** 启动一次流式对话（后台跑，handler 先返回 accepted）。 */
function startStream(
  deps: ChatDeps,
  payload: { message: string; sessionId?: string; mode?: "build" | "plan"; reasoningEffort?: string },
): { accepted: boolean; sessionId: string } {
  // 会话解析：显式 > 当前会话 > 新建会话（多会话列表）
  const sessionId =
    payload.sessionId ??
    deps.sessions?.currentId() ??
    deps.sessions?.newSession().sessionId ??
    `sess-${Date.now()}`;
  let assistantText = "";
  const modelInfo = deps.getModelInfo?.();

  void deps.chatService
    .stream({ message: payload.message, sessionId, mode: payload.mode, reasoningEffort: payload.reasoningEffort }, (item) => {
      const type = String(item.meta?.type ?? "chunk");
      if (type === "chunk") assistantText += item.content;
      const content = type === "error" ? sanitizeErrorMessage(item.content) : item.content;
      deps.push(`chat:stream:${type}`, {
        sessionId,
        content,
        meta: item.meta,
      });
    })
    .then(async (result) => {
      const finalText = result.finalText || assistantText;
      // 会话持久化（恢复上次会话的数据来源）
      deps.sessions?.append(sessionId, payload.message, finalText, modelInfo);
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
      const cleaned = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      deps.push("chat:stream:error", { sessionId, content: cleaned, message: cleaned });
    });
  return { accepted: true, sessionId };
}

export function registerChatDomain(deps: ChatDeps): void {
  handleTrusted(deps, "chat:stream", (payload) =>
    startStream(deps, payload as { message: string; sessionId?: string; mode?: "build" | "plan" }),
  );

  handleTrusted(deps, "chat:send", (payload) =>
    startStream(deps, payload as { message: string; sessionId?: string; mode?: "build" | "plan" }),
  );

  handleTrusted(deps, "chat:steer", (payload) => {
    const p = payload as { message: string; sessionId?: string };
    const accepted = deps.chatService.steer(p.sessionId ?? undefined, p.message);
    return { accepted };
  });

  handleTrusted(deps, "chat:saveTimeline", (payload) => {
    const p = payload as { sessionId?: string; timeline?: unknown[] };
    const ok = deps.sessions?.attachTimeline(p.sessionId ?? null, Array.isArray(p.timeline) ? p.timeline : []) ?? false;
    return { ok };
  });

  handleTrusted(deps, "chat:rollback", (payload) => {
    const p = payload as { keepCount: number; sessionId?: string };
    const session = deps.sessions?.truncate(p.sessionId ?? null, p.keepCount) ?? null;
    return { ok: session !== null, session };
  });

  handleTrusted(deps, "chat:stop", (payload) => {
    const p = payload as { sessionId: string };
    // 只调用 stop：ChatService 的 stream 收尾会 emit 唯一的 done（aborted）。
    // 这里若再手工 push done，UI 会收到两次 done，表现为「看起来结束了但实际还在跑」。
    const stopped = deps.chatService.stop(p.sessionId);
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

  // ── 多会话管理 ──
  handleTrusted(deps, "chat:sessions", () => ({
    sessions: deps.sessions?.list() ?? [],
    currentId: deps.sessions?.currentId() ?? null,
  }));

  handleTrusted(deps, "chat:newSession", () => {
    const session = deps.sessions?.newSession() ?? null;
    return { session, sessions: deps.sessions?.list() ?? [], currentId: session?.sessionId ?? null };
  });

  handleTrusted(deps, "chat:switchSession", (payload) => {
    const p = payload as { sessionId: string };
    const ok = deps.sessions?.switchTo(p.sessionId) ?? false;
    return { ok, session: ok ? deps.sessions?.load() ?? null : null };
  });

  handleTrusted(deps, "chat:deleteSession", (payload) => {
    const p = payload as { sessionId: string };
    const removed = deps.sessions?.remove(p.sessionId) ?? false;
    return { removed, sessions: deps.sessions?.list() ?? [], currentId: deps.sessions?.currentId() ?? null };
  });
}
