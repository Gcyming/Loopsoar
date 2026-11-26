import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentSummary,
  AskUserRequest,
  BootStatus,
  BrowserSnapshotResult,
  PermissionsState,
  Preferences,
  ProviderStatus,
  SessionMeta,
  TabState,
} from "./types.js";
import { MOTION, NO_DRAG_REGION } from "./theme.js";
import { useContributedTheme } from "./useContributedTheme.js";
import { styles } from "./appStyles.js";
import { useAgentWindowLayout } from "./useAgentWindowLayout.js";
import { useSidebarLayout } from "./useSidebarLayout.js";
import { useModelPicker } from "./useModelPicker.js";
import { useBrowserPopoverOverlay, isNativePageVisible } from "./useBrowserPopoverOverlay.js";
import { useWorkspaces } from "./useWorkspaces.js";
import { useBrowserTabs, type CreateFreshSession } from "./useBrowserTabs.js";
import { useSettingsEntry } from "./useSettingsEntry.js";
import { useBottomDock } from "./useBottomDock.js";
const Settings = React.lazy(() => import("./Settings.js"));
const ChromePage = React.lazy(() => import("./ChromePage.js"));
import MessageList from "./MessageList.js";
import { dismissAllPopovers, useAnyPopoverOpen } from "./popover.js";
import BrowserChrome from "./BrowserChrome.js";
import AppTitleBar from "./AppTitleBar.js";
import WorkspacePanel from "./WorkspacePanel.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import Composer from "./Composer.js";
import Onboarding, { isOnboardingDone } from "./Onboarding.js";
import { setLanguage, getLanguage, t } from "./i18n.js";
import { splitAgentTabs } from "./agentWorkspace.js";
import { useChromePageTabs } from "./useChromePageTabs.js";
import type { ChromePageKind, SidebarMode, SidebarModeAction, ThemeMode } from "./types.js";
import AppDialogs from "./AppDialogs.js";
const SnapshotPanel = React.lazy(() => import("./SnapshotPanel.js"));
import AgentSidebar from "./AgentSidebar.js";
import AppBottomPanels from "./AppBottomPanels.js";
import StartPage from "./StartPage.js";
import { useBootstrapData, useChatStreamEvents } from "./useChatStreamEvents.js";
import { usePermissionQueue } from "./usePermissionQueue.js";
import { useStartupTab } from "./useStartupTab.js";
import SplashScreen from "./SplashScreen.js";
import { useStartupGate } from "./useStartupGate.js";
import { useDownloads } from "./useDownloads.js";
import {
  useE2eChatAutoSend,
  useE2eChromePageDeepLink,
  useE2eMenuDeepLinks,
  useE2eRestoredScroll,
  useE2eSettingsDeepLink,
} from "./useE2eDeepLinks.js";
import { useChatActions } from "./useChatActions.js";
import { useSessionActions } from "./useSessionActions.js";
import { nextId } from "./ids.js";
import {
  applySteerToLatest,
  createSessionStreamMeta,
  restoreMessages,
  type ChatMessage,
  type SessionStreamMeta,
} from "./chatStreamState.js";
import PendingSteers from "./PendingSteers.js";
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

/**
 * Loopsoar 主界面（GUI-3）：品牌三色 + 自定义标题栏 + 图标系统 + 交互反馈/动画。
 * 品牌色（界面 wordmark）：亚麻白 #F4EFE6 / 赭石 #C8763C；app icon 原始色 #0A0A0A / #FCF7F1 / #FA9C38。
 *
 * 架构（P5 拆分后）：本文件只保留「状态与业务编排」——会话/浏览器/设置的门面状态、
 * 发送/回滚/重生成/停止等动作、以及顶层布局装配。具体实现按职责外置：
 *   · useChatStreamEvents.ts —— 启动数据同步 + chat:stream:* 事件订阅与 per-session 路由；
 *   · useChatActions.ts      —— 发送 / 建会话 / steer / 回滚 / 重生成 / 停止；
 *   · useSessionActions.ts   —— 会话切换 / 分叉 / 删除 / 浏览器控制 / 保存页面 / 快照；
 *   · useBrowserPopoverOverlay.ts —— 浮层与原生网页视图的几何让位/静态底图；
 *   · useBottomDock.ts —— 终端/DevTools 开合、高度持久化与主进程同步；
 *   · AppTitleBar.tsx / AppDialogs.tsx / AppBottomPanels.tsx —— 顶层布局分区；
 *   · useE2eDeepLinks.ts     —— ?e2e=* 深链自动化（生产路径零副作用）；
 *   · AgentSidebar.tsx       —— 侧栏外壳（复制会话/工作区条/会话切换与历史菜单）；
 *   · BrowserMenus.tsx       —— 历史 / 下载下拉面板；
 *   · StartPage.tsx / StatusBar.tsx / PermissionDialog.tsx / Toast.tsx —— 纯展示块；
 *   · chatStreamState.ts / timeline.ts —— 事件→消息、消息→时间线的纯函数层。
 * 所有拆分均为「受控 props + 回调」，状态仍集中在本组件，避免出现第二套数据源。
 */

/* ---------------------------------- 主界面 ---------------------------------- */

export default function App(): React.JSX.Element {
  const api = useLoopsoarApi();
  const [boot, setBoot] = useState<BootStatus | null>(null);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [maximized, setMaximized] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  /** 跨会话任务条：所有带 Agent 工作区的会话（浏览器控制触发的折叠工作区）。 */
  const [agentTasks, setAgentTasks] = useState<{ sessionId: string; tabs: TabState[] }[]>([]);
  /** 浏览器当前可见组（USER 或某个任务会话）：任务 chip 去重必须用它，不能用聊天会话。 */
  const [browserVisibleSession, setBrowserVisibleSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>("");
  // 待发指令（运行中插入的引导）：按会话保队列（切走再切回不丢），当前会话的队列镜像到 UI。
  // 队列上限与 core/steerBus 的 STEER_MAX_PENDING 对齐（见 pendingSteers.ts）。
  const pendingRef = useRef<Map<string, PendingSteer[]>>(new Map());
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  /** 事件订阅（在 useChatStreamEvents 内一次绑定）读取最新回调的引用桥。 */
  const steerAppliedRef = useRef<((sessionId: string, items: Array<{ id: string; text: string }>) => void) | null>(null);
  const streamSettledRef = useRef<((sessionId: string) => void) | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(() => {
    if (typeof location === "undefined") return false;
    return new URLSearchParams(location.search).get("e2e") === "settings";
  });
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  // 主题（soft / classic / 扩展贡献的主题）：内置走 data-theme，扩展主题只覆盖白名单 CSS 变量。
  const theme = preferences?.theme ?? "soft";
  useContributedTheme(theme);
  // 右侧会话栏：常驻 / 收起；「小窗化」= 打开独立 BrowserWindow（真窗口，可拖动/缩放）
  const sidebarMode: SidebarMode = preferences?.sidebarMode ?? "docked";
  // 独立窗口模式：?mini=1 时本渲染器只画 Agent 会话栏（由主进程 Agent 窗口加载）
  const miniWindow =
    typeof location !== "undefined" && new URLSearchParams(location.search).get("mini") === "1";
  // 浏览器管理整页（历史/下载/收藏夹/设置）：由浮层「查看更多」或动作打开。
  // 新行为：管理页作为「标签」打开（tabId → 页面类型），当前网页保留在它自己的标签里。
  // chromePage 只留给 E2E 深链/旧壳层兜底，不再承载常规打开路径。
  const [chromePage, setChromePage] = useState<ChromePageKind | null>(null);
  // 首次启动向导：本地标记完成/跳过；设置·关于可重开（P6）
  const [onboardingOpen, setOnboardingOpen] = useState<boolean>(() => !isOnboardingDone());
  /** Agent 工作区（折叠标签组）是否展开：展开时隐藏原生网页视图，否则列表面板会被网页盖住。 */

  /** 新标签页/整页会话处于 Vibecoding 状态（侧栏会话按钮据此变成「会话列表」按钮）。 */
  const [vibeModeActive, setVibeModeActive] = useState(false);
  /** 用户是否刚在会话列表里主动选过会话：直接回话时才复用，否则每次直接回话都新建会话。 */
  const pickedSessionRef = useRef(false);
  const [mode, setMode] = useState<"build" | "plan">("build");
  const [reasoningEffort, setReasoningEffort] = useState<string>("");

  // ask_user 弹窗队列：ask:user 事件入队，逐条回答后出队（理论上同一时刻只有一条，队列兜住连发）
  const [askQueue, setAskQueue] = useState<AskUserRequest[]>([]);
  const [permSummary, setPermSummary] = useState<PermissionsState | null>(null);
  const [settingsSection, setSettingsSection] = useState<string>("");
  /** 任意 usePopover 列表打开时都要让原生 WebContentsView 让位，否则菜单会被网页整块盖住。 */
  const anyPopoverOpen = useAnyPopoverOpen();
  // 下载状态 + 新下载反馈（工具栏角标 / 自动展开下载小窗，见 useDownloads）。
  const { setDownloads, summary: downloadsSummary } = useDownloads({ api });
  // 浏览器工具栏浮层（更多/收藏夹/历史/下载）打开：需隐藏原生 WebContentsView，否则菜单被网页遮挡
  // 页面快照面板：null=关闭；非空时隐藏原生浏览器视图并渲染可读浮层
  const [snapshotData, setSnapshotData] = useState<BrowserSnapshotResult | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  /** 新标签页/新会话令牌：StartPage 据此重置回「搜索」初始页。 */
  const [freshSessionToken, setFreshSessionToken] = useState(0);
  /** 新建会话（不换页）令牌：只把主页面切回初始页，保留搜索/Vibecoding 模式。 */
  const [sessionResetToken, setSessionResetToken] = useState(0);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  /** 权限确认队列：当前会话才弹窗；后台会话只给「点击前往」入口（见 AppDialogs）。 */
  const { permReq, otherSessionPerm, addPermRequest, resolvePermRequest } = usePermissionQueue(currentSession);
  /** 浏览器动作回调需要读「最新」会话，但 hook 必须在 createFreshSessionAndTab 之前调用。 */
  const currentSessionRef = useRef<string | null>(null);
  currentSessionRef.current = currentSession;
  const createFreshSessionRef = useRef<CreateFreshSession | null>(null);
  const {
    contentRef,
    beginIconDrag,
    changeSidebarMode,
    agentWindowOpen,
    agentIconMode,
    agentFloat,
    floatRect,
    stableIconRect,
    contentHidden,
    iconShown,
    contentBaseOpacity,
    iconTransition,
    panelTransition,
    freezeW,
    freezeH,
  } = useAgentWindowLayout({
    api,
    miniWindow,
    preferences,
    setPreferences,
    setNotice,
    currentSession,
    setSessionOpen,
  });
  const {
    sidebarWidth,
    setSidebarWidth,
    vibeSidebarWidth,
    sidebarDragging,
    startResize,
    activeVibeWidth,
    effectiveSidebarWidth,
  } = useSidebarLayout({
    api,
    preferences,
    setPreferences,
    sidebarMode,
    vibeModeActive,
    miniWindow,
    agentWindowOpen,
  });
  /**
   * 会话级「浏览器控制」开关（功能1）。真值以会话持久化（SessionMeta.browserControl）为准，
   * 这里保持即时态；草稿态（还没有会话）先记 draftBrowserControlRef，建会话后立即落库。
   */
  const [browserControl, setBrowserControl] = useState(false);
  const draftBrowserControlRef = useRef(false);
  // 全局浮层仲裁：同一时刻只允许一个菜单展开；点击外部/Esc/切界面统一收起。
  // 会话历史下拉在 AgentSidebar 内用 usePopover("app-session") 登记；这里只负责全局收起。

  // 启动时先为空：真实会话 ID 必须来自 shell（恢复历史或 chat:sessions 的 currentId），
  // 否则未恢复历史的冷启动会拿一个假 ID 发送，消息落到索引外的"幽灵会话"。
  const sessionIdRef = useRef<string>("");
  const {
    workspaces,
    activeWorkspaceId,
    workspacePanelOpen,
    setWorkspacePanelOpen,
    setWorkspaces,
    setActiveWorkspaceId,
    applyWorkspaces,
    bindWorkspaceToCurrentSession,
    createWorkspace,
    renameWorkspace,
    removeWorkspace,
    openWorkspaceFolder,
  } = useWorkspaces({ api, sessionIdRef, setSessions, setNotice });
  /** 标签页 ↔ 会话绑定：会话只在首次对话时创建并绑定当前标签页；切回旧标签页恢复其会话。 */
  const tabSessionRef = useRef<Map<string, string>>(new Map());
  const omniboxRef = useRef<HTMLInputElement | null>(null);
  /** 最近一次同步到地址栏的 URL（仅活动标签 URL 变化时才覆盖，避免打断用户输入）。 */
  const lastSyncedUrlRef = useRef<string>("");
  const {
    tabs,
    setTabs,
    address,
    setAddress,
    currentUrl,
    setCurrentUrl,
    activeTabId,
    applyTabSnapshot,
    navigate,
    newTab,
    selectTab,
    moveTab,
    closeTab,
    tabAction,
    openTabMenu,
    closeAgentWorkspace,
    goBack,
    goForward,
    reloadPage,
    retryActivePage,
  } = useBrowserTabs({
    api,
    preferences,
    setNotice,
    lastSyncedUrlRef,
    createFreshSessionRef,
    currentSessionRef,
  });
  /** 启动门：首屏数据/恢复标签到齐前保持启动面板（原生网页视图由 baseOverlay 同源隐藏）。 */
  const { splashVisible, splashOverlay, splashStatus, splashSteps } = useStartupGate({ boot, preferences, tabs });
  /** 时间线「思考过程」卡的开合（按消息 id；流式中默认展开，收尾后自动收起）。 */
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
  /** 上下文占用估算：used=约 4 字符/token；cap=模型声明上下文窗口 */
  const contextUsage = useMemo(() => {
    const spec = provider?.models?.find((m) => m.id === provider.model);
    const cap = spec?.contextWindow && spec.contextWindow > 0 ? spec.contextWindow : 128000;
    const chars = messages.reduce((n, m) => n + m.text.length, 0) + input.length;
    const used = Math.round(chars / 4);
    return { used, cap, pct: Math.min(100, Math.round((used / cap) * 100)) };
  }, [messages, input, provider]);
  const contextPct = contextUsage.pct;
  /** 挤压检测：可用宽度 / 内容自然宽度；低于阈值时按钮收缩为圆形图标 */
  const [squeezeRatio, setSqueezeRatio] = useState(1);
  const [compactUi, setCompactUi] = useState(false);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const measureRowRef = useRef<HTMLDivElement | null>(null);
  const tailSeqRef = useRef<number>(0);
  /** 消息按会话缓存：切走再切回时恢复该会话的实时状态（含后台仍在跑的流）。 */
  const messagesRef = useRef<ChatMessage[]>([]);
  /** 输入框草稿按会话隔离：切会话时保存本会话草稿、恢复目标会话草稿，绝不串台。 */
  const inputRef = useRef<string>("");
  const draftRef = useRef<Map<string, string>>(new Map());
  const sessionCacheRef = useRef(new Map<string, ChatMessage[]>());
  const sessionMetaRef = useRef(new Map<string, SessionStreamMeta>());
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);
  // 「浏览器控制」按会话水合：切会话跟着换；草稿态沿用用户刚点的选择（建会话后落库）
  useEffect(() => {
    if (!currentSession) {
      setBrowserControl(draftBrowserControlRef.current);
      return;
    }
    const meta = sessions.find((item) => item.id === currentSession);
    if (meta) setBrowserControl(meta.browserControl === true);
  }, [currentSession, sessions]);

  const metaFor = useCallback((sessionId: string): SessionStreamMeta => {
    let meta = sessionMetaRef.current.get(sessionId);
    if (!meta) {
      meta = createSessionStreamMeta();
      sessionMetaRef.current.set(sessionId, meta);
    }
    return meta;
  }, []);

  const readSessionMessages = useCallback((sessionId: string): ChatMessage[] => {
    return sessionCacheRef.current.get(sessionId) ?? (sessionId === sessionIdRef.current ? messagesRef.current : []);
  }, []);

  const writeSessionMessages = useCallback((sessionId: string, next: ChatMessage[]): void => {
    sessionCacheRef.current.set(sessionId, next);
    if (sessionId === sessionIdRef.current) {
      messagesRef.current = next;
      setMessages(next);
    }
  }, []);

  const updateSessionMessages = useCallback(
    (sessionId: string, updater: (prev: ChatMessage[]) => ChatMessage[]): void => {
      writeSessionMessages(sessionId, updater(readSessionMessages(sessionId)));
    },
    [readSessionMessages, writeSessionMessages],
  );

  /** 读取某会话的待发指令队列（App 内唯一数据源，按会话隔离）。 */
  const readPending = useCallback((sessionId: string): PendingSteer[] => pendingRef.current.get(sessionId) ?? [], []);

  /** 写回某会话的待发队列；若是当前会话，同步 UI 镜像。 */
  const writePending = useCallback((sessionId: string, next: PendingSteer[]): void => {
    if (next.length === 0) pendingRef.current.delete(sessionId);
    else pendingRef.current.set(sessionId, next);
    if (sessionId === sessionIdRef.current) setPendingSteers(next);
  }, []);

  // 提示自动消失：成功 4.5s、失败/中断 8s；避免每条提示都要手动点掉
  useEffect(() => {
    if (!notice) return;
    const sticky = /(失败|错误|无法|中断)/.test(notice);
    // 主窗口：提示交给壳层的透明子窗口（永远压在网页之上、下方居中）。
    if (!miniWindow && api) {
      void api.ui.toast({ text: String(notice ?? "").slice(0, 300), sticky }).catch(() => undefined);
    }
    const timer = window.setTimeout(() => setNotice(""), sticky ? 8000 : 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 挂载：拉取状态（启动/供应商/偏好/会话/工作区/标签）+ 订阅流式事件（逻辑见各自 hook）
  useBootstrapData({
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
  });
  useChatStreamEvents({
    api,
    sessionIdRef,
    lastSyncedUrlRef,
    tailSeqRef,
    metaFor,
    updateSessionMessages,
    setPermReq: addPermRequest,
    resolvePermRequest,
    setAskQueue,
    setThinkingOpen,
    setDownloads,
    setTabs,
    setAddress,
    setCurrentUrl,
    setBusy,
    setNotice,
    // 事件订阅只绑一次：通过 ref 桥接最新回调（见下方 steerAppliedRef/streamSettledRef 赋值）
    onSteerApplied: (sessionId, items) => steerAppliedRef.current?.(sessionId, items),
    onStreamSettled: (sessionId) => streamSettledRef.current?.(sessionId),
  });

  // E2E/演示：恢复会话后把最后一条时间线滚到可视区（只做一次）
  useE2eRestoredScroll(messages.length, busy);

  const openSettings = useSettingsEntry({ api, setSection: setSettingsSection, setOpen: setSettingsOpen, setInput });

  const {
    modelMenuOpen,
    setModelMenuOpen,
    modelGroups,
    openModelMenu,
    chooseModel,
    effortOptions,
    effortLabel,
  } = useModelPicker({ api, provider, setProvider, setNotice, openSettings });

  // 挤压检测：内容自然宽度 vs 可用宽度；<92% 触发图标化（阈值可调）
  useEffect(() => {
    const box = composerBoxRef.current;
    const ghost = measureRowRef.current;
    if (!box || !ghost) return;
    const measure = (): void => {
      const needed = ghost.scrollWidth;
      const available = box.clientWidth - 16; // 左右内边距
      if (needed <= 0 || available <= 0) return;
      const ratio = Math.max(0, Math.min(1, available / needed));
      setSqueezeRatio(ratio);
      setCompactUi(ratio < 0.92);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(ghost);
    return () => observer.disconnect();
  }, [provider, permSummary, mode, reasoningEffort, sidebarWidth, modelGroups]);

  // 供应商/模型变更同步：设置页保存后刷新模型 chip 与模型列表
  useEffect(() => {
    if (!api) return;
    const refresh = (): void => {
      void api.settings.getProvider().then(setProvider).catch(() => {});
    };
    window.addEventListener("loopsoar:providers-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("loopsoar:providers-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [api]);

  // Agent 工作区：Agent 打开/导航过的标签折叠进一个 chip，其余仍是普通标签条
  // （分组规则在 agentWorkspace.ts，纯函数可单测；这里只负责渲染与副作用）。
  const { user: userTabs, bound: boundTabs } = useMemo(() => splitAgentTabs(tabs), [tabs]);
  const { activePageKind, displayUserTabs, openChromePage, closeChromePage, switchChromePage, navigateFromChromePage, openExternalFromChromePage } = useChromePageTabs({
    api, tabs, userTabs, language: preferences?.language, navigate, setChromePage, legacyChromePage: chromePage,
  }); const openChromeSettings = useCallback((): void => switchChromePage("settings"), [switchChromePage]);
  // 工作区里最后一个网页也没了（Agent 关页/会话切走）：折叠面板不该悬空留着。

  const activeTabIdRef = React.useRef<string | null>(null);
  activeTabIdRef.current = activeTabId;
  /** 最新标签列表的同步镜像：effect 里要读「这一刻」的标签，state 可能晚一帧。 */
  const tabsRef = React.useRef<TabState[]>(tabs);
  tabsRef.current = tabs;

  const {
    terminalOpen,
    setTerminalOpen,
    devtoolsOpen,
    devtoolsHeight,
    terminalHeight,
    toggleDevtools,
    toggleTerminal,
    changeTerminalHeight,
  } = useBottomDock({ api, activeTabId, setNotice });

  /**
   * Agent 浏览器活动（会话隔离）：只让「当前会话」的浏览器显示呼吸灯；
   * 动作发生在当前会话时，把它正在操作的标签切到可见；其它会话一概不动界面。
   */
  React.useEffect(() => {
    if (!api) return;
    const sendCornerColor = (): void => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--ls-surface-raised").trim();
      const color = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : "#17191e";
      void api.browser.setCornerColor({ color }).catch(() => undefined);
    };
    sendCornerColor();
    const observer = new MutationObserver(sendCornerColor);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [api]);

  React.useEffect(() => {
    if (!api) return;
    return api.on("browser:tabs", (payload) => {
      const visible = (payload as { visibleSession?: string } | null)?.visibleSession;
      if (visible) setBrowserVisibleSession(visible);
    });
  }, [api]);

  React.useEffect(() => {
    if (!api) return;
    const refreshTasks = (): void => {
      void api.browser
        .listTasks()
        .then((r) => {
          setAgentTasks(r.tasks);
          setBrowserVisibleSession(r.visibleSession ?? null);
        })
        .catch(() => undefined);
    };
    refreshTasks();
    const off = api.on("browser:tabs", refreshTasks);
    return () => {
      off?.();
    };
  }, [api, currentSession]);

  const agentActivityRef = React.useRef<Map<string, number>>(new Map());
  React.useEffect(() => {
    if (!api || miniWindow) return;
    return api.on("chrome:agentActivity", (payload) => {
      const p = payload as { sessionId?: string; tool?: string; phase?: string };
      const sid = p.sessionId;
      if (!sid) return;
      const counts = agentActivityRef.current;
      const next = Math.max(0, (counts.get(sid) ?? 0) + (p.phase === "start" ? 1 : -1));
      if (next === 0) counts.delete(sid);
      else counts.set(sid, next);
      const mine = sid === (sessionIdRef.current || null);
      if (mine && p.phase === "start") {
        // 跟随宿主的活动标签：用户手动切走了标签时，把它切回 Agent 正在操作的那一个
        void api.browser
          .listTabs()
          .then((result) => {
            const active = (result.tabs ?? []).find((tab) => tab.active);
            if (active && active.id !== activeTabIdRef.current) {
              return api.browser.selectTab({ tabId: active.id });
            }
            return null;
          })
          .catch(() => undefined);
      }
    });
  }, [api, miniWindow]);
  // 标签页 ↔ 会话绑定（只用于「空白新标签页 = 草稿」这一条产品规则）。
  //
  // 浏览器的标签组本身已按会话隔离（BrowserHost.groups，见 ADR-0104）：切会话时主进程
  // 换的是可见组，所以当前看到的页面永远属于当前会话——**不能**因为映射表里查不到就把
  // 会话重置成草稿，否则「切到一个有网页的会话」会先清空消息、再被一次无关重渲染拉回来，
  // 看起来就像两个会话的页面/对话串在了一起。只有「空白标签页」才是新对话的入口。
  React.useEffect(() => {
    if (!activeTabId) return;
    const mapped = tabSessionRef.current.get(activeTabId) ?? null;
    if (mapped === (sessionIdRef.current || null)) return;
    // tabs 状态可能比 activeTabId 晚一帧：查不到这个 id 时**什么也不做**。
    // 宁可保留现状，也不能把「未知标签」当成「空白新标签」把会话重置成草稿——
    // 那会在 Agent 刚导航完成的一瞬间清空对话，看起来像两个会话串了。
    const tab = tabsRef.current.find((item) => item.id === activeTabId) ?? null;
    // 未知标签（state 晚一帧）与带 URL / Agent 绑定的标签都保持现状：
    // Agent 新建的页面在「还没开始加载」的一瞬 url 为空，若按空白页处理会把正在跑的对话清空。
    if (!mapped && (tab === null || tab.url || tab.agentBound === true)) return;
    if (!mapped) {
      sessionIdRef.current = "";
      setCurrentSession(null);
      setMessages([]);
      setPendingSteers([]);
      setBusy(false);
      setInput("");
      return;
    }
    const cached = sessionCacheRef.current.get(mapped);
    if (!cached) return; // 非本运行期创建的会话：保持现状（切换浏览器标签组由 switchSession 负责）
    sessionIdRef.current = mapped;
    setCurrentSession(mapped);
    setMessages(cached);
    setPendingSteers(readPending(mapped));
    setBusy(metaFor(mapped).busy);
  }, [activeTabId]);

  // 工作区清单预载：「+ 工作区」菜单与侧栏会话树启动即可用（WorkspacePanel 之外不再等到打开面板才加载）。
  React.useEffect(() => {
    if (!api) return;
    void api.workspace
      .list()
      .then((r) => {
        applyWorkspaces(r);
      })
      .catch(() => undefined);
  }, [api, applyWorkspaces]);

  /**
   * 新会话 = 新标签页（用户 m07920 规则）：会话绑定标签页、标签页绑定工作区。
   * 先切到目标工作区，再 chat.newSession（旧会话标签组由 shell 存档），最后在新会话里补一个空白标签。
   */
  /**
   * 新建页/启动/显式「新建会话」只重置为**草稿**，不创建会话记录：
   * 用户规则（m09384）：没有与 Agent 对话之前不算新会话；首次发送时才创建并绑定当前工作区。
   */
  const createFreshSessionAndTab = useCallback(
    async (options?: { workspaceId?: string; notice?: string; reset?: "search" | "keep"; newBlankTab?: boolean }): Promise<void> => {
      if (!api) return;
      pickedSessionRef.current = false;
      dismissAllPopovers();
      // 新会话默认「浏览器控制」关（与 shell 侧缺省一致）；草稿标志一并清掉
      draftBrowserControlRef.current = false;
      setBrowserControl(false);
      draftRef.current.set(sessionIdRef.current, inputRef.current);
      if (options?.workspaceId && options.workspaceId !== activeWorkspaceId) {
        const selected = await api.workspace.select({ id: options.workspaceId });
        if (!selected.ok) {
          setNotice(selected.error ?? "切换工作区失败");
          return;
        }
        applyWorkspaces(selected);
      }
      // 草稿态：没有会话、没有消息；右侧只是「尚未归属工作区的会话栏」。
      sessionIdRef.current = "";
      setCurrentSession(null);
      setMessages([]);
      setPendingSteers([]);
      setBusy(false);
      setInput("");
      // 先把可见组切回用户标签，避免在任务工作区里数标签/建标签。
      await api.browser.showUserTabs().catch(() => undefined);
      let tabs = await api.browser.listTabs();
      if (options?.newBlankTab) {
        // 已经有一个空白用户页就复用它，不再叠加第二个「新建标签页」。
        const blank = tabs.tabs.find((tab) => !tab.url);
        if (blank) await api.browser.selectTab({ tabId: blank.id });
        else await api.browser.newTab({});
        tabs = await api.browser.listTabs();
      } else if (tabs.tabs.length === 0) {
        await api.browser.newTab({});
        tabs = await api.browser.listTabs();
      }
      setTabs(tabs.tabs);
      const activeTab = tabs.tabs.find((tab) => tab.active);
      lastSyncedUrlRef.current = activeTab?.url ?? "";
      setAddress(activeTab?.url ?? "");
      setCurrentUrl(activeTab?.url ?? "");
      if ((options?.reset ?? "search") === "search") setFreshSessionToken((value) => value + 1);
      else setSessionResetToken((value) => value + 1);
      setNotice(options?.notice ?? (options?.reset === "keep" ? "新会话草稿：发送后才会创建" : "已新建标签页"));
    },
    [api, activeWorkspaceId, applyWorkspaces],
  );
  // useBrowserTabs 早于 createFreshSessionAndTab 调用；这里把最新实现桥接给浏览器动作。
  createFreshSessionRef.current = createFreshSessionAndTab;

  /** 新建标签页 = 新会话（每次都进入一个新的搜索页，不再和当前会话共用标签组）。 */
  /** 新标签页/整页会话的「+ 新加工作区」：原生文件夹选择器 → 挂载并设为当前工作区。 */
  const addWorkspaceForChat = useCallback((): void => {
    void createWorkspace().then(async (workspace) => {
      if (!workspace) return;
      // 新建工作区后直接进入该工作区的「新会话 + 新标签页」搜索页（用户 m07920）。
      await createFreshSessionAndTab({
        workspaceId: workspace.id,
        notice: `已添加工作区：${workspace.name}`,
      });
    });
  }, [createFreshSessionAndTab, createWorkspace]);

  /** 通用附件选择：返回路径（用户取消返回 null），供右侧输入区与 Vibecoding 输入区共用。 */
  const pickAttachmentPath = useCallback(async (): Promise<string | null> => {
    try {
      const r = await api?.dialog.pickPath({ kind: "file", title: "选择附件" });
      return r && !r.canceled && r.path ? r.path : null;
    } catch {
      return null;
    }
  }, [api]);
  /** 在指定工作区下新建会话：先切工作区，再新建「会话 + 空白标签页」。 */
  const newSessionInWorkspace = useCallback(
    (workspaceId: string): void => {
      if (!api) return;
      void createFreshSessionAndTab({ workspaceId, reset: "keep" }).catch((err: unknown) =>
        setNotice("新建会话失败：" + (err instanceof Error ? err.message : String(err))),
      );
    },
    [api, createFreshSessionAndTab],
  );

  /** 推理强度：Composer 与新版会话页共用同一持久化逻辑。 */
  const changeReasoningEffort = useCallback(
    (value: string): void => {
      setReasoningEffort(value);
      if (!api || !preferences) return;
      const next = { ...preferences, reasoningEffort: value };
      setPreferences(next);
      void api.settings
        .setPreferences(next)
        .then((r) => setPreferences(r.preferences))
        .catch(() => undefined);
    },
    [api, preferences],
  );
  const respondPermission = useCallback((choice: "allow-once" | "allow-session" | "deny"): void => {
    if (!api || !permReq) return;
    void api.perm.respond({ requestId: permReq.requestId, choice });
    resolvePermRequest(permReq.requestId);
  }, [api, permReq, resolvePermRequest]);

  /**
   * 只展示「当前会话」的询问：Agent 可能在后台会话里提问或触发敏感确认，
   * 弹窗不能凭空盖在用户正在看的会话上（会话隔离）。缺失 sessionId 的旧壳层事件按当前会话处理。
   */
  const scopedAskQueue = useMemo(
    () => askQueue.filter((item) => !item.sessionId || item.sessionId === currentSession),
    [askQueue, currentSession],
  );
  const activeAsk = scopedAskQueue[0] ?? null;
  /** 其它会话里挂起的询问（只给一个可点击的提示，不抢界面）。 */
  const otherSessionAsk = askQueue.find((item) => !!item.sessionId && item.sessionId !== currentSession) ?? null;

  /** 设置/权限/快照等整页 DOM 已经盖住网页：这些场景不需要再抓静态底图。 */
  const baseOverlay = (!miniWindow && splashOverlay) || settingsOpen ||
    workspacePanelOpen ||
    snapshotData !== null ||
    onboardingOpen ||
    activePageKind !== null ||
    activeAsk !== null ||
    permReq !== null;
  const activeTabState = tabs.find((tab) => tab.active) ?? null;
  // 与 BrowserHost.applyLayout 的 visible 条件同源：搜索主页/错误/vibe 时原生视图不可见；
  // 加载中仍可见（页面保持渲染，DOM 加载页只在「还没有页面」时出现）。
  const nativePageVisible = isNativePageVisible({
    miniWindow,
    currentUrl,
    loadFailure: activeTabState?.loadFailure ?? null,
    vibeModeActive,
  });
  const { pageColumnRef, popoverOverPage, browserPreview } = useBrowserPopoverOverlay({
    api,
    anyPopoverOpen,
    baseOverlay,
    nativePageVisible,
  });

  /** 到期的询问自动出队：shell 已按取消结算，弹窗再留着只会让用户点出一个「已过期」。 */
  useEffect(() => {
    if (askQueue.length === 0) return;
    const nextExpiry = askQueue
      .map((item) => item.expiresAt)
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => {
        const nowMs = Date.now();
        setAskQueue((prev) =>
          prev.filter((item) => !(typeof item.expiresAt === "number" && item.expiresAt <= nowMs)),
        );
      },
      Math.max(0, nextExpiry - Date.now()) + 60,
    );
    return () => window.clearTimeout(timer);
  }, [askQueue]);

  /** 回答/取消 ask_user 弹窗：先出队再回填（避免重复提交），失败只提示不阻塞界面。 */
  const respondAsk = useCallback((answer: string | null): void => {
    const request = activeAsk;
    if (!request) return;
    setAskQueue((prev) => prev.filter((item) => item.requestId !== request.requestId));
    if (!api?.ask) {
      setNotice("未在 Electron shell 中运行，回答无法送达");
      return;
    }
    const payload = answer === null
      ? { requestId: request.requestId, cancelled: true }
      : { requestId: request.requestId, answer };
    void api.ask
      .respond(payload)
      .then((result) => {
        // received=false：问题已过期 / 会话已终止（shell 侧按取消结算了）
        if (!result?.received) setNotice(t(getLanguage(), "app.answerUndelivered"));
      })
      .catch((err: unknown) => setNotice(`${t(getLanguage(), "app.answerFailed")}${err instanceof Error ? err.message : String(err)}`));
  }, [api, activeAsk]);

  const {
    sendText,
    startVibe,
    send,
    rollbackTo,
    regenerate,
    stop,
    editPendingSteer,
    insertPendingSteer,
    removePendingSteer,
  } = useChatActions({
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
  });
  const {
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
  } = useSessionActions({
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
    bindWorkspaceToCurrentSession,
    addWorkspaceForChat,
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
  });

  // E2E 深链（?e2e=chat / model-menu / ... / settings）：脚本化验证用，生产路径不触发
  useE2eChatAutoSend(api, sendText);
  useE2eMenuDeepLinks({
    api,
    sessionIdRef,
    openModelMenu,
    newSession,
    sendText,
    switchSession,
    setInput,
    setWorkspacePanelOpen,
  });
  // 每次进入 Loopsoar 都是新会话（用户 m07920 规则）；等 shell 恢复完标签后再执行，
  // 否则会抢跑创建空标签/漏显示恢复标签（见 useStartupTab 注释）。
  useStartupTab({ api, miniWindow, boot, createFreshSessionAndTab, setNotice });

  useE2eSettingsDeepLink(setSettingsOpen, setSettingsSection);
  useE2eChromePageDeepLink(setChromePage);

  // 修复遮挡：应用内浮层（设置 / 工作区面板 / 快照 / 向导 / 标题栏工作区菜单）
  // 打开时隐藏原生 WebContentsView；菜单/浮层本身是主窗口 DOM，原生视图在它上面会盖住菜单。
  // 注意不要每次依赖变化都 cleanup 成 false（会在连续切换时闪一帧页面），只在卸载时复位。
  useEffect(() => {
    if (!api) return;
    const overlay = baseOverlay || popoverOverPage;
    void api.browser.setOverlay({ open: overlay }).catch(() => {});
  }, [api, baseOverlay, popoverOverPage]);
  useEffect(() => {
    return () => {
      void api?.browser.setOverlay({ open: false }).catch(() => undefined);
    };
  }, [api]);

  // 语言：偏好（启动加载 / 设置里修改）同步到 i18n store；已接入 i18n 的组件即时重渲染
  useEffect(() => {
    if (preferences?.language) setLanguage(preferences.language);
  }, [preferences?.language]);

  // 让位：打开设置/工作区面板时收起快照浮层（避免两层模态叠在一起）
  useEffect(() => {
    if (settingsOpen || workspacePanelOpen) setSnapshotData(null);
  }, [settingsOpen, workspacePanelOpen]);

  // 界面隔离/换界面收起：进入设置、整页、工作区、快照等其它界面时，任何已展开列表
  // （会话下拉 / Composer 权限·模型·命令菜单）都必须一起收起，否则会压在新界面上
  // （用户实测截图）。统一走 dismissAllPopovers()，未来新增列表只要用 usePopover 就自动覆盖。
  const otherInterfaceOpen = settingsOpen || activePageKind !== null || workspacePanelOpen || snapshotData !== null;
  useEffect(() => {
    if (!otherInterfaceOpen) return;
    dismissAllPopovers();
  }, [otherInterfaceOpen]);

  // 窗口失焦：切到别的应用/系统弹窗时也收起展开列表，回来界面干净（用户 m02115）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBlur = (): void => dismissAllPopovers();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // 页面变化后快照内容会过期：自动收起，避免展示与当前页不匹配的旧正文
  useEffect(() => {
    if (!snapshotData) return;
    if (currentUrl && snapshotData.url && currentUrl !== snapshotData.url) setSnapshotData(null);
  }, [currentUrl, snapshotData]);

  // 动效强度偏好 → 根节点 data 属性（CSS 里统一降级，避免各处手写判断）
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.animations = preferences?.animations ?? "full";
  }, [preferences]);

  /** 当前会话实际绑定的工作区（未认领时为 null，选择器显示「选择工作区」）。 */
  // 草稿态（尚未创建会话）跟随活动工作区；已有会话时显示它的真实归属（未归属为 null）。
  const sessionWorkspaceId = currentSession
    ? sessions.find((item) => item.id === currentSession)?.workspaceId ?? null
    : activeWorkspaceId ?? null;

  const providerLabel = useMemo(() => {
    if (!provider) return "provider: 读取中…";
    if (!provider.configured) return "provider: 未配置";
    return provider.usable
      ? `provider: ${provider.provider} · ${provider.model}`
      : `provider: ${provider.provider}（${provider.reason ?? "不可用"}）`;
  }, [provider]);

  const agentLabel = agents.find((a) => a.isDefault)?.name ?? "—";
  /**
   * 权限 chip 摘要：只看「有风险的四档」——写文件 / 执行命令 / 网络 / 浏览器操作。
   *  · 读权限不参与（读默认放行，算进去会让摘要永远显示「询问」）；
   *  · 浏览器档与其余三档同一优先级顺序与文案口径（Slice G 遗留：此前漏了 browser，
   *    导致只把浏览器档设为「拒绝 / 询问」时 chip 仍显示「放行」，与真实策略不一致）。
   */
  const permissionLabel = (state: PermissionsState): string => {
    const p = state.permissions;
    const risky = [p.write, p.terminal, p.network, p.browser];
    if (risky.every((x) => x === "deny")) return t(getLanguage(), "app.readonlySession");
    if (risky.some((x) => x === "confirm")) return t(getLanguage(), "app.permsAsk");
    return t(getLanguage(), "app.permsAllow");
  };
  // 运行中输入非空时仍可发送：此时作为「转向提示」注入（steer）
  const canSend = Boolean(api) && input.trim() !== "";
  const body = (
    <>
      {/* Agent 独立窗口（?mini=1）也走自绘标题栏：无系统边框，只有最小化/关闭；
          主窗口标题栏同时承载标签页（与窗口按钮同一行，Chrome 式）。 */}
      <AppTitleBar
        maximized={maximized}
        miniWindow={miniWindow}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        userTabs={displayUserTabs}
        boundTabs={boundTabs}
        agentTasks={agentTasks}
        browserVisibleSession={browserVisibleSession}
        currentSession={currentSession}
        onToggleWorkspace={toggleWorkspacePopover}
        onCloseWorkspace={closeAgentWorkspace}
        onOpenTask={openAgentTask}
        onSelectTab={selectTab}
        onMoveTab={moveTab}
        onCloseTab={closeTab}
        onTabAction={tabAction}
        onOpenTabMenu={openTabMenu}
        onNewTab={newTab}
      />
      {/* 工作区：左侧「网页列」（导航工具条 + 圆角页框），右侧会话栏。
          浏览器工具条只在网页列上方；原生 WebContentsView 几何不变。 */}
      <div style={styles.workRow}>
        {miniWindow ? null : (
          <div
            ref={pageColumnRef}
            data-native-page={nativePageVisible ? "live" : undefined}
            style={{ ...styles.pageColumn, position: "relative" }}
          >
            {popoverOverPage && browserPreview ? (
              <div data-testid="browser-popover-preview" style={styles.browserFreeze} aria-hidden="true">
                <img src={browserPreview} alt="" style={styles.browserFreezeImage} />
              </div>
            ) : null}
            <BrowserChrome
              tabs={tabs}
              address={address}
              currentUrl={currentUrl}
              omniboxRef={omniboxRef}
              searchEngine={preferences?.searchEngine ?? "bing"}
              onSearchEngineChange={changeSearchEngine}
              onAddressChange={setAddress}
              onNavigate={navigate}
              onBack={goBack}
              onForward={goForward}
              onReload={reloadPage}
              onSnapshot={snapshot}
              onNotice={setNotice}
              downloadsSummary={downloadsSummary}
            />
            <StartPage
              currentUrl={currentUrl}
              loading={Boolean(tabs.find((tab) => tab.active)?.loading)}
              failure={tabs.find((tab) => tab.active)?.loadFailure ?? null}
              onRetry={retryActivePage}
              onBack={tabs.find((tab) => tab.active)?.canBack ? goBack : undefined}
              searchEngine={preferences?.searchEngine ?? "bing"}
              onSubmitSearch={(text) => navigate(text)}
              onOpenUrl={(url) => navigate(url)}
              modelLabel={provider?.model ?? "未配置模型"}
              modelGroups={modelGroups}
              onChooseModel={chooseModel}
              messages={messages}
              chatMode={mode}
              busy={busy}
              contextUsed={contextUsage.used}
              contextCap={contextUsage.cap}
              contextPct={contextPct}
              hidden={Boolean(currentUrl) && !tabs.find((tab) => tab.active)?.loadFailure && !vibeModeActive}
              thinkingOpen={thinkingOpen}
              onToggleThinking={(id) => setThinkingOpen((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))}
              onRollback={rollbackTo}
              onRegenerate={regenerate}
              onFork={forkFrom}
              onStartVibe={startVibe}
              onSendMessage={(text) => sendText(text)}
              onStop={stop}
              onVibeModeChange={setVibeModeActive}
              resetToken={freshSessionToken}
              sessionResetToken={sessionResetToken}
              effortOptions={effortOptions}
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={changeReasoningEffort}
              effortLabel={effortLabel}
              chatBuildMode={mode}
              onToggleBuildMode={() => setMode(mode === "build" ? "plan" : "build")}
              workspaces={workspaces}
              activeWorkspaceId={sessionWorkspaceId}
              onSelectWorkspace={bindWorkspaceToCurrentSession}
              onAddWorkspace={addWorkspaceForChat}
              onPickAttachment={pickAttachmentPath}
              browserControl={browserControl}
              onToggleBrowserControl={toggleBrowserControl}
              onOpenWorkspacePanel={() => {
                dismissAllPopovers();
                setWorkspacePanelOpen(true);
              }}
            />
          </div>
        )}

        {!miniWindow && !agentWindowOpen && sidebarMode === "docked" ? (
          <div className="sidebar-splitter" style={styles.splitter} onMouseDown={startResize} title="拖动调整面板宽度" />
        ) : null}
        {/* 侧栏外框：唯一拥有 width 过渡的节点（收起/展开/窗口化都在这里动）。
            右对齐 + overflow:hidden：宽度变窄时裁掉内容左侧、右缘钉住窗口右边；
            原生网页视图由 useSidebarLayout 在 rAF 中逐帧调用 browser:setSidebarWidth({animate:false})
            同步让位（主进程不再跑第二套动画，避免两套计时器互相追帧）。 */}
        <div
          style={{
            width: miniWindow ? "100%" : effectiveSidebarWidth,
            flexShrink: 0,
            boxSizing: "border-box",
            display: "flex",
            justifyContent: "flex-end",
            overflow: "hidden",
            minWidth: 0,
            // 会话栏顶部不再留白：与第二行工具条同高起步，头部按钮纵向拉长并进同一横带；
            // 右侧/底部贴边与状态栏同色收口；左侧不再额外留白 —— 页框自己的 8px 内缩 + 2px splitter
            // 已构成自然分区间隙，再叠加 padding 会让「一线之隔」变成 20px+ 的空白带（用户 m04618）。
            padding: miniWindow ? 8 : 0,
            transition:
              miniWindow || sidebarDragging
                ? "none"
                : `width ${MOTION.sidebarDuration} ${MOTION.ease}, padding ${MOTION.sidebarDuration} ${MOTION.ease}`,
          }}
        >
        <AgentSidebar
          // 侧栏列宽就是内容宽：之前传 sidebarWidth-16（为左右各 8px 的旧 padding 预留）叠加
          // wrapper 左 padding，实际把内容压窄 16–24px；现在 padding 归零，内容铺满整列。
          width={miniWindow ? 0 : vibeModeActive ? activeVibeWidth : sidebarWidth}
          embeddedInAgentWindow={miniWindow}
          mode={miniWindow ? "docked" : sidebarMode}
          onModeChange={
            miniWindow
              ? (m: SidebarModeAction): void => {
                  // 独立窗口里点「小窗化/收起」= 收回主窗口
                  if (m !== "docked") void api?.ui.closeAgentWindow().catch(() => {});
                }
              : changeSidebarMode
          }
          agentLabel={agentLabel}
          messages={messages}
          sessions={sessions}
          currentSession={currentSession}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          sessionOpen={sessionOpen}
          onToggleSession={toggleSessionMenu}
          onCloseSession={() => setSessionOpen(false)}
          onNewSession={newSession}
          onNewSessionInWorkspace={newSessionInWorkspace}
          onRenameWorkspace={renameWorkspace}
          onRemoveWorkspace={removeWorkspace}
          onOpenWorkspaceFolder={openWorkspaceFolder}
          onSwitchSession={switchSession}
          onDeleteSession={deleteSession}
          onRenameSession={renameSession}
          onForkSession={forkSessionById}
          onOpenWorkspacePanel={() => {
            dismissAllPopovers();
            setWorkspacePanelOpen(true);
          }}
          onAddWorkspace={addWorkspaceForChat}
          onNotice={setNotice}
          vibeMode={vibeModeActive}
          onExpandFromRail={expandSidebarWithSessions}
        >
          <MessageList
            messages={messages}
            mode={mode}
            contextUsed={contextUsage.used}
            contextCap={contextUsage.cap}
            contextPct={contextPct}
            thinkingOpen={thinkingOpen} busy={busy} resumeKey={currentSession ?? undefined}
            expandAllGroups={new URLSearchParams(location.search).get("expandAllGroups") === "1"}
            openProducts={new URLSearchParams(location.search).get("openProducts") === "1"}
            onToggleThinking={(id) => setThinkingOpen((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))}
            onRollback={rollbackTo}
            onRegenerate={regenerate}
            onFork={forkFrom}
            onOpenUrl={(url) => void api?.browser.newTab({ url }).catch(() => {})}
          />
          <PendingSteers
            items={pendingSteers}
            onEdit={editPendingSteer}
            onInsertNow={insertPendingSteer}
            onRemove={removePendingSteer}
          />
          <Composer
            value={input}
            onChange={setInput}
            onSend={send}
            onStop={stop}
            busy={busy}
            canSend={canSend}
            mode={mode}
            onToggleMode={() => setMode(mode === "build" ? "plan" : "build")}
            compactUi={compactUi}
            squeezeRatio={squeezeRatio}
            boxRef={composerBoxRef}
            measureRef={measureRowRef}
            provider={provider}
            permSummary={permSummary}
            onPermissionChange={(next) => {
              void api?.settings
                .setPermissions(next.permissions)
                .then(() => api.settings.getPermissions())
                .then((r) => setPermSummary(r))
                .catch(() => {});
            }}
            onOpenSettings={openSettings}
            onNotice={setNotice}
            onCommand={handleSlashCommand}
            onExtensionCommand={(prompt) => setInput(prompt)}
            modelMenuOpen={modelMenuOpen}
            onOpenModelMenu={openModelMenu}
            onCloseModelMenu={() => setModelMenuOpen(false)}
            modelGroups={modelGroups}
            onChooseModel={chooseModel}
            effortOptions={effortOptions}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={changeReasoningEffort}
            effortLabel={effortLabel}
            permissionLabel={permissionLabel}
            workspaces={workspaces}
            activeWorkspaceId={sessionWorkspaceId}
            onSelectWorkspace={bindWorkspaceToCurrentSession}
            onAddWorkspace={addWorkspaceForChat}
            browserControl={browserControl}
            onToggleBrowserControl={toggleBrowserControl}
            onPickAttachment={() => {
              void pickAttachmentPath().then((path) => {
                if (!path) return;
                setInput((prev) => (prev ? `${prev}
【附件】${path}` : `【附件】${path}`));
                setNotice("已添加附件（路径已放入消息）");
              });
            }}
          />
        </AgentSidebar>
        </div>
      </div>

      <AppBottomPanels
        miniWindow={miniWindow}
        terminalOpen={terminalOpen}
        terminalHeight={terminalHeight}
        devtoolsOpen={devtoolsOpen}
        devtoolsHeight={devtoolsHeight}
        currentSession={currentSession}
        shellStatus={boot?.status}
        agentLabel={agentLabel}
        providerLabel={providerLabel}
        currentUrl={currentUrl}
        mode={mode}
        onCloseTerminal={() => setTerminalOpen(false)}
        onTerminalHeightChange={changeTerminalHeight}
        onTerminalResizeStart={() => {
          void api?.browser.setOverlay({ open: true }).catch(() => {});
        }}
        onTerminalResizeEnd={() => {
          void api?.browser.setOverlay({ open: false }).catch(() => {});
        }}
        onToggleTerminal={toggleTerminal}
        onToggleDevtools={toggleDevtools}
      />

      <WorkspacePanel
        open={workspacePanelOpen}
        onClose={() => setWorkspacePanelOpen(false)}
        currentSessionId={currentSession}
        currentSessionTitle={sessions.find((item) => item.id === currentSession)?.title ?? t(getLanguage(), "app.currentSession")}
        sessionWorkspaceId={sessions.find((item) => item.id === currentSession)?.workspaceId ?? activeWorkspaceId}
        onChanged={(text) => {
          if (text) setNotice(text);
          void api?.chat.sessions().then((r) => {
            setSessions(r.sessions);
            setCurrentSession(r.currentId);
          }).catch(() => {});
          void api?.workspace.list().then((r) => {
            applyWorkspaces(r);
          }).catch(() => {});
        }}
        onNotice={setNotice}
      />
      {/* 页面快照浮层：正文/元素可滚动复制；打开设置/工作区时自动收起 */}
      <React.Suspense fallback={null}>
        <SnapshotPanel snapshot={snapshotData} onClose={() => setSnapshotData(null)} />
      </React.Suspense>
      {settingsOpen ? (
        <React.Suspense fallback={null}>
        <Settings
          key={settingsSection || "settings"}
          api={api}
          initialSection={(settingsSection || undefined) as never}
          onClose={() => {
            setSettingsOpen(false);
            // 关闭设置后同步权限与供应商（模型 chip / 模型列表可能已变更）
            void api?.settings.getPermissions().then(setPermSummary).catch(() => {});
            void api?.settings.getProvider().then(setProvider).catch(() => {});
          }}
          onPreferencesSaved={(next) => setPreferences(next)}
          onOpenUrl={(url) => {
            // 设置内点商店/外链：直接离开设置并打开该页（用户 m09567：不想退出设置才能看到跳转结果）
            dismissAllPopovers();
            setSettingsOpen(false);
            setChromePage(null);
            // 等浮层关闭、原生视图重新显示后再开新标签：同一 tick 内开标签会被还在遮罩状态的主进程布局隐藏
            window.setTimeout(() => {
              void api?.browser.newTab({ url }).catch(() => undefined);
            }, 90);
          }}
          onOpenOnboarding={() => {
            dismissAllPopovers();
            setOnboardingOpen(true);
          }}
        />
        </React.Suspense>
      ) : null}

      {/* 浏览器管理页（历史/下载/收藏夹/设置）：作为标签打开，当前网页保留在它自己的标签里 */}
      {activePageKind ? (
        <React.Suspense fallback={null}>
        <ChromePage
          kind={activePageKind}
          api={api}
          onClose={closeChromePage}
          onNavigate={navigateFromChromePage}
          onOpenPage={switchChromePage}
          onOpenSettings={openChromeSettings}
          onOpenUrl={openExternalFromChromePage}
          onNotice={setNotice}
        />
        </React.Suspense>
      ) : null}

      {/* 首次启动向导（P6）：跳过/完成写本地标记；设置·关于可重开 */}
      {onboardingOpen ? (
        <Onboarding
          open={onboardingOpen}
          onClose={() => setOnboardingOpen(false)}
          // 首启向导里选一次默认布局（用户决定 m00974）：之后 Agent 打开网页不再弹窗询问。
          initialLayout={preferences?.browserOpenLayout === "agentWindow" ? "agentWindow" : "docked"}
          onChooseLayout={(layout) => {
            const next = { ...(preferences ?? {}), browserOpenLayout: layout } as Preferences;
            setPreferences(next);
            void api?.settings
              .setPreferences(next)
              .then((r) => setPreferences(r.preferences))
              .catch(() => undefined);
          }}
          onOpenSettings={(section) => {
            setOnboardingOpen(false);
            openSettings(section);
          }}
        />
      ) : null}

      <AppDialogs
        permReq={permReq} onRespondPermission={respondPermission}
        activeAsk={activeAsk} onRespondAsk={respondAsk}
        otherSessionAsk={otherSessionAsk} otherSessionPerm={otherSessionPerm}
        onSwitchSession={switchSession}
        notice={notice} miniWindow={miniWindow}
        onDismissNotice={() => setNotice("")}
      />
    </>
  );

  if (!miniWindow) {
    return <div style={styles.app}>{body}<SplashScreen visible={splashVisible} status={splashStatus} steps={splashSteps} /></div>;
  }

  // 独立小窗：透明窗口 + 一块可几何过渡的面板（Slime float 同款）。
  // 面板内是真实 UI（尺寸钉住不重排）；最小化/还原时面板做 left/top/width/height 过渡，
  // 图标层叠在面板上淡入淡出。
  return (
    <div style={styles.agentShellMini}>
      <div
        data-agent-panel
        // 图标态把点击/拖动挂在面板层：连面板圆角裁切掉的四角也能接收事件（图标层在圆角外会被 clip 命中失败）。
        onPointerDown={agentIconMode && !agentFloat ? beginIconDrag : undefined}
        style={{
          ...styles.agentPanel,
          left: floatRect ? floatRect.x : stableIconRect ? stableIconRect.x : 0,
          top: floatRect ? floatRect.y : stableIconRect ? stableIconRect.y : 0,
          width: floatRect ? floatRect.width : stableIconRect ? stableIconRect.width : "100%",
          height: floatRect ? floatRect.height : stableIconRect ? stableIconRect.height : "100%",
          ...(agentFloat
            ? {
                transition: panelTransition,
              }
            : null),
        }}
      >
        <div
          ref={contentRef}
          style={{
            // 图标态稳定后直接不渲染会话内容：既避免 420×720 的隐形容器在 56px 窗口里继续布局/绘制，
            // 也移除它内部的窗口拖拽区（-webkit-app-region: drag 会抢走图标上的点击 → 只有局部能点）。
            display: agentIconMode && !agentFloat ? "none" : "flex",
            flexDirection: "column",
            width: freezeW ?? "100%",
            height: freezeH ?? "100%",
            flex: "0 0 auto",
            minWidth: 0,
            opacity: contentBaseOpacity,
            transition: "none",
            pointerEvents: contentHidden ? "none" : "auto",
          }}
        >
          {body}
        </div>
        <div
          className="agent-float-icon"
          data-agent-icon
          role="button"
          aria-label={t(getLanguage(), "chat.agentIconRestore")}
          title={t(getLanguage(), "chat.agentIconRestore")}
          style={{
            ...styles.agentFloatIcon,
            // 全窗 no-drag：盖住隐藏内容可能残留的拖拽区，保证图标任意位置都能点击/拖动。
            ...NO_DRAG_REGION,
            opacity: iconShown ? 1 : 0,
            pointerEvents: agentIconMode && !agentFloat ? "auto" : "none",
            cursor: agentIconMode && !agentFloat ? "grab" : "default",
            transition: iconTransition,
          }}
        >
          <img
            src="./logo.png"
            alt="Loopsoar"
            width={56}
            height={56}
            draggable={false}
            style={{ display: "block" }}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- 样式 ---------------------------------- */

/** App 外壳仅保留顶层布局样式；各区块样式随组件迁到各自文件。 */
