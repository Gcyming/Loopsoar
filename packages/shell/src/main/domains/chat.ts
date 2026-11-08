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
  /** 新建会话归属的当前工作区。 */
  getActiveWorkspaceId?: () => string | null;
  /** 会话被打开/新建（壳层据此切换浏览器标签"文件夹"）。可等待：返回前完成标签组切换。 */
  onSessionOpened?: (sessionId: string) => void | Promise<void>;
  /** 删除会话前清理它的 worktree（会话文件删除后拿不到路径）。 */
  onSessionDeleting?: (sessionId: string) => void | Promise<void>;
  /** 会话被删除（壳层据此销毁对应标签组并切到 nextId）。 */
  onSessionDeleted?: (sessionId: string, nextSessionId: string | null) => void | Promise<void>;
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

/** 生成中的会话：UI 的 saveTimeline 可能早于会话落库到达（done 事件先于 sessions.append），先暂存。 */
const activeStreams = new Set<string>();
const stagedTimelines = new Map<string, unknown[]>();
/**
 * 生成中的会话 → 已流出的正文累积。
 * 用于「应用退出/崩溃前」把已生成内容落盘：否则退出瞬间还在生成的那条回复会整段丢失，
 * 重启后看起来像「回复被截断」。正常结束时由 .then 落库并清除。
 */
const activePartials = new Map<string, string>();

/**
 * 退出前把仍在生成中的回复（已流出的部分）落盘。
 * 由 shutdown 流程调用；调用后清空内存记录，避免重复写入。
 */
export function flushActivePartials(save: (sessionId: string, text: string) => void): void {
  for (const [sessionId, text] of activePartials) {
    try {
      if (text.trim()) save(sessionId, `${text}\n\n（应用退出时本轮回复尚未完成，以上为已生成内容）`);
    } catch (err) {
      console.warn("[Loopsoar] 退出时保存生成中回复失败（已忽略）：", err);
    }
  }
  activePartials.clear();
}

/** 启动一次流式对话（后台跑，handler 先返回 accepted）。 */
function startStream(
  deps: ChatDeps,
  payload: { message: string; sessionId?: string; mode?: "build" | "plan"; reasoningEffort?: string },
): { accepted: boolean; sessionId: string } {
  // 会话解析：显式 > 当前会话 > 新建会话（多会话列表）
  let sessionId = payload.sessionId ?? deps.sessions?.currentId() ?? null;
  if (!sessionId) {
    sessionId =
      deps.sessions?.newSession(deps.getActiveWorkspaceId?.() ?? null).sessionId ?? `sess-${Date.now()}`;
    deps.onSessionOpened?.(sessionId);
  }
  let assistantText = "";
  const modelInfo = deps.getModelInfo?.();
  activeStreams.add(sessionId);

  void deps.chatService
    .stream({ message: payload.message, sessionId, mode: payload.mode, reasoningEffort: payload.reasoningEffort }, (item) => {
      const type = String(item.meta?.type ?? "chunk");
      if (type === "chunk") {
        assistantText += item.content;
        // 记录已流出正文（退出/崩溃时落盘的来源；正常结束会清除）
        activePartials.set(sessionId, assistantText);
      }
      if (type === "steer") {
        // 引导注入回执：走专用事件（不进 chat:stream:* 通用流），UI 撤待发卡并折进思考历程
        let parsed: { items?: { id?: string; text?: string; kind?: string; fromName?: string }[] } = {};
        try {
          parsed = JSON.parse(item.content) as typeof parsed;
        } catch {
          parsed = {};
        }
        const items = Array.isArray(parsed.items)
          ? parsed.items.filter(
              (it): it is { id: string; text: string; kind?: string; fromName?: string } =>
                Boolean(it) && typeof it.id === "string" && typeof it.text === "string",
            )
          : [];
        deps.push("chat:steer:applied", { sessionId, items });
        return;
      }
      const content = type === "error" ? sanitizeErrorMessage(item.content) : item.content;
      deps.push(`chat:stream:${type}`, {
        sessionId,
        content,
        meta: item.meta,
      });
    })
    .then(async (result) => {
      const finalText = result.finalText || assistantText;
      activePartials.delete(sessionId);
      // 会话持久化（恢复上次会话的数据来源）
      deps.sessions?.append(sessionId, payload.message, finalText, modelInfo);
      // 时间线回填：done 事件先于 append 到达，UI 的 saveTimeline 可能先落进暂存区；
      // 这里（append 之后）再挂到刚追加的助手消息上，否则会错误覆盖上一条助手消息的时间线。
      activeStreams.delete(sessionId);
      const stagedTimeline = stagedTimelines.get(sessionId);
      stagedTimelines.delete(sessionId);
      if (stagedTimeline && stagedTimeline.length > 0) {
        deps.sessions?.attachTimeline(sessionId, stagedTimeline);
      }
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
      activeStreams.delete(sessionId);
      stagedTimelines.delete(sessionId);
      activePartials.delete(sessionId);
      const cleaned = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      // 异常中断也要把已经流式产出的正文落库：否则重启后这段内容凭空消失，
      // 用户看到的就是「回复被截断/丢了尾巴」（m02515 截断根除）。没有产出正文时保持原样。
      if (assistantText.trim()) {
        try {
          deps.sessions?.append(sessionId, payload.message, `${assistantText}\n\n（本轮异常中断：${cleaned}）`, modelInfo);
        } catch (appendErr) {
          console.warn("[Loopsoar] 异常中断时保存部分回复失败（已忽略）：", appendErr);
        }
      }
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
    const p = payload as { message: string; sessionId?: string; steerId?: string };
    return deps.chatService.steer(p.sessionId ?? undefined, p.message, p.steerId);
  });

  // 撤销尚未注入的引导（待发卡的修改/撤销删除动作）
  handleTrusted(deps, "chat:steerCancel", (payload) => {
    const p = payload as { steerId: string; sessionId?: string };
    return { cancelled: deps.chatService.steerCancel(p.sessionId ?? undefined, p.steerId) };
  });

  handleTrusted(deps, "chat:saveTimeline", (payload) => {
    const p = payload as { sessionId?: string; timeline?: unknown[] };
    const timeline = Array.isArray(p.timeline) ? p.timeline : [];
    // done 事件先于会话落库到达：本轮流仍在跑（append 未完成）时先暂存，
    // 由 startStream 在 append 之后挂到新助手消息上；否则立即挂到已有会话的最后一条助手消息。
    if (p.sessionId && activeStreams.has(p.sessionId)) {
      stagedTimelines.set(p.sessionId, timeline);
      return { ok: true };
    }
    const ok = deps.sessions?.attachTimeline(p.sessionId ?? null, timeline) ?? false;
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

  handleTrusted(deps, "chat:newSession", async () => {
    const session = deps.sessions?.newSession(deps.getActiveWorkspaceId?.() ?? null) ?? null;
    if (session?.sessionId) await deps.onSessionOpened?.(session.sessionId);
    return { session, sessions: deps.sessions?.list() ?? [], currentId: session?.sessionId ?? null };
  });

  handleTrusted(deps, "chat:switchSession", async (payload) => {
    const p = payload as { sessionId: string };
    const ok = deps.sessions?.switchTo(p.sessionId) ?? false;
    if (ok) await deps.onSessionOpened?.(p.sessionId);
    return { ok, session: ok ? deps.sessions?.load() ?? null : null };
  });

  handleTrusted(deps, "chat:deleteSession", async (payload) => {
    const p = payload as { sessionId: string };
    if (deps.sessions?.get(p.sessionId)) await deps.onSessionDeleting?.(p.sessionId);
    const removed = deps.sessions?.remove(p.sessionId) ?? false;
    if (removed) await deps.onSessionDeleted?.(p.sessionId, deps.sessions?.currentId() ?? null);
    return { removed, sessions: deps.sessions?.list() ?? [], currentId: deps.sessions?.currentId() ?? null };
  });
}
