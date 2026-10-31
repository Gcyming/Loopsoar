import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { normalizeNavigateUrl } from "loopsoar-contracts/navigation";
import { resolveOmniboxInput } from "loopsoar-contracts/omnibox";
import type {
  AgentSummary,
  BootStatus,
  LoopsoarAPI,
  DownloadItem,
  HistoryEntry,
  PermissionsState,
  Preferences,
  ProviderModel,
  ProviderStatus,
  SessionMeta,
  TabState,
} from "./types.js";
import { BRAND, DRAG_REGION, NO_DRAG_REGION } from "./theme.js";
import { Icon } from "./Icon.js";
import Settings from "./Settings.js";
import TopicRail from "./TopicRail.js";
import MessageList from "./MessageList.js";
import { buildModelGroups, type ModelGroup } from "./modelGroups.js";
import { usePopover } from "./popover.js";
import BrowserChrome from "./BrowserChrome.js";
import Composer from "./Composer.js";
import { type TimelineStep } from "./timeline.js";

/**
 * Loopsoar 主界面（GUI-3）：品牌三色 + 自定义标题栏 + 图标系统 + 交互反馈/动画。
 * 品牌色（来自官方图标）：深墨 #111318 / 亚麻白 #F4EFE6 / 赭石 #C8763C。
 * 交互范式借鉴 slime 已打磨的实践：
 *   · 按钮 hover 上浮 1px + 软阴影、active 按下 scale(.97/.88) 回弹；
 *   · 流式吐字「逐单元渐入」：新字符由右到左滑入 + 由浅到深（260ms cubic-bezier(.22,.61,.36,1)）；
 *   · 流式光标闪烁、加载 spinner、状态点脉冲、消息行淡入；
 *   · prefers-reduced-motion 下只保留不透明度渐入（去掉位移，避免"什么都看不到"）。
 */

import {
  applyChunk,
  applyDone,
  applyReasoning,
  applySteer,
  applyToolResult,
  applyToolStart,
  parseDone,
  restoreMessages,
  type ChatMessage,
} from "./chatStreamState.js";

const ROLE_LABEL: Record<ChatMessage["role"], string> = {
  user: "你",
  assistant: "Loopsoar",
  reasoning: "推理",
  tool: "工具",
  system: "系统",
};

function roleColor(role: ChatMessage["role"]): string {
  switch (role) {
    case "user":
      return BRAND.linen;
    case "assistant":
      return BRAND.ochreHover;
    case "reasoning":
      return "#9a8fb8";
    case "tool":
      return "#c9a227";
    default:
      return BRAND.linenMuted;
  }
}

function useLoopsoarApi(): LoopsoarAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { loopsoarAPI?: LoopsoarAPI }).loopsoarAPI ?? null;
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ---------------------------------- 标题栏 ---------------------------------- */

function TitleBar({ maximized }: { maximized: boolean }): React.JSX.Element {
  const api = useLoopsoarApi();
  return (
    <div style={styles.titleBar}>
      <div
        style={{ ...styles.titleDrag, ...DRAG_REGION }}
        onDoubleClick={() => void api?.window.maximize()}
      >
        <img src="./logo.png" alt="" width={18} height={18} style={styles.titleLogo} />
        <span style={styles.titleText}>Loopsoar</span>
      </div>
      <div style={{ ...styles.windowControls, ...NO_DRAG_REGION }}>
        <button
          type="button"
          aria-label="最小化"
          title="最小化"
          className="win-btn"
          style={styles.windowButton}
          onClick={() => void api?.window.minimize()}
        >
          <Icon name="minimize" size={12} />
        </button>
        <button
          type="button"
          aria-label={maximized ? "还原" : "最大化"}
          title={maximized ? "还原" : "最大化"}
          className="win-btn"
          style={styles.windowButton}
          onClick={() => void api?.window.maximize()}
        >
          <span
            style={{
              display: "block",
              width: 10,
              height: 10,
              border: `1.2px solid currentColor`,
              borderRadius: maximized ? 0 : 1,
              boxShadow: maximized ? "inset 0 -2px 0 -1px currentColor" : "none",
            }}
          />
        </button>
        <button
          type="button"
          aria-label="关闭"
          title="关闭"
          className="win-btn win-close"
          style={styles.windowButton}
          onClick={() => void api?.window.close()}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------- 主界面 ---------------------------------- */

export default function App(): React.JSX.Element {
  const api = useLoopsoarApi();
  const [boot, setBoot] = useState<BootStatus | null>(null);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [maximized, setMaximized] = useState(false);
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
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [mode, setMode] = useState<"build" | "plan">("build");
  const [reasoningEffort, setReasoningEffort] = useState<string>("");
  const [permReq, setPermReq] = useState<{ requestId: string; toolName: string; target?: string; kind?: string } | null>(null);
  const [permSummary, setPermSummary] = useState<PermissionsState | null>(null);
  const [settingsSection, setSettingsSection] = useState<string>("");
  const [sidebarWidth, setSidebarWidth] = useState<number>(360);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [modelGroups, setModelGroups] = useState<ModelGroup[] | null>(null);
  // 全局浮层仲裁：同一时刻只允许一个菜单展开；点击外部/Esc 收起（含 Composer 内菜单）。
  usePopover("app-session", sessionOpen, setSessionOpen);
  usePopover("app-history", historyOpen, setHistoryOpen);
  usePopover("app-downloads", downloadsOpen, setDownloadsOpen);

  const sessionIdRef = useRef<string>(nextId("sess"));
  const omniboxRef = useRef<HTMLInputElement | null>(null);
  /** 最近一次同步到地址栏的 URL（仅活动标签 URL 变化时才覆盖，避免打断用户输入）。 */
  const lastSyncedUrlRef = useRef<string>("");
  const sendStartedAtRef = useRef<number>(0);
  const firstTokenAtRef = useRef<number>(0);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
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
  const activeAssistantRef = useRef<string | null>(null);
  const tailSeqRef = useRef<number>(0);

  // 挂载：拉取状态 + 订阅流式事件（事件名来自契约 EVENTS 白名单）
  useEffect(() => {
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
          void api.browser.setSidebarWidth({ width: prefs.sidebarWidth }).catch(() => {});
        }
        // 恢复上次会话（设置 · 通用 · 恢复上次会话）
        if (prefs.restoreSession) {
          const history = await api.chat.history().catch(() => null);
          if (history?.session?.messages?.length) {
            sessionIdRef.current = history.session.sessionId;
            const restored = restoreMessages(history.session.messages, nextId);
            // 只在界面仍为空时恢复：避免异步历史把用户刚发出的消息覆盖掉（曾导致"回复消失"）
            setMessages((prev) => (prev.length === 0 ? restored : prev));
          }
        }
      }
      const permResult = await api.settings.getPermissions().catch(() => null);
      if (permResult) setPermSummary(permResult);
      const sessionResult = await api.chat.sessions().catch(() => null);
      if (sessionResult) {
        setSessions(sessionResult.sessions);
        setCurrentSession(sessionResult.currentId);
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

    /** 追加流式增量：text 累积 + tail 标记（触发逐单元渐入动画）。 */
    const upsertAssistant = (delta: string): void => {
      if (firstTokenAtRef.current === 0) firstTokenAtRef.current = Date.now();
      const id = activeAssistantRef.current ?? nextId("a");
      activeAssistantRef.current = id;
      tailSeqRef.current += 1;
      const tailSeq = tailSeqRef.current;
      setMessages((prev) => applyChunk(prev, id, delta, { tailSeq }));
    };

    const pushTransient = (role: ChatMessage["role"], text: string): void => {
      setMessages((prev) => [...prev, { id: nextId(role), role, text, status: "done" }]);
    };

    const unsubscribers = [
      api.on("chat:stream:chunk", (payload) => {
        const p = payload as { content?: string };
        if (typeof p.content === "string" && p.content.length > 0) upsertAssistant(p.content);
      }),
      api.on("chat:stream:reasoning", (payload) => {
        const p = payload as { content?: string };
        const reasoningDelta = typeof p.content === "string" ? p.content : "";
        if (reasoningDelta.length > 0) {
          if (firstTokenAtRef.current === 0) firstTokenAtRef.current = Date.now();
          setMessages((prev) => {
            const at = activeAssistantRef.current;
            return at ? applyReasoning(prev, at, reasoningDelta) : prev;
          });
        }
      }),
      api.on("chat:stream:tool_start", (payload) => {
        const raw = String((payload as { content?: string }).content ?? "");
        setMessages((prev) => {
          const at = activeAssistantRef.current;
          return at ? applyToolStart(prev, at, raw) : prev;
        });
      }),
      api.on("chat:stream:tool", (payload) => {
        const raw = String((payload as { content?: string }).content ?? "");
        setMessages((prev) => {
          const at = activeAssistantRef.current;
          if (!at) return prev;
          return applyToolResult(prev, at, raw, nextId("tool"));
        });
      }),
      api.on("chat:stream:progress", (payload) => {
        const raw = String((payload as { content?: string }).content ?? "");
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
          setMessages((prev) => {
            const at = activeAssistantRef.current;
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
        if (parsed.note) pushTransient("system", parsed.note);
      }),
      api.on("chat:stream:heartbeat", () => {}),
      api.on("perm:request", (payload) => {
        const req = payload as { requestId?: string; toolName?: string; target?: string; kind?: string };
        if (req?.requestId) {
          setPermReq({ requestId: req.requestId, toolName: req.toolName ?? "工具", target: req.target, kind: req.kind });
        }
      }),
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
        const p = payload as { content?: string };
        const start = sendStartedAtRef.current;
        const first = firstTokenAtRef.current;
        const finishedAssistantId = activeAssistantRef.current;
        const info = parseDone(p.content);
        const statusText = info.statusText;
        setMessages((prev) => {
          const streaming = prev.find((m) => m.status === "streaming");
          if (streaming?.timeline?.length && api) {
            void api.chat
              .saveTimeline({ sessionId: sessionIdRef.current ?? undefined, timeline: streaming.timeline })
              .catch(() => {});
          }
          return applyDone(prev, info, { startedAt: start, firstTokenAt: first });
        });
        if (finishedAssistantId) {
          // slime 口径：收尾后整块思考历程自动收起（用户可随时再展开）
          // E2E/演示：?expandTimeline=1 时保持展开，便于验收时间线视觉
          const params = new URLSearchParams(location.search);
          const keepTimelineOpen = params.get("expandTimeline") === "1";
          if (!keepTimelineOpen) setThinkingOpen((prev) => ({ ...prev, [finishedAssistantId]: false }));
          // E2E/演示：?scrollTimeline=1 时把最后一条思考时间线滚到可视区顶部，便于截图验收
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
        }
        activeAssistantRef.current = null;
        firstTokenAtRef.current = 0;
        sendStartedAtRef.current = 0;
        setBusy(false);
        setNotice(statusText);
      }),
      api.on("chat:stream:error", (payload) => {
        const p = payload as { content?: string; message?: string };
        const text = p.message ?? p.content ?? "未知错误";
        activeAssistantRef.current = null;
        setBusy(false);
        setNotice("回复失败");
        setMessages((prev) => {
          if (prev.some((m) => m.status === "streaming")) {
            return prev.map((m) =>
              m.status === "streaming" ? { ...m, status: "error", tail: undefined, errorText: text } : m,
            );
          }
          // 首字之前就失败：没有流式气泡 → 补一条错误消息，否则错误被吞掉
          return [
            ...prev,
            { id: nextId("assistant"), role: "assistant" as const, text: "", status: "error" as const, errorText: text, createdAt: Date.now() },
          ];
        });
      }),
    ];
    return () => {
      window.removeEventListener("resize", syncMaximized);
      for (const unsub of unsubscribers) unsub();
    };
  }, [api]);

  /** E2E/演示：恢复会话后把最后一条时间线滚到可视区（只做一次） */
  const restoredScrollDoneRef = useRef(false);
  useEffect(() => {
    if (restoredScrollDoneRef.current || messages.length === 0 || busy) return;
    if (new URLSearchParams(location.search).get("scrollTimeline") !== "1") return;
    const timer = setTimeout(() => {
      const cards = document.querySelectorAll(".chat-scroll .think-card");
      const last = cards[cards.length - 1] as HTMLElement | undefined;
      if (last) {
        restoredScrollDoneRef.current = true;
        last.scrollIntoView({ block: "start" });
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [messages.length, busy]);

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

  /** 发送一条文本：立即渲染用户消息 + 助手占位（不等首字），再发起流式请求。 */
  const sendText = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      if (!text || !api) return;
      setBusy(true);
      setNotice("");
      const assistantId = nextId("assistant");
      setMessages((prev) => [
        ...prev,
        { id: nextId("u"), role: "user", text, status: "done", createdAt: Date.now() },
        { id: assistantId, role: "assistant", text: "", status: "streaming", createdAt: Date.now() },
      ]);
      activeAssistantRef.current = assistantId;
      sendStartedAtRef.current = Date.now();
      firstTokenAtRef.current = 0;
      void api.chat
        .stream({ message: text, sessionId: sessionIdRef.current, mode, reasoningEffort: reasoningEffort || undefined })
        .catch((err: unknown) => {
          setBusy(false);
          setNotice(`发送失败：${err instanceof Error ? err.message : String(err)}`);
        });
    },
    [api, mode, reasoningEffort],
  );

  const send = useCallback((): void => {
    const text = input.trim();
    if (!text || !api) return;
    setInput("");
    if (busy) {
      // 运行中：作为「转向提示」注入（轮次边界生效，不打断当前输出）
      setMessages((prev) => {
        const active = activeAssistantRef.current;
        const appended = active ? applySteer(prev, active, text) : prev;
        return [
          ...appended,
          { id: nextId("u"), role: "user", text, status: "done", createdAt: Date.now(), steer: true },
        ];
      });
      void api.chat
        .steer({ message: text, sessionId: sessionIdRef.current ?? undefined })
        .then((r) => setNotice(r.accepted ? "转向已注入（下一轮生效）" : "转向未生效：当前没有运行中的回复"))
        .catch((err: unknown) => setNotice(`转向失败：${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    sendText(text);
  }, [api, busy, input, sendText]);

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
      setMessages((prev) => prev.slice(0, idx));
      setInput(target.text);
      setNotice("已回滚到该消息，内容已放回输入框");
      void api?.chat.rollback({ keepCount, sessionId: sessionIdRef.current ?? undefined }).catch(() => {});
    },
    [api, messages],
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
      setMessages((prev) => prev.slice(0, userIdx));
      void api?.chat.rollback({ keepCount, sessionId: sessionIdRef.current ?? undefined }).catch(() => {});
      window.setTimeout(() => sendText(text), 80);
    },
    [api, messages, sendText],
  );

  const stop = useCallback((): void => {
    if (!api) return;
    void api.chat.stop({ sessionId: sessionIdRef.current });
  }, [api]);

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

  const toggleHistory = useCallback((): void => {
    if (!api) return;
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    void api.browser.history({}).then((r) => {
      setHistoryEntries(r.entries);
      setHistoryOpen(true);
      setDownloadsOpen(false);
      setModelMenuOpen(false);
    });
  }, [api, historyOpen]);

  const toggleDownloads = useCallback((): void => {
    if (!api) return;
    if (downloadsOpen) {
      setDownloadsOpen(false);
      return;
    }
    void api.browser.downloads().then((r) => {
      setDownloads(r.downloads);
      setDownloadsOpen(true);
      setHistoryOpen(false);
      setModelMenuOpen(false);
    });
  }, [api, downloadsOpen]);

  const refreshSessions = useCallback((): void => {
    if (!api) return;
    void api.chat.sessions().then((r) => {
      setSessions(r.sessions);
      setCurrentSession(r.currentId);
    }).catch(() => {});
  }, [api]);

  const newSession = useCallback((): void => {
    if (!api) return;
    void api.chat.newSession().then((r) => {
      setSessions(r.sessions);
      setCurrentSession(r.currentId);
      setMessages([]);
      if (r.session?.sessionId) sessionIdRef.current = r.session.sessionId;
      setSessionOpen(false);
      setNotice("已新建会话");
    });
  }, [api]);

  const switchSession = useCallback((sessionId: string): void => {
    if (!api) return;
    void api.chat.switchSession({ sessionId }).then((r) => {
      if (!r.ok) return;
      setCurrentSession(sessionId);
      sessionIdRef.current = sessionId;
      const msgs = r.session?.messages ?? [];
      setMessages(restoreMessages(msgs, nextId));
      setSessionOpen(false);
    });
  }, [api]);

  const snapshot = useCallback((): void => {
    if (!api) return;
    void api.browser.snapshot().then((result) => {
      setNotice(
        result.ok
          ? `页面快照：${result.title ?? ""}（${(result.text ?? "").length} 字符）`
          : `快照失败：${result.error}`,
      );
    });
  }, [api]);

  // E2E：?e2e=chat 时自动发一条消息（配合 scripts/mock-openai-server.mjs 验证真流式链路）
  useEffect(() => {
    if (!api || typeof location === "undefined") return;
    if (new URLSearchParams(location.search).get("e2e") !== "chat") return;
    const message = new URLSearchParams(location.search).get("chatText") || "你好，请简单介绍一下你自己";
    const delay = Number(new URLSearchParams(location.search).get("chatDelay") ?? "900");
    if (Number.isFinite(delay) && delay < 0) return;
    const timer = setTimeout(() => {
      sendText(message);
    }, Number.isFinite(delay) && delay >= 0 ? delay : 900);
    return () => clearTimeout(timer);
  }, [api, sendText]);

  // E2E：?e2e=model-menu / perm-menu 自动展开输入区弹层（验证锚定与不被裁切）
  useEffect(() => {
    if (!api || typeof location === "undefined") return;
    const mode = new URLSearchParams(location.search).get("e2e");
    if (mode !== "model-menu" && mode !== "perm-menu" && mode !== "menus-overlap" && mode !== "set-effort" && mode !== "steer-choice") return;
    const clickPermissionChip = (): void => {
      // 权限菜单的开关属于 Composer：深链只负责点击它的触发 chip（避免 App 再维护一份状态）。
      const chips = Array.from(document.querySelectorAll<HTMLElement>(".chip"));
      chips.find((chip) => (chip.textContent ?? "").includes("权限"))?.click();
    };
    const timer = setTimeout(() => {
      if (mode === "model-menu") {
        openModelMenu();
        return;
      }
      if (mode === "steer-choice") {
        // E2E：先发起一轮长回复，再在运行中输入并发送 → 应弹出「编辑 / 直接引导 / 取消」选择
        sendText("你好，请简单介绍一下你自己");
        window.setTimeout(() => setInput("补充：只看最近一周的情报"), 700);
        window.setTimeout(() => {
          document.querySelector<HTMLButtonElement>(".send-btn")?.click();
        }, 1100);
        return;
      }
      if (mode === "set-effort") {
        // E2E：展开模型菜单并点击「高」推理等级，用于验证偏好持久化（重启后仍为高）。
        openModelMenu();
        window.setTimeout(() => {
          const buttons = Array.from(document.querySelectorAll<HTMLElement>("[data-popover] .chip"));
          buttons.find((button) => (button.textContent ?? "").trim() === "高")?.click();
        }, 700);
        return;
      }
      if (mode === "menus-overlap") {
        // 先开模型菜单，再点权限 chip：验证全局互斥（最终只应保留权限菜单）。
        openModelMenu();
        window.setTimeout(clickPermissionChip, 400);
        return;
      }
      clickPermissionChip();
    }, 900);
    return () => clearTimeout(timer);
  }, [api, openModelMenu, sendText]);

  // E2E 深链：?e2e=settings&section=xxx 直接打开对应设置分区
  useEffect(() => {
    if (typeof location === "undefined") return;
    const params = new URLSearchParams(location.search);
    if (params.get("e2e") !== "settings") return;
    setSettingsOpen(true);
    const wanted = params.get("section");
    if (wanted) setSettingsSection(wanted);
  }, []);

  // 修复遮挡：应用内浮层（设置）打开时隐藏原生 WebContentsView
  useEffect(() => {
    if (!api) return;
    void api.browser.setOverlay({ open: settingsOpen }).catch(() => {});
    return () => {
      void api.browser.setOverlay({ open: false }).catch(() => {});
    };
  }, [api, settingsOpen]);

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

  // 历史 / 下载面板（以点击的按钮为基点展开）
  const renderHistoryPanel = (): React.JSX.Element => (
    <div className="pop-in" data-popover style={styles.popover}>
      <div style={styles.dropTitle}>历史记录（本标签）</div>
      {historyEntries.length === 0 ? (
        <div style={styles.dropEmpty}>暂无历史</div>
      ) : (
        historyEntries.map((h) => (
          <button
            key={`${h.index}-${h.url}`}
            type="button"
            className="model-item"
            style={{ ...styles.dropItem, ...(h.current ? styles.dropItemActive : {}) }}
            onClick={() => {
              setHistoryOpen(false);
              void api?.browser.navigate({ url: h.url }).then((r) => {
                if (r.ok) {
                  setCurrentUrl(r.url ?? h.url);
                  setAddress(r.url ?? h.url);
                }
              });
            }}
            title={h.url}
          >
            {h.url}
          </button>
        ))
      )}
    </div>
  );

  const renderDownloadsPanel = (): React.JSX.Element => (
    <div className="pop-in" data-popover style={{ ...styles.popover, right: 0, left: "auto", width: 400 }}>
      <div style={styles.dropTitle}>下载</div>
      {downloads.length === 0 ? (
        <div style={styles.dropEmpty}>暂无下载</div>
      ) : (
        downloads.map((d) => (
          <div key={d.id} style={styles.dlRow}>
            <div style={styles.dlMeta}>
              <span style={styles.dlName} title={d.savePath}>{d.filename}</span>
              <span style={styles.dlState}>
                {d.state === "completed"
                  ? "已完成"
                  : d.state === "progressing"
                    ? `${Math.round((d.received / Math.max(1, d.total)) * 100)}%`
                    : d.state === "cancelled"
                      ? "已取消"
                      : "失败"}
              </span>
            </div>
            <div style={styles.dlActions}>
              {d.state === "progressing" ? (
                <button type="button" className="icon-btn" title="取消" onClick={() => void api?.browser.downloadAction({ id: d.id, action: "cancel" })}>
                  <Icon name="close" size={12} />
                </button>
              ) : null}
              {d.state === "completed" ? (
                <button type="button" className="icon-btn" title="打开" onClick={() => void api?.browser.downloadAction({ id: d.id, action: "open" })}>
                  <Icon name="arrow-go" size={12} />
                </button>
              ) : null}
              <button type="button" className="icon-btn" title="打开所在文件夹" onClick={() => void api?.browser.downloadAction({ id: d.id, action: "showInFolder" })}>
                <Icon name="folder" size={12} />
              </button>
              <button type="button" className="icon-btn" title="移除记录" onClick={() => void api?.browser.downloadAction({ id: d.id, action: "remove" }).then(() => void api.browser.downloads().then((r) => setDownloads(r.downloads)))}>
                <Icon name="close" size={12} />
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );

  return (
    <div style={styles.app}>
      <TitleBar maximized={maximized} />

      <BrowserChrome
        tabs={tabs}
        address={address}
        currentUrl={currentUrl}
        omniboxRef={omniboxRef}
        historyOpen={historyOpen}
        downloadsOpen={downloadsOpen}
        downloadsActive={downloads.some((d) => d.state === "progressing")}
        historyPanel={renderHistoryPanel()}
        downloadsPanel={renderDownloadsPanel()}
        onAddressChange={setAddress}
        onNavigate={() => navigate()}
        onBack={goBack}
        onForward={goForward}
        onToggleHistory={toggleHistory}
        onToggleDownloads={toggleDownloads}
        onSnapshot={() => void snapshot()}
        onOpenSettings={() => setSettingsOpen(true)}
        onSelectTab={selectTab}
        onCloseTab={closeTab}
        onNewTab={newTab}
      />

      <div style={styles.body}>
        <section style={styles.browserPane}>
          <div style={styles.startPage}>
            <div style={styles.startMark}>
              <img src="./logo.png" alt="Loopsoar" width={64} height={64} />
            </div>
            <div style={styles.startTitle}>{currentUrl ? "Loopsoar" : "新建标签页"}</div>
            <div style={styles.startSubtitle}>
              {currentUrl ? "浏览器优先的本地 AI Agent" : "在顶部输入网址或搜索内容，回车开始"}
            </div>
            <div style={styles.startHints}>
              <div style={styles.hintRow}>
                <Icon name="arrow-go" size={14} style={styles.hintIcon} />
                <span>在顶部输入网址或搜索内容，回车打开页面</span>
              </div>
              <div style={styles.hintRow}>
                <Icon name="agent" size={14} style={styles.hintIcon} />
                <span>右侧与 Agent 对话：授权范围内读写文件、执行命令、操控网页</span>
              </div>
              <div style={styles.hintRow}>
                <Icon name="capture" size={14} style={styles.hintIcon} />
                <span>原生浏览器视图会覆盖此区域（WebContentsView · D0 已验证）</span>
              </div>
            </div>
            <div style={styles.startUrl}>{currentUrl ? `当前页面：${currentUrl}` : "尚未打开网页"}</div>
          </div>
        </section>

        <div style={styles.splitter} onMouseDown={startResize} title="拖动调整面板宽度" />
        <aside style={{ ...styles.sidebar, width: sidebarWidth }}>
          <div style={styles.sidebarHeader}>
            <span style={styles.sidebarTitle}>
              <Icon name="agent" size={14} style={{ marginRight: 6 }} />
              Agent 对话
            </span>
            <span style={styles.sidebarActions}>
              <button
                type="button"
                className="icon-btn"
                title="复制整段会话为 Markdown"
                onClick={() => {
                  const markdown = messages
                    .filter((m) => m.role === "user" || m.role === "assistant")
                    .map((m) => {
                      const who = m.role === "user" ? (m.steer ? "用户（转向）" : "用户") : "Loopsoar";
                      const thinkText = (m.timeline ?? [])
                        .filter((step): step is Extract<TimelineStep, { kind: "think" }> => step.kind === "think")
                        .map((step) => step.text)
                        .join("\n");
                      const think = thinkText ? `> 思考过程：${thinkText.replace(/\n/g, "\n> ")}\n\n` : "";
                      return `### ${who}\n\n${think}${m.text}`;
                    })
                    .join("\n\n---\n\n");
                  if (!markdown.trim()) {
                    setNotice("会话为空，没有可复制的内容");
                    return;
                  }
                  void navigator.clipboard
                    ?.writeText(markdown)
                    .then(() => setNotice("整段会话已复制为 Markdown"))
                    .catch(() => setNotice("复制失败：剪贴板不可用"));
                }}
              >
                <Icon name="file" size={13} />
              </button>
              <span style={styles.sidebarAgent}>{agentLabel}</span>
            </span>
          </div>
          <div style={styles.sessionBar}>
            <span style={styles.anchor} data-popover-trigger>
              <button
                type="button"
                className="chip"
                style={{ ...styles.chip, maxWidth: 220, ...(compactUi ? styles.chipCompact : {}) }}
                onClick={() => { refreshSessions(); setSessionOpen((v) => !v); }}
                title={`切换会话：${sessions.find((x) => x.id === currentSession)?.title ?? "新会话"}${compactUi ? "（空间不足，已折叠）" : ""}`}
                aria-label="切换会话"
              >
                <Icon name="notes" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
                {compactUi ? null : sessions.find((x) => x.id === currentSession)?.title ?? "新会话"}
              </button>
            </span>
            <button type="button" className="icon-btn" title="新建会话" onClick={newSession}>
              <Icon name="plus" size={13} />
            </button>
            {sessionOpen ? (
              <div data-popover style={styles.sessionMenu}>
                <div style={styles.dropTitle}>会话历史</div>
                {sessions.length === 0 ? <div style={styles.dropEmpty}>还没有会话</div> : null}
                {sessions.map((x) => (
                  <div key={x.id} style={styles.sessionRow}>
                    <button
                      type="button"
                      className="model-item"
                      style={{ ...styles.sessionItem, ...(x.id === currentSession ? styles.dropItemActive : {}) }}
                      onClick={() => switchSession(x.id)}
                      title={x.preview}
                    >
                      <span style={styles.sessionTitle}>{x.title}</span>
                      <span style={styles.sessionMeta}>{new Date(x.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="删除会话"
                      onClick={() =>
                        void api?.chat.deleteSession({ sessionId: x.id }).then((r) => {
                          setSessions(r.sessions);
                          setCurrentSession(r.currentId);
                          if (x.id === currentSession) setMessages([]);
                        })
                      }
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <MessageList
            messages={messages}
            mode={mode}
            providerModel={provider?.model ?? undefined}
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
        </aside>
      </div>

      <footer style={{ ...styles.statusBar, height: LAYOUT.STATUS_BAR_HEIGHT }}>
        <span style={styles.statusItem}>
          <span className="live-dot" style={styles.liveDot} />
          shell: {boot?.status ?? "—"}
        </span>
        <span style={styles.statusItem}>agent: {agentLabel}</span>
        <span style={styles.statusItem}>{providerLabel}</span>
        <span style={{ ...styles.statusItem, ...styles.statusUrl }}>{currentUrl || "about:start"}</span>
      </footer>

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
        />
      ) : null}

      {permReq ? (
        <div style={styles.permOverlay}>
          <div style={styles.permCard}>
            <div style={styles.permTitle}>Agent 请求执行工具</div>
            <div style={styles.permTool}>
              <Icon name="bolt" size={14} style={{ marginRight: 6, color: BRAND.ochreHover }} />
              {permReq.toolName}
              {permReq.target ? <span style={styles.permTarget}> → {permReq.target}</span> : null}
            </div>
            <div style={styles.permHint}>本次操作需要你的确认（权限设置：询问）。</div>
            <div style={styles.permBtns}>
              <button type="button" className="btn-ghost" style={styles.ghostButton} onClick={() => respondPermission("deny")}>
                拒绝
              </button>
              <button type="button" className="btn-ghost" style={styles.ghostButton} onClick={() => respondPermission("allow-session")}>
                本会话允许
              </button>
              <button type="button" className="btn-primary" style={styles.primaryButton} onClick={() => respondPermission("allow-once")}>
                允许一次
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <button type="button" className="toast" style={styles.toast} onClick={() => setNotice("")} title="点击关闭">
          <Icon name="bolt" size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          {notice.slice(0, 260)}
          {notice.length > 260 ? "…" : ""}
        </button>
      ) : null}
    </div>
  );
}

function fmtMs(ms: number): string {
  if (!ms || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/* ---------------------------------- 样式 ---------------------------------- */

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
  // 自定义标题栏
  titleBar: {
    display: "flex",
    alignItems: "center",
    height: LAYOUT.TITLE_BAR_HEIGHT,
    background: BRAND.ink,
    borderBottom: `1px solid ${BRAND.border}`,
    flexShrink: 0,
    userSelect: "none",
  },
  titleDrag: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    height: "100%",
    paddingLeft: 12,
    minWidth: 0,
  },
  titleLogo: { borderRadius: 4, display: "block" },
  titleText: { fontSize: 12, fontWeight: 600, letterSpacing: 0.6, color: BRAND.linenMuted },
  windowControls: { display: "flex", alignItems: "stretch", height: "100%", flexShrink: 0 },
  windowButton: {
    width: 46,
    height: "100%",
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12,
    lineHeight: 1,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
  },
  // 顶部操作栏
  primaryButton: {
    height: 28,
    padding: "0 12px",
    borderRadius: 7,
    border: "none",
    background: BRAND.ochre,
    color: BRAND.ink,
    fontWeight: 700,
    fontSize: 12.5,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  },
  ghostButton: {
    height: 28,
    padding: "0 11px",
    borderRadius: 7,
    border: `1px solid ${BRAND.borderStrong}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12.5,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  },
  tabEmpty: { fontSize: 11, color: BRAND.linenFaint, paddingLeft: 4 },
  body: { display: "flex", flex: 1, minHeight: 0, overflow: "hidden" },
  browserPane: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: `radial-gradient(circle at 28% 18%, rgba(200,118,60,0.10) 0%, ${BRAND.ink} 58%)`,
  },
  startPage: { maxWidth: 520, padding: 28, textAlign: "left" },
  startMark: { marginBottom: 18, opacity: 0.95 },
  startTitle: { fontSize: 32, fontWeight: 800, letterSpacing: 0.4, color: BRAND.linen },
  startSubtitle: { marginTop: 6, fontSize: 13.5, color: BRAND.ochreHover, letterSpacing: 0.2 },
  startHints: { marginTop: 20, display: "grid", gap: 9 },
  hintRow: { display: "flex", alignItems: "flex-start", gap: 8, color: BRAND.linenMuted, fontSize: 12.5, lineHeight: 1.6 },
  hintIcon: { marginTop: 3, color: BRAND.ochre, opacity: 0.9 },
  startUrl: { marginTop: 20, fontSize: 11.5, color: BRAND.linenFaint },
  splitter: {
    width: 6,
    flexShrink: 0,
    cursor: "col-resize",
    background: "transparent",
    borderLeft: `1px solid ${BRAND.border}`,
    transition: "background 120ms",
  },
  anchor: { position: "relative", display: "inline-flex" },
  /** 会话栏 chip（输入区 chip 已迁到 Composer；这里保留会话切换所需的最小定义）。 */
  chip: {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 8px",
    borderRadius: 12,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  chipCompact: { width: 24, padding: 0, justifyContent: "center" },
  dropPanel: {
    position: "absolute",
    top: 84,
    left: 12,
    width: 420,
    maxHeight: 360,
    overflowY: "auto",
    borderRadius: 10,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
    padding: 8,
    zIndex: 40,
  },
  dropTitle: { fontSize: 10.5, color: BRAND.linenFaint, padding: "2px 6px 6px" },
  dropEmpty: { fontSize: 11.5, color: BRAND.linenFaint, padding: "8px 6px" },
  dropItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "6px 8px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  dropItemActive: { background: BRAND.ochreSoft, color: BRAND.ochreHover },
  dlRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "6px 8px",
    borderBottom: `1px solid ${BRAND.border}`,
  },
  dlMeta: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  dlName: { fontSize: 11.5, color: BRAND.linen, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 },
  dlState: { fontSize: 10.5, color: BRAND.linenFaint },
  dlActions: { display: "inline-flex", gap: 2, flexShrink: 0 },
  sessionBar: { position: "relative", display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderBottom: `1px solid ${BRAND.border}` },
  sessionMenu: {
    position: "absolute",
    top: "100%",
    left: 10,
    width: 300,
    maxHeight: 320,
    overflowY: "auto",
    borderRadius: 10,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
    padding: 6,
    zIndex: 30,
  },
  sessionRow: { display: "flex", alignItems: "center", gap: 2 },
  sessionItem: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "6px 8px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    textAlign: "left",
    minWidth: 0,
  },
  sessionTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  sessionMeta: { fontSize: 10, color: BRAND.linenFaint, flexShrink: 0 },
  modelMenu: {
    position: "absolute",
    right: 8,
    bottom: "100%",
    marginBottom: 8,
    width: 280,
    maxHeight: 320,
    overflowY: "auto",
    borderRadius: 10,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
    padding: 6,
    zIndex: 20,
  },
  sidebar: {
    display: "flex",
    flexDirection: "column",
    minWidth: 280,
    flexShrink: 0,
    borderLeft: `1px solid ${BRAND.border}`,
    background: BRAND.inkPanel,
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "11px 14px",
    fontWeight: 600,
    fontSize: 13,
    borderBottom: `1px solid ${BRAND.border}`,
    color: BRAND.linen,
  },
  sidebarTitle: { display: "inline-flex", alignItems: "center" },
  sidebarAgent: { fontSize: 11, color: BRAND.linenFaint, fontWeight: 400 },
  sidebarActions: { display: "inline-flex", alignItems: "center", gap: 6 },
  scrollRail: {
    position: "absolute",
    right: 8,
    bottom: 14,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    padding: "3px 2px",
    borderRadius: 999,
    background: "rgba(17,19,24,0.82)",
    border: `1px solid ${BRAND.border}`,
    boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
    backdropFilter: "blur(6px)",
  },
  scrollBtn: {
    width: 24,
    height: 24,
    padding: 0,
    border: "none",
    borderRadius: 999,
    background: "transparent",
    color: BRAND.linenMuted,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 120ms, color 120ms, opacity 160ms",
  },
  scrollRailLine: { width: 14, height: 1, background: BRAND.border },
  announces: { display: "flex", flexDirection: "column", gap: 2, margin: "2px 0 4px" },
  announceRow: { display: "flex", alignItems: "baseline", gap: 6, fontSize: 11, color: BRAND.linenFaint, minWidth: 0 },
  announceMark: { width: 10, flex: "none", textAlign: "center", fontSize: 9.5 },
  announceText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
  thinkToggleLabel: { whiteSpace: "nowrap", flex: "none" },
  timeline: {
    position: "relative",
    borderLeft: `2px solid ${BRAND.border}`,
    paddingLeft: 14,
    marginLeft: 2,
    marginBottom: 10,
  },
  toolStepText: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: BRAND.linenMuted },
  msgRow: { display: "flex", width: "100%" },
  bubble: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    maxWidth: "92%",
    padding: "8px 10px",
    borderRadius: 10,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkRaised,
  },
  bubbleUser: { background: BRAND.ochreSoft, borderColor: "rgba(200,118,60,0.35)" },
  bubbleAssistant: { background: BRAND.inkRaised },
  bubbleError: { borderColor: "rgba(248,113,113,0.45)" },
  bubbleHead: { display: "flex", alignItems: "center", gap: 6 },
  bubbleTime: { fontSize: 9.5, color: BRAND.linenFaint },
  copyBtn: { width: 20, height: 20, opacity: 0.7 },
  reasoningBlock: { borderLeft: `2px solid #5b5470`, paddingLeft: 8 },
  reasoningToggle: {
    border: "none",
    background: "transparent",
    color: "#9a8fb8",
    fontSize: 10.5,
    cursor: "pointer",
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
  },
  reasoningText: { marginTop: 4, fontSize: 11, color: BRAND.linenMuted, whiteSpace: "pre-wrap", lineHeight: 1.6 },
  toolList: { display: "flex", flexDirection: "column", gap: 3 },
  toolRow: {
    display: "flex",
    alignItems: "center",
    fontSize: 10.5,
    color: BRAND.linenMuted,
    background: BRAND.ink,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 6,
    padding: "3px 6px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  bubbleText: { fontSize: 12.5, lineHeight: 1.75, color: BRAND.linen, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  bubbleFoot: { fontSize: 9.5, color: BRAND.linenFaint, marginTop: 2 },
  message: { display: "flex", flexDirection: "column", gap: 4 },
  roleTag: { fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6 },
  messageText: {
    fontSize: 12.5,
    lineHeight: 1.7,
    color: BRAND.linen,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  permOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(8,9,12,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 60,
  },
  permCard: {
    width: 420,
    borderRadius: 12,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    padding: 16,
    boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
  },
  permTitle: { fontSize: 13, fontWeight: 700, marginBottom: 10 },
  permTool: { display: "flex", alignItems: "center", fontSize: 13, color: BRAND.linen },
  permTarget: { color: BRAND.linenMuted, fontSize: 11.5, marginLeft: 4, wordBreak: "break-all" },
  permHint: { marginTop: 8, fontSize: 11, color: BRAND.linenFaint, lineHeight: 1.6 },
  permBtns: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 },
  composerRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 },
  statusBar: {
    display: "flex",
    alignItems: "center",
    gap: 18,
    padding: "0 12px",
    background: BRAND.ink,
    borderTop: `1px solid ${BRAND.border}`,
    fontSize: 11,
    color: BRAND.linenFaint,
    flexShrink: 0,
  },
  statusItem: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  liveDot: { marginRight: 6, verticalAlign: "1px" },
  statusUrl: { marginLeft: "auto", fontFamily: "ui-monospace, Consolas, monospace", color: BRAND.linenFaint },
  toast: {
    position: "absolute",
    left: "50%",
    bottom: 46,
    transform: "translateX(-50%)",
    display: "inline-flex",
    alignItems: "center",
    maxWidth: "70%",
    padding: "7px 14px",
    borderRadius: 8,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    color: BRAND.linen,
    fontSize: 12,
    cursor: "pointer",
    boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};
