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
  /** 规则候选：从用户消息中识别硬约束，交给人确认；未注入时静默跳过。 */
  ruleLearning?: {
    observe(input: { sessionId: string; workspaceId?: string; message: string }): { added: number; repeated: number } | Promise<{ added: number; repeated: number }>;
  };
  sessions?: SessionStore;
  /** 是否自动从会话抽取记忆（来自「通用」偏好）。 */
  shouldAutoCapture?: () => boolean;
  /** 当前生成本轮回复的供应商/模型（流开始瞬间快照，避免中途切换污染历史）。 */
  getModelInfo?: () => { provider?: string; model?: string } | undefined;
  /** 新建会话归属的当前工作区。 */
  getActiveWorkspaceId?: () => string | null;
  /** 默认工作区（新会话首次对话时自动认领）。 */
  getDefaultWorkspaceId?: () => string | null;
  /** 会话被打开/新建（壳层据此切换浏览器标签"文件夹"）。可等待：返回前完成标签组切换。 */
  onSessionOpened?: (sessionId: string, requestedWorkspaceId?: string | null) => void | Promise<void>;
  /** 删除会话前清理它的 worktree（会话文件删除后拿不到路径）。 */
  onSessionDeleting?: (sessionId: string) => void | Promise<void>;
  /** 会话被删除（壳层据此销毁对应标签组并切到 nextId）。 */
  onSessionDeleted?: (sessionId: string, nextSessionId: string | null) => void | Promise<void>;
  /**
   * 一轮对话开始 / 结束（含异常与用户停止）。
   *
   * 为什么放在壳层而不是渲染层：接管锁的对象是**网页**，归属会话；后台会话、独立小窗、
   * 甚至没有窗口的时候 Agent 都可能跑起来。渲染层只知道自己那一个会话的 busy，
   * 用它决定锁不锁会在「后台会话仍在跑」时漏锁、在「切走会话」时锁错对象。
   */
  onTurnStarted?: (sessionId: string) => void;
  onTurnSettled?: (sessionId: string) => void;
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
/**
 * 「运行中被删除」的会话：回合结束时必须跳过 sessions.append —— 否则 append 会按
 * `current ?? {新会话}` 重建并写回索引，用户刚删掉的会话会带着最后一轮“复活”。
 */
const deletedSessions = new Set<string>();
/** 运行中被删除时清掉墓碑（会话 id 不复用；清掉避免集合无限增长）。 */
function takeTombstone(sessionId: string): boolean {
  return deletedSessions.delete(sessionId);
}
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

/** 是否有会话正在生成（退出确认用：运行中退出会丢当前回合）。 */
export function hasActiveStreams(): boolean {
  return activeStreams.size > 0;
}

/** 正在生成的会话 id（渲染器崩溃自愈后用它恢复 busy 态，避免重复发送/并发流）。 */
export function activeChatStreamIds(): string[] {
  return [...activeStreams];
}

/** 启动一次流式对话（后台跑，handler 先返回 accepted）。 */
export function startStream(
  deps: ChatDeps,
  payload: {
    message: string;
    sessionId?: string;
    mode?: "build" | "plan";
    reasoningEffort?: string;
    /** 定时任务等无人值守会话：普通工具确认自动放行，敏感步骤拒绝。 */
    autonomous?: boolean;
  },
  hooks?: {
    /** 本轮正常结束（会话已落库）；定时任务据此记运行结果。 */
    onDone?: (result: { sessionId: string; finalText: string }) => void;
    /** 本轮异常中断（已尽力保存部分正文）。 */
    onError?: (result: { sessionId: string; error: string }) => void;
  },
): { accepted: boolean; sessionId: string; error?: string } {
  // 会话解析：显式 > 当前会话 > 新建会话（多会话列表）
  let sessionId = payload.sessionId ?? deps.sessions?.currentId() ?? null;
  if (!sessionId) {
    sessionId =
      deps.sessions?.newSession(null).sessionId ?? `sess-${Date.now()}`;
    deps.onSessionOpened?.(sessionId, null);
  }
  // 同一会话同时只允许一条流：并发流会覆盖 abort/steer 控制器，两轮内容交错写进同一气泡、
  // 且各自 append 一次（重启后重复）。这里在入口直接拒绝，由 UI 撤销乐观占位并提示。
  if (activeStreams.has(sessionId)) {
    return { accepted: false, sessionId, error: "该会话已有回复正在生成，请先停止或等待本轮结束" };
  }
  if (deletedSessions.has(sessionId)) {
    return { accepted: false, sessionId, error: "会话已被删除" };
  }
  // 用户规则（m09384）：只有完全没选工作区的新用户直接对话才落到「未归属工作区」；
  // 不再自动绑定默认工作区（工作区由输入框/左侧下拉选择，新建页不创建会话）。
  let assistantText = "";
  let deletedMidRun = false;
  const modelInfo = deps.getModelInfo?.();
  activeStreams.add(sessionId);
  // 先上锁再开跑：模型第一个工具调用到达前，网页就已经处于「Agent 操作中」状态。
  deps.onTurnStarted?.(sessionId);

  void deps.chatService
    .stream({ message: payload.message, sessionId, mode: payload.mode, reasoningEffort: payload.reasoningEffort, autonomous: payload.autonomous }, (item) => {
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
      activeStreams.delete(sessionId);
      const stagedTimeline = stagedTimelines.get(sessionId);
      stagedTimelines.delete(sessionId);
      // 会话在生成期间被用户删除：不要 append（否则会话会被重建并“复活”）。
      if (takeTombstone(sessionId)) {
        deletedMidRun = true;
        return;
      }
      // 会话持久化（恢复上次会话的数据来源）
      deps.sessions?.append(sessionId, payload.message, finalText, modelInfo);
      // 时间线回填：done 事件先于 append 到达，UI 的 saveTimeline 可能先落进暂存区；
      // 这里（append 之后）再挂到刚追加的助手消息上，否则会错误覆盖上一条助手消息的时间线。
      if (stagedTimeline && stagedTimeline.length > 0) {
        deps.sessions?.attachTimeline(sessionId, stagedTimeline);
      }
      // 先通知调用方「本轮已落库」，再做记忆汇总等后台工作：定时任务不应等记忆抽取。
      try {
        hooks?.onDone?.({ sessionId, finalText });
      } catch (hookErr) {
        console.warn("[Loopsoar] onDone 回调失败（已忽略）：", hookErr);
      }
      // 记忆自动汇总：抽取候选 → 五门治理 → 落盘（失败不阻断对话）
      if (deps.memory && (deps.shouldAutoCapture?.() ?? true) && finalText.trim()) {
        try {
          const captured = await deps.memory.captureFromTurn({
            userMessage: payload.message,
            assistantReply: finalText,
            sessionId,
            workspaceId: deps.sessions?.get(sessionId)?.workspaceId ?? undefined,
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
      // 规则候选：只识别「必须/只能/不要…」这类硬约束，等用户采纳后才写 AGENTS.md。
      if (deps.ruleLearning) {
        try {
          const learned = await deps.ruleLearning.observe({
            sessionId,
            workspaceId: deps.sessions?.get(sessionId)?.workspaceId ?? undefined,
            message: payload.message,
          });
          if (learned.added > 0 || learned.repeated > 0) {
            deps.push("rules:updated", { action: "observed", ...learned });
          }
        } catch (err) {
          console.warn("[Loopsoar] 规则候选识别失败（已忽略）：", err);
        }
      }
    })
    .finally(() => {
      // 正常结束 / 异常 / 用户停止都会走到这里：解锁绝不能只挂在成功分支上。
      // 会话已被删除时跳过收尾钩子（任务分支/浏览器锁都不该再为一个不存在的会话工作）。
      if (!deletedMidRun) deps.onTurnSettled?.(sessionId);
    })
    .catch((err: unknown) => {
      activeStreams.delete(sessionId);
      stagedTimelines.delete(sessionId);
      activePartials.delete(sessionId);
      if (takeTombstone(sessionId)) {
        deletedMidRun = true;
        return;
      }
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
      try {
        hooks?.onError?.({ sessionId, error: cleaned });
      } catch (hookErr) {
        console.warn("[Loopsoar] onError 回调失败（已忽略）：", hookErr);
      }
    });
  return { accepted: true, sessionId };
}

export function registerChatDomain(deps: ChatDeps): ChatDeps {
  handleTrusted(deps, "chat:stream", (payload) =>
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

  handleTrusted(deps, "chat:renameSession", (payload) => {
    const p = payload as { sessionId: string; title: string };
    const ok = deps.sessions?.renameSession(p.sessionId, p.title) ?? false;
    return { ok, sessions: deps.sessions?.list() ?? [] };
  });

  handleTrusted(deps, "chat:forkSession", async (payload) => {
    const p = payload as { sessionId?: string; keepCount: number; title?: string };
    const sourceId = p.sessionId ?? deps.sessions?.currentId() ?? null;
    if (!sourceId) return { ok: false, session: null, sessions: deps.sessions?.list() ?? [], currentId: null };
    const session = deps.sessions?.fork(sourceId, p.keepCount, p.title) ?? null;
    // 分支会话同样走「打开会话」链路：切工作区/浏览器组，但不继承旧会话的标签页。
    if (session?.sessionId) await deps.onSessionOpened?.(session.sessionId);
    return {
      ok: session !== null,
      session,
      sessions: deps.sessions?.list() ?? [],
      currentId: session?.sessionId ?? null,
    };
  });

  handleTrusted(deps, "chat:stop", (payload) => {
    const p = payload as { sessionId: string };
    // 只调用 stop：ChatService 的 stream 收尾会 emit 唯一的 done（aborted）。
    // 这里若再手工 push done，UI 会收到两次 done，表现为「看起来结束了但实际还在跑」。
    const stopped = deps.chatService.stop(p.sessionId);
    return { stopped };
  });

  // 暂停/恢复：缺省会话 = 壳层当前会话（输入区控制条无需自己查会话 id）。
  handleTrusted(deps, "chat:pause", (payload) => {
    const p = payload as { sessionId?: string };
    const sessionId = p.sessionId ?? deps.sessions?.currentId() ?? "";
    if (!sessionId) return { paused: false, error: "没有可暂停的活动会话" };
    const paused = deps.chatService.pause(sessionId);
    if (paused) deps.push("chat:pauseState", { sessionId, paused: true });
    return { paused, sessionId };
  });

  handleTrusted(deps, "chat:resume", (payload) => {
    const p = payload as { sessionId?: string; change?: string };
    const sessionId = p.sessionId ?? deps.sessions?.currentId() ?? "";
    if (!sessionId) return { resumed: false, error: "没有可恢复的活动会话" };
    const change = p.change?.trim();
    // 先投递改动，再放行：下一次轮次边界 drain 时模型已能拿到新约束。
    let steer: { accepted: boolean; reason?: string } | null = null;
    if (change) {
      steer = deps.chatService.steer(sessionId, `【暂停期间用户修改】\n${change}`, undefined);
      // 投递失败（运行已结束/队列满）不能假装恢复成功：保持暂停态让用户重试或终止。
      if (!steer.accepted) {
        return {
          resumed: false,
          sessionId,
          error: steer.reason === "full" ? "改动队列已满，请先取消一条待发指令" : "改动未能注入（运行可能已结束），请重试",
          steer,
        };
      }
    }
    const resumed = deps.chatService.resume(sessionId);
    if (resumed) deps.push("chat:pauseState", { sessionId, paused: false });
    return { resumed, sessionId, steer };
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

  handleTrusted(deps, "chat:newSession", async (payload) => {
    const p = (payload ?? {}) as { workspaceId?: string | null };
    // undefined = 旧行为（当前活动工作区）；null = 暂不归属，等首次对话自动落默认工作区。
    const workspaceId = p.workspaceId === undefined ? deps.getActiveWorkspaceId?.() ?? null : p.workspaceId;
    const session = deps.sessions?.newSession(workspaceId) ?? null;
    if (session?.sessionId) await deps.onSessionOpened?.(session.sessionId, workspaceId);
    return { session, sessions: deps.sessions?.list() ?? [], currentId: session?.sessionId ?? null };
  });

  handleTrusted(deps, "chat:switchSession", async (payload) => {
    const p = payload as { sessionId: string };
    const ok = deps.sessions?.switchTo(p.sessionId) ?? false;
    if (ok) await deps.onSessionOpened?.(p.sessionId);
    return { ok, session: ok ? deps.sessions?.load() ?? null : null };
  });

  // 会话级「浏览器控制」开关（功能1）：落到会话文件 + 索引；下一轮 stream 起工具面生效。
  // 关闭时 browser_* 既不进 toolSchemas（模型看不见）也过不了执行闸（见 main/index.ts 装配）。
  handleTrusted(deps, "chat:setBrowserControl", (payload) => {
    const p = payload as { sessionId: string; enabled: boolean };
    const ok = deps.sessions?.setBrowserControl(p.sessionId, p.enabled) ?? false;
    return { ok };
  });

  handleTrusted(deps, "chat:deleteSession", async (payload) => {
    const p = payload as { sessionId: string };
    // 先停止运行中的回合，并登记墓碑：否则回合结束时的 append 会把刚删除的会话写回来。
    if (deps.chatService.stop(p.sessionId)) deletedSessions.add(p.sessionId);
    if (deps.sessions?.get(p.sessionId)) await deps.onSessionDeleting?.(p.sessionId);
    const removed = deps.sessions?.remove(p.sessionId) ?? false;
    if (removed) await deps.onSessionDeleted?.(p.sessionId, deps.sessions?.currentId() ?? null);
    return { removed, sessions: deps.sessions?.list() ?? [], currentId: deps.sessions?.currentId() ?? null };
  });
  return deps;
}
