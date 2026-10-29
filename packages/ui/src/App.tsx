import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { normalizeNavigateUrl } from "loopsoar-contracts/navigation";
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

/**
 * Loopsoar 主界面（GUI-3）：品牌三色 + 自定义标题栏 + 图标系统 + 交互反馈/动画。
 * 品牌色（来自官方图标）：深墨 #111318 / 亚麻白 #F4EFE6 / 赭石 #C8763C。
 * 交互范式借鉴 slime 已打磨的实践：
 *   · 按钮 hover 上浮 1px + 软阴影、active 按下 scale(.97/.88) 回弹；
 *   · 流式吐字「逐单元渐入」：新字符由右到左滑入 + 由浅到深（260ms cubic-bezier(.22,.61,.36,1)）；
 *   · 流式光标闪烁、加载 spinner、状态点脉冲、消息行淡入；
 *   · prefers-reduced-motion 下只保留不透明度渐入（去掉位移，避免"什么都看不到"）。
 */

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "reasoning" | "tool" | "system";
  text: string;
  /** 流式尾巴：最近一次增量，用于逐单元渐入动画。 */
  tail?: string;
  /** 尾巴序号：变化即重新触发动画（React key）。 */
  tailSeq?: number;
  status?: "streaming" | "done" | "error";
  /** 推理内容（可折叠） */
  reasoning?: string;
  /** 工具调用轨迹 */
  tools?: { id: string; label: string; state: "running" | "done" | "error" }[];
  /** 耗时统计：首字 / 总耗时（毫秒） */
  timing?: { firstTokenMs?: number; totalMs?: number; rounds?: number; toolCalls?: number; tokens?: number };
  /** 创建时间戳（显示 HH:mm） */
  createdAt?: number;
  /** 错误说明 */
  errorText?: string;
}


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
  const [permMenuOpen, setPermMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [modelList, setModelList] = useState<{ models: ProviderModel[]; error: string | null } | null>(null);
  const sessionIdRef = useRef<string>(nextId("sess"));
  const omniboxRef = useRef<HTMLInputElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const sendStartedAtRef = useRef<number>(0);
  const firstTokenAtRef = useRef<number>(0);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
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
        if (prefs.sidebarWidth) {
          setSidebarWidth(prefs.sidebarWidth);
          void api.browser.setSidebarWidth({ width: prefs.sidebarWidth }).catch(() => {});
        }
        // 恢复上次会话（设置 · 通用 · 恢复上次会话）
        if (prefs.restoreSession) {
          const history = await api.chat.history().catch(() => null);
          if (history?.session?.messages?.length) {
            sessionIdRef.current = history.session.sessionId;
            setMessages(
              history.session.messages.map((m) => ({
                id: nextId(m.role),
                role: m.role === "user" ? ("user" as const) : ("assistant" as const),
                text: m.text,
                status: "done" as const,
              })),
            );
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
      if (tabsResult) setTabs(tabsResult.tabs);
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
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) {
          return [
            ...prev,
            { id, role: "assistant" as const, text: delta, tail: delta, tailSeq, status: "streaming" as const, createdAt: Date.now() },
          ];
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          text: next[idx].text + delta,
          tail: delta,
          tailSeq,
          status: "streaming",
        };
        return next;
      });
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
        if (typeof p.content === "string" && p.content.length > 0) {
          if (firstTokenAtRef.current === 0) firstTokenAtRef.current = Date.now();
          setMessages((prev) => {
            const at = activeAssistantRef.current;
            return prev.map((m) => (m.id === at ? { ...m, reasoning: (m.reasoning ?? "") + p.content } : m));
          });
        }
      }),
      api.on("chat:stream:tool", (payload) => {
        const content = String((payload as { content?: string }).content ?? "").slice(0, 400);
        let label = content;
        try {
          const parsed = JSON.parse(content) as { name?: string; tool?: string; args?: unknown };
          label = `${parsed.name ?? parsed.tool ?? "工具"}${parsed.args ? ` ${JSON.stringify(parsed.args).slice(0, 120)}` : ""}`;
        } catch {
          // 保持原文
        }
        setMessages((prev) => {
          const at = activeAssistantRef.current;
          if (!at) return prev;
          return prev.map((m) => {
            if (m.id !== at) return m;
            return { ...m, tools: [...(m.tools ?? []), { id: nextId("tool"), label, state: "running" }] };
          });
        });
      }),
      api.on("chat:stream:progress", (payload) => {
        pushTransient("system", String((payload as { content?: string }).content ?? ""));
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
        if (Array.isArray(p.tabs)) setTabs(p.tabs);
      }),
      api.on("memory:updated", () => {
        /* 记忆条目在设置面板中查看；主界面保持安静 */
      }),
      api.on("chat:stream:done", (payload) => {
        const p = payload as { content?: string };
        const start = sendStartedAtRef.current;
        const first = firstTokenAtRef.current;
        let usage: { rounds?: number; toolCalls?: number; totalTokens?: number } = {};
        let statusText = "完成";
        try {
          const parsed = JSON.parse(p.content ?? "{}") as {
            status?: string;
            usage?: { rounds?: number; toolCalls?: number; totalTokens?: number };
          };
          usage = parsed.usage ?? {};
          statusText = parsed.status === "done" ? "完成" : `完成（${parsed.status ?? "done"}）`;
        } catch {
          // 保持默认
        }
        setMessages((prev) =>
          prev.map((m) => {
            if (m.status !== "streaming") return m;
            return {
              ...m,
              status: "done",
              tail: undefined,
              tools: (m.tools ?? []).map((t) => ({ ...t, state: t.state === "running" ? "done" : t.state })),
              timing: {
                firstTokenMs: first && start ? first - start : undefined,
                totalMs: start ? Date.now() - start : undefined,
                ...usage,
              },
            };
          }),
        );
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
  }, [provider, permSummary, mode, reasoningEffort, sidebarWidth, modelList]);

  // 新消息/流式增量时自动滚到底部
  useEffect(() => {
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

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
    setModelMenuOpen((v) => !v);
    // 先用已保存的模型清单秒开（离线可用），再异步拉取最新列表
    // 只展示在供应商设置里「启用」的模型；默认模型始终保留
    const cached = (provider.models ?? []).filter((m) => m.selected !== false || m.id === provider.model);
    setModelList({ models: cached.length > 0 ? cached : [{ id: provider.model ?? "" }], error: null });
    void api.settings
      .listModels({ provider: provider.provider ?? "", baseUrl: provider.baseUrl ?? "", model: provider.model ?? "" })
      .then((r) => {
        if (r.models.length > 0 || r.error) {
          const enabled = new Map(cached.map((m) => [m.id, m]));
          const fetched = r.models
            .filter((m) => enabled.size === 0 || enabled.has(m.id) || m.id === provider.model)
            .map((m) => ({ ...m, selected: enabled.get(m.id)?.selected ?? m.selected }));
          setModelList({ models: fetched.length > 0 ? fetched : cached, error: r.error });
        }
      })
      .catch(() => {});
  }, [api, provider, openSettings]);

  // 当前模型声明的推理等级；为空则不显示「推理」chip
  const effortOptions = useMemo(() => {
    const spec = provider?.models?.find((m) => m.id === provider.model);
    return spec?.thinkingEfforts ?? [];
  }, [provider]);

  const effortLabel = useCallback((value: string): string => {
    if (!value) return "推理：关";
    const map: Record<string, string> = { minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "最高" };
    return `推理：${map[value] ?? value}`;
  }, []);

  const chooseModel = useCallback(
    (model: string): void => {
      setModelMenuOpen(false);
      if (!api || !provider) return;
      void api.settings
        .setProvider({ provider: provider.provider ?? "", baseUrl: provider.baseUrl ?? "", model })
        .then(() => {
          setProvider({ ...provider, model, configured: true });
          setNotice(`已切换模型：${model}`);
        })
        .catch(() => {});
    },
    [api, provider],
  );

  const respondPermission = useCallback((choice: "allow-once" | "allow-session" | "deny"): void => {
    if (!api || !permReq) return;
    void api.perm.respond({ requestId: permReq.requestId, choice });
    setPermReq(null);
  }, [api, permReq]);

  const send = useCallback((): void => {
    const text = input.trim();
    if (!text || !api) return;
    setInput("");
    setBusy(true);
    setNotice("");
    setMessages((prev) => [...prev, { id: nextId("u"), role: "user", text, status: "done", createdAt: Date.now() }]);
    activeAssistantRef.current = null;
    sendStartedAtRef.current = Date.now();
    firstTokenAtRef.current = 0;
    void api.chat.stream({ message: text, sessionId: sessionIdRef.current, mode, reasoningEffort: reasoningEffort || undefined }).catch((err: unknown) => {
      setBusy(false);
      setNotice(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    });
  }, [api, input]);

  const stop = useCallback((): void => {
    if (!api) return;
    void api.chat.stop({ sessionId: sessionIdRef.current });
  }, [api]);

  const navigate = useCallback(
    (raw?: string): void => {
      if (!api) return;
      const normalized = normalizeNavigateUrl(raw ?? address);
      if (!normalized.ok) {
        setNotice(`导航被拒绝：${normalized.reason}`);
        return;
      }
      setNotice("导航中…");
      void api.browser.navigate({ url: normalized.url }).then((result) => {
        if (result.ok) {
          setCurrentUrl(result.url ?? normalized.url);
          setAddress(result.url ?? normalized.url);
          setNotice("导航完成");
          void api.browser.listTabs().then((r) => setTabs(r.tabs)).catch(() => {});
        } else {
          setNotice(`导航失败：${result.error ?? "未知"}`);
        }
      });
    },
    [address, api],
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
      setPermMenuOpen(false);
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
      setPermMenuOpen(false);
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
      setMessages(
        msgs.map((m) => ({
          id: nextId(m.role),
          role: m.role === "user" ? ("user" as const) : ("assistant" as const),
          text: m.text,
          status: "done" as const,
        })),
      );
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
    const message = "你好，请简单介绍一下你自己";
    const timer = setTimeout(() => {
      setBusy(true);
      setMessages((prev) => [...prev, { id: nextId("u"), role: "user", text: message, status: "done" }]);
      void api.chat
        .stream({ message, sessionId: sessionIdRef.current, mode: "build" })
        .catch(() => setBusy(false));
    }, 900);
    return () => clearTimeout(timer);
  }, [api]);

  // E2E：?e2e=model-menu / perm-menu 自动展开输入区弹层（验证锚定与不被裁切）
  useEffect(() => {
    if (!api || typeof location === "undefined") return;
    const mode = new URLSearchParams(location.search).get("e2e");
    if (mode !== "model-menu" && mode !== "perm-menu") return;
    const timer = setTimeout(() => {
      if (mode === "model-menu") openModelMenu();
      else void api.settings.getPermissions().then((r) => { setPermSummary(r); setPermMenuOpen(true); }).catch(() => {});
    }, 900);
    return () => clearTimeout(timer);
  }, [api, openModelMenu]);

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
  const canSend = Boolean(api) && !busy && input.trim() !== "";

  // 历史 / 下载面板（以点击的按钮为基点展开）
  const renderHistoryPanel = (): React.JSX.Element => (
    <div className="pop-in" style={styles.popover}>
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
    <div className="pop-in" style={{ ...styles.popover, right: 0, left: "auto", width: 400 }}>
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

      <header style={{ ...styles.topBar, height: LAYOUT.TOP_BAR_HEIGHT }}>
        <div style={styles.navGroup}>
          <button
            type="button"
            className="icon-btn"
            title="后退"
            disabled={!tabs.find((x) => x.active)?.canBack}
            onClick={goBack}
          >
            <Icon name="back" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="前进"
            disabled={!tabs.find((x) => x.active)?.canForward}
            onClick={goForward}
          >
            <Icon name="forward" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="刷新"
            disabled={!currentUrl}
            onClick={() => navigate(currentUrl)}
          >
            <Icon name="reload" size={16} />
          </button>
          <span style={styles.anchor}>
            <button type="button" className="icon-btn" title="历史记录" onClick={toggleHistory}>
              <Icon name="history" size={16} />
            </button>
            {historyOpen ? renderHistoryPanel() : null}
          </span>
        </div>

        <div style={styles.omniboxWrap}>
          <Icon name="search" size={14} style={styles.omniboxIcon} />
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate();
            }}
            ref={omniboxRef}
            placeholder="输入地址或搜索内容，回车导航…"
            style={styles.omnibox}
            aria-label="地址与搜索"
          />
          <button type="button" className="icon-btn" title="收藏（待接）" disabled style={styles.omniboxStar}>
            <Icon name="star" size={15} />
          </button>
        </div>

        <div style={styles.topActions}>
          <span style={styles.anchor}>
            <button type="button" className="icon-btn" title="下载" onClick={toggleDownloads} style={{ position: "relative" }}>
              <Icon name="download" size={17} />
              {downloads.some((d) => d.state === "progressing") ? <span style={styles.dlDot} /> : null}
            </button>
            {downloadsOpen ? renderDownloadsPanel() : null}
          </span>
          <button type="button" className="icon-btn" title={currentUrl ? "页面快照" : "先打开一个网页"} onClick={snapshot} disabled={!api || !currentUrl}>
            <Icon name="capture" size={17} />
          </button>
          <button type="button" className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" size={17} />
          </button>
          <button type="button" className="icon-btn" title="更多（待接）" disabled>
            <Icon name="more" size={17} />
          </button>
        </div>
      </header>


      <div style={{ ...styles.tabBar, height: LAYOUT.TAB_BAR_HEIGHT }}>
        {tabs.length > 0
          ? tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-item${tab.active ? " is-active" : ""}`}
              style={{ ...styles.tab, ...(tab.active ? styles.tabActive : {}) }}
              onClick={() => selectTab(tab.id)}
              title={tab.url || tab.title}
            >
              <span style={styles.tabTitle}>{tab.title || "新建标签页"}</span>
              <button
                type="button"
                className="icon-btn tab-close"
                title="关闭标签"
                style={styles.tabClose}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <Icon name="close" size={10} />
              </button>
            </div>
            ))
          : null}
        <button type="button" className="icon-btn" title="新建标签页" style={styles.tabAdd} onClick={newTab}>
          <Icon name="plus" size={13} />
        </button>
      </div>

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
            <span style={styles.sidebarAgent}>{agentLabel}</span>
          </div>
          <div style={styles.sessionBar}>
            <span style={styles.anchor}>
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
              <div style={styles.sessionMenu}>
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
          <div ref={messageListRef} style={styles.messageList}>
            {messages.length === 0 ? (
              <div style={styles.emptyHint}>和 Loopsoar 说点什么，例如「帮我总结当前网页」。</div>
            ) : (
              messages.map((m) => {
                const mine = m.role === "user";
                const hasTimeline = Boolean(m.reasoning) || (m.tools?.length ?? 0) > 0;
                const showThinking = m.status === "streaming" && !m.text && !hasTimeline;
                const timeText = new Date(m.createdAt ?? Date.now()).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                });
                if (mine) {
                  return (
                    <div key={m.id} className="msg-row" style={styles.msgRowUser}>
                      <div className="msg-user-bubble" style={styles.userBubble}>
                        {m.text}
                      </div>
                      <div className="msg-hover" style={styles.msgHover}>
                        <span style={styles.msgHoverTag}>{mode === "build" ? "Build" : "Plan"}</span>
                        <span>· {timeText}</span>
                        <button
                          type="button"
                          className="msg-action"
                          title="复制消息"
                          onClick={() => void navigator.clipboard?.writeText(m.text).catch(() => {})}
                        >
                          <Icon name="file" size={12} />
                        </button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={m.id} className="msg-row" style={styles.msgRowAssistant}>
                    {hasTimeline ? (
                      <div className="think-timeline is-live" style={styles.timeline}>
                        {m.reasoning ? (
                          <div className="think-step">
                            <span className="think-step-mark" />
                            <button
                              type="button"
                              className="think-step-toggle"
                              onClick={() => setExpandedReasoning((prev) => ({ ...prev, [m.id]: !prev[m.id] }))}
                              title={expandedReasoning[m.id] ? "收起思考过程" : "展开思考过程"}
                            >
                              {expandedReasoning[m.id] ? "收起思考过程" : "思考过程"}
                              {expandedReasoning[m.id] ? null : (
                                <span className="think-step-preview">
                                  {m.reasoning.replace(/\s+/g, " ").slice(0, 90)}
                                </span>
                              )}
                            </button>
                            {expandedReasoning[m.id] ? (
                              <div className="think-step-text">{m.reasoning}</div>
                            ) : null}
                          </div>
                        ) : null}
                        {(m.tools ?? []).map((t) => (
                          <div key={t.id} className="think-step">
                            <span className="think-step-mark" data-state={t.state} />
                            <span className="think-step-text" style={styles.toolStepText}>
                              {t.label}
                              <span className="think-step-state">
                                {t.state === "running" ? "进行中" : t.state === "error" ? "失败" : "完成"}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {showThinking ? (
                      <div style={styles.thinkingRow}>
                        <span className="text-scan-light">正在思考</span>
                        <span className="stream-dot-row">
                          <span className="stream-dot" />
                          <span className="stream-dot" style={{ animationDelay: "0.2s" }} />
                          <span className="stream-dot" style={{ animationDelay: "0.4s" }} />
                        </span>
                      </div>
                    ) : null}
                    <div className="msg-body-text" style={styles.assistantBody}>
                      {m.tail && m.status === "streaming"
                        ? renderRich(m.text.slice(0, m.text.length - m.tail.length))
                        : renderRich(m.text)}
                      {m.tail && m.status === "streaming" ? (
                        <span key={m.tailSeq} className="stream-tail">
                          {m.tail}
                        </span>
                      ) : null}
                      {m.status === "streaming" && m.text ? <span className="stream-caret" /> : null}
                    </div>
                    {m.errorText ? <div style={styles.errBox}>{m.errorText}</div> : null}
                    <div className="msg-hover" style={styles.msgHover}>
                      <span style={styles.msgHoverTag}>Loopsoar</span>
                      {provider?.model ? <span>· {provider.model}</span> : null}
                      <span>· {timeText}</span>
                      {m.text ? (
                        <button
                          type="button"
                          className="msg-action"
                          title="复制回复"
                          onClick={() => void navigator.clipboard?.writeText(m.text).catch(() => {})}
                        >
                          <Icon name="file" size={12} />
                        </button>
                      ) : null}
                      {m.timing ? (
                        <span style={styles.msgTiming}>
                          首字 {fmtMs(m.timing.firstTokenMs ?? 0)} · 总耗时 {fmtMs(m.timing.totalMs ?? 0)}
                          {m.timing.tokens ? ` · ${m.timing.tokens} tokens` : ""}
                          {m.timing.toolCalls ? ` · ${m.timing.toolCalls} 次工具` : ""}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div style={styles.composer}>
            <div ref={composerBoxRef} style={styles.composerBox} data-squeeze={squeezeRatio.toFixed(2)}>
              {/* 隐藏测量行：始终保持完整文案，用于计算自然宽度 */}
              <div ref={measureRowRef} aria-hidden style={styles.measureRow}>
                <span style={styles.measureChip}>
                  <Icon name="bolt" size={12} style={{ marginRight: 4 }} />Build
                </span>
                <span style={styles.measureChip}>
                  <Icon name="check" size={12} style={{ marginRight: 4 }} />
                  {permSummary ? permissionLabel(permSummary) : "权限"}
                </span>
                <span style={styles.measureChip}>
                  <Icon name="cloud-upload" size={12} style={{ marginRight: 4 }} />
                  {provider?.configured ? provider.model : "未配置模型"}
                </span>
                <span style={styles.measureChip}>停止</span>
                <span style={styles.measureChip}>发送</span>
              </div>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="输入消息（Enter 发送，Shift+Enter 换行）"
                style={styles.textarea}
                rows={3}
              />
              <div style={styles.chipRow}>
                <button
                  type="button"
                  className="chip"
                  style={{
                    ...styles.chip,
                    ...(compactUi ? styles.chipCompact : {}),
                    ...(mode === "build" ? styles.chipActive : {}),
                  }}
                  title={`模式：${mode === "build" ? "Build 可执行工具" : "Plan 只读规划"}${compactUi ? "（空间不足，已折叠）" : ""}`}
                  aria-label={mode === "build" ? "Build 模式" : "Plan 模式"}
                  onClick={() => setMode(mode === "build" ? "plan" : "build")}
                >
                  <Icon name="bolt" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
                  {compactUi ? null : mode === "build" ? "Build" : "Plan"}
                </button>
                <span style={styles.anchor}>
                  <button
                    type="button"
                    className="chip"
                    style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}) }}
                    title={`当前会话权限${compactUi ? "（空间不足，已折叠）" : ""}`}
                    aria-label="当前会话权限"
                    onClick={() => {
                      if (!permSummary) {
                        void api?.settings.getPermissions().then((r) => { setPermSummary(r); setPermMenuOpen(true); }).catch(() => {});
                        return;
                      }
                      setPermMenuOpen((v) => !v);
                    }}
                  >
                    <Icon name="check" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
                    {compactUi ? null : permSummary ? permissionLabel(permSummary) : "权限"}
                  </button>
                  {permMenuOpen && permSummary ? (
                    <div className="pop-in" style={{ ...styles.popover, ...styles.chipPopover }}>
                      <div style={styles.modelMenuHead}>本会话工具权限</div>
                      {[
                        { key: "read", label: "读取文件" },
                        { key: "write", label: "写入文件" },
                        { key: "terminal", label: "执行命令" },
                        { key: "network", label: "网络访问" },
                      ].map((cat) => (
                        <div key={cat.key} style={styles.permRow}>
                          <span style={styles.permCat}>{cat.label}</span>
                          <span style={styles.permSeg}>
                            {(["allow", "confirm", "deny"] as const).map((v) => (
                              <button
                                key={v}
                                type="button"
                                className="perm-seg"
                                style={{
                                  ...styles.permSegBtn,
                                  ...(permSummary.permissions[cat.key as "read"] === v ? styles.permSegBtnOn : {}),
                                }}
                                onClick={() => {
                                  const next = {
                                    ...permSummary,
                                    permissions: { ...permSummary.permissions, [cat.key]: v },
                                  };
                                  setPermSummary(next);
                                  void api?.settings.setPermissions(next.permissions).catch(() => {});
                                }}
                              >
                                {v === "allow" ? "允许" : v === "confirm" ? "询问" : "拒绝"}
                              </button>
                            ))}
                          </span>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="model-item"
                        style={styles.modelMenuFoot}
                        onClick={() => {
                          setPermMenuOpen(false);
                          openSettings("permissions");
                        }}
                      >
                        打开完整权限设置…
                      </button>
                    </div>
                  ) : null}
                </span>
                <span style={styles.anchor}>
                  <button
                    type="button"
                    className="chip"
                    style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}) }}
                    title={`选择模型：${provider?.configured ? provider.model : "未配置"}${compactUi ? "（空间不足，已折叠）" : ""}`}
                    aria-label="选择模型"
                    onClick={openModelMenu}
                  >
                    <Icon name="cloud-upload" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
                    {compactUi ? null : provider?.configured ? provider.model : "未配置模型"}
                  </button>
                  {modelMenuOpen ? (
                    <div className="pop-in" style={{ ...styles.popover, ...styles.chipPopover, width: 300 }}>
                      <div style={styles.modelMenuHead}>{provider?.provider ?? "未配置"} · 选择模型</div>
                      {modelList === null ? (
                        <div style={styles.modelMenuItem}>加载中…</div>
                      ) : (
                        <>
                          {modelList.models.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              className="model-item"
                              style={{ ...styles.modelMenuItem, ...(m.id === provider?.model ? styles.modelMenuItemActive : {}) }}
                              onClick={() => chooseModel(m.id)}
                              title={`${m.id}${m.contextWindow ? ` · 上下文 ${Math.round(m.contextWindow / 1000)}K` : ""}${m.thinkingEfforts?.length ? ` · 推理 ${m.thinkingEfforts.join("/")}` : ""}`}
                            >
                              <span style={styles.modelItemName}>
                                {m.id}
                                {m.thinking ? <span style={styles.modelBadge}>推理</span> : null}
                                {m.vision ? <span style={styles.modelBadge}>视觉</span> : null}
                              </span>
                              {m.id === provider?.model ? <Icon name="check" size={12} /> : null}
                            </button>
                          ))}
                          {modelList.error ? <div style={styles.modelMenuErr}>{modelList.error}（可回退到默认模型）</div> : null}
                        </>
                      )}
                      {effortOptions.length > 0 ? (
                        <div style={styles.effortSection}>
                          <div style={styles.modelMenuHead}>推理等级</div>
                          <div style={styles.effortRow}>
                            {["", ...effortOptions].map((value) => (
                              <button
                                key={value || "off"}
                                type="button"
                                className="chip"
                                style={{ ...styles.chip, ...(reasoningEffort === value ? styles.chipActive : {}) }}
                                onClick={() => setReasoningEffort(value)}
                                title={value || "关闭推理"}
                              >
                                {effortLabel(value).replace("推理：", "")}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        className="model-item"
                        style={styles.modelMenuFoot}
                        onClick={() => {
                          setModelMenuOpen(false);
                          openSettings("providers");
                        }}
                      >
                        管理供应商 / 添加模型…
                      </button>
                    </div>
                  ) : null}
                </span>
                <span style={styles.spacer} />
                {busy ? (
                  <>
                    <Icon name="spinner" size={14} className="spinner" style={styles.spinnerInline} />
                    <button
                      type="button"
                      className="chip"
                      style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}) }}
                      onClick={stop}
                      title={`停止生成${compactUi ? "（空间不足，已折叠）" : ""}`}
                      aria-label="停止生成"
                    >
                      <Icon name="stop" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
                      {compactUi ? null : "停止"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="send-btn"
                    style={{ ...styles.sendBtn, opacity: canSend ? 1 : 0.45 }}
                    onClick={send}
                    disabled={!canSend}
                    title="发送（Enter）"
                  >
                    <Icon name="send" size={15} />
                  </button>
                )}
              </div>
            </div>
            <div style={styles.composerFoot}>
              <span style={styles.notice}>
                {notice ||
                  (busy
                    ? "生成中…"
                    : mode === "plan"
                      ? "Plan 模式：只读规划，不执行写操作"
                      : "Build 模式：可在权限范围内执行工具")}
              </span>
            </div>
          </div>
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

/** 轻量富文本：代码块 + 行内代码 + 粗体（不引入第三方依赖）。 */
function renderRich(text: string): React.ReactNode {
  if (!text) return null;
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return blocks.map((block, bi) => {
    if (block.startsWith("```")) {
      const body = block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
      return (
        <pre key={`code-${bi}`} style={styles.codeBlock}>
          <code>{body}</code>
        </pre>
      );
    }
    const parts = block.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return (
      <span key={`text-${bi}`}>
        {parts.map((part, pi) => {
          if (part.startsWith("`") && part.endsWith("`")) {
            return <code key={pi} style={styles.inlineCode}>{part.slice(1, -1)}</code>;
          }
          if (part.startsWith("**") && part.endsWith("**")) {
            return <strong key={pi}>{part.slice(2, -2)}</strong>;
          }
          return <React.Fragment key={pi}>{part}</React.Fragment>;
        })}
      </span>
    );
  });
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
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 10px",
    background: BRAND.inkRaised,
    borderBottom: `1px solid ${BRAND.border}`,
    flexShrink: 0,
  },
  navGroup: { display: "flex", gap: 2, flexShrink: 0 },
  omniboxWrap: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 8,
    height: 30,
    padding: "0 6px 0 12px",
    borderRadius: 15,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    minWidth: 0,
  },
  omniboxIcon: { color: BRAND.linenFaint, flex: "none" },
  omnibox: {
    flex: 1,
    height: "100%",
    border: "none",
    outline: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 13,
    minWidth: 0,
  },
  omniboxStar: { width: 24, height: 24, flex: "none" },
  topActions: { display: "flex", gap: 2, flexShrink: 0 },
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
  tabBar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 8px",
    background: BRAND.inkRaised,
    borderBottom: `1px solid ${BRAND.border}`,
    flexShrink: 0,
    overflowX: "auto",
    overflowY: "hidden",
  },
  tabEmpty: { fontSize: 11, color: BRAND.linenFaint, paddingLeft: 4 },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    maxWidth: 220,
    height: 26,
    padding: "0 6px 0 10px",
    borderRadius: 7,
    border: `1px solid transparent`,
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    flex: "0 1 auto",
    minWidth: 0,
    transition: "background 120ms, color 120ms, border-color 120ms",
  },
  tabActive: {
    background: BRAND.inkPanel,
    borderColor: BRAND.borderStrong,
    color: BRAND.linen,
  },
  tabTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tabClose: { width: 18, height: 18 },
  tabAdd: { width: 24, height: 24, flex: "none" },
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
  permRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "5px 8px",
  },
  permCat: { fontSize: 11.5, color: BRAND.linenMuted },
  permSeg: { display: "inline-flex", border: `1px solid ${BRAND.border}`, borderRadius: 6, overflow: "hidden" },
  permSegBtn: {
    padding: "2px 7px",
    border: "none",
    background: "transparent",
    color: BRAND.linenFaint,
    fontSize: 10.5,
    cursor: "pointer",
  },
  permSegBtnOn: { background: BRAND.ochre, color: BRAND.ink, fontWeight: 700 },
  dlDot: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 6,
    height: 6,
    borderRadius: 999,
    background: BRAND.ochre,
  },
  anchor: { position: "relative", display: "inline-flex" },
  popover: {
    position: "absolute",
    top: "100%",
    left: 0,
    marginTop: 6,
    width: 360,
    maxHeight: 360,
    overflowY: "auto",
    borderRadius: 10,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
    padding: 8,
    zIndex: 45,
  },
  chipPopover: {
    top: "auto",
    bottom: "100%",
    left: "auto",
    right: 0,
    marginTop: 0,
    marginBottom: 6,
    width: 300,
    maxWidth: "calc(100vw - 24px)",
    maxHeight: 320,
    overflowY: "auto",
  },
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
  modelMenuHead: { fontSize: 10.5, color: BRAND.linenFaint, padding: "4px 8px 6px" },
  modelMenuItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    padding: "7px 8px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 12,
    cursor: "pointer",
    textAlign: "left",
  },
  modelMenuItemActive: { background: BRAND.ochreSoft, color: BRAND.ochreHover },
  modelItemName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 8 },
  modelMenuErr: { fontSize: 10.5, color: BRAND.danger, padding: "4px 8px" },
  modelMenuFoot: {
    marginTop: 4,
    borderTop: `1px solid ${BRAND.border}`,
    borderRadius: 0,
    padding: "8px 8px 4px",
    fontSize: 11.5,
    color: BRAND.linenMuted,
    background: "transparent",
    border: "none",
    width: "100%",
    textAlign: "left",
    cursor: "pointer",
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
  messageList: { flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 },
  emptyHint: { color: BRAND.linenFaint, fontSize: 12.5, lineHeight: 1.8 },
  msgRowUser: { display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: 14 },
  msgRowAssistant: { display: "flex", flexDirection: "column", alignItems: "stretch", marginBottom: 16 },
  userBubble: {
    maxWidth: "78%",
    padding: "10px 14px",
    borderRadius: "16px 16px 4px 16px",
    background: BRAND.ochre,
    color: "#ffffff",
    lineHeight: 1.65,
    fontSize: 13.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    userSelect: "text",
  },
  msgHover: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
    fontSize: 10.5,
    color: BRAND.linenFaint,
    minHeight: 18,
  },
  msgHoverTag: { fontWeight: 600, color: BRAND.linenMuted },
  msgTiming: { marginLeft: "auto" },
  assistantBody: { fontSize: 13.5, lineHeight: 1.8, color: BRAND.linen, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  thinkingRow: { display: "inline-flex", alignItems: "center", gap: 7, color: BRAND.linenMuted, fontSize: 13 },
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
  streamDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    background: BRAND.ochre,
    animation: "pulseDot 1.1s ease-in-out infinite",
  },
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
  codeBlock: {
    margin: "6px 0",
    padding: 8,
    borderRadius: 7,
    background: BRAND.ink,
    border: `1px solid ${BRAND.border}`,
    fontSize: 11,
    lineHeight: 1.5,
    overflowX: "auto",
    fontFamily: "ui-monospace, Consolas, monospace",
  },
  inlineCode: {
    padding: "0 4px",
    borderRadius: 4,
    background: BRAND.ink,
    fontSize: 11,
    fontFamily: "ui-monospace, Consolas, monospace",
    color: "#d8c9a8",
  },
  errBox: { fontSize: 11, color: "#f87171", background: "rgba(248,113,113,0.10)", padding: "5px 7px", borderRadius: 6 },
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
  composer: { borderTop: `1px solid ${BRAND.border}`, padding: 10 },
  composerBox: {
    position: "relative",
    minWidth: 0,
    maxWidth: "100%",
    boxSizing: "border-box",
    borderRadius: 12,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    padding: "8px 8px 6px",
  },
  chipRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "nowrap" },
  chip: {
    flexShrink: 1,
    minWidth: 0,
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 9px",
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11,
    cursor: "pointer",
    maxWidth: 170,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chipActive: { borderColor: BRAND.ochre, color: BRAND.ochreHover, background: BRAND.ochreSoft },
  chipCompact: {
    width: 28,
    height: 28,
    padding: 0,
    justifyContent: "center",
    borderRadius: 999,
    flexShrink: 0,
    transition: "width 140ms ease, border-radius 140ms ease",
  },
  measureRow: {
    position: "absolute",
    left: 0,
    top: 0,
    display: "flex",
    gap: 6,
    visibility: "hidden",
    pointerEvents: "none",
    whiteSpace: "nowrap",
  },
  measureChip: {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 9px",
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    fontSize: 11,
  },
  spacer: { flex: 1 },
  effortSection: { borderTop: `1px solid ${BRAND.border}`, padding: "6px 4px 2px" },
  effortRow: { display: "flex", flexWrap: "wrap", gap: 4 },
  modelBadge: {
    marginLeft: 6,
    fontSize: 9,
    padding: "0 4px",
    borderRadius: 4,
    border: `1px solid ${BRAND.border}`,
    color: BRAND.linenFaint,
    verticalAlign: "1px",
  },
  sendBtn: {
    width: 28,
    height: 28,
    borderRadius: 999,
    border: "none",
    background: BRAND.ochre,
    color: BRAND.ink,
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
    flex: "none",
    transition: "transform 80ms, background 120ms",
  },
  composerFoot: { marginTop: 6, padding: "0 2px" },
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
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    resize: "none",
    borderRadius: 8,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    color: BRAND.linen,
    padding: 10,
    fontSize: 12.5,
    lineHeight: 1.6,
    outline: "none",
  },
  composerRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 },
  spinnerInline: { color: BRAND.ochre, flex: "none" },
  notice: {
    flex: 1,
    fontSize: 11,
    color: BRAND.linenFaint,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
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
