import React, { useCallback, useEffect } from "react";
import type { LoopsoarAPI, ProviderStatus, SessionMeta, TabState } from "./types.js";
import { nextId } from "./ids.js";
import { applySteerToLatest, type ChatMessage, type SessionStreamMeta } from "./chatStreamState.js";
import {
  PENDING_STEER_MAX,
  enqueuePending,
  mergeDelivered,
  nextResendable,
  removePending,
  requeueUndelivered,
  setPendingStatus,
  type PendingSteer,
} from "./steerQueue.js";

/** 最小可变 ref 形状（只要求 current 可读写）。 */
interface MutableRef<T> {
  current: T;
}

/**
 * 聊天动作钩子：发送 / 首次建会话 / Vibecoding 首发送 / 运行中转向（steer）入队与投递 /
 * 回滚 / 重生成 / 停止，以及待发指令卡片的三操作与 steer 回执、一轮收尾续发。
 *
 * 从 App.tsx 的「状态与业务编排」中按职责外置：这些动作共享同一组会话缓存/队列 refs
 * 与 setter，聚合在一个钩子内可保持单一数据源与原有调用顺序，App 只做状态持有与装配。
 * 所有回调体与依赖原样迁移，行为不变。
 */
export interface UseChatActionsOptions {
  api: LoopsoarAPI | null;
  sessionIdRef: MutableRef<string>;
  metaFor: (sessionId: string) => SessionStreamMeta;
  updateSessionMessages: (sessionId: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  provider: ProviderStatus | null;
  setBusy: (value: boolean) => void;
  setNotice: (value: string) => void;
  mode: "build" | "plan";
  reasoningEffort: string;
  activeWorkspaceId: string | null;
  tabs: TabState[];
  tabSessionRef: MutableRef<Map<string, string>>;
  writeSessionMessages: (sessionId: string, next: ChatMessage[]) => void;
  setSessions: React.Dispatch<React.SetStateAction<SessionMeta[]>>;
  setCurrentSession: (value: string | null) => void;
  draftBrowserControlRef: MutableRef<boolean>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setPendingSteers: (value: PendingSteer[]) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  pickedSessionRef: MutableRef<boolean>;
  readPending: (sessionId: string) => PendingSteer[];
  writePending: (sessionId: string, next: PendingSteer[]) => void;
  input: string;
  busy: boolean;
  messages: ChatMessage[];
  steerAppliedRef: MutableRef<((sessionId: string, items: Array<{ id: string; text: string }>) => void) | null>;
  streamSettledRef: MutableRef<((sessionId: string) => void) | null>;
}

export interface ChatActions {
  sendText: (raw: string, targetSessionId?: string) => void;
  startVibe: (raw: string) => void;
  send: () => void;
  rollbackTo: (targetId: string) => void;
  regenerate: (assistantId: string) => void;
  stop: () => void;
  editPendingSteer: (id: string) => void;
  insertPendingSteer: (id: string) => void;
  removePendingSteer: (id: string) => void;
}

export function useChatActions(options: UseChatActionsOptions): ChatActions {
  const {
    api,
    sessionIdRef,
    metaFor,
    updateSessionMessages,
    provider,
    setBusy,
    setNotice,
    mode,
    reasoningEffort,
    activeWorkspaceId,
    tabs,
    tabSessionRef,
    writeSessionMessages,
    setSessions,
    setCurrentSession,
    draftBrowserControlRef,
    setMessages,
    setPendingSteers,
    setInput,
    pickedSessionRef,
    readPending,
    writePending,
    input,
    busy,
    messages,
    steerAppliedRef,
    streamSettledRef,
  } = options;

  /** 用户在本会话点过「停止」的标记：收尾时保留待发队列但不再自动续发。 */
  const stopRequestedRef = React.useRef<Set<string>>(new Set());

  /** 发送一条文本：立即渲染用户消息 + 助手占位（不等首字），再发起流式请求。 */
  const sendText = useCallback(
    (raw: string, targetSessionId?: string): void => {
      const text = raw.trim();
      if (!text || !api) return;
      const sid = targetSessionId ?? sessionIdRef.current;
      if (!sid) return;
      const meta = metaFor(sid);
      const assistantId = nextId("assistant");
      const userId = nextId("u");
      // 保存旧流状态：主进程可能拒绝本次 stream（例如另一个窗口已在同一会话生成），
      // 拒绝时必须原样恢复，否则旧流的 chunk 会被路由到已撤销的占位消息上。
      const previousMeta = {
        activeId: meta.activeId,
        startedAt: meta.startedAt,
        firstTokenAt: meta.firstTokenAt,
        busy: meta.busy,
        stopping: meta.stopping,
      };
      meta.activeId = assistantId;
      meta.startedAt = Date.now();
      meta.firstTokenAt = 0;
      meta.busy = true;
      meta.stopping = false;
      updateSessionMessages(sid, (prev) => [
        ...prev,
        { id: userId, role: "user", text, status: "done", createdAt: Date.now() },
        {
          id: assistantId,
          role: "assistant",
          text: "",
          status: "streaming",
          createdAt: Date.now(),
          provider: provider?.provider ?? undefined,
          model: provider?.model ?? undefined,
        },
      ]);
      setBusy(true);
      setNotice("");
      void api.chat
        .stream({ message: text, sessionId: sid, mode, reasoningEffort: reasoningEffort || undefined })
        .then((result) => {
          if (result?.accepted !== false) return;
          // 被拒（会话已有流/已删除）：撤销乐观插入的用户消息与占位，恢复发送前的运行状态，
          // 把原文放回输入框（用户不必重新输入）。
          updateSessionMessages(sid, (prev) => prev.filter((m) => m.id !== assistantId && m.id !== userId));
          Object.assign(meta, previousMeta);
          if (sid === sessionIdRef.current) {
            setInput((prev) => (prev.trim() ? prev : text));
            setBusy(previousMeta.busy);
            setNotice(result.error ?? "发送失败：该会话已有回复正在生成");
          }
        })
        .catch((err: unknown) => {
          // 传输层失败：把占位收成错误消息（否则气泡会永远停留在“输出中”）。
          meta.busy = previousMeta.busy;
          meta.activeId = previousMeta.activeId;
          meta.startedAt = previousMeta.startedAt;
          meta.firstTokenAt = previousMeta.firstTokenAt;
          if (sid === sessionIdRef.current) {
            setBusy(previousMeta.busy);
            setNotice(`发送失败：${err instanceof Error ? err.message : String(err)}`);
          }
          updateSessionMessages(sid, (prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, status: "error" as const, tail: undefined, errorText: err instanceof Error ? err.message : String(err) }
                : m,
            ),
          );
        });
    },
    [api, metaFor, mode, provider, reasoningEffort, setBusy, setInput, setNotice, updateSessionMessages],
  );

  /** 首次发送：没有会话时创建（工作区=当前选择；没有选择则未归属），并切换到该会话。 */
  const ensureSessionForSend = useCallback(async (): Promise<string | null> => {
    if (!api) return null;
    if (sessionIdRef.current) return sessionIdRef.current;
    const created = await api.chat.newSession({ workspaceId: activeWorkspaceId ?? null });
    const sid = created.session?.sessionId ?? created.currentId ?? null;
    if (!sid) throw new Error("创建会话失败");
    sessionIdRef.current = sid;
    const boundTabId = tabs.find((tab) => tab.active)?.id;
    if (boundTabId) tabSessionRef.current.set(boundTabId, sid);
    writeSessionMessages(sid, []);
    setSessions(created.sessions);
    setCurrentSession(sid);
    // 草稿态点过「浏览器控制」：先落库再发首条消息——否则第一条消息的工具面会按「关闭」算，
    // 用户看到的是「开了开关但 Agent 说没有浏览器能力」。
    if (draftBrowserControlRef.current) {
      try {
        const saved = await api.chat.setBrowserControl({ sessionId: sid, enabled: true });
        if (saved.ok) {
          setSessions((prev) => prev.map((item) => (item.id === sid ? { ...item, browserControl: true } : item)));
        }
      } catch {
        // 落库失败不阻断发送：工具面按关闭处理（fail-closed）
      }
    }
    setMessages([]);
    setPendingSteers([]);
    setBusy(false);
    setInput("");
    return sid;
  }, [activeWorkspaceId, api, tabs, writeSessionMessages]);

  /** 新标签页 Vibecoding 首次发送：默认总是新建会话；只有刚在会话列表里主动选过会话才续接。 */
  const startVibe = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      if (!text || !api) return;
      const reusePicked = pickedSessionRef.current && Boolean(sessionIdRef.current);
      pickedSessionRef.current = false;
      const begin = async (): Promise<void> => {
        const sid = reusePicked && sessionIdRef.current ? sessionIdRef.current : await ensureSessionForSend();
        if (!sid) throw new Error("创建会话失败");
        sendText(text, sid);
      };
      void begin().catch((err: unknown) => setNotice(`发送失败：${err instanceof Error ? err.message : String(err)}`));
    },
    [api, ensureSessionForSend, sendText],
  );
  /** 投递一条待发指令：运行中不打断，主进程在轮次边界注入后回执 chat:steer:applied。 */
  const deliverSteer = useCallback(
    (sid: string, item: PendingSteer): void => {
      if (!api) return;
      void api.chat
        .steer({ message: item.text, sessionId: sid, steerId: item.id })
        .then((result) => {
          if (result.accepted) {
            writePending(sid, setPendingStatus(readPending(sid), item.id, "delivered"));
            return;
          }
          const reason =
            result.reason === "full"
              ? "队列已满（最多 8 条）"
              : result.reason === "no-running"
                ? "当前没有运行中的回复"
                : "内容为空或重复";
          // 没送达就留在队列里（queued）：本轮结束后由 onStreamSettled 自动续发
          writePending(sid, setPendingStatus(readPending(sid), item.id, "queued", reason));
          setNotice(`待发指令暂存队列：${reason}`);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          writePending(sid, setPendingStatus(readPending(sid), item.id, "failed", message));
          setNotice(`待发指令投递失败：${message}`);
        });
    },
    [api, readPending, writePending],
  );

  /**
   * 运行中发送：**只入队，不投递**（对齐 slime 三选项语义）。
   *
   * 用户发出后先显示待发卡，由用户三选一：
   *   · 什么都不做 → 本轮 Agent 输出结束后，自动把这条作为下一轮用户需求发出；
   *   · 点卡片上的「引导」→ 作为 steer 投递，在当前这轮的下一个轮次边界并入思考历程（绝不打断）；
   *   · 点「修改」/「撤销删除」→ 取回重写或丢弃。
   * 此前是"入队即投递"，用户明确否掉了这一形态。
   */
  const queueSteer = useCallback(
    (raw: string): boolean => {
      const text = raw.trim();
      const sid = sessionIdRef.current;
      if (!text || !sid || !api) return false;
      const current = readPending(sid);
      if (current.length >= PENDING_STEER_MAX) {
        setNotice(`待发队列已满（最多 ${PENDING_STEER_MAX} 条），请等本轮结束后再发`);
        return false;
      }
      const item: PendingSteer = { id: nextId("steer"), text, createdAt: Date.now(), status: "queued" };
      writePending(sid, enqueuePending(current, item));
      setNotice(`已排队（${current.length + 1}/${PENDING_STEER_MAX}）：本轮结束后自动发出；点「引导」可提前并入当前思考`);
      return true;
    },
    [api, readPending, writePending],
  );

  const send = useCallback((override?: string): void => {
    const text = (override ?? input).trim();
    if (!text || !api) return;
    if (busy) {
      // 运行中：Enter = 待发指令（入队 + 投递，不打断当前输出；slime 语义）。
      // 只有真正入队成功才清空输入：队列满时保留原文，避免用户丢消息（旧实现先清空再判满）。
      if (queueSteer(text)) setInput("");
      return;
    }
    setInput("");
    void ensureSessionForSend()
      .then((sid) => {
        if (sid) sendText(text, sid);
      })
      .catch((err: unknown) => setNotice(`发送失败：${err instanceof Error ? err.message : String(err)}`));
  }, [api, busy, ensureSessionForSend, input, queueSteer, sendText]);

  /** 回滚到某条用户消息：消息之后的对话删除、内容放回输入框、持久化会话同步截断。 */
  const rollbackTo = useCallback(
    (targetId: string): void => {
      // 生成中禁止回滚：清空消息后仍在跑的流会继续往缓存写增量，UI 出现「幽灵回复」，
      // 而落库又按截断后的历史追加，重启后前后不一致（会同时丢上下文和写重复）。
      if (busy) {
        setNotice("正在生成回复，请先停止或等待本轮结束后再回滚");
        return;
      }
      const idx = messages.findIndex((m) => m.id === targetId);
      if (idx < 0) return;
      const target = messages[idx];
      if (target.role !== "user") return;
      const keepCount = messages
        .slice(0, idx)
        .filter((m) => m.role === "user" || (m.role === "assistant" && m.status !== "error")).length;
      const sid = sessionIdRef.current;
      if (sid) updateSessionMessages(sid, (prev) => prev.slice(0, idx));
      setInput(target.text);
      setNotice("已回滚到该消息，内容已放回输入框");
      void api?.chat.rollback({ keepCount, sessionId: sessionIdRef.current ?? undefined }).catch(() => {});
    },
    [api, busy, messages, updateSessionMessages],
  );

  /** 重新生成：回滚到上一条用户消息并重发（复用现有 rollback + sendText 通道）。 */
  const regenerate = useCallback(
    (assistantId: string): void => {
      // 生成中禁止「重新生成」：会并发启动第二条流，两轮内容交错写进同一气泡并重复落库。
      if (busy) {
        setNotice("正在生成回复，请先停止或等待本轮结束后再重新生成");
        return;
      }
      const idx = messages.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      let userIdx = -1;
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (messages[i].role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) return;
      const text = messages[userIdx].text;
      const keepCount = messages
        .slice(0, userIdx)
        .filter((m) => m.role === "user" || (m.role === "assistant" && m.status !== "error")).length;
      const sid = sessionIdRef.current;
      if (sid) updateSessionMessages(sid, (prev) => prev.slice(0, userIdx));
      void api?.chat.rollback({ keepCount, sessionId: sessionIdRef.current ?? undefined }).catch(() => {});
      window.setTimeout(() => sendText(text), 80);
    },
    [api, busy, messages, sendText, updateSessionMessages],
  );

  const stop = useCallback((): void => {
    if (!api) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    // 标记「用户主动停止」：abort 的 error 事件被 UI 收束为已停止，而不是红色报错
    const meta = metaFor(sid);
    meta.stopping = true;
    // 停止 = 用户要中断本轮，不能在本轮收尾后立刻把待发队列自动发出去（会像「停不下来」）。
    stopRequestedRef.current.add(sid);
    setNotice("正在停止…");
    void api.chat
      .stop({ sessionId: sid })
      .then((r) => {
        if (r.stopped) return;
        stopRequestedRef.current.delete(sid);
        meta.stopping = false;
        meta.busy = false;
        setBusy(false);
        setNotice("当前没有正在运行的回复");
      })
      .catch(() => {
        stopRequestedRef.current.delete(sid);
        meta.stopping = false;
      });
  }, [api, metaFor]);

  /* ------------------------- 待发指令卡片的三个操作 ------------------------- */

  /** 修改：撤销主进程缓冲 → 移出队列 → 文本放回输入框。 */
  const editPendingSteer = useCallback(
    (id: string): void => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const item = readPending(sid).find((entry) => entry.id === id);
      if (!item) return;
      void api?.chat.steerCancel({ steerId: id, sessionId: sid }).catch(() => {});
      writePending(sid, removePending(readPending(sid), id));
      setInput((prev) => (prev ? `${prev}\n${item.text}` : item.text));
      setNotice("已取回待发内容，可修改后重新发送");
    },
    [api, readPending, writePending],
  );

  /** 引导插入：仅此按钮会把排队内容作为 steer 投递给主进程（并入当前这轮思考，不打断）。 */
  const insertPendingSteer = useCallback(
    (id: string): void => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const item = readPending(sid).find((entry) => entry.id === id);
      if (!item) return;
      if (item.status === "delivered") {
        setNotice("已作为引导投递，等待本轮注入");
        return;
      }
      writePending(sid, setPendingStatus(readPending(sid), id, "queued"));
      deliverSteer(sid, item);
      setNotice("已作为引导插入当前这一轮（不打断输出）…");
    },
    [deliverSteer, readPending, writePending],
  );

  /** 撤销删除：撤销主进程缓冲并移出队列。 */
  const removePendingSteer = useCallback(
    (id: string): void => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      void api?.chat.steerCancel({ steerId: id, sessionId: sid }).catch(() => {});
      writePending(sid, removePending(readPending(sid), id));
      setNotice("已撤销待发指令");
    },
    [api, readPending, writePending],
  );

  /** 注入回执：撤卡 + 把文案折进当轮 assistant 的「引导」时间线卡（不乐观提前塞）。 */
  const handleSteerApplied = useCallback(
    (sessionId: string, items: Array<{ id: string; text: string }>): void => {
      const { next, deliveredTexts } = mergeDelivered(readPending(sessionId), items);
      writePending(sessionId, next);
      if (deliveredTexts.length === 0) return;
      updateSessionMessages(sessionId, (prev) => deliveredTexts.reduce((acc, text) => applySteerToLatest(acc, text), prev));
      setNotice(deliveredTexts.length === 1 ? "引导已并入本轮思考历程" : `已并入 ${deliveredTexts.length} 条引导`);
    },
    [readPending, updateSessionMessages, writePending],
  );

  /** 一轮收尾：未注入的改回 queued；当前会话自动续发第一条（slime 的排队续发语义）。 */
  const handleStreamSettled = useCallback(
    (sessionId: string): void => {
      // 本轮可能刚把会话升级成「浏览器任务」：刷新列表，任务/分支徽标不必等下次切会话。
      void api?.chat
        .sessions()
        .then((r) => setSessions(r.sessions))
        .catch(() => undefined);
      const wasStopped = stopRequestedRef.current.delete(sessionId);
      const current = readPending(sessionId);
      if (current.length === 0) return;
      const requeued = requeueUndelivered(current);
      writePending(sessionId, requeued);
      if (sessionId !== sessionIdRef.current) return;
      // 用户刚点过停止：保留队列但不自动续发，避免「点了停止还在继续发」。
      if (wasStopped) {
        setNotice("已停止；待发指令保留在队列中，可手动发送或删除");
        return;
      }
      const next = nextResendable(requeued);
      if (!next) return;
      writePending(sessionId, removePending(requeued, next.id));
      window.setTimeout(() => {
        sendText(next.text);
        setNotice("本轮已结束，待发指令已自动续发");
      }, 120);
    },
    [readPending, sendText, writePending],
  );

  // 事件订阅在 useChatStreamEvents 内只绑一次：用 effect 把最新回调写进 ref 桥
  useEffect(() => {
    steerAppliedRef.current = handleSteerApplied;
  }, [handleSteerApplied]);
  useEffect(() => {
    streamSettledRef.current = handleStreamSettled;
  }, [handleStreamSettled]);

  return {
    sendText,
    startVibe,
    send,
    rollbackTo,
    regenerate,
    stop,
    editPendingSteer,
    insertPendingSteer,
    removePendingSteer,
  };
}
