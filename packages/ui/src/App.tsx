import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LAYOUT, computeSidebarMaxWidth, computeSidebarMinWidth, computeVibeSidebarBounds } from "loopsoar-contracts/layout";
import { resolveOmniboxInput } from "loopsoar-contracts/omnibox";
import type {
  AgentSummary,
  AskUserRequest,
  BootStatus,
  BrowserSnapshotResult,
  DownloadItem,
  HistoryEntry,
  PermissionsState,
  Preferences,
  ProviderStatus,
  SessionMeta,
  TabState,
  WorkspaceRecord,
} from "./types.js";
import { BRAND, MOTION, NO_DRAG_REGION, applyTheme } from "./theme.js";
const Settings = React.lazy(() => import("./Settings.js"));
const ChromePage = React.lazy(() => import("./ChromePage.js"));
import MessageList from "./MessageList.js";
import { buildModelGroups, type ModelGroup } from "./modelGroups.js";
import { dismissAllPopovers } from "./popover.js";
import BrowserChrome from "./BrowserChrome.js";
import BrowserTabs from "./BrowserTabs.js";
import TitleBar from "./TitleBar.js";
import WorkspaceSwitcher from "./WorkspaceSwitcher.js";
import WorkspacePanel from "./WorkspacePanel.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import Composer from "./Composer.js";
const TerminalPanel = React.lazy(() => import("./TerminalPanel.js"));
import Onboarding, { isOnboardingDone } from "./Onboarding.js";
import { setLanguage, getLanguage, t, useT } from "./i18n.js";
import { splitAgentTabs } from "./agentWorkspace.js";
import type { ChromePageKind, SidebarMode, ThemeMode } from "./types.js";
import AskUserDialog from "./AskUserDialog.js";
const SnapshotPanel = React.lazy(() => import("./SnapshotPanel.js"));
import AgentSidebar from "./AgentSidebar.js";
import StatusBar from "./StatusBar.js";
import PermissionDialog from "./PermissionDialog.js";
import Toast from "./Toast.js";
import StartPage from "./StartPage.js";
import { useBootstrapData, useChatStreamEvents } from "./useChatStreamEvents.js";
import {
  useE2eChatAutoSend,
  useE2eChromePageDeepLink,
  useE2eMenuDeepLinks,
  useE2eRestoredScroll,
  useE2eSettingsDeepLink,
} from "./useE2eDeepLinks.js";
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
 * 品牌色（来自官方图标）：深墨 #111318 / 亚麻白 #F4EFE6 / 赭石 #C8763C。
 *
 * 架构（P5 拆分后）：本文件只保留「状态与业务编排」——会话/浏览器/设置的门面状态、
 * 发送/回滚/重生成/停止等动作、以及顶层布局装配。具体实现按职责外置：
 *   · useChatStreamEvents.ts —— 启动数据同步 + chat:stream:* 事件订阅与 per-session 路由；
 *   · useE2eDeepLinks.ts     —— ?e2e=* 深链自动化（生产路径零副作用）；
 *   · AgentSidebar.tsx       —— 侧栏外壳（复制会话/工作区条/会话切换与历史菜单）；
 *   · BrowserMenus.tsx       —— 历史 / 下载下拉面板；
 *   · StartPage.tsx / StatusBar.tsx / PermissionDialog.tsx / Toast.tsx —— 纯展示块；
 *   · chatStreamState.ts / timeline.ts —— 事件→消息、消息→时间线的纯函数层。
 * 所有拆分均为「受控 props + 回调」，状态仍集中在本组件，避免出现第二套数据源。
 */

/** 终端抽屉高度持久化键（与 railParams 等本地设置一致，放 localStorage）。 */
const TERMINAL_HEIGHT_STORAGE_KEY = "loopsoar_terminal_height";

/** 读取持久化的终端抽屉高度：夹紧到契约范围，读失败回默认值。 */
function readTerminalHeight(): number {
  const fallback = LAYOUT.TERMINAL_PANEL_HEIGHT;
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(
      LAYOUT.TERMINAL_PANEL_MAX_HEIGHT,
      Math.max(LAYOUT.TERMINAL_PANEL_MIN_HEIGHT, Math.round(value)),
    );
  } catch {
    return fallback; // 隐私模式等不允许访问 localStorage
  }
}

/* ---------------------------------- 主界面 ---------------------------------- */

/** 与 DOM 侧栏 CSS 过渡保持一致（MOTION.sidebarDuration = 320ms）。 */
const SIDEBAR_ANIMATION_MS_UI = 320;

export default function App(): React.JSX.Element {
  const api = useLoopsoarApi();
  const [boot, setBoot] = useState<BootStatus | null>(null);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [maximized, setMaximized] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  // 应用内终端（P0-4）：面板开合 + 高度（高度 localStorage 持久化；布局范围来自契约 LAYOUT）。
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** 底部开发者工具面板（与终端同区域；打开时终端自动收起）。 */
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [devtoolsHeight] = useState(360);
  const [terminalHeight, setTerminalHeight] = useState<number>(() => readTerminalHeight());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [address, setAddress] = useState("");
  const [currentUrl, setCurrentUrl] = useState<string>("");
  /** 切会话后网页是否被收起（此时显示空白页/纯净对话，点标签才展开网页）。 */
  const [viewSuppressed, setViewSuppressed] = useState(false);
  /** 跨会话任务条：所有带 Agent 工作区的会话（浏览器控制触发的折叠工作区）。 */
  const [agentTasks, setAgentTasks] = useState<{ sessionId: string; tabs: TabState[] }[]>([]);
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
  // 主题（soft 柔和无框默认 / classic 旧观感）：写到 html[data-theme]，CSS 变量整体切换
  const theme: ThemeMode = preferences?.theme ?? "soft";
  React.useEffect(() => {
    applyTheme(theme === "classic" ? "classic" : "soft");
  }, [theme]);
  // 右侧会话栏：常驻 / 收起；「小窗化」= 打开独立 BrowserWindow（真窗口，可拖动/缩放）
  const storedSidebarMode: SidebarMode = preferences?.sidebarMode ?? "docked";
  const sidebarMode: SidebarMode = storedSidebarMode === "float" ? "docked" : storedSidebarMode;
  // 独立窗口模式：?mini=1 时本渲染器只画 Agent 会话栏（由主进程 Agent 窗口加载）
  const miniWindow =
    typeof location !== "undefined" && new URLSearchParams(location.search).get("mini") === "1";
  const [agentWindowOpen, setAgentWindowOpen] = useState(false);
  /**
   * 小窗开合与偏好的「最新值」镜像：chrome:applyLayout 的事件回调只绑一次，
   * 如果直接闭包 state 会读到开通/关窗之前的旧值（重复开窗或重复关窗）；
   * 写进依赖数组又会让回调随每次偏好更新重订阅。用 ref 读最新值最稳。
   */
  const agentWindowOpenRef = useRef(false);
  const preferencesRef = useRef<Preferences | null>(null);
  useEffect(() => {
    agentWindowOpenRef.current = agentWindowOpen;
  }, [agentWindowOpen]);
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);
  /**
   * Agent 小窗的「最小化（缩成图标按钮）」状态：由主进程事件 chrome:agentWindowIconMode 驱动。
   * 图标模式只换视图，不卸载会话；点击图标 → ui:restoreAgentWindow 还原。
   */
  const [agentIconMode, setAgentIconMode] = useState(false);
  React.useEffect(() => {
    if (!miniWindow || !api) return;
    return api.on("chrome:agentWindowIconMode", (payload) => {
      setAgentIconMode(Boolean((payload as { icon?: boolean } | null)?.icon));
    });
  }, [miniWindow, api]);
  /**
   * 最小化/还原的「面板几何过渡」（Slime float 同款）：
   *   · minimize：窗口尺寸不动；面板 left/top/width/height 从整窗过渡到图标矩形，
   *     内容钉在原尺寸 + overflow:hidden 裁切（零重排），内容淡出、图标淡入；
   *     过渡结束主进程把窗口一次性落到图标 bounds。
   *   · restore：窗口已瞬间落到目标 bounds；面板从图标矩形展开成整窗，内容淡入、图标淡出。
   */
  const [agentFloat, setAgentFloat] = useState<{
    phase: "minimize" | "restore";
    durationMs: number;
    from: { x: number; y: number; width: number; height: number };
    to: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const [agentFloatStarted, setAgentFloatStarted] = useState(false);
  /** 图标态稳定后面板应停留的矩形（相对窗口）：窗口不再缩放，面板靠它保持 56px 图标位置。 */
  const [agentIconRect, setAgentIconRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [agentFloatFreeze, setAgentFloatFreeze] = useState<{ width: number; height: number } | null>(null);
  React.useEffect(() => {
    if (!miniWindow || !api) return;
    return api.on("chrome:agentWindowTransition", (payload) => {
      const p = (payload ?? {}) as {
        phase?: string;
        durationMs?: number;
        from?: { x?: number; y?: number; width?: number; height?: number };
        to?: { x?: number; y?: number; width?: number; height?: number };
      };
      if (p.phase !== "minimize" && p.phase !== "restore") return;
      const rect = (value?: { x?: number; y?: number; width?: number; height?: number }): { x: number; y: number; width: number; height: number } | null => {
        if (!value) return null;
        const { x, y, width, height } = value;
        if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
        return {
          x: x as number,
          y: y as number,
          width: Math.max(1, width as number),
          height: Math.max(1, height as number),
        };
      };
      const from = rect(p.from);
      const to = rect(p.to);
      if (!from || !to) return;
      const full = p.phase === "minimize" ? from : to;
      if (p.phase === "restore") setAgentIconRect(null);
      setAgentFloat({
        phase: p.phase,
        durationMs: Number(p.durationMs) || 400,
        from,
        to,
      });
      setAgentFloatStarted(false);
      setAgentFloatFreeze({ width: Math.round(full.width), height: Math.round(full.height) });
    });
  }, [miniWindow, api]);
  React.useEffect(() => {
    if (!agentFloat) return;
    // 先以起点几何挂载一帧，再切到终点 → 触发 CSS transition（Slime 用同一手法）。
    const raf = requestAnimationFrame(() => setAgentFloatStarted(true));
    return () => cancelAnimationFrame(raf);
  }, [agentFloat]);
  React.useEffect(() => {
    if (!agentFloat) return;
    // 兜底清理（主进程正常会在动画结束后通知 iconMode 切换，这里防丢事件卡在过渡态）。
    const timer = window.setTimeout(() => setAgentFloat(null), agentFloat.durationMs + 240);
    return () => window.clearTimeout(timer);
  }, [agentFloat]);
  React.useEffect(() => {
    if (!agentFloat) return;
    if (agentFloat.phase === "minimize" && agentIconMode) {
      // 已收成图标：窗口 bounds 不变，面板固定停在图标矩形；内容保持钉住（避免在 56px 下重排整页 UI）。
      setAgentIconRect(agentFloat.to);
      setAgentFloat(null);
    } else if (agentFloat.phase === "restore" && !agentIconMode) {
      // 已展开：弹回普通布局（内容 100% 自动布局）。
      setAgentFloat(null);
      setAgentFloatFreeze(null);
      setAgentIconRect(null);
    }
  }, [agentFloat, agentIconMode]);
  React.useEffect(() => {
    if (!agentFloat) return;
    // Slime startFloatGeometryFade 同款：按面板宽度进度驱动内容透明度（不是固定时长淡出）——
    // 宽度 > 90% 区间全亮，在 90%→45% 区间 smoothstep 淡出/淡入，避免「窗口还很大内容就没了」。
    const node = contentRef.current;
    if (!node) return;
    const fromW = agentFloat.from.width;
    const toW = agentFloat.to.width;
    const span = Math.max(1, Math.abs(fromW - toW));
    const minW = Math.min(fromW, toW);
    const lo = minW + span * 0.45;
    const hi = minW + span * 0.9;
    const band = Math.max(1, hi - lo);
    const duration = Math.max(1, agentFloat.durationMs);
    const started = performance.now();
    let raf = 0;
    node.style.transition = "none";
    const step = (): void => {
      const u = Math.min(1, (performance.now() - started) / duration);
      const width = fromW + (toW - fromW) * u;
      const raw = Math.max(0, Math.min(1, (width - lo) / band));
      const opacity = raw * raw * (3 - 2 * raw);
      node.style.opacity = String(opacity);
      if (u < 1) raf = requestAnimationFrame(step);
      else node.style.opacity = "";
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      node.style.transition = "";
      node.style.opacity = "";
    };
  }, [agentFloat]);
  React.useEffect(() => {
    if (!miniWindow) return;
    document.documentElement.dataset.mini = "1";
    return () => {
      delete document.documentElement.dataset.mini;
    };
  }, [miniWindow]);
  // 浏览器管理整页（历史/下载/收藏夹/设置）：由浮层「查看更多」或动作打开
  const [chromePage, setChromePage] = useState<ChromePageKind | null>(null);
  // 首次启动向导：本地标记完成/跳过；设置·关于可重开（P6）
  const [onboardingOpen, setOnboardingOpen] = useState<boolean>(() => !isOnboardingDone());
  const [tabs, setTabs] = useState<TabState[]>([]);
  /** Agent 工作区（折叠标签组）是否展开：展开时隐藏原生网页视图，否则列表面板会被网页盖住。 */

  /** 新标签页/整页会话处于 Vibecoding 状态（侧栏会话按钮据此变成「会话列表」按钮）。 */
  const [vibeModeActive, setVibeModeActive] = useState(false);
  /** 用户是否刚在会话列表里主动选过会话：直接回话时才复用，否则每次直接回话都新建会话。 */
  const pickedSessionRef = useRef(false);
  const [mode, setMode] = useState<"build" | "plan">("build");
  const [reasoningEffort, setReasoningEffort] = useState<string>("");
  const [permReq, setPermReq] = useState<{
    requestId: string;
    toolName: string;
    target?: string;
    kind?: string;
    reason?: string;
    category?: string;
  } | null>(null);
  // ask_user 弹窗队列：ask:user 事件入队，逐条回答后出队（理论上同一时刻只有一条，队列兜住连发）
  const [askQueue, setAskQueue] = useState<AskUserRequest[]>([]);
  const [permSummary, setPermSummary] = useState<PermissionsState | null>(null);
  const [settingsSection, setSettingsSection] = useState<string>("");
  const [sidebarWidth, setSidebarWidth] = useState<number>(360);
  /** Vibecoding 模式独立侧栏宽度（0 = 未初始化，进入时用 vibe 最小宽度）。 */
  const [vibeSidebarWidth, setVibeSidebarWidth] = useState<number>(0);
  /** 侧栏拖拽中：拖拽时宽度必须逐帧跟手，不能开 CSS 过渡（否则手感变「橡皮筋」）。 */
  const [sidebarDragging, setSidebarDragging] = useState(false);
  /** 供 IPC effect 同步读取（state 更新是异步的，拖拽时序里必须用 ref）。 */
  const sidebarDraggingRef = React.useRef(false);
  /** 最近一次逻辑对齐宽度（诊断/动画回退用）。 */
  const nativeSidebarWidthRef = React.useRef<number | null>(null);
  /** 渲染层 rAF 驱动的侧栏宽度动画（主进程逐帧 setBounds，渲染层 60/120Hz 调度比主进程计时器稳）。 */
  const sidebarRafRef = React.useRef<number | null>(null);
  /** 与侧栏 DOM 同一条 cubic-bezier(0.2,0,0.2,1) 曲线。 */
  const easeSidebar = React.useCallback((t: number): number => {
    // 牛顿迭代解 cubic-bezier(0.2, 0, 0.2, 1) 的 x→t，再取 y。
    let x = t;
    for (let i = 0; i < 6; i++) {
      const cx = 3 * 0.2 * (1 - x) * (1 - x) * x + 3 * 0.2 * (1 - x) * x * x + x * x * x;
      const dx = 3 * 0.2 * (1 - x) * (1 - 2 * x) + 3 * 0.2 * (2 * x - 3 * x * x) + 3 * x * x;
      if (Math.abs(cx - t) < 1e-4 || Math.abs(dx) < 1e-6) break;
      x -= (cx - t) / dx;
      x = Math.max(0, Math.min(1, x));
    }
    return 3 * (1 - x) * (1 - x) * x * 0 + 3 * (1 - x) * x * x * 1 + x * x * x;
  }, []);
  /** 侧栏宽度动画进行中：AgentSidebar 内容先隐藏，避免逐帧重排文字（有网页时尤其卡）。 */
  const [sidebarWidthAnimating, setSidebarWidthAnimating] = React.useState(false);
    /** 原生视图宽度是否已完成启动水合：首次同步必须瞬时落位（不播动画），之后才允许 320ms 过渡。 */
  const nativeSidebarReadyRef = React.useRef(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // 下载事件仍由 hook 驱动（用于下载完成提示等后续扩展）；浮层/整页各自按需拉取列表
  const [, setDownloads] = useState<DownloadItem[]>([]);
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
  /**
   * 会话级「浏览器控制」开关（功能1）。真值以会话持久化（SessionMeta.browserControl）为准，
   * 这里保持即时态；草稿态（还没有会话）先记 draftBrowserControlRef，建会话后立即落库。
   */
  const [browserControl, setBrowserControl] = useState(false);
  const draftBrowserControlRef = useRef(false);
  const [modelGroups, setModelGroups] = useState<ModelGroup[] | null>(null);
  // 全局浮层仲裁：同一时刻只允许一个菜单展开；点击外部/Esc/切界面统一收起。
  // 会话历史下拉在 AgentSidebar 内用 usePopover("app-session") 登记；这里只负责全局收起。

  // 启动时先为空：真实会话 ID 必须来自 shell（恢复历史或 chat:sessions 的 currentId），
  // 否则未恢复历史的冷启动会拿一个假 ID 发送，消息落到索引外的"幽灵会话"。
  const sessionIdRef = useRef<string>("");
  /** 标签页 ↔ 会话绑定：会话只在首次对话时创建并绑定当前标签页；切回旧标签页恢复其会话。 */
  const tabSessionRef = useRef<Map<string, string>>(new Map());
  const omniboxRef = useRef<HTMLInputElement | null>(null);
  /** 最近一次同步到地址栏的 URL（仅活动标签 URL 变化时才覆盖，避免打断用户输入）。 */
  const lastSyncedUrlRef = useRef<string>("");
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
    setPermReq,
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

  const openSettings = useCallback((section?: string): void => {
    // 进入设置属于「切换界面」：任何展开中的列表/浮层（含 Composer 权限菜单）先收起，
    // 否则会压在新界面上（用户 m02115 截图：设置页上还浮着「本会话工具权限」）。
    dismissAllPopovers();
    setSettingsSection(section ?? "general");
    setSettingsOpen(true);
  }, []);

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

  // 侧栏宽度硬约束（ADR-0037）：最小宽度 = 窗口宽度 × 比例（用户裁决：当前左右栏比例即最小窄度），
  // 最大宽度 = min(720, 窗口宽度 - 320)；窗口 resize 与偏好水合后都要重新夹紧，避免启动时
  // 落回默认 360 而短暂窄于下限（拖拽本身的夹紧在 startResize 里，共用同一对契约函数）。
  useEffect(() => {
    const clamp = (): void => {
      const min = computeSidebarMinWidth(window.innerWidth);
      const max = computeSidebarMaxWidth(window.innerWidth);
      setSidebarWidth((w) => Math.min(Math.max(min, w), max));
      const vibe = computeVibeSidebarBounds(window.innerWidth);
      setVibeSidebarWidth((w) => (w > 0 ? Math.min(Math.max(vibe.min, w), vibe.max) : vibe.min));
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [preferences?.sidebarWidth, preferences?.vibeSidebarWidth]);

  // 偏好水合：读取用户上次在 Vibecoding 模式拖出的宽度（无效则回到 vibe 最小宽度）。
  useEffect(() => {
    const vibe = computeVibeSidebarBounds(window.innerWidth);
    const saved = preferences?.vibeSidebarWidth;
    setVibeSidebarWidth((w) => {
      const base = w > 0 ? w : (typeof saved === "number" ? saved : vibe.min);
      return Math.min(Math.max(vibe.min, base), vibe.max);
    });
  }, [preferences?.vibeSidebarWidth]);

  // 侧栏拖拽：mousemove 实时改 DOM 宽度，松开时持久化 + 同步原生视图
  const startResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const startX = event.clientX;
      // Vibecoding 模式用独立的窄区间（约为标准最小宽度的一半 ~ 3/5）；切回搜索模式后恢复标准区间。
      const vibe = computeVibeSidebarBounds(window.innerWidth);
      const bounds = vibeModeActive
        ? { min: vibe.min, max: vibe.max }
        : { min: computeSidebarMinWidth(window.innerWidth), max: computeSidebarMaxWidth(window.innerWidth) };
      const startWidth = vibeModeActive ? Math.min(Math.max(vibe.min, vibeSidebarWidth || vibe.min), vibe.max) : sidebarWidth;
      // 拖拽期间隐藏原生 WebContentsView，否则鼠标移入浏览器区后 mousemove 会被它吞掉
      void api?.browser.setOverlay({ open: true }).catch(() => {});
      sidebarDraggingRef.current = true;
      setSidebarDragging(true);
      const onMove = (e: MouseEvent): void => {
        const next = Math.max(bounds.min, Math.min(bounds.max, startWidth - (e.clientX - startX)));
        if (vibeModeActive) setVibeSidebarWidth(next);
        else setSidebarWidth(next);
      };
      const onUp = (e: MouseEvent): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        sidebarDraggingRef.current = false;
        setSidebarDragging(false);
        const next = Math.max(bounds.min, Math.min(bounds.max, startWidth - (e.clientX - startX)));
        if (vibeModeActive) setVibeSidebarWidth(next);
        else setSidebarWidth(next);
        void api?.browser.setOverlay({ open: false }).catch(() => {});
        // 松手时原生视图宽度直接落位（拖拽过程视图是隐藏的，不需要补动画）
        void api?.browser.setSidebarWidth({ width: next, animate: false }).catch(() => {});
        if (api && preferences) {
          void api.settings
            .setPreferences(vibeModeActive ? { ...preferences, vibeSidebarWidth: next } : { ...preferences, sidebarWidth: next })
            .then((r) => setPreferences(r.preferences))
            .catch(() => {});
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [api, preferences, sidebarWidth, vibeModeActive, vibeSidebarWidth],
  );

  /** 侧栏模式切换：收起/展开写偏好；「小窗化」改为打开独立 Agent 窗口（真窗口化）。 */
  const changeSidebarMode = useCallback(
    (next: SidebarMode): void => {
      if (!api) return;
      setSessionOpen(false);
      if (next === "float") {
        if (agentWindowOpen) {
          void api.ui.closeAgentWindow().catch(() => {});
          return;
        }
        void api.ui
          .openAgentWindow({ sessionId: currentSession ?? undefined })
          .then((r) => {
            if (r.ok) setAgentWindowOpen(true);
            else setNotice(`小窗打开失败：${r.error ?? "未知错误"}`);
          })
          .catch(() => setNotice("小窗打开失败"));
        return;
      }
      if (!preferences) return;
      const persist = (): void => {
        void api.settings
          .setPreferences({ ...preferences, sidebarMode: next })
          .then((r) => setPreferences(r.preferences))
          .catch(() => {});
      };
      persist();
    },
    [api, preferences, agentWindowOpen, currentSession],
  );

  useEffect(() => {
    if (!vibeModeActive) return;
    const vibe = computeVibeSidebarBounds(window.innerWidth);
    setVibeSidebarWidth(vibe.min);
  }, [vibeModeActive]);

  // 独立窗口被用户关闭（或主进程回收）→ 主窗口恢复侧栏
  React.useEffect(() => {
    if (!api || miniWindow) return;
    return api.on("chrome:agentWindowClosed", () => {
      agentWindowOpenRef.current = false;
      setAgentWindowOpen(false);
    });
  }, [api, miniWindow]);

  /**
   * Agent 第一次打开网页前的「会话窗口布局」安排（第二阶段 Slice E · 功能②）。
   *
   * 壳层已经完成询问/记忆（browser_navigate 的 beforeOpenPage 钩子），这里只执行真正的窗口动作：
   *   · agentWindow：会话独立成小窗（已打开则不重复开——主进程 open 是单实例，只聚焦）；
   *   · docked：先收小窗，再把侧栏恢复成「常驻右侧」并落库（常规布局 = 网页占主区）。
   * 依赖只放 api/miniWindow（稳定值），小窗状态与偏好走 ref：
   * 直接闭包 state 会读到开窗/偏好的旧值（重复开窗、或拿半份偏好覆盖设置）。
   */
  React.useEffect(() => {
    if (!api || miniWindow) return;
    return api.on("chrome:applyLayout", (payload) => {
      const { mode, sessionId } = (payload ?? {}) as { mode?: string; sessionId?: string };
      if (mode === "agentWindow") {
        if (agentWindowOpenRef.current) {
          // 已开：不重复开窗，只让它聚焦/切到该会话（主进程 open 单实例，重复调用只 focus）。
          void api.ui.openAgentWindow({ sessionId }).catch(() => {});
          return;
        }
        // 先占位再开：同一 tick 内再来一条事件也不会并发创建两个窗口。
        agentWindowOpenRef.current = true;
        void api.ui
          .openAgentWindow({ sessionId })
          .then((result) => {
            if (result.ok) {
              setAgentWindowOpen(true);
              return;
            }
            agentWindowOpenRef.current = false;
            setNotice(
              t(getLanguage(), "browser.layout.openFailed", {
                error: result.error ?? t(getLanguage(), "common.unknownError"),
              }),
            );
          })
          .catch(() => {
            agentWindowOpenRef.current = false;
            setNotice(
              t(getLanguage(), "browser.layout.openFailed", { error: t(getLanguage(), "common.unknownError") }),
            );
          });
        return;
      }
      if (mode !== "docked") return;
      if (agentWindowOpenRef.current) {
        agentWindowOpenRef.current = false;
        void api.ui.closeAgentWindow().catch(() => {});
        setAgentWindowOpen(false);
      }
      const prefs = preferencesRef.current;
      // 偏好还没水合（null）/ 已经是常驻右侧：都不写盘，避免用半份偏好覆盖用户设置。
      if (!prefs || prefs.sidebarMode === "docked") return;
      void api.settings
        .setPreferences({ ...prefs, sidebarMode: "docked" })
        .then((result) => setPreferences(result.preferences))
        .catch(() => {});
    });
  }, [api, miniWindow]);

  /** 生效的侧栏宽度（收起态只用图标条宽度，让网页区自然变宽）。 */
  // 独立窗口模式下主窗口侧栏完全隐藏 → 网页区铺满（宽度 0）
  const vibeBounds = computeVibeSidebarBounds(typeof window === "undefined" ? 1440 : window.innerWidth);
  /** Vibecoding 生效宽度：始终夹在 [vibe.min, vibe.max]；未初始化时回落到最小宽度。 */
  const activeVibeWidth = Math.min(
    Math.max(vibeBounds.min, vibeSidebarWidth > 0 ? vibeSidebarWidth : vibeBounds.min),
    vibeBounds.max,
  );
  const effectiveSidebarWidth = agentWindowOpen
    ? 0
    : sidebarMode === "collapsed"
      ? LAYOUT.SIDEBAR_COLLAPSED_WIDTH
      : vibeModeActive
        ? activeVibeWidth
        : sidebarWidth;
  React.useEffect(() => {
    if (!api || miniWindow || !preferences) return;
    const target = effectiveSidebarWidth;
    const previous = nativeSidebarWidthRef.current;
    // 启动水合（默认宽度→偏好宽度/收起态）必须瞬时落位；拖拽时逐帧跟手且不播动画。
    const animate = nativeSidebarReadyRef.current && !sidebarDraggingRef.current;
    nativeSidebarReadyRef.current = true;
    // 宽度没变（只是其它偏好更新导致 effect 重跑）：不能重播动画/重抓截图，否则会留下静态快照遮住网页。
    if (previous === target) {
      setSidebarWidthAnimating(false);
      return;
    }
    nativeSidebarWidthRef.current = target;
    if (!animate) {
      setSidebarWidthAnimating(false);
      void api.browser.setSidebarWidth({ width: target, animate: false }).catch(() => {});
      return;
    }
    // 左右同拍：DOM 侧栏 CSS 过渡 320ms；原生网页视图由渲染层 rAF 逐帧驱动
    // （主进程 setInterval 在 Windows 上实际只有 ~40fps，rAF 跟随合成器，通常 60/120Hz）。
    setSidebarWidthAnimating(true);
    const from = typeof previous === "number" ? previous : target;
    const startedAt = performance.now();
    if (sidebarRafRef.current !== null) cancelAnimationFrame(sidebarRafRef.current);
    const step = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / SIDEBAR_ANIMATION_MS_UI);
      const eased = easeSidebar(t);
      const width = Math.round(from + (target - from) * eased);
      void api.browser.setSidebarWidth({ width, animate: false }).catch(() => {});
      if (t < 1) {
        sidebarRafRef.current = requestAnimationFrame(step);
      } else {
        sidebarRafRef.current = null;
        void api.browser.setSidebarWidth({ width: target, animate: false }).catch(() => {});
        setSidebarWidthAnimating(false);
      }
    };
    sidebarRafRef.current = requestAnimationFrame(step);
    return () => {
      if (sidebarRafRef.current !== null) {
        cancelAnimationFrame(sidebarRafRef.current);
        sidebarRafRef.current = null;
      }
    };
  }, [api, effectiveSidebarWidth, miniWindow, preferences]);

  // 全宽终端占用的底部高度 → 原生网页视图必须让出，否则面板会被 WebContentsView 盖住
  React.useEffect(() => {
    if (!api) return;
    const bottom = terminalOpen ? terminalHeight : devtoolsOpen ? devtoolsHeight : 0;
    const timer = window.setTimeout(() => {
      void api.browser.setBottomInset({ bottom }).catch(() => {});
    }, 60);
    return () => window.clearTimeout(timer);
  }, [api, terminalOpen, terminalHeight, devtoolsOpen, devtoolsHeight]);

  // 底部开发者工具：主进程负责面板开合（含页面内 F12 / devtools 自身关闭），渲染层只同步状态。
  React.useEffect(() => {
    if (!api) return;
    return api.on("chrome:devToolsPanel", (payload) => {
      const open = Boolean((payload as { open?: boolean } | null)?.open);
      setDevtoolsOpen(open);
    });
  }, [api]);

  // 面板高度/开合同步给主进程（窗口 resize 由主进程自己重算）。
  React.useEffect(() => {
    if (!api) return;
    const timer = window.setTimeout(() => {
      void api.browser.setDevToolsPanel({ open: devtoolsOpen, height: devtoolsHeight }).catch(() => undefined);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [api, devtoolsOpen, devtoolsHeight]);

  const toggleDevtools = useCallback((): void => {
    if (!api) return;
    if (terminalOpen) setTerminalOpen(false);
    void api.browser
      .toggleDevTools({})
      .then((result) => {
        if (!result.ok) setNotice(result.error ?? "无法打开开发者工具");
      })
      .catch((err: unknown) => setNotice(`无法打开开发者工具：${err instanceof Error ? err.message : String(err)}`));
  }, [api, terminalOpen]);

  // F12 / Ctrl+Shift+I：DOM 焦点在主窗口时也能开关底部调试面板（网页内由浏览器 adapter 处理）。
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const inspect = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i";
      if (event.key !== "F12" && !inspect) return;
      event.preventDefault();
      toggleDevtools();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleDevtools]);

  const tr = useT();
  // Agent 工作区：Agent 打开/导航过的标签折叠进一个 chip，其余仍是普通标签条
  // （分组规则在 agentWorkspace.ts，纯函数可单测；这里只负责渲染与副作用）。
  const { user: userTabs, bound: boundTabs } = useMemo(() => splitAgentTabs(tabs), [tabs]);
  // 工作区里最后一个网页也没了（Agent 关页/会话切走）：折叠面板不该悬空留着。


  const activeTabId = useMemo(() => tabs.find((tab) => tab.active)?.id ?? null, [tabs]);
  const activeTabIdRef = React.useRef<string | null>(null);
  activeTabIdRef.current = activeTabId;
  /** 最新标签列表的同步镜像：effect 里要读「这一刻」的标签，state 可能晚一帧。 */
  const tabsRef = React.useRef<TabState[]>(tabs);
  tabsRef.current = tabs;

  /**
   * Agent 浏览器活动（会话隔离）：只让「当前会话」的浏览器显示呼吸灯；
   * 动作发生在当前会话时，把它正在操作的标签切到可见；其它会话一概不动界面。
   */
  const [agentBrowserBusy, setAgentBrowserBusy] = React.useState(0);
  /** 正在跑 Agent 的会话（轮次级）：呼吸灯按它点亮，工具执行只在轮次内的一小段。 */
  const [agentTurnSessions, setAgentTurnSessions] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!api) return;
    const refreshTasks = (): void => {
      void api.browser
        .listTasks()
        .then((r) => setAgentTasks(r.tasks))
        .catch(() => undefined);
    };
    refreshTasks();
    const off = api.on("browser:tabs", refreshTasks);
    return () => {
      off?.();
    };
  }, [api, currentSession]);

  React.useEffect(() => {
    if (!api) return;
    const applySuppressed = (suppressed: boolean): void => {
      setViewSuppressed(suppressed);
      // 网页收起时把页面区域让给空白页（地址栏也清空，避免「有地址但没网页」的错觉）。
      if (suppressed) {
        setCurrentUrl("");
        setAddress("");
      }
    };
    void api.browser
      .viewState()
      .then((state) => applySuppressed(Boolean(state?.suppressed)))
      .catch(() => undefined);
    return api.on("browser:viewSuppressed", (payload) => {
      applySuppressed(Boolean((payload as { suppressed?: boolean } | null)?.suppressed));
    });
  }, [api]);

  React.useEffect(() => {
    if (!api || miniWindow) return;
    return api.on("chrome:agentTurn", (payload) => {
      const p = payload as { sessionId?: string; running?: boolean };
      if (!p.sessionId) return;
      setAgentTurnSessions((prev) => {
        const has = prev.includes(p.sessionId as string);
        if (p.running === true) return has ? prev : [...prev, p.sessionId as string];
        return has ? prev.filter((id) => id !== p.sessionId) : prev;
      });
    });
  }, [api, miniWindow]);
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
      setAgentBrowserBusy(mine ? next : 0);
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

  // 切标签时收起调试面板（面板绑定的是原标签的 WebContents，避免显示错页）。
  React.useEffect(() => {
    if (!devtoolsOpen || !api) return;
    void api.browser.setDevToolsPanel({ open: false }).catch(() => undefined);
    // 只在标签切换时触发；devtoolsOpen 作为守卫读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, api]);

  // 终端抽屉高度：夹紧到契约范围并持久化（TerminalPanel 拖拽/键盘调整后回调）
  const changeTerminalHeight = useCallback((next: number): void => {
    const clamped = Math.min(
      LAYOUT.TERMINAL_PANEL_MAX_HEIGHT,
      Math.max(LAYOUT.TERMINAL_PANEL_MIN_HEIGHT, Math.round(next)),
    );
    setTerminalHeight(clamped);
    try {
      localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(clamped));
    } catch {
      // 忽略（隐私模式等）
    }
  }, []);

  const openModelMenu = useCallback((): void => {
    if (!api || !provider?.configured) {
      openSettings("providers");
      return;
    }
    if (modelMenuOpen) {
      setModelMenuOpen(false);
      return;
    }
    setModelMenuOpen(true);
    // 跨供应商：直接读本地供应商清单（含模型参数），不做远端探测，秒开且离线可用
    setModelGroups(null);
    void api.settings
      .listProviders()
      .then((result) => setModelGroups(buildModelGroups(result.items, result.activeId)))
      .catch(() => setModelGroups([]));
  }, [api, modelMenuOpen, openSettings, provider]);

  // 工作区清单预载：「+ 工作区」菜单与侧栏会话树启动即可用（WorkspacePanel 之外不再等到打开面板才加载）。
  React.useEffect(() => {
    if (!api) return;
    void api.workspace
      .list()
      .then((r) => {
        setWorkspaces(r.workspaces);
        setActiveWorkspaceId(r.activeId);
      })
      .catch(() => undefined);
  }, [api]);
  // 新标签页 Vibecoding 的模型胶囊要立刻能展开：启动后预载一次跨供应商模型清单（离线、只读本地）。
  React.useEffect(() => {
    if (!api || modelGroups !== null) return;
    void api.settings
      .listProviders()
      .then((result) => setModelGroups(buildModelGroups(result.items, result.activeId)))
      .catch(() => setModelGroups([]));
  }, [api, modelGroups]);
  // 当前模型声明的推理等级；为空则不显示「推理」chip
  const effortOptions = useMemo(() => {
    const spec = provider?.models?.find((m) => m.id === provider.model);
    // 模型未声明 reasoning levels 时给默认三档（关=不发参数，安全），保证「推理强度」始终可用
    return spec?.thinkingEfforts && spec.thinkingEfforts.length > 0 ? spec.thinkingEfforts : ["low", "medium", "high"];
  }, [provider]);

  // 推理等级统一英文（用户 2026-11-14：菜单里中英混杂很难看）：
  // 档位名直接用模型声明的值（low / medium / high / max …），关闭态显示 off。
  const effortLabel = useCallback((value: string): string => (value ? value : "off"), []);

  const chooseModel = useCallback(
    (modelId: string, providerId: string): void => {
      setModelMenuOpen(false);
      if (!api) return;
      const group = modelGroups?.find((item) => item.providerId === providerId);
      if (!group) return;
      void (async () => {
        if (!group.active) await api.settings.setActiveProvider({ id: providerId });
        await api.settings.setProvider({ provider: group.provider, baseUrl: group.baseUrl, model: modelId });
        const nextProvider = await api.settings.getProvider();
        setProvider(nextProvider);
        const list = await api.settings.listProviders().catch(() => null);
        if (list) setModelGroups(buildModelGroups(list.items, list.activeId));
        setNotice(`已切换到 ${group.provider} · ${modelId}`);
      })().catch((err: unknown) => setNotice(`切换模型失败：${err instanceof Error ? err.message : String(err)}`));
    },
    [api, modelGroups],
  );

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
        setWorkspaces(selected.workspaces);
        setActiveWorkspaceId(selected.activeId);
      }
      // 草稿态：没有会话、没有消息；右侧只是「尚未归属工作区的会话栏」。
      sessionIdRef.current = "";
      setCurrentSession(null);
      setMessages([]);
      setPendingSteers([]);
      setBusy(false);
      setInput("");
      let tabs = await api.browser.listTabs();
      if (options?.newBlankTab) {
        await api.browser.newTab({});
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
    [api, activeWorkspaceId],
  );

  /** 新建标签页 = 新会话（每次都进入一个新的搜索页，不再和当前会话共用标签组）。 */
  /** 新标签页/整页会话的「+ 工作区」：选择已有工作区（影响之后新建的会话归属）。 */
  const selectWorkspaceForChat = useCallback(
    (id: string): void => {
      if (!api) return;
      void api.workspace
        .select({ id })
        .then((r) => {
          if (!r.ok) {
            setNotice(r.error ?? "切换工作区失败");
            return;
          }
          setWorkspaces(r.workspaces);
          setActiveWorkspaceId(r.activeId);
          setNotice(`工作区：${r.workspace?.name ?? ""}`);
        })
        .catch((err: unknown) => setNotice(`切换工作区失败：${err instanceof Error ? err.message : String(err)}`));
    },
    [api],
  );

  /** 输入框下方工作区选择器：草稿态只设后续活动工作区；已有会话才绑定。 */
  const bindWorkspaceToCurrentSession = useCallback(
    (workspaceId: string): void => {
      if (!api) return;
      if (!sessionIdRef.current) {
        void api.workspace
          .select({ id: workspaceId })
          .then((r) => {
            if (!r.ok) {
              setNotice(r.error ?? "切换工作区失败");
              return;
            }
            setWorkspaces(r.workspaces);
            setActiveWorkspaceId(r.activeId);
            setNotice("后续新建页/会话将在此工作区进行");
          })
          .catch((err: unknown) => setNotice("切换工作区失败：" + (err instanceof Error ? err.message : String(err))));
        return;
      }
      void api.workspace
        .bindSession({ workspaceId })
        .then((r) => {
          if (!r.ok) {
            setNotice(r.error ?? "切换工作区失败");
            return;
          }
          if (r.sessions) setSessions(r.sessions);
          if (r.workspaces) setWorkspaces(r.workspaces);
          if (r.activeId) setActiveWorkspaceId(r.activeId);
          setNotice("已切换工作区");
        })
        .catch((err: unknown) => setNotice("切换工作区失败：" + (err instanceof Error ? err.message : String(err))));
    },
    [api],
  );

  /** 新标签页/整页会话的「+ 新加工作区」：原生文件夹选择器 → 挂载并设为当前工作区。 */
  const addWorkspaceForChat = useCallback((): void => {
    if (!api) return;
    void api.workspace
      .create({})
      .then(async (r) => {
        if (!r.ok) {
          // 用户取消文件夹选择不算错误
          if (r.error && !r.error.includes("取消") && !r.error.toLowerCase().includes("cancel")) setNotice(r.error);
          return;
        }
        setWorkspaces(r.workspaces);
        setActiveWorkspaceId(r.activeId);
        // 新建工作区后直接进入该工作区的「新会话 + 新标签页」搜索页（用户 m07920）。
        await createFreshSessionAndTab({
          workspaceId: r.activeId ?? undefined,
          notice: `已添加工作区：${r.workspace?.name ?? ""}`,
        });
      })
      .catch((err: unknown) => setNotice(`添加工作区失败：${err instanceof Error ? err.message : String(err)}`));
  }, [api, createFreshSessionAndTab]);

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

  /** 重命名工作区（只改显示名）。 */
  const renameWorkspace = useCallback((workspaceId: string, name: string): void => {
    if (!api) return;
    void api.workspace
      .rename({ id: workspaceId, name })
      .then((r) => {
        setWorkspaces(r.workspaces);
        setActiveWorkspaceId(r.activeId);
        setNotice(r.ok ? "工作区已重命名为「" + (r.workspace?.name ?? name) + "」" : (r.error ?? "重命名失败"));
      })
      .catch((err: unknown) => setNotice("重命名失败：" + (err instanceof Error ? err.message : String(err))));
  }, [api]);

  /** 删除工作区（后端会拒绝仍有会话绑定的工作区）。 */
  const removeWorkspace = useCallback((workspaceId: string): void => {
    if (!api) return;
    void api.workspace
      .remove({ id: workspaceId })
      .then((r) => {
        setWorkspaces(r.workspaces);
        setActiveWorkspaceId(r.activeId);
        setNotice(r.ok ? "工作区已删除" : (r.error ?? "删除工作区失败"));
      })
      .catch((err: unknown) => setNotice("删除工作区失败：" + (err instanceof Error ? err.message : String(err))));
  }, [api]);

  /** 在系统文件管理器中打开工作区根目录。 */
  const openWorkspaceFolder = useCallback((workspaceId: string): void => {
    if (!api) return;
    void api.workspace
      .openFolder({ id: workspaceId })
      .then((r) => {
        if (!r.ok) setNotice(r.error ?? "无法打开文件夹");
      })
      .catch((err: unknown) => setNotice("无法打开文件夹：" + (err instanceof Error ? err.message : String(err))));
  }, [api]);
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
    setPermReq(null);
  }, [api, permReq]);

  /** 回答/取消 ask_user 弹窗：先出队再回填（避免重复提交），失败只提示不阻塞界面。 */
  const respondAsk = useCallback((answer: string | null): void => {
    const request = askQueue[0];
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
        if (!result?.received) setNotice("回答未送达：问题已过期或会话已结束");
      })
      .catch((err: unknown) => setNotice(`回答失败：${err instanceof Error ? err.message : String(err)}`));
  }, [api, askQueue]);

  /** 发送一条文本：立即渲染用户消息 + 助手占位（不等首字），再发起流式请求。 */
  const sendText = useCallback(
    (raw: string, targetSessionId?: string): void => {
      const text = raw.trim();
      if (!text || !api) return;
      const sid = targetSessionId ?? sessionIdRef.current;
      if (!sid) return;
      const meta = metaFor(sid);
      const assistantId = nextId("assistant");
      meta.activeId = assistantId;
      meta.startedAt = Date.now();
      meta.firstTokenAt = 0;
      meta.busy = true;
      meta.stopping = false;
      updateSessionMessages(sid, (prev) => [
        ...prev,
        { id: nextId("u"), role: "user", text, status: "done", createdAt: Date.now() },
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
        .catch((err: unknown) => {
          meta.busy = false;
          if (sid === sessionIdRef.current) {
            setBusy(false);
            setNotice(`发送失败：${err instanceof Error ? err.message : String(err)}`);
          }
        });
    },
    [api, metaFor, mode, provider, reasoningEffort, updateSessionMessages],
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
    (raw: string): void => {
      const text = raw.trim();
      const sid = sessionIdRef.current;
      if (!text || !sid || !api) return;
      const current = readPending(sid);
      if (current.length >= PENDING_STEER_MAX) {
        setNotice(`待发队列已满（最多 ${PENDING_STEER_MAX} 条），请等本轮结束后再发`);
        return;
      }
      const item: PendingSteer = { id: nextId("steer"), text, createdAt: Date.now(), status: "queued" };
      writePending(sid, enqueuePending(current, item));
      setNotice(`已排队（${current.length + 1}/${PENDING_STEER_MAX}）：本轮结束后自动发出；点「引导」可提前并入当前思考`);
    },
    [api, readPending, writePending],
  );

  const send = useCallback((): void => {
    const text = input.trim();
    if (!text || !api) return;
    setInput("");
    if (busy) {
      // 运行中：Enter = 待发指令（入队 + 投递，不打断当前输出；slime 语义）
      queueSteer(text);
      return;
    }
    void ensureSessionForSend()
      .then((sid) => {
        if (sid) sendText(text, sid);
      })
      .catch((err: unknown) => setNotice(`发送失败：${err instanceof Error ? err.message : String(err)}`));
  }, [api, busy, ensureSessionForSend, input, queueSteer, sendText]);

  /** 回滚到某条用户消息：消息之后的对话删除、内容放回输入框、持久化会话同步截断。 */
  const rollbackTo = useCallback(
    (targetId: string): void => {
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
    [api, messages, updateSessionMessages],
  );

  /** 重新生成：回滚到上一条用户消息并重发（复用现有 rollback + sendText 通道）。 */
  const regenerate = useCallback(
    (assistantId: string): void => {
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
    [api, messages, sendText, updateSessionMessages],
  );

  const stop = useCallback((): void => {
    if (!api) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    // 标记「用户主动停止」：abort 的 error 事件被 UI 收束为已停止，而不是红色报错
    const meta = metaFor(sid);
    meta.stopping = true;
    setNotice("正在停止…");
    void api.chat
      .stop({ sessionId: sid })
      .then((r) => {
        if (r.stopped) return;
        meta.stopping = false;
        meta.busy = false;
        setBusy(false);
        setNotice("当前没有正在运行的回复");
      })
      .catch(() => {
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
      const current = readPending(sessionId);
      if (current.length === 0) return;
      const requeued = requeueUndelivered(current);
      writePending(sessionId, requeued);
      if (sessionId !== sessionIdRef.current) return;
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

  const navigate = useCallback(
    (raw?: string): void => {
      if (!api) return;
      const input = raw ?? address;
      const engine = preferences?.searchEngine ?? "bing";
      const resolved = resolveOmniboxInput(input, engine);
      if (resolved.kind === "invalid") {
        setNotice(`导航被拒绝：${resolved.reason}`);
        return;
      }
      setNotice("");
      // 乐观切换：地址栏/加载页立刻指向目标，加载完成后再用真实 URL 覆盖（重定向场景）。
      setCurrentUrl(resolved.url);
      void api.browser.navigate({ url: resolved.url }).then((result) => {
        if (result.ok) {
          setCurrentUrl(result.url ?? resolved.url);
          setAddress(result.url ?? resolved.url);
          void api.browser.listTabs().then((r) => setTabs(r.tabs)).catch(() => {});
        } else {
          setNotice(`导航失败：${result.error ?? "未知"}`);
        }
      });
    },
    [address, api, preferences],
  );

  // 浮层动作（独立子窗口经主进程转发）：打开整页管理 / 主窗口导航 / 保存页面
  const savePageRef = React.useRef<null | (() => void)>(null);
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
    return api.on("chrome:dismissPopovers", () => dismissAllPopovers());
  }, [api]);
  React.useEffect(() => {
    if (!api) return;
    return api.on("chrome:popoverAction", (payload) => {
      const p = payload as { action?: string; payload?: { kind?: ChromePageKind; url?: string; tabId?: string } };
      if (p?.action === "openPage" && p.payload?.kind) {
        dismissAllPopovers();
        setChromePage(p.payload.kind);
        return;
      }
      if (p?.action === "navigate" && p.payload?.url) {
        navigate(p.payload.url);
        return;
      }
      if (p?.action === "savePage") savePageRef.current?.();
      if (p?.action === "selectTab" && p.payload?.tabId) {
        selectTab(p.payload.tabId);
        return;
      }
      // Agent 工作区浮层里的「关闭此网页」：与标签条上的关闭同一条链路（关页不等于关会话）。
      if (p?.action === "closeTab" && p.payload?.tabId) {
        closeTab(p.payload.tabId);
        return;
      }
      if (p?.action === "selectWorkspace") {
        const id = (p.payload as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") bindWorkspaceToCurrentSession(id);
        return;
      }
      if (p?.action === "addWorkspace") {
        addWorkspaceForChat();
        return;
      }
    });
  }, [api, navigate, bindWorkspaceToCurrentSession, addWorkspaceForChat]);

  const newTab = useCallback((): void => {
    if (!api) return;
    void createFreshSessionAndTab({ newBlankTab: true }).catch((err: unknown) =>
      setNotice("新建标签页失败：" + (err instanceof Error ? err.message : String(err))),
    );
  }, [api, createFreshSessionAndTab]);

  const selectTab = useCallback(
    (tabId: string): void => {
      if (!api) return;
      // 切标签属于切换界面：所有已展开列表/浮层先收起（用户 m02115 全局规则）。
      dismissAllPopovers();
      void api.browser.selectTab({ tabId }).then(() => {
        void api.browser.listTabs().then((r) => setTabs(r.tabs)).catch(() => {});
        const tab = tabs.find((t) => t.id === tabId);
        if (tab?.url) {
          setAddress(tab.url);
          setCurrentUrl(tab.url);
        }
      });
    },
    [api, tabs],
  );

  const closeTab = useCallback(
    (tabId: string): void => {
      if (!api) return;
      // 关掉最后一个网页 = 回到空白搜索页（会话与侧栏保持原样），**绝不退出程序**。
      // 退出只认窗口关闭/菜单退出这类显式手势；「关网页顺手关掉整个应用」是用户明确反馈的痛点。
      void api.browser
        .closeTab({ tabId })
        .then(() => api.browser.listTabs())
        .then((r) => {
          setTabs(r.tabs);
          const active = r.tabs.find((tab) => tab.active);
          const url = active?.url ?? "";
          lastSyncedUrlRef.current = url;
          setAddress(url);
          setCurrentUrl(url);
        })
        .catch(() => undefined);
    },
    [api, tabs.length],
  );

  /** 关闭整个 Agent 工作区：关闭全部绑定页（任务会话本身保留，页面关闭不等于会话结束）。 */
  const closeAgentWorkspace = useCallback((): void => {
    if (!api) return;
    const ids = tabs.filter((tab) => tab.agentBound === true).map((tab) => tab.id);
    if (ids.length === 0) return;
    void (async () => {
      for (const id of ids) {
        await api.browser.closeTab({ tabId: id }).catch(() => undefined);
      }
      const result = await api.browser.listTabs().catch(() => null);
      if (!result) return;
      setTabs(result.tabs);
      const active = result.tabs.find((tab) => tab.active);
      const url = active?.url ?? "";
      lastSyncedUrlRef.current = url;
      setAddress(url);
      setCurrentUrl(url);
    })();
  }, [api, tabs]);

  const goBack = useCallback((): void => {
    if (!api) return;
    void api.browser.back({}).then((r) => {
      if (r.ok && r.url) {
        setCurrentUrl(r.url);
        setAddress(r.url);
      }
      void api.browser.listTabs().then((x) => setTabs(x.tabs)).catch(() => {});
    });
  }, [api]);

  const goForward = useCallback((): void => {
    if (!api) return;
    void api.browser.forward({}).then((r) => {
      if (r.ok && r.url) {
        setCurrentUrl(r.url);
        setAddress(r.url);
      }
      void api.browser.listTabs().then((x) => setTabs(x.tabs)).catch(() => {});
    });
  }, [api]);

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
      const to = (payload as { to?: string } | null)?.to;
      if (!to) return;
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

  /** 刷新当前页：走 browser:reload（区别于地址栏导航，不重置历史栈）。 */
  const reloadPage = useCallback((): void => {
    if (!api) return;
    void api.browser
      .reload({})
      .then((result) => {
        if (!result.ok) {
          setNotice(`刷新失败：${result.error ?? "未知错误"}`);
          return;
        }
        if (result.url) {
          lastSyncedUrlRef.current = result.url;
          setAddress(result.url);
          setCurrentUrl(result.url);
        }
        void api.browser.listTabs().then((r) => setTabs(r.tabs)).catch(() => {});
      })
      .catch((err: unknown) => setNotice(`刷新失败：${err instanceof Error ? err.message : String(err)}`));
  }, [api]);

  /** 加载失败页的「重试」：有失败 URL 就重新导航（首次加载失败时标签 url 还是空的，reload 会 no-op）。 */
  const retryActivePage = useCallback((): void => {
    const active = tabs.find((tab) => tab.active);
    if (active?.loadFailure?.url) {
      navigate(active.loadFailure.url);
      return;
    }
    reloadPage();
  }, [navigate, reloadPage, tabs]);

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
  // 每次进入 Loopsoar 都是新会话（用户 m07920 规则）：shell 启动恢复完成后，
  // 新建「会话 + 空白标签页」，旧会话仍保留在会话列表/各自标签组里。
  const initialTabEnsuredRef = React.useRef(false);
  React.useEffect(() => {
    if (!api || miniWindow || initialTabEnsuredRef.current || !boot) return;
    initialTabEnsuredRef.current = true;
    const timer = window.setTimeout(() => {
      void createFreshSessionAndTab().catch((err: unknown) =>
        setNotice("新建会话失败：" + (err instanceof Error ? err.message : String(err))),
      );
    }, 120);
    return () => window.clearTimeout(timer);
  }, [api, miniWindow, boot, createFreshSessionAndTab]);

  useE2eSettingsDeepLink(setSettingsOpen, setSettingsSection);
  useE2eChromePageDeepLink(setChromePage);

  // 修复遮挡：应用内浮层（设置 / 工作区面板 / 快照 / 向导 / 标题栏工作区菜单）
  // 打开时隐藏原生 WebContentsView；菜单/浮层本身是主窗口 DOM，原生视图在它上面会盖住菜单。
  // 注意不要每次依赖变化都 cleanup 成 false（会在连续切换时闪一帧页面），只在卸载时复位。
  useEffect(() => {
    if (!api) return;
    const overlay =
      settingsOpen ||
      workspacePanelOpen ||
      snapshotData !== null ||
      onboardingOpen ||
      chromePage !== null;
    void api.browser.setOverlay({ open: overlay }).catch(() => {});
  }, [api, settingsOpen, workspacePanelOpen, snapshotData, onboardingOpen, chromePage]);
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
  const otherInterfaceOpen = settingsOpen || chromePage !== null || workspacePanelOpen || snapshotData !== null;
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
    if (risky.every((x) => x === "deny")) return "只读会话";
    if (risky.some((x) => x === "confirm")) return "权限：询问";
    return "权限：放行";
  };
  // 运行中输入非空时仍可发送：此时作为「转向提示」注入（steer）
  const canSend = Boolean(api) && input.trim() !== "";

  // 图标态：整窗透明 + 单层圆角图标（无窗框）。按下拖动=移动窗口，
  // 单击（位移 < 4px）=还原会话视图——与 Slime「图标浮窗可拖、点一下回来」一致。
  const iconDragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const beginIconDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    iconDragRef.current = { x: event.screenX, y: event.screenY, moved: false };
    const move = (ev: PointerEvent): void => {
      const state = iconDragRef.current;
      if (!state) return;
      const dx = ev.screenX - state.x;
      const dy = ev.screenY - state.y;
      if (!state.moved && Math.abs(dx) + Math.abs(dy) > 4) state.moved = true;
      if (!state.moved || (dx === 0 && dy === 0)) return;
      state.x = ev.screenX;
      state.y = ev.screenY;
      void api?.ui.moveAgentWindow({ dx, dy }).catch(() => undefined);
    };
    const finish = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      iconDragRef.current = null;
    };
    const up = (): void => {
      const state = iconDragRef.current;
      finish();
      if (!state?.moved) void api?.ui.restoreAgentWindow().catch(() => undefined);
    };
    const cancel = (): void => {
      finish();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  // Slime float 同款：minimize 时窗口不动、面板从整窗收到图标矩形；restore 反向展开。
  // 面板尺寸过渡期间，内容被钉在原窗口像素尺寸 + overflow:hidden 裁切 → 零重排。
  const floatRect = agentFloat ? (agentFloatStarted ? agentFloat.to : agentFloat.from) : null;
  /** 稳定图标态：面板停留在图标矩形（该大窗口在图标态被主进程隐藏，由独立 56px 图标窗口顶替）。 */
  const stableIconRect = !agentFloat && agentIconMode ? agentIconRect : null;
  const floatMs = agentFloat?.durationMs ?? 400;
  const floatEase = "cubic-bezier(0,0,0.2,1)";
  // 图标态 / 过渡相位决定内容与图标层的显隐：
  //   minimize：内容淡出、图标淡入（Slime 的 180ms ease + 120ms delay）；
  //   restore ：内容淡入、图标立即淡出（不再被 agentIconMode 的旧值挡住）；
  //   静止图标态：只显示图标。
  const contentHidden =
    agentFloat?.phase === "minimize" ? true : agentFloat?.phase === "restore" ? false : agentIconMode;
  const iconShown =
    agentFloat?.phase === "minimize" ? true : agentFloat?.phase === "restore" ? false : agentIconMode;
  // 内容透明度：过渡期间由 rAF 按宽度进度直接写 style（Slime 同款）；静止态用这个基准值。
  const contentBaseOpacity = contentHidden || agentFloat?.phase === "restore" ? 0 : 1;
  const iconTransition =
    agentFloat?.phase === "minimize"
      ? "opacity 180ms ease 120ms"
      : agentFloat?.phase === "restore"
        ? "opacity 160ms ease"
        : "none";
  // 起点几何挂载的那一帧必须关掉 transition（否则浏览器会从上一状态插值，出现「先摊满再缩」的假动画）。
  const panelTransition =
    agentFloat && agentFloatStarted
      ? `left ${floatMs}ms ${floatEase}, top ${floatMs}ms ${floatEase}, width ${floatMs}ms ${floatEase}, height ${floatMs}ms ${floatEase}`
      : "none";
  const freezeW = agentFloatFreeze?.width;
  const freezeH = agentFloatFreeze?.height;

  const body = (
    <>
      {/* Agent 独立窗口（?mini=1）也走自绘标题栏：无系统边框，只有最小化/关闭；
          主窗口标题栏同时承载标签页（与窗口按钮同一行，Chrome 式）。 */}
      <TitleBar
        maximized={maximized}
        variant={miniWindow ? "agent" : "main"}
        {...(miniWindow
          ? {}
          : {
              tabsLeading: (
                <WorkspaceSwitcher
                  workspaces={workspaces}
                  activeWorkspaceId={activeWorkspaceId}
                />
              ),
              tabs: (
                <BrowserTabs
                  tabs={userTabs}
                  boundTabs={boundTabs}
                  onToggleWorkspace={() => {
                    // 独立浮层：网页保持原样（不隐藏、不被挤），浮层天然压在网页之上。
                    dismissAllPopovers();
                    toggleWorkspacePopover();
                  }}
                  onCloseWorkspace={closeAgentWorkspace}
                  agentTasks={agentTasks}
                  currentSessionId={currentSession}
                  onOpenTask={openAgentTask}
                  onSelectTab={selectTab}
                  onCloseTab={closeTab}
                  onNewTab={newTab}
                />
              ),
            })}
      />

      {/* 工作区：左侧「网页列」（导航工具条 + 圆角页框），右侧会话栏。
          浏览器工具条只在网页列上方，不横跨到会话区；会话栏从标题栏下方起满高，
          顶部就是自己的功能按钮区。原生 WebContentsView 几何不变
          （x=inset、y=titlebar+topbar+inset、宽度让出侧栏与 splitter）。 */}
      <div style={styles.workRow}>
        {miniWindow ? null : (
          <div style={{ ...styles.pageColumn, position: "relative" }}>
            {/* 呼吸灯已移到 Agent 覆盖窗口（原生视图之上）：DOM 层再画一圈会和它叠成双环。 */}
            <BrowserChrome
              tabs={tabs}
              address={address}
              currentUrl={currentUrl}
              omniboxRef={omniboxRef}
              searchEngine={preferences?.searchEngine ?? "bing"}
              onSearchEngineChange={changeSearchEngine}
              onAddressChange={setAddress}
              onNavigate={() => navigate()}
              onBack={goBack}
              onForward={goForward}
              onReload={reloadPage}
              onSnapshot={() => void snapshot()}
              onNotice={setNotice}
            />
            <StartPage
              currentUrl={viewSuppressed ? "" : currentUrl}
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
              hidden={
                Boolean(currentUrl) &&
                !tabs.find((tab) => tab.active)?.loading &&
                !tabs.find((tab) => tab.active)?.loadFailure &&
                !vibeModeActive
              }
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
            原生网页视图由 browser:setSidebarWidth({animate:true}) 用同曲线同步让位。 */}
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
          liveWidth={sidebarDragging || miniWindow}
          embeddedInAgentWindow={miniWindow}
          mode={miniWindow ? "docked" : sidebarMode}
          onModeChange={
            miniWindow
              ? (m: SidebarMode): void => {
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
          compactUi={compactUi}
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
            thinkingOpen={thinkingOpen}
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

      {/* 应用内终端：全宽底部面板（VS Code 风格，从整个程序底部拉起） */}
      <div
        style={{
          height: terminalOpen ? terminalHeight : 0,
          flexShrink: 0,
          overflow: "hidden",
          transition: "height 240ms cubic-bezier(0.2, 0, 0.2, 1)",
        }}
      >
        <React.Suspense fallback={null}>
        <TerminalPanel
          sessionId={currentSession ?? undefined}
          open={terminalOpen}
          onClose={() => setTerminalOpen(false)}
          height={terminalHeight}
          onHeightChange={changeTerminalHeight}
          fullWidth
          onResizeStart={() => {
            void api?.browser.setOverlay({ open: true }).catch(() => {});
          }}
          onResizeEnd={() => {
            void api?.browser.setOverlay({ open: false }).catch(() => {});
          }}
        />
        </React.Suspense>
      </div>

      {miniWindow ? null : (
      <StatusBar
        shellStatus={boot?.status}
        agentLabel={agentLabel}
        providerLabel={providerLabel}
        currentUrl={currentUrl}
        mode={mode}
        terminalOpen={terminalOpen}
        onToggleTerminal={() => {
          if (!terminalOpen && devtoolsOpen) {
            void api?.browser.setDevToolsPanel({ open: false }).catch(() => undefined);
          }
          setTerminalOpen((value) => !value);
        }}
        devtoolsOpen={devtoolsOpen}
        onToggleDevtools={toggleDevtools}
      />
      )}

      {/* 底部开发者工具面板：占位放在状态栏之后 → 面板增高时状态栏被平滑推上去，
          成为展开面板的顶栏；真实 DevTools WebContentsView 由主进程覆盖在该区域上。 */}
      <div
        data-testid="devtools-panel-slot"
        aria-hidden={!devtoolsOpen}
        style={{
          height: devtoolsOpen ? devtoolsHeight : 0,
          flexShrink: 0,
          overflow: "hidden",
          transition: "height 240ms cubic-bezier(0.2, 0, 0.2, 1)",
        }}
      />

      <WorkspacePanel
        open={workspacePanelOpen}
        onClose={() => setWorkspacePanelOpen(false)}
        currentSessionId={currentSession}
        currentSessionTitle={sessions.find((item) => item.id === currentSession)?.title ?? "当前会话"}
        sessionWorkspaceId={sessions.find((item) => item.id === currentSession)?.workspaceId ?? activeWorkspaceId}
        onChanged={(text) => {
          if (text) setNotice(text);
          void api?.chat.sessions().then((r) => {
            setSessions(r.sessions);
            setCurrentSession(r.currentId);
          }).catch(() => {});
          void api?.workspace.list().then((r) => {
            setWorkspaces(r.workspaces);
            setActiveWorkspaceId(r.activeId);
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

      {/* 浏览器管理整页（浮层「查看更多」跳转）：历史/下载/收藏夹/设置 */}
      {chromePage ? (
        <React.Suspense fallback={null}>
        <ChromePage
          kind={chromePage}
          api={api}
          onClose={() => setChromePage(null)}
          onNavigate={(url) => {
            setChromePage(null);
            navigate(url);
          }}
          onOpenPage={(kind) => setChromePage(kind)}
          onOpenSettings={() => setChromePage("settings")}
          onOpenUrl={(url) => {
            // 整页设置内打开商店等外链：直接离开整页并打开目标页（等遮罩关闭再建标签）
            setChromePage(null);
            window.setTimeout(() => {
              void api?.browser.newTab({ url }).catch(() => undefined);
            }, 90);
          }}
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

      {permReq ? <PermissionDialog request={permReq} onRespond={respondPermission} /> : null}

      {/* ask_user 弹窗：Agent 提问挂起任务时置顶显示；取消/Esc 按 cancelled 回填 */}
      {askQueue.length > 0 ? (
        <AskUserDialog key={askQueue[0].requestId} request={askQueue[0]} onRespond={respondAsk} />
      ) : null}

      {/* 主窗口的提示走独立子窗口（原生网页会盖住 DOM）；只有独立的小窗模式仍用内联 Toast。 */}
      {notice && miniWindow ? <Toast text={notice} onDismiss={() => setNotice("")} /> : null}
    </>
  );

  if (!miniWindow) {
    return <div style={styles.app}>{body}</div>;
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
const styles: Record<string, React.CSSProperties> = {
  app: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    margin: 0,
    background: BRAND.ink,
    color: BRAND.linen,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    boxSizing: "border-box",
    overflow: "hidden",
  },
  // 独立小窗：透明窗口只负责「桌面留白」，可见面全部由面板裁切（圆角/悬浮都由面板决定）。
  agentShellMini: {
    position: "relative",
    width: "100%",
    height: "100vh",
    margin: 0,
    background: "transparent",
    overflow: "hidden",
  },
  // 小窗面板：Slime float 的盒模型（圆角 + overflow:hidden），左侧/顶部/宽高由过渡状态驱动。
  agentPanel: {
    position: "absolute",
    boxSizing: "border-box",
    overflow: "hidden",
    background: BRAND.ink,
    color: BRAND.linen,
    borderRadius: 14,
  },
  // 面板上的图标层：固定 56px logo（不随面板缩放），淡入淡出，图标态可拖动/点击还原。
  agentFloatIcon: {
    position: "absolute",
    inset: 0,
    zIndex: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
    touchAction: "none",
  },
  // chrome 外壳：工具条、splitter、会话栏共用同一块抬高的面（BRAND.inkRaised），
  // 页框四边内缩成「深色门户」；中间那一点缝（splitter + 会话栏左侧留白）因此被填满，
  // 顶部网址栏与会话栏连成一体，再用页框圆角形成闭合外框。
  workRow: {
    display: "flex",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    background: BRAND.inkRaised,
  },
  // 网页列：导航工具条（第二行）只覆盖这一列；页框在 StartPage 里内缩成圆角面板。
  pageColumn: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, overflow: "hidden" },
  splitter: {
    // 净占位仍是 2px，但命中区向左多覆盖 4px，正好盖住页框右侧留白 —— 鼠标停在
    // 「网页深色面板 ↔ 抬高外壳」的视觉交界处就能拖拽（用户 m04830：之前命中区在交界右侧 4px）。
    width: LAYOUT.SPLITTER_WIDTH + 4,
    marginLeft: -4,
    flexShrink: 0,
    cursor: "col-resize",
    // 不画分隔线：网页区与会话区之间只靠「页框内缩 + 2px 热区」形成一道细缝。
    background: "transparent",
    transition: "background 120ms",
  },
};
