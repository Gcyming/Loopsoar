import React, { useCallback, useEffect } from "react";
import type {
  LoopsoarAPI,
  Preferences,
  SidebarModeAction,
  ChromePageKind,
  BrowserSnapshotResult,
  SessionMeta,
  TabState,
} from "./types.js";
import { nextId } from "./ids.js";
import { restoreMessages, type ChatMessage, type SessionStreamMeta } from "./chatStreamState.js";
import type { PendingSteer } from "./steerQueue.js";
import { dismissAllPopovers } from "./popover.js";
import { getLanguage, t } from "./i18n.js";
import type { TabMenuAction } from "./BrowserTabs.js";

/** 最小可变 ref 形状（只要求 current 可读写）。 */
interface MutableRef<T> {
  current: T;
}

/** 新建「会话 + 空白标签」的可选参数（与 App 中 createFreshSessionAndTab 对齐）。 */
export interface CreateFreshOptions {
  workspaceId?: string;
  notice?: string;
  reset?: "search" | "keep";
  newBlankTab?: boolean;
}

/**
 * 会话/导航动作钩子：搜索引擎切换、浮层动作转发、会话刷新/切换/分叉/删除/重命名、
 * 浏览器控制开关、斜杠命令、保存页面与快照。
 *
 * 从 App.tsx 按职责外置：这些动作共享会话/标签工作区的 refs 与 setter，聚合在一个钩子内
 * 保持单一数据源与原有调用顺序（在 useChatActions 之后调用，stop 由聊天钩子注入）。
 * 所有回调体与依赖原样迁移，行为不变。
 */
export interface UseSessionActionsOptions {
  api: LoopsoarAPI | null;
  preferences: Preferences | null;
  setPreferences: React.Dispatch<React.SetStateAction<Preferences | null>>;
  setSessions: React.Dispatch<React.SetStateAction<SessionMeta[]>>;
  setCurrentSession: React.Dispatch<React.SetStateAction<string | null>>;
  setNotice: (value: string) => void;
  setSessionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** 打开管理页：优先复用同类标签，否则新建标签承载（不再覆盖当前网页）。 */
  openChromePage: (kind: ChromePageKind) => void;
  setSnapshotData: React.Dispatch<React.SetStateAction<BrowserSnapshotResult | null>>;
  setTabs: React.Dispatch<React.SetStateAction<TabState[]>>;
  setAddress: React.Dispatch<React.SetStateAction<string>>;
  setCurrentUrl: React.Dispatch<React.SetStateAction<string>>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setPendingSteers: (value: PendingSteer[]) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  navigate: (url?: string) => void;
  selectTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  tabAction: (action: TabMenuAction, tabId: string) => void;
  bindWorkspaceToCurrentSession: (workspaceId: string) => void;
  addWorkspaceForChat: () => void;
  changeSidebarMode: (next: SidebarModeAction) => void;
  createFreshSessionAndTab: (options?: CreateFreshOptions) => Promise<void>;
  openSettings: (section?: string) => void;
  sessionIdRef: MutableRef<string>;
  draftBrowserControlRef: MutableRef<boolean>;
  browserControl: boolean;
  setBrowserControl: React.Dispatch<React.SetStateAction<boolean>>;
  currentSession: string | null;
  pendingRef: MutableRef<Map<string, PendingSteer[]>>;
  sessionCacheRef: MutableRef<Map<string, ChatMessage[]>>;
  inputRef: MutableRef<string>;
  draftRef: MutableRef<Map<string, string>>;
  lastSyncedUrlRef: MutableRef<string>;
  tabSessionRef: MutableRef<Map<string, string>>;
  writeSessionMessages: (sessionId: string, next: ChatMessage[]) => void;
  metaFor: (sessionId: string) => SessionStreamMeta;
  readPending: (sessionId: string) => PendingSteer[];
  messages: ChatMessage[];
  pickedSessionRef: MutableRef<boolean>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  stop: () => void;
}

export interface SessionActions {
  changeSearchEngine: (engine: Preferences["searchEngine"]) => void;
  refreshSessions: () => void;
  toggleSessionMenu: () => void;
  toggleBrowserControl: () => void;
  expandSidebarWithSessions: () => void;
  newSession: () => void;
  handleSlashCommand: (command: string) => void;
  switchSession: (sessionId: string) => void;
  openAgentTask: (taskSessionId: string) => void;
  renameSession: (targetId: string, title: string) => void;
  forkSessionById: (targetId: string, keepCount: number) => void;
  forkFrom: (targetId: string) => void;
  toggleWorkspacePopover: () => void;
  deleteSession: (sessionId: string) => void;
  savePage: () => void;
  snapshot: () => void;
}

export function useSessionActions(options: UseSessionActionsOptions): SessionActions {
  const {
    api,
    preferences,
    setPreferences,
    setSessions,
    setCurrentSession,
    setNotice,
    setSessionOpen,
    openChromePage,
    setSnapshotData,
    setTabs,
    setAddress,
    setCurrentUrl,
    setMessages,
    setPendingSteers,
    setInput,
    navigate,
    selectTab,
    closeTab,
    tabAction,
    changeSidebarMode,
    createFreshSessionAndTab,
    openSettings,
    sessionIdRef,
    draftBrowserControlRef,
    browserControl,
    setBrowserControl,
    currentSession,
    pendingRef,
    sessionCacheRef,
    inputRef,
    draftRef,
    lastSyncedUrlRef,
    tabSessionRef,
    writeSessionMessages,
    metaFor,
    readPending,
    messages,
    pickedSessionRef,
    setBusy,
    stop,
  } = options;

  const changeSearchEngine = useCallback(
    (engine: Preferences["searchEngine"]): void => {
      if (!preferences) return;
      const next = { ...preferences, searchEngine: engine };
      setPreferences(next); // 即时生效：地址栏图标 + 下一次搜索立刻使用新引擎
      void api?.settings
        .setPreferences(next)
        .then((r) => setPreferences(r.preferences))
        .catch(() => {
          // 落盘失败不阻塞当前会话；下次打开设置会重新读取
        });
    },
    [api, preferences],
  );

  // 浮层动作（独立子窗口经主进程转发）：打开整页管理 / 主窗口导航 / 保存页面
  const savePageRef = React.useRef<null | (() => void)>(null);
  // 浮层动作 effect 只订阅一次：openChromePage 会随标签列表重建，用 ref 取最新实现（避免旧闭包重复开标签）。
  const openChromePageRef = React.useRef(openChromePage);
  openChromePageRef.current = openChromePage;
  // 工具栏浮层（独立子窗口）的「点击列表外收起」：主窗口内任何非触发按钮的按下都关闭它。
  // 触发按钮自己负责原子 toggle（ui:togglePopover），这里跳过，避免 pointerdown 先关、click 又开导致连闪。
  React.useEffect(() => {
    if (!api?.ui?.closePopover) return;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-chrome-popover-trigger]")) return;
      void api.ui.closePopover().catch(() => undefined);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [api]);
  React.useEffect(() => {
    if (!api) return;
    // 用户点原生网页面板（WebContentsView，DOM 收不到 pointerdown）也算「点列表外」→ 收起所有浮层。
    return api.on("chrome:dismissPopovers", () => {
      dismissAllPopovers();
      void api.ui?.closePopover().catch(() => undefined);
    });
  }, [api]);
  React.useEffect(() => {
    if (!api) return;
    return api.on("chrome:popoverAction", (payload) => {
      const p = payload as {
        action?: string;
        payload?: {
          kind?: ChromePageKind;
          url?: string;
          tabId?: string;
          tabAction?: string;
          scope?: "visible" | "user" | "task";
          sessionId?: string;
          index?: number;
        };
      };
      if (p?.action === "tabAction" && p.payload?.tabId && p.payload?.tabAction) {
        tabAction(p.payload.tabAction as TabMenuAction, p.payload.tabId);
        return;
      }
      if (p?.action === "openPage" && p.payload?.kind) {
        dismissAllPopovers();
        openChromePageRef.current(p.payload.kind);
        return;
      }
      if (p?.action === "navigate" && p.payload?.url) {
        navigate(p.payload.url);
        return;
      }
      if (p?.action === "savePage") savePageRef.current?.();
      if (p?.action === "selectTab" && p.payload?.tabId) {
        const tabId = p.payload.tabId;
        const scope = p.payload.scope;
        // 统一标签面板会列出「全局普通标签」和「其他任务的 Agent 标签」；
        // 先切到对应标签组，再按 tabId 选中，否则 selectTab 只在当前可见组里找。
        if (scope === "user") {
          void api.browser
            .showUserTabs()
            .then(() => selectTab(tabId))
            .catch(() => undefined);
          return;
        }
        if (scope === "task" && p.payload.sessionId) {
          void api.browser
            .showTask({ sessionId: p.payload.sessionId })
            .then(() => selectTab(tabId))
            .catch(() => undefined);
          return;
        }
        selectTab(tabId);
        return;
      }
      // 面板「最近关闭」：主进程会重开网页并切到它所属的标签组，这里只把界面同步过来。
      if (p?.action === "reopenClosedTab") {
        const index = typeof p.payload?.index === "number" ? p.payload.index : 0;
        void api.browser
          .reopenClosedTabAt({ index })
          .then(async (result) => {
            if (!result?.ok) return;
            // 主进程已经切好标签组并选中：这里只把界面同步到新的活动页。
            const snapshot = await api.browser.listTabs();
            setTabs(snapshot.tabs);
            const active = snapshot.tabs.find((tab) => tab.active);
            if (active) {
              setCurrentUrl(active.url ?? "");
              setAddress(active.url ?? "");
            }
          })
          .catch(() => undefined);
        return;
      }
      // Agent 工作区浮层里的「关闭此网页」：与标签条上的关闭同一条链路（关页不等于关会话）。
      if (p?.action === "closeTab" && p.payload?.tabId) {
        closeTab(p.payload.tabId);
        return;
      }
    });
  }, [
    api,
    navigate,
    tabAction,
    selectTab,
    closeTab,
    setTabs,
    setAddress,
    setCurrentUrl,
  ]);

  const refreshSessions = useCallback((): void => {
    if (!api) return;
    void api.chat.sessions().then((r) => {
      setSessions(r.sessions);
      setCurrentSession(r.currentId);
    }).catch(() => {});
  }, [api]);

  /** 会话 chip：刷新列表 + 切换下拉开合（原内联组合动作）。 */
  const toggleSessionMenu = useCallback((): void => {
    refreshSessions();
    setSessionOpen((value) => !value);
  }, [refreshSessions]);

  /**
   * 会话级「浏览器控制」开关（功能1）：开启 = Agent 看得见、也能执行 browser_* 工具。
   * · 会话已存在 → 立即落库（shell 装配的 allowlist 在下一轮 stream 生效）；
   * · 草稿态（还没会话 id）→ 只记标志，由 ensureSessionForSend 建会话后先写再发首条消息。
   */
  const toggleBrowserControl = useCallback((): void => {
    const next = !browserControl;
    setBrowserControl(next);
    draftBrowserControlRef.current = next;
    const sid = sessionIdRef.current || currentSession;
    const notice = (key: string): void => setNotice(t(getLanguage(), key));
    if (!sid) {
      notice(next ? "composer.browserControlOn" : "composer.browserControlOff");
      return;
    }
    if (!api) {
      setBrowserControl(!next);
      draftBrowserControlRef.current = !next;
      notice("composer.browserControlUnavailable");
      return;
    }
    void api.chat
      .setBrowserControl({ sessionId: sid, enabled: next })
      .then((r) => {
        if (!r.ok) {
          // 会话已不存在（被删/切走）：回滚 UI 真值，不要留下「界面开着但实际关着」的错觉
          setBrowserControl(!next);
          draftBrowserControlRef.current = !next;
          setNotice(t(getLanguage(), "composer.browserControlFailed", { error: "会话不存在" }));
          return;
        }
        setSessions((prev) => prev.map((item) => (item.id === sid ? { ...item, browserControl: next } : item)));
        notice(next ? "composer.browserControlOn" : "composer.browserControlOff");
      })
      .catch((err: unknown) => {
        setBrowserControl(!next);
        draftBrowserControlRef.current = !next;
        setNotice(
          t(getLanguage(), "composer.browserControlFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      });
  }, [api, browserControl, currentSession]);

  /** 收起态竖条：悬停/点条目后展开侧栏并打开会话列表（等宽度过渡结束再弹浮层，锚点才正确）。 */
  const expandSidebarWithSessions = useCallback((): void => {
    dismissAllPopovers();
    // 只展开侧栏；会话/工作区列表由用户自己点开（用户 m10071：悬停自动展开时不要连带展开列表）
    changeSidebarMode("docked");
  }, [changeSidebarMode]);
  /** 新建会话 = 新标签页（会话与标签页一一绑定）。 */
  const newSession = useCallback((): void => {
    if (!api) return;
    void createFreshSessionAndTab({ reset: "keep" }).catch((err: unknown) =>
      setNotice("新建会话失败：" + (err instanceof Error ? err.message : String(err))),
    );
  }, [api, createFreshSessionAndTab]);

  /**
   * 斜杠命令执行（Composer 只负责解析/面板，动作由 App 统一接线）。
   * /compact 目前没有独立 IPC：上下文在超预算时会自动压缩，这里只给可读提示。
   */
  const handleSlashCommand = useCallback(
    (command: string): void => {
      const cmd = command.trim().toLowerCase();
      switch (cmd) {
        case "/new":
          newSession();
          break;
        case "/clear":
          setInput("");
          break;
        case "/stop":
          stop();
          break;
        case "/settings":
          openSettings();
          break;
        case "/compact": {
          // 真实压缩：先预览统计 → 用户确认 → 写回持久化并重载当前会话消息
          if (!api) break;
          void (async () => {
            try {
              const preview = await api.chat.compact({ apply: false });
              if (!preview.ok) {
                setNotice(preview.error ?? "压缩失败");
                return;
              }
              if (preview.compressed === false) {
                setNotice("当前会话未超预算，无需压缩。");
                return;
              }
              const pct = Math.round(preview.savedRatio * 100);
              const confirmed = window.confirm(
                `将把 ${preview.before.messages} 条（约 ${preview.before.chars} 字符）压缩为 ${preview.after.messages} 条（约 ${preview.after.chars} 字符），节省 ${pct}%。\n早期内容会汇总为摘要，是否继续？`,
              );
              if (!confirmed) return;
              const applied = await api.chat.compact({ apply: true });
              if (!applied.ok) {
                setNotice(applied.error ?? "压缩失败");
                return;
              }
              setNotice(`已压缩：${applied.before.messages} → ${applied.after.messages} 条，节省 ${Math.round(applied.savedRatio * 100)}%`);
              const history = await api.chat.history().catch(() => null);
              if (history?.session?.messages?.length) {
                writeSessionMessages(history.session.sessionId, restoreMessages(history.session.messages, nextId));
              }
            } catch (err) {
              setNotice(`压缩失败：${err instanceof Error ? err.message : String(err)}`);
            }
          })();
          break;
        }
        case "/help":
          setNotice("可用命令：/new 新建会话 · /clear 清空输入 · /stop 停止生成 · /settings 打开设置 · /compact 压缩说明 · /help 帮助");
          break;
        default:
          setNotice(`未知命令：${command}（输入 /help 查看可用命令）`);
      }
    },
    [api, newSession, openSettings, setInput, stop, writeSessionMessages],
  );

  const switchSession = useCallback((sessionId: string): void => {
    if (!api) return;
    // 切会话属于切换界面：先收起所有展开列表/浮层（用户 m02115 全局规则）。
    dismissAllPopovers();
    const previousSessionId = sessionIdRef.current;
    void api.chat.switchSession({ sessionId }).then((r) => {
      if (!r.ok) return;
      pickedSessionRef.current = true;
      sessionIdRef.current = sessionId;
      setCurrentSession(sessionId);
      // 优先恢复该会话的实时缓存（后台可能仍在跑）；否则用持久化历史
      const cached = sessionCacheRef.current.get(sessionId);
      const msgs = cached ?? restoreMessages(r.session?.messages ?? [], nextId);
      writeSessionMessages(sessionId, msgs);
      const meta = metaFor(sessionId);
      setBusy(meta.busy);
      // 切会话：把该会话自己的待发队列镜像回 UI（每个会话独立排队）
      setPendingSteers(readPending(sessionId));
      // 会话隔离：输入草稿跟着会话走（先存旧会话，再恢复新会话）
      draftRef.current.set(previousSessionId, inputRef.current);
      setInput(draftRef.current.get(sessionId) ?? "");
      setNotice("");
      void api.browser
        .listTabs()
        .then((r) => {
          setTabs(r.tabs);
          const active = r.tabs.find((tab) => tab.active);
          // 绑定方向：把「该会话自己的活动标签」记到它名下（而不是把上一個会话的标签改判给新会话）。
          if (active) tabSessionRef.current.set(active.id, sessionId);
          const url = active?.url ?? "";
          lastSyncedUrlRef.current = url;
          setAddress(url);
          setCurrentUrl(url);
        })
        .catch(() => undefined);
    });
  }, [api, metaFor, readPending, writeSessionMessages]);

  /**
   * 从某条消息分支：把「到这条为止」的历史复制成新会话并切过去。
   * 为什么需要：Agent 浏览器操作会把会话绑在任务上，用户之后可能只想纯讨论——
   * 分支给出一条干净的对话线，原会话完全不动（浏览器任务也不被复制）。
   */
  /** 点跨会话任务 chip / 任务会话：进入该任务的折叠工作区（同时切到对应会话）。 */
  const openAgentTask = useCallback(
    (taskSessionId: string): void => {
      if (!api) return;
      switchSession(taskSessionId);
      void api.browser
        .showTask({ sessionId: taskSessionId })
        .then((r) => {
          setTabs(r.tabs);
          const active = r.tabs.find((tab) => tab.active);
          setAddress(active?.url ?? "");
          setCurrentUrl(active?.url ?? "");
        })
        .catch(() => undefined);
    },
    [api, switchSession],
  );

  // 首次动作结束：任务身份过户给新分支，界面跟着进入该任务的折叠工作区。
  React.useEffect(() => {
    if (!api) return;
    return api.on("chat:taskForked", (payload) => {
      const p = payload as { from?: string; to?: string } | null;
      const to = p?.to;
      if (!to) return;
      refreshSessions();
      // 用户回合中途切去看别的会话：只刷新列表，不把他强行拽到任务分支。
      if (p?.from && sessionIdRef.current && sessionIdRef.current !== p.from) {
        return;
      }
      switchSession(to);
      void api.browser
        .showTask({ sessionId: to })
        .then((r) => {
          setTabs(r.tabs);
          const active = r.tabs.find((tab) => tab.active);
          setAddress(active?.url ?? "");
          setCurrentUrl(active?.url ?? "");
        })
        .catch(() => undefined);
    });
  }, [api, switchSession]);

  const renameSession = useCallback(
    (targetId: string, title: string): void => {
      if (!api) return;
      void api.chat
        .renameSession({ sessionId: targetId, title })
        .then((r) => {
          if (r.ok) setSessions(r.sessions);
        })
        .catch((err: unknown) => setNotice(`重命名失败：${err instanceof Error ? err.message : String(err)}`));
    },
    [api],
  );

  const forkSessionById = useCallback(
    (targetId: string, keepCount: number): void => {
      if (!api) return;
      void api.chat
        .forkSession({ sessionId: targetId, keepCount })
        .then((r) => {
          if (!r.ok || !r.session) {
            setNotice("分叉失败：源会话不存在");
            return;
          }
          setSessions(r.sessions);
          switchSession(r.session.sessionId);
          setNotice("已分叉会话");
        })
        .catch((err: unknown) => setNotice(`分叉失败：${err instanceof Error ? err.message : String(err)}`));
    },
    [api, switchSession],
  );

  const forkFrom = useCallback(
    (targetId: string): void => {
      if (!api) return;
      const idx = messages.findIndex((m) => m.id === targetId);
      if (idx < 0) return;
      const keepCount = messages
        .slice(0, idx + 1)
        .filter((m) => m.role === "user" || (m.role === "assistant" && m.status !== "error")).length;
      const sid = sessionIdRef.current;
      if (!sid) return;
      void api.chat
        .forkSession({ sessionId: sid, keepCount })
        .then((r) => {
          if (!r.ok || !r.session) {
            setNotice("分支失败：源会话不存在");
            return;
          }
          setSessions(r.sessions);
          switchSession(r.session.sessionId);
          setNotice("已从此消息分支；原会话保持不变");
        })
        .catch((err: unknown) => setNotice(`分支失败：${err instanceof Error ? err.message : String(err)}`));
    },
    [api, messages, switchSession],
  );

  /**
   * 打开「Agent 工作区」浮层：独立子窗口，压在网页之上。
   * 为什么不在主窗口里画：主窗口 DOM 在原生网页视图之下，面板要么被盖住、要么得把网页隐藏/下移。
   */
  const toggleWorkspacePopover = useCallback((): void => {
    if (!api) return;
    const chip = document.querySelector('[data-workspace-chip="1"]') as HTMLElement | null;
    if (!chip) return;
    const rect = chip.getBoundingClientRect();
    void api.ui
      .togglePopover({
        kind: "workspace",
        anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        lang: preferences?.language === "en-US" ? "en-US" : "zh-CN",
      })
      .catch(() => undefined);
  }, [api, preferences?.language]);

  /** 删除会话：当前会话被删时连同左侧标签切到下一个会话（原内联逻辑外置）。 */
  const deleteSession = useCallback(
    (sessionId: string): void => {
      if (!api) return;
      void (async () => {
        // 工作区 > 会话 > 网页：删会话时先关掉它名下的全部网页（关网页则不会删会话）。
        await api.browser.closeSessionTabs({ sessionId }).catch(() => undefined);
        return api.chat.deleteSession({ sessionId });
      })()
        .then((r) => {
          setSessions(r.sessions);
          setCurrentSession(r.currentId);
          // 会话都没了：待发队列一并清掉
          pendingRef.current.delete(sessionId);
          // 删除当前会话：右侧不能只清空，必须连同左侧标签一起切到下一个会话
          if (sessionId === currentSession) {
            setMessages([]);
            setPendingSteers([]);
            if (r.currentId) switchSession(r.currentId);
          }
        })
        .catch(() => {});
    },
    [api, currentSession, switchSession],
  );

  /** 保存当前页面 HTML 全页（主进程写到下载目录 saved-pages/），成功 toast 显示路径。 */
  const savePage = useCallback((): void => {
    if (!api) return;
    setNotice("正在保存页面…");
    void api.browser
      .savePage({})
      .then((result) => {
        if (!result.ok) {
          setNotice(`保存失败：${result.error ?? "未知错误"}`);
          return;
        }
        const size = typeof result.bytes === "number" ? `（${Math.max(1, Math.round(result.bytes / 1024))} KB）` : "";
        setNotice(`页面已保存${size}：${result.path ?? "（路径未返回）"}`);
      })
      .catch((err: unknown) => setNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`));
  }, [api]);
  // 供「浮层动作」稳定引用最新的 savePage（避免把整个回调塞进事件 effect 依赖）
  React.useEffect(() => {
    savePageRef.current = savePage;
  }, [savePage]);

  const snapshot = useCallback((): void => {
    if (!api) return;
    // 打开快照面板 = 进入整页浮层：先收起所有展开列表（用户 m02115 全局规则）。
    dismissAllPopovers();
    void api.browser
      .snapshot()
      .then((result) => {
        if (result.ok) {
          setSnapshotData(result); // 面板化：正文/元素可滚动与复制，不再只 toast 一行
          setNotice("");
          return;
        }
        setNotice(`快照失败：${result.error ?? "未知错误"}`);
      })
      .catch((err: unknown) => setNotice(`快照失败：${err instanceof Error ? err.message : String(err)}`));
  }, [api]);

  return {
    changeSearchEngine,
    refreshSessions,
    toggleSessionMenu,
    toggleBrowserControl,
    expandSidebarWithSessions,
    newSession,
    handleSlashCommand,
    switchSession,
    openAgentTask,
    renameSession,
    forkSessionById,
    forkFrom,
    toggleWorkspacePopover,
    deleteSession,
    savePage,
    snapshot,
  };
}
