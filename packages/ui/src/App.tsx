import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
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
import { BRAND, applyTheme } from "./theme.js";
import Settings from "./Settings.js";
import ChromePage from "./ChromePage.js";
import MessageList from "./MessageList.js";
import { buildModelGroups, type ModelGroup } from "./modelGroups.js";
import { usePopover } from "./popover.js";
import BrowserChrome from "./BrowserChrome.js";
import TitleBar from "./TitleBar.js";
import WorkspacePanel from "./WorkspacePanel.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import Composer from "./Composer.js";
import TerminalPanel from "./TerminalPanel.js";
import Onboarding, { isOnboardingDone } from "./Onboarding.js";
import { setLanguage } from "./i18n.js";
import type { ChromePageKind, SidebarMode, ThemeMode } from "./types.js";
import AskUserDialog from "./AskUserDialog.js";
import SnapshotPanel from "./SnapshotPanel.js";
import AgentSidebar from "./AgentSidebar.js";
import StatusBar from "./StatusBar.js";
import PermissionDialog from "./PermissionDialog.js";
import Toast from "./Toast.js";
import StartPage from "./StartPage.js";
import { useBootstrapData, useChatStreamEvents } from "./useChatStreamEvents.js";
import {
  useE2eChatAutoSend,
  useE2eMenuDeepLinks,
  useE2eRestoredScroll,
  useE2eSettingsDeepLink,
} from "./useE2eDeepLinks.js";
import { nextId } from "./ids.js";
import {
  applySteer,
  createSessionStreamMeta,
  restoreMessages,
  type ChatMessage,
  type SessionStreamMeta,
} from "./chatStreamState.js";

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
  const [terminalHeight, setTerminalHeight] = useState<number>(() => readTerminalHeight());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [address, setAddress] = useState("");
  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>("");
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
  // 右侧会话栏三态：常驻 / 收起 / 小窗化（持久化到偏好）
  const sidebarMode: SidebarMode = preferences?.sidebarMode ?? "docked";
  // 浏览器管理整页（历史/下载/收藏夹/设置）：由浮层「查看更多」或动作打开
  const [chromePage, setChromePage] = useState<ChromePageKind | null>(null);
  // 首次启动向导：本地标记完成/跳过；设置·关于可重开（P6）
  const [onboardingOpen, setOnboardingOpen] = useState<boolean>(() => !isOnboardingDone());
  const [tabs, setTabs] = useState<TabState[]>([]);
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
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // 下载事件仍由 hook 驱动（用于下载完成提示等后续扩展）；浮层/整页各自按需拉取列表
  const [, setDownloads] = useState<DownloadItem[]>([]);
  // 浏览器工具栏浮层（更多/收藏夹/历史/下载）打开：需隐藏原生 WebContentsView，否则菜单被网页遮挡
  // 页面快照面板：null=关闭；非空时隐藏原生浏览器视图并渲染可读浮层
  const [snapshotData, setSnapshotData] = useState<BrowserSnapshotResult | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [modelGroups, setModelGroups] = useState<ModelGroup[] | null>(null);
  // 全局浮层仲裁：同一时刻只允许一个菜单展开；点击外部/Esc 收起（含 Composer 内菜单）。
  usePopover("app-session", sessionOpen, setSessionOpen);

  // 启动时先为空：真实会话 ID 必须来自 shell（恢复历史或 chat:sessions 的 currentId），
  // 否则未恢复历史的冷启动会拿一个假 ID 发送，消息落到索引外的"幽灵会话"。
  const sessionIdRef = useRef<string>("");
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
  const sessionCacheRef = useRef(new Map<string, ChatMessage[]>());
  const sessionMetaRef = useRef(new Map<string, SessionStreamMeta>());
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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

  // 提示自动消失：成功 4.5s、失败/中断 8s；避免每条提示都要手动点掉
  useEffect(() => {
    if (!notice) return;
    const sticky = /(失败|错误|无法|中断)/.test(notice);
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
  });

  // E2E/演示：恢复会话后把最后一条时间线滚到可视区（只做一次）
  useE2eRestoredScroll(messages.length, busy);

  const openSettings = useCallback((section?: string): void => {
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

  // 侧栏最小宽度硬约束：窗口变窄时自动夹紧，避免输入区被挤压变形
  useEffect(() => {
    const clamp = (): void => {
      const max = Math.max(320, Math.min(720, window.innerWidth - 320));
      setSidebarWidth((w) => Math.min(Math.max(280, w), max));
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  // 侧栏拖拽：mousemove 实时改 DOM 宽度，松开时持久化 + 同步原生视图
  const startResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      // 可调范围：侧栏 280~720，且浏览器区至少保留 320 → 任意宽度下都能拖出比例
      const minWidth = 280;
      const maxForWindow = (): number => Math.max(minWidth + 40, Math.min(720, window.innerWidth - 320));
      // 拖拽期间隐藏原生 WebContentsView，否则鼠标移入浏览器区后 mousemove 会被它吞掉
      void api?.browser.setOverlay({ open: true }).catch(() => {});
      const onMove = (e: MouseEvent): void => {
        const next = Math.max(minWidth, Math.min(maxForWindow(), startWidth - (e.clientX - startX)));
        setSidebarWidth(next);
      };
      const onUp = (e: MouseEvent): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        const next = Math.max(minWidth, Math.min(maxForWindow(), startWidth - (e.clientX - startX)));
        setSidebarWidth(next);
        void api?.browser.setOverlay({ open: false }).catch(() => {});
        void api?.browser.setSidebarWidth({ width: next }).catch(() => {});
        if (api && preferences) {
          void api.settings
            .setPreferences({ ...preferences, sidebarWidth: next })
            .then((r) => setPreferences(r.preferences))
            .catch(() => {});
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [api, preferences, sidebarWidth],
  );

  /** 侧栏模式切换：写偏好（持久化）+ 立即同步原生视图宽度。 */
  const changeSidebarMode = useCallback(
    (next: SidebarMode): void => {
      if (!api || !preferences) return;
      setSessionOpen(false);
      void api.settings
        .setPreferences({ ...preferences, sidebarMode: next })
        .then((r) => setPreferences(r.preferences))
        .catch(() => {});
    },
    [api, preferences],
  );

  /** 生效的侧栏宽度（收起态只用图标条宽度，让网页区自然变宽）。 */
  const effectiveSidebarWidth = sidebarMode === "collapsed" ? LAYOUT.SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;
  React.useEffect(() => {
    if (!api) return;
    void api.browser.setSidebarWidth({ width: effectiveSidebarWidth }).catch(() => {});
  }, [api, effectiveSidebarWidth]);

  // 全宽终端占用的底部高度 → 原生网页视图必须让出，否则面板会被 WebContentsView 盖住
  React.useEffect(() => {
    if (!api) return;
    const bottom = terminalOpen ? terminalHeight : 0;
    const timer = window.setTimeout(() => {
      void api.browser.setBottomInset({ bottom }).catch(() => {});
    }, 60);
    return () => window.clearTimeout(timer);
  }, [api, terminalOpen, terminalHeight]);

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

  // 当前模型声明的推理等级；为空则不显示「推理」chip
  const effortOptions = useMemo(() => {
    const spec = provider?.models?.find((m) => m.id === provider.model);
    // 模型未声明 reasoning levels 时给默认三档（关=不发参数，安全），保证「推理强度」始终可用
    return spec?.thinkingEfforts && spec.thinkingEfforts.length > 0 ? spec.thinkingEfforts : ["low", "medium", "high"];
  }, [provider]);

  const effortLabel = useCallback((value: string): string => {
    if (!value) return "推理：关";
    const map: Record<string, string> = { minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "最高" };
    return `推理：${map[value] ?? value}`;
  }, []);

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
    (raw: string): void => {
      const text = raw.trim();
      if (!text || !api) return;
      const sid = sessionIdRef.current;
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

  const send = useCallback((): void => {
    const text = input.trim();
    if (!text || !api) return;
    setInput("");
    if (busy) {
      // 运行中：作为「转向提示」注入（轮次边界生效，不打断当前输出）
      const sid = sessionIdRef.current;
      if (sid) {
        const active = metaFor(sid).activeId;
        updateSessionMessages(sid, (prev) => {
          const appended = active ? applySteer(prev, active, text) : prev;
          return [
            ...appended,
            { id: nextId("u"), role: "user", text, status: "done", createdAt: Date.now(), steer: true },
          ];
        });
      }
      void api.chat
        .steer({ message: text, sessionId: sessionIdRef.current ?? undefined })
        .then((r) => setNotice(r.accepted ? "转向已注入（下一轮生效）" : "转向未生效：当前没有运行中的回复"))
        .catch((err: unknown) => setNotice(`转向失败：${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    sendText(text);
  }, [api, busy, input, metaFor, sendText, updateSessionMessages]);

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

  const navigate = useCallback(
    (raw?: string): void => {
      if (!api) return;
      const input = raw ?? address;
      const engine = (preferences?.searchEngine ?? "bing") as "bing" | "google" | "duckduckgo";
      const resolved = resolveOmniboxInput(input, engine);
      if (resolved.kind === "invalid") {
        setNotice(`导航被拒绝：${resolved.reason}`);
        return;
      }
      if (resolved.kind === "search") {
        setNotice(`搜索：${resolved.query}`);
      } else {
        setNotice("导航中…");
      }
      void api.browser.navigate({ url: resolved.url }).then((result) => {
        if (result.ok) {
          setCurrentUrl(result.url ?? resolved.url);
          setAddress(result.url ?? resolved.url);
          setNotice("导航完成");
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
  React.useEffect(() => {
    if (!api) return;
    return api.on("chrome:popoverAction", (payload) => {
      const p = payload as { action?: string; payload?: { kind?: ChromePageKind; url?: string } };
      if (p?.action === "openPage" && p.payload?.kind) {
        setChromePage(p.payload.kind);
        return;
      }
      if (p?.action === "navigate" && p.payload?.url) {
        navigate(p.payload.url);
        return;
      }
      if (p?.action === "savePage") savePageRef.current?.();
    });
  }, [api, navigate]);

  const newTab = useCallback((): void => {
    if (!api) return;
    // 已是空白新建页：不再叠一个空标签，聚焦地址栏即可
    const active = tabs.find((x) => x.active);
    if (active && !active.url) {
      setNotice("当前就是新建标签页，输入地址即可");
      omniboxRef.current?.focus();
      return;
    }
    void api.browser.newTab({}).then((r) => {
      if (r.ok) {
        setNotice("");
        void api.browser.listTabs().then((t) => setTabs(t.tabs)).catch(() => {});
        setTimeout(() => omniboxRef.current?.focus(), 50);
      }
    });
  }, [api, tabs]);

  const selectTab = useCallback(
    (tabId: string): void => {
      if (!api) return;
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
      void api.browser.closeTab({ tabId }).then(() => {
        void api.browser.listTabs().then((r) => setTabs(r.tabs)).catch(() => {});
      });
    },
    [api],
  );

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

  const newSession = useCallback((): void => {
    if (!api) return;
    void api.chat.newSession().then((r) => {
      setSessions(r.sessions);
      setCurrentSession(r.currentId);
      const nextIdValue = r.session?.sessionId;
      if (nextIdValue) {
        sessionIdRef.current = nextIdValue;
        writeSessionMessages(nextIdValue, []);
      } else {
        setMessages([]);
      }
      setBusy(false);
      setSessionOpen(false);
      setNotice("已新建会话");
      void api.browser
        .listTabs()
        .then((r) => {
          setTabs(r.tabs);
          const active = r.tabs.find((tab) => tab.active);
          const url = active?.url ?? "";
          lastSyncedUrlRef.current = url;
          setAddress(url);
          setCurrentUrl(url);
        })
        .catch(() => undefined);
    });
  }, [api, writeSessionMessages]);

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
    void api.chat.switchSession({ sessionId }).then((r) => {
      if (!r.ok) return;
      sessionIdRef.current = sessionId;
      setCurrentSession(sessionId);
      // 优先恢复该会话的实时缓存（后台可能仍在跑）；否则用持久化历史
      const cached = sessionCacheRef.current.get(sessionId);
      const msgs = cached ?? restoreMessages(r.session?.messages ?? [], nextId);
      writeSessionMessages(sessionId, msgs);
      const meta = metaFor(sessionId);
      setBusy(meta.busy);
      setSessionOpen(false);
      setNotice("");
      void api.browser
        .listTabs()
        .then((r) => {
          setTabs(r.tabs);
          const active = r.tabs.find((tab) => tab.active);
          const url = active?.url ?? "";
          lastSyncedUrlRef.current = url;
          setAddress(url);
          setCurrentUrl(url);
        })
        .catch(() => undefined);
    });
  }, [api, metaFor, writeSessionMessages]);

  /** 删除会话：当前会话被删时连同左侧标签切到下一个会话（原内联逻辑外置）。 */
  const deleteSession = useCallback(
    (sessionId: string): void => {
      void api?.chat
        .deleteSession({ sessionId })
        .then((r) => {
          setSessions(r.sessions);
          setCurrentSession(r.currentId);
          // 删除当前会话：右侧不能只清空，必须连同左侧标签一起切到下一个会话
          if (sessionId === currentSession) {
            setMessages([]);
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
  useE2eSettingsDeepLink(setSettingsOpen, setSettingsSection);

  // 修复遮挡：应用内浮层（设置 / 工作区 / 快照面板 / 首次向导）打开时隐藏原生 WebContentsView
  useEffect(() => {
    if (!api) return;
    const overlay = settingsOpen || workspacePanelOpen || snapshotData !== null || onboardingOpen || chromePage !== null;
    void api.browser.setOverlay({ open: overlay }).catch(() => {});
    return () => {
      void api.browser.setOverlay({ open: false }).catch(() => {});
    };
  }, [api, settingsOpen, workspacePanelOpen, snapshotData, onboardingOpen, chromePage]);

  // 语言：偏好（启动加载 / 设置里修改）同步到 i18n store；已接入 i18n 的组件即时重渲染
  useEffect(() => {
    if (preferences?.language) setLanguage(preferences.language);
  }, [preferences?.language]);

  // 让位：打开设置/工作区面板时收起快照浮层（避免两层模态叠在一起）
  useEffect(() => {
    if (settingsOpen || workspacePanelOpen) setSnapshotData(null);
  }, [settingsOpen, workspacePanelOpen]);

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

  const providerLabel = useMemo(() => {
    if (!provider) return "provider: 读取中…";
    if (!provider.configured) return "provider: 未配置";
    return provider.usable
      ? `provider: ${provider.provider} · ${provider.model}`
      : `provider: ${provider.provider}（${provider.reason ?? "不可用"}）`;
  }, [provider]);

  const agentLabel = agents.find((a) => a.isDefault)?.name ?? "—";
  const permissionLabel = (state: PermissionsState): string => {
    const p = state.permissions;
    const risky = [p.write, p.terminal, p.network];
    if (risky.every((x) => x === "deny")) return "只读会话";
    if (risky.some((x) => x === "confirm")) return "权限：询问";
    return "权限：放行";
  };
  // 运行中输入非空时仍可发送：此时作为「转向提示」注入（steer）
  const canSend = Boolean(api) && input.trim() !== "";

  return (
    <div style={styles.app}>
      <TitleBar maximized={maximized} />

      <BrowserChrome
        tabs={tabs}
        address={address}
        currentUrl={currentUrl}
        omniboxRef={omniboxRef}
        onAddressChange={setAddress}
        onNavigate={() => navigate()}
        onBack={goBack}
        onForward={goForward}
        onReload={reloadPage}
        onSnapshot={() => void snapshot()}
        onNotice={setNotice}
        onSelectTab={selectTab}
        onCloseTab={closeTab}
        onNewTab={newTab}
      />

      <div style={styles.body}>
        <StartPage currentUrl={currentUrl} />

        {sidebarMode === "docked" ? (
          <div style={styles.splitter} onMouseDown={startResize} title="拖动调整面板宽度" />
        ) : null}
        {/* docked：会话栏以「浮动卡片」呈现（8px 留白 + 圆角 + 阴影，不贴窗口边） */}
        <div
          style={{
            width: effectiveSidebarWidth,
            flexShrink: 0,
            boxSizing: "border-box",
            display: "flex",
            minWidth: 0,
            // collapsed 保持贴边竖条；docked 四周留 8px 形成浮动卡片；float 由 CSS 负责外边距
            padding: sidebarMode === "docked" ? 8 : 0,
          }}
        >
        <AgentSidebar
          width={sidebarMode === "docked" ? Math.max(240, effectiveSidebarWidth - 16) : effectiveSidebarWidth}
          mode={sidebarMode}
          onModeChange={changeSidebarMode}
          agentLabel={agentLabel}
          messages={messages}
          sessions={sessions}
          currentSession={currentSession}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          compactUi={compactUi}
          sessionOpen={sessionOpen}
          onToggleSession={toggleSessionMenu}
          onNewSession={newSession}
          onSwitchSession={switchSession}
          onDeleteSession={deleteSession}
          onOpenWorkspacePanel={() => setWorkspacePanelOpen(true)}
          onNotice={setNotice}
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
            onOpenUrl={(url) => void api?.browser.newTab({ url }).catch(() => {})}
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
            onReasoningEffortChange={(value) => {
              setReasoningEffort(value);
              if (!api || !preferences) return;
              const next = { ...preferences, reasoningEffort: value };
              setPreferences(next);
              void api.settings
                .setPreferences(next)
                .then((r) => setPreferences(r.preferences))
                .catch(() => {});
            }}
            effortLabel={effortLabel}
            permissionLabel={permissionLabel}
            onPickAttachment={() => {
              void api?.dialog
                .pickPath({ kind: "file", title: "选择附件" })
                .then((r) => {
                  if (r.canceled || !r.path) return;
                  setInput((prev) => (prev ? `${prev}
【附件】${r.path}` : `【附件】${r.path}`));
                  setNotice("已添加附件（路径已放入消息）");
                })
                .catch(() => {});
            }}
            notice={notice}
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
      </div>

      <StatusBar
        shellStatus={boot?.status}
        agentLabel={agentLabel}
        providerLabel={providerLabel}
        currentUrl={currentUrl}
        terminalOpen={terminalOpen}
        onToggleTerminal={() => setTerminalOpen((value) => !value)}
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
      <SnapshotPanel snapshot={snapshotData} onClose={() => setSnapshotData(null)} />
      {settingsOpen ? (
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
          onOpenOnboarding={() => setOnboardingOpen(true)}
        />
      ) : null}

      {/* 浏览器管理整页（浮层「查看更多」跳转）：历史/下载/收藏夹/设置 */}
      {chromePage ? (
        <ChromePage
          kind={chromePage}
          api={api}
          onClose={() => setChromePage(null)}
          onNavigate={(url) => {
            setChromePage(null);
            navigate(url);
          }}
          onSavePage={savePage}
          onOpenSettings={() => setChromePage("settings")}
          onNotice={setNotice}
        />
      ) : null}

      {/* 首次启动向导（P6）：跳过/完成写本地标记；设置·关于可重开 */}
      {onboardingOpen ? (
        <Onboarding
          open={onboardingOpen}
          onClose={() => setOnboardingOpen(false)}
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

      {notice ? <Toast text={notice} onDismiss={() => setNotice("")} /> : null}
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
  body: { display: "flex", flex: 1, minHeight: 0, overflow: "hidden" },
  splitter: {
    width: 6,
    flexShrink: 0,
    cursor: "col-resize",
    background: "transparent",
    borderLeft: `1px solid ${BRAND.border}`,
    transition: "background 120ms",
  },
};
