/**
 * 后端同步钩子（从 App 抽出，行为与原内联 effect 完全一致）。
 *
 * 两个钩子：
 *   · useBootstrapData —— 挂载时并行拉取启动状态/供应商/偏好/会话/工作区/标签/下载，
 *     并监听窗口 resize 同步最大化状态；
 *   · useChatStreamEvents —— 订阅 chat:stream:*（chunk/reasoning/tool_start/tool/progress/
 *     done/error/heartbeat）、perm:request、ask:user、loop:fallback、browser:tabs/downloads、
 *     memory:updated，按 payload.sessionId 路由进 per-session 消息缓存。
 *
 * 设计约束（重要）：
 *   1. 事件全部由 chatStreamState 的纯函数处理，这里只做接线，不解析业务；
 *   2. options 里的设置器来自 useState、metaFor/updateSessionMessages 来自 useCallback，
 *      引用在会话生命周期内稳定，因此内部 effect 仍以 [api] 为依赖 —— 与拆分前的
 *      内联 effect 相同，不会因父组件重渲染而重复订阅 / 丢事件；
 *   3. 每条订阅都有 unsubscriber，effect cleanup 全部注销（StrictMode 双挂载安全）。
 */
import * as React from "react";
import type {
  AgentSummary,
  AskUserRequest,
  BootStatus,
  DownloadItem,
  LoopsoarAPI,
  PermissionsState,
  Preferences,
  ProviderStatus,
  SessionMeta,
  TabState,
  WorkspaceRecord,
} from "./types.js";
import {
  applyChunk,
  applyLateChunk,
  applyDone,
  applyReasoning,
  applyToolResult,
  applyToolStart,
  parseDone,
  restoreMessages,
  settleAbortedTools,
  type ChatMessage,
  type SessionStreamMeta,
} from "./chatStreamState.js";
import { nextId } from "./ids.js";

/** 最小 ref 形状（只要 current 可读写；避免依赖 React 版本里的 RefObject 命名差异）。 */
interface MutableRef<T> {
  current: T;
}

export interface BootstrapDataOptions {
  api: LoopsoarAPI | null;
  sessionIdRef: MutableRef<string>;
  lastSyncedUrlRef: MutableRef<string>;
  /** 按会话缓存的消息表：恢复历史时同步写入，避免切回时丢历史。 */
  sessionCacheRef: MutableRef<Map<string, ChatMessage[]>>;
  setBoot: (value: BootStatus | null) => void;
  setProvider: (value: ProviderStatus | null) => void;
  setAgents: (value: AgentSummary[]) => void;
  setMaximized: (value: boolean) => void;
  setPreferences: (value: Preferences | null) => void;
  setReasoningEffort: (value: string) => void;
  setSidebarWidth: (value: number) => void;
  setPermSummary: (value: PermissionsState | null) => void;
  setSessions: (value: SessionMeta[]) => void;
  setCurrentSession: (value: string | null) => void;
  setWorkspaces: (value: WorkspaceRecord[]) => void;
  setActiveWorkspaceId: (value: string | null) => void;
  setDownloads: (value: DownloadItem[]) => void;
  setTabs: (value: TabState[]) => void;
  setAddress: (value: string) => void;
  setCurrentUrl: (value: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setNotice: (value: string) => void;
}

/** 挂载期数据同步：启动状态 + 偏好 + 会话/工作区/标签 + 最大化监听。 */
export function useBootstrapData(options: BootstrapDataOptions): void {
  const {
    api,
    sessionIdRef,
    lastSyncedUrlRef,
    sessionCacheRef,
    setBoot,
    setProvider,
    setAgents,
    setMaximized,
    setPreferences,
    setReasoningEffort,
    setSidebarWidth,
    setPermSummary,
    setSessions,
    setCurrentSession,
    setWorkspaces,
    setActiveWorkspaceId,
    setDownloads,
    setTabs,
    setAddress,
    setCurrentUrl,
    setMessages,
    setNotice,
  } = options;

  React.useEffect(() => {
    if (!api) {
      setNotice("未在 Electron shell 中运行（window.loopsoarAPI 不存在）");
      return;
    }
    void (async () => {
      const [bootResult, providerResult, agentsResult, stateResult, prefsResult] = await Promise.allSettled([
        api.runtime.status(),
        api.settings.getProvider(),
        api.agents.list(),
        api.window.state(),
        api.settings.getPreferences(),
      ]);
      if (prefsResult.status === "fulfilled") {
        const prefs = prefsResult.value.preferences;
        setPreferences(prefs);
        setReasoningEffort(prefs.reasoningEffort ?? "");
        if (prefs.sidebarWidth) {
          setSidebarWidth(prefs.sidebarWidth);
          // 原生视图宽度只由 App 的 effectiveSidebarWidth 单一来源下发：
          // 这里再按偏好直发会把「收起态/独立 Agent 窗口态」覆盖回偏好宽度（曾导致网页不铺满）。
        }
        // 恢复上次会话（设置 · 通用 · 恢复上次会话）
        if (prefs.restoreSession) {
          const history = await api.chat.history().catch(() => null);
          if (history?.session?.messages?.length) {
            sessionIdRef.current = history.session.sessionId;
            const restored = restoreMessages(history.session.messages, nextId);
            // 只在界面仍为空时恢复：避免异步历史把用户刚发出的消息覆盖掉（曾导致"回复消失"）
            setMessages((prev) => (prev.length === 0 ? restored : prev));
            sessionCacheRef.current.set(history.session.sessionId, restored);
          }
        }
      }
      const permResult = await api.settings.getPermissions().catch(() => null);
      if (permResult) setPermSummary(permResult);
      const sessionResult = await api.chat.sessions().catch(() => null);
      if (sessionResult) {
        setSessions(sessionResult.sessions);
        setCurrentSession(sessionResult.currentId);
        // 没恢复历史（restoreSession=false 或历史为空）时，也必须采用 shell 的真实当前会话
        if (!sessionIdRef.current && sessionResult.currentId) {
          sessionIdRef.current = sessionResult.currentId;
        }
      }
      const workspaceResult = await api.workspace.list().catch(() => null);
      if (workspaceResult) {
        setWorkspaces(workspaceResult.workspaces);
        setActiveWorkspaceId(workspaceResult.activeId);
      }
      const dlResult = await api.browser.downloads().catch(() => null);
      if (dlResult) setDownloads(dlResult.downloads);
      const tabsResult = await api.browser.listTabs().catch(() => null);
      if (tabsResult) {
        setTabs(tabsResult.tabs);
        const active = tabsResult.tabs.find((tab) => tab.active);
        if (active?.url) {
          lastSyncedUrlRef.current = active.url;
          setAddress(active.url);
          setCurrentUrl(active.url);
        }
      }
      if (bootResult.status === "fulfilled") setBoot(bootResult.value);
      if (providerResult.status === "fulfilled") setProvider(providerResult.value);
      if (agentsResult.status === "fulfilled") setAgents(agentsResult.value.agents);
      if (stateResult.status === "fulfilled") setMaximized(stateResult.value.maximized);
    })();

    const syncMaximized = (): void => {
      void api.window
        .state()
        .then((s) => setMaximized(s.maximized))
        .catch(() => {});
    };
    window.addEventListener("resize", syncMaximized);

    return () => {
      window.removeEventListener("resize", syncMaximized);
    };
    // options 内的设置器/ref 引用稳定，效果等价于拆分前的 [api] 依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
}

export interface ChatStreamEventOptions {
  api: LoopsoarAPI | null;
  sessionIdRef: MutableRef<string>;
  lastSyncedUrlRef: MutableRef<string>;
  tailSeqRef: MutableRef<number>;
  metaFor: (sessionId: string) => SessionStreamMeta;
  updateSessionMessages: (sessionId: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  setPermReq: (
    value: {
      requestId: string;
      toolName: string;
      target?: string;
      kind?: string;
      reason?: string;
      category?: string;
    } | null,
  ) => void;
  setAskQueue: React.Dispatch<React.SetStateAction<AskUserRequest[]>>;
  setThinkingOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setDownloads: (value: DownloadItem[]) => void;
  setTabs: (value: TabState[]) => void;
  setAddress: (value: string) => void;
  setCurrentUrl: (value: string) => void;
  setBusy: (value: boolean) => void;
  setNotice: (value: string) => void;
  /** 待发指令注入回执（chat:steer:applied）：App 据此撤卡并把文案折进当轮时间线。 */
  onSteerApplied?: (sessionId: string, items: Array<{ id: string; text: string }>) => void;
  /** 某会话一轮收尾（done/error 结算后调用；后台会话也会调用，用于待发队列自动续发）。 */
  onStreamSettled?: (sessionId: string) => void;
}

/** 订阅后端事件并路由进 per-session 缓存；卸载时逐条退订。 */
export function useChatStreamEvents(options: ChatStreamEventOptions): void {
  const {
    api,
    sessionIdRef,
    lastSyncedUrlRef,
    tailSeqRef,
    metaFor,
    updateSessionMessages,
    setPermReq,
    setAskQueue,
    setThinkingOpen,
    setDownloads,
    setTabs,
    setAddress,
    setCurrentUrl,
    setBusy,
    setNotice,
    onSteerApplied,
    onStreamSettled,
  } = options;

  React.useEffect(() => {
    if (!api) return;

    /** 追加流式增量：text 累积 + tail 标记（触发逐单元渐入动画）。 */
    const upsertAssistant = (sessionId: string, delta: string): void => {
      const meta = metaFor(sessionId);
      if (meta.firstTokenAt === 0) meta.firstTokenAt = Date.now();
      tailSeqRef.current += 1;
      const tailSeq = tailSeqRef.current;
      const id = meta.activeId;
      if (!id) {
        // 迟到增量（done 之后才到）：并回最后一条助手消息，绝不新建气泡 ——
        // 否则正文会被劈成“前半缺尾 + 后半寥寥几字”，只有重启 App 才恢复。
        updateSessionMessages(sessionId, (prev) => applyLateChunk(prev, delta, { tailSeq, fallbackId: nextId("a") }));
        return;
      }
      updateSessionMessages(sessionId, (prev) => applyChunk(prev, id, delta, { tailSeq }));
    };

    const pushTransient = (sessionId: string, role: ChatMessage["role"], text: string): void => {
      updateSessionMessages(sessionId, (prev) => [...prev, { id: nextId(role), role, text, status: "done" }]);
    };

    const unsubscribers = [
      api.on("chat:stream:chunk", (payload) => {
        const p = payload as { content?: string; sessionId?: string };
        const sid = p.sessionId ?? sessionIdRef.current;
        if (!sid) return;
        if (typeof p.content === "string" && p.content.length > 0) upsertAssistant(sid, p.content);
      }),
      api.on("chat:stream:reasoning", (payload) => {
        const p = payload as { content?: string; sessionId?: string };
        const sid = p.sessionId ?? sessionIdRef.current;
        if (!sid) return;
        const reasoningDelta = typeof p.content === "string" ? p.content : "";
        if (reasoningDelta.length === 0) return;
        const meta = metaFor(sid);
        if (meta.firstTokenAt === 0) meta.firstTokenAt = Date.now();
        const at = meta.activeId;
        if (at) updateSessionMessages(sid, (prev) => applyReasoning(prev, at, reasoningDelta));
      }),
      api.on("chat:stream:tool_start", (payload) => {
        const p = payload as { content?: string; sessionId?: string };
        const sid = p.sessionId ?? sessionIdRef.current;
        if (!sid) return;
        const raw = String(p.content ?? "");
        const at = metaFor(sid).activeId;
        if (at) updateSessionMessages(sid, (prev) => applyToolStart(prev, at, raw));
      }),
      api.on("chat:stream:tool", (payload) => {
        const p = payload as { content?: string; sessionId?: string };
        const sid = p.sessionId ?? sessionIdRef.current;
        if (!sid) return;
        const raw = String(p.content ?? "");
        const at = metaFor(sid).activeId;
        if (!at) return;
        updateSessionMessages(sid, (prev) => applyToolResult(prev, at, raw, nextId("tool")));
      }),
      api.on("chat:stream:progress", (payload) => {
        const p = payload as { content?: string; sessionId?: string };
        const sid = p.sessionId ?? sessionIdRef.current;
        if (!sid) return;
        const raw = String(p.content ?? "");
        let parsed: {
          note?: string;
          compressed?: boolean;
          dropped?: number;
          beforeChars?: number;
          afterChars?: number;
        } = {};
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          parsed = { note: raw };
        }
        if (parsed.compressed) {
          const note = parsed.note ?? `已自动压缩 ${parsed.dropped ?? 0} 条早期消息`;
          const at = metaFor(sid).activeId;
          if (!at) return;
          updateSessionMessages(sid, (prev) => {
            return prev.map((m) =>
              m.id === at
                ? {
                    ...m,
                    compressNote: note,
                    ...(typeof parsed.beforeChars === "number" && typeof parsed.afterChars === "number"
                      ? {
                          compressStats: {
                            dropped: parsed.dropped ?? 0,
                            beforeChars: parsed.beforeChars,
                            afterChars: parsed.afterChars,
                          },
                        }
                      : {}),
                  }
                : m,
            );
          });
          return;
        }
        if (parsed.note) pushTransient(sid, "system", parsed.note);
      }),
      api.on("chat:stream:heartbeat", () => {}),
      // 待发指令注入回执：主进程在轮次边界真正注入后才会发这个事件（旧 shell 未登记事件时降级不订阅）
      ((): () => void => {
        try {
          return api.on("chat:steer:applied", (payload) => {
            const p = payload as { sessionId?: string; items?: unknown };
            const sid = p.sessionId ?? sessionIdRef.current;
            const rawItems = Array.isArray(p.items) ? p.items : [];
            const items = rawItems.filter(
              (item): item is { id: string; text: string } =>
                Boolean(item) &&
                typeof (item as { id?: unknown }).id === "string" &&
                typeof (item as { text?: unknown }).text === "string",
            );
            if (sid && items.length > 0) onSteerApplied?.(sid, items);
          });
        } catch {
          return () => {};
        }
      })(),
      api.on("perm:request", (payload) => {
        const req = payload as {
          requestId?: string;
          toolName?: string;
          target?: string;
          kind?: string;
          reason?: string;
          category?: string;
        };
        if (req?.requestId) {
          setPermReq({
            requestId: req.requestId,
            toolName: req.toolName ?? "工具",
            target: req.target,
            kind: req.kind,
            reason: req.reason,
            category: req.category,
          });
        }
      }),
      // 新增事件用 try/catch 包裹：旧 shell 的 preload 白名单未登记时会抛错，降级为不订阅
      ((): () => void => {
        try {
          return api.on("ask:user", (payload) => {
            const req = payload as Partial<AskUserRequest> | null;
            if (!req || typeof req.requestId !== "string" || typeof req.question !== "string") return;
            const request: AskUserRequest = {
              requestId: req.requestId,
              question: req.question,
              ...(Array.isArray(req.options) ? { options: req.options.filter((item): item is string => typeof item === "string") } : {}),
              ...(typeof req.allowFreeText === "boolean" ? { allowFreeText: req.allowFreeText } : {}),
              ...(typeof req.sessionId === "string" && req.sessionId ? { sessionId: req.sessionId } : {}),
              ...(req.kind === "sensitive" ? { kind: "sensitive" as const } : {}),
              ...(typeof req.title === "string" && req.title ? { title: req.title } : {}),
              ...(Array.isArray(req.detail)
                ? {
                    detail: req.detail
                      .filter((row): row is { label: string; value: string } => {
                        return !!row && typeof row.label === "string" && typeof row.value === "string";
                      })
                      .slice(0, 8),
                  }
                : {}),
              ...(typeof req.expiresAt === "number" && Number.isFinite(req.expiresAt) ? { expiresAt: req.expiresAt } : {}),
            };
            // 去重入队：同一 requestId 重复推送不弹两个窗
            setAskQueue((prev) => (prev.some((item) => item.requestId === request.requestId) ? prev : [...prev, request]));
          });
        } catch {
          return () => {};
        }
      })(),
      ((): () => void => {
        try {
          return api.on("loop:fallback", (payload) => {
            const info = payload as { reason?: string };
            // ADR-0010：安全回退必须可见（自定义 loop 跑挂 → 同一 ctx 回退 builtin）
            setNotice(`Agent-Loop 已回退到内置 loop：${info?.reason ?? "原因未知"}`);
          });
        } catch {
          return () => {};
        }
      })(),
      api.on("browser:downloads", (payload) => {
        const p = payload as { downloads?: DownloadItem[] };
        if (Array.isArray(p.downloads)) setDownloads(p.downloads);
      }),
      api.on("browser:tabs", (payload) => {
        const p = payload as { tabs?: TabState[] };
        if (!Array.isArray(p.tabs)) return;
        setTabs(p.tabs);
        // 地址栏与活动网页强绑定：用户点链接 / AI 导航 / 页面重定向 / 切标签都走这里。
        const active = p.tabs.find((tab) => tab.active);
        // 会话即"文件夹"：切到没有网页的会话时，地址栏/当前页面必须一起清空，不能残留上一个会话的 URL
        const nextUrl = active?.url ?? "";
        if (nextUrl !== lastSyncedUrlRef.current) {
          lastSyncedUrlRef.current = nextUrl;
          setAddress(nextUrl);
          setCurrentUrl(nextUrl);
        }
      }),
      api.on("memory:updated", () => {
        /* 记忆条目在设置面板中查看；主界面保持安静 */
      }),
      api.on("chat:stream:done", (payload) => {
        const p = payload as { content?: string; sessionId?: string };
        const sid = p.sessionId ?? sessionIdRef.current;
        if (!sid) return;
        const meta = metaFor(sid);
        const info = parseDone(p.content);
        // abort 也可能是其它入口触发的（本窗口没点停止）：同样按「已停止」收尾，
        // 不显示「已中断（aborted）：外部中止信号触发…」这种机器文案。
        const wasStopping = meta.stopping || info.interrupted?.status === "aborted";
        // 用户主动停止：中断横幅统一显示 stopped/用户已停止（与 error 停止分支一致）
        const settledInfo =
          wasStopping && info.interrupted
            ? { ...info, interrupted: { status: "stopped", reason: "用户已停止" } }
            : info;
        let finishedId: string | null = null;
        updateSessionMessages(sid, (prev) => {
          const streaming = prev.find((m) => m.status === "streaming");
          finishedId = streaming?.id ?? null;
          if (streaming?.timeline?.length && api) {
            void api.chat.saveTimeline({ sessionId: sid, timeline: streaming.timeline }).catch(() => {});
          }
          return applyDone(prev, settledInfo, { startedAt: meta.startedAt, firstTokenAt: meta.firstTokenAt });
        });
        meta.busy = false;
        meta.stopping = false;
        meta.activeId = null;
        meta.startedAt = 0;
        meta.firstTokenAt = 0;
        onStreamSettled?.(sid);
        if (sid !== sessionIdRef.current) return; // 后台会话收尾：缓存里已是完成态，切回时展示
        const params = new URLSearchParams(location.search);
        if (finishedId && params.get("expandTimeline") !== "1") {
          setThinkingOpen((prev) => ({ ...prev, [finishedId as string]: false }));
        }
        const scrollTarget = params.get("scrollTo");
        if (params.get("scrollTimeline") === "1" || scrollTarget) {
          setTimeout(() => {
            const selector = scrollTarget === "plan"
              ? ".chat-scroll .plan-card"
              : scrollTarget === "todo"
                ? ".chat-scroll .todo-announce"
                : scrollTarget === "product"
                  ? ".chat-scroll .product-panel"
                  : scrollTarget === "diff"
                    ? ".chat-scroll .think-diff-block"
                    : scrollTarget === "user"
                      ? ".chat-scroll .msg-row[data-rail-role='user']"
                      : ".chat-scroll .think-card";
            const nodes = document.querySelectorAll(selector);
            const last = nodes[nodes.length - 1] as HTMLElement | undefined;
            last?.scrollIntoView({ block: "center" });
          }, 500);
        }
        setBusy(false);
        // 错误/中断原因已经在会话消息里完整展示（红字/中断标记），这里不再重复弹底部提示挡住内容
        // （用户：「会话内都有说明了，这个提示也挡信息了」）。
        if (wasStopping) setNotice("已停止");
        else if (!info.interrupted) setNotice(info.statusText);
      }),
      api.on("chat:stream:error", (payload) => {
        const p = payload as { content?: string; message?: string; sessionId?: string };
        const sid = p.sessionId ?? sessionIdRef.current;
        if (!sid) return;
        const meta = metaFor(sid);
        const text = p.message ?? p.content ?? "未知错误";
        if (meta.stopping) {
          // 用户主动停止：abort 会以 error 形式冒泡，这里统一收束为「已停止」，不显示红色报错
          updateSessionMessages(sid, (prev) =>
            prev.map((m) =>
              m.status === "streaming"
                ? {
                    ...m,
                    status: "done",
                    tail: undefined,
                    interrupted: { status: "stopped", reason: "用户已停止" },
                    timeline: settleAbortedTools(m.timeline),
                  }
                : m,
            ),
          );
          meta.busy = false;
          meta.stopping = false;
          meta.activeId = null;
          meta.startedAt = 0;
          meta.firstTokenAt = 0;
          onStreamSettled?.(sid);
          if (sid === sessionIdRef.current) {
            setBusy(false);
            setNotice("已停止");
          }
          return;
        }
        meta.busy = false;
        meta.activeId = null;
        meta.startedAt = 0;
        meta.firstTokenAt = 0;
        onStreamSettled?.(sid);
        if (sid === sessionIdRef.current) {
          setBusy(false);
          // 与 done 路径一致：失败原因已在消息气泡里展示，不再重复弹底部提示。
        }
        updateSessionMessages(sid, (prev) => {
          if (prev.some((m) => m.status === "streaming")) {
            return prev.map((m) => (m.status === "streaming" ? { ...m, status: "error", tail: undefined, errorText: text } : m));
          }
          return [
            ...prev,
            { id: nextId("assistant"), role: "assistant" as const, text: "", status: "error" as const, errorText: text, createdAt: Date.now() },
          ];
        });
      }),
    ];

    return () => {
      for (const unsub of unsubscribers) unsub();
    };
    // options 内的设置器/ref 引用稳定，效果等价于拆分前的 [api] 依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
}
