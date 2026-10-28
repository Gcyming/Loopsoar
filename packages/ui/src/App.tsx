import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { normalizeNavigateUrl } from "loopsoar-contracts/navigation";
import type {
  AgentSummary,
  BootStatus,
  LoopsoarAPI,
  PermissionsState,
  Preferences,
  ProviderStatus,
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
  const [permReq, setPermReq] = useState<{ requestId: string; toolName: string; target?: string; kind?: string } | null>(null);
  const [permSummary, setPermSummary] = useState<PermissionsState | null>(null);
  const [settingsSection, setSettingsSection] = useState<string>("general");
  const sessionIdRef = useRef<string>(nextId("sess"));
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
      const id = activeAssistantRef.current ?? nextId("a");
      activeAssistantRef.current = id;
      tailSeqRef.current += 1;
      const tailSeq = tailSeqRef.current;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) {
          return [...prev, { id, role: "assistant", text: delta, tail: delta, tailSeq, status: "streaming" }];
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
        if (typeof p.content === "string" && p.content.length > 0) pushTransient("reasoning", p.content);
      }),
      api.on("chat:stream:tool", (payload) => {
        pushTransient("tool", JSON.stringify((payload as { content?: string }).content ?? "").slice(0, 400));
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
      api.on("browser:tabs", (payload) => {
        const p = payload as { tabs?: TabState[] };
        if (Array.isArray(p.tabs)) setTabs(p.tabs);
      }),
      api.on("memory:updated", () => {
        /* 记忆条目在设置面板中查看；主界面保持安静 */
      }),
      api.on("chat:stream:done", (payload) => {
        const p = payload as { content?: string };
        activeAssistantRef.current = null;
        setBusy(false);
        setMessages((prev) =>
          prev.map((m) => (m.status === "streaming" ? { ...m, status: "done", tail: undefined } : m)),
        );
        try {
          const parsed = JSON.parse(p.content ?? "{}") as { status?: string; reason?: string };
          setNotice(`完成：${parsed.status ?? "done"}${parsed.reason ? ` · ${parsed.reason}` : ""}`);
        } catch {
          setNotice("完成");
        }
      }),
      api.on("chat:stream:error", (payload) => {
        const p = payload as { content?: string; message?: string };
        activeAssistantRef.current = null;
        setBusy(false);
        setMessages((prev) =>
          prev.map((m) => (m.status === "streaming" ? { ...m, status: "error", tail: undefined } : m)),
        );
        pushTransient("system", `错误：${p.message ?? p.content ?? "未知错误"}`);
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
    setMessages((prev) => [...prev, { id: nextId("u"), role: "user", text, status: "done" }]);
    activeAssistantRef.current = null;
    void api.chat.stream({ message: text, sessionId: sessionIdRef.current, mode }).catch((err: unknown) => {
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
    void api.browser.newTab({}).then((r) => {
      if (r.ok) {
        setNotice("已新建标签页");
        void api.browser.listTabs().then((t) => setTabs(t.tabs)).catch(() => {});
      }
    });
  }, [api]);

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

  return (
    <div style={styles.app}>
      <TitleBar maximized={maximized} />

      <header style={{ ...styles.topBar, height: LAYOUT.TOP_BAR_HEIGHT }}>
        <div style={styles.navGroup}>
          <button type="button" className="icon-btn" title="后退（待接历史）" disabled>
            <Icon name="back" size={16} />
          </button>
          <button type="button" className="icon-btn" title="前进（待接历史）" disabled>
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
        </div>

        <div style={styles.omniboxWrap}>
          <Icon name="search" size={14} style={styles.omniboxIcon} />
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate();
            }}
            placeholder="输入地址或搜索内容，回车导航…"
            style={styles.omnibox}
            aria-label="地址与搜索"
          />
          <button type="button" className="icon-btn" title="收藏（待接）" disabled style={styles.omniboxStar}>
            <Icon name="star" size={15} />
          </button>
        </div>

        <div style={styles.topActions}>
          <button type="button" className="icon-btn" title="页面快照" onClick={snapshot} disabled={!api}>
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
        {tabs.length === 0 ? (
          <span style={styles.tabEmpty}>暂无标签 — 输入地址导航，或点 + 新建</span>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-item${tab.active ? " is-active" : ""}`}
              style={{ ...styles.tab, ...(tab.active ? styles.tabActive : {}) }}
              onClick={() => selectTab(tab.id)}
              title={tab.url || tab.title}
            >
              <span style={styles.tabTitle}>{tab.title || "新标签页"}</span>
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
        )}
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
            <div style={styles.startTitle}>Loopsoar</div>
            <div style={styles.startSubtitle}>浏览器优先的本地 AI Agent</div>
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

        <aside style={{ ...styles.sidebar, width: LAYOUT.SIDEBAR_WIDTH }}>
          <div style={styles.sidebarHeader}>
            <span style={styles.sidebarTitle}>
              <Icon name="agent" size={14} style={{ marginRight: 6 }} />
              Agent 对话
            </span>
            <span style={styles.sidebarAgent}>{agentLabel}</span>
          </div>
          <div style={styles.messageList}>
            {messages.length === 0 ? (
              <div style={styles.emptyHint}>和 Loopsoar 说点什么，例如「帮我总结当前网页」。</div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className="msg-enter" style={styles.message}>
                  <span style={{ ...styles.roleTag, color: roleColor(m.role) }}>{ROLE_LABEL[m.role]}</span>
                  <span style={styles.messageText}>
                    {m.tail && m.status === "streaming"
                      ? m.text.slice(0, m.text.length - m.tail.length)
                      : m.text}
                    {m.tail && m.status === "streaming" ? (
                      <span key={m.tailSeq} className="stream-tail">
                        {m.tail}
                      </span>
                    ) : null}
                    {m.status === "streaming" ? <span className="stream-caret" /> : null}
                  </span>
                </div>
              ))
            )}
          </div>
          <div style={styles.composer}>
            <div style={styles.composerBox}>
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
                  style={{ ...styles.chip, ...(mode === "build" ? styles.chipActive : {}) }}
                  title="模式：Build 可执行工具 / Plan 只读规划"
                  onClick={() => setMode(mode === "build" ? "plan" : "build")}
                >
                  <Icon name="bolt" size={12} style={{ marginRight: 4 }} />
                  {mode === "build" ? "Build" : "Plan"}
                </button>
                <button
                  type="button"
                  className="chip"
                  style={styles.chip}
                  title="当前会话权限（点击修改）"
                  onClick={() => openSettings("permissions")}
                >
                  <Icon name="check" size={12} style={{ marginRight: 4 }} />
                  {permSummary ? permissionLabel(permSummary) : "权限"}
                </button>
                <button
                  type="button"
                  className="chip"
                  style={styles.chip}
                  title="选择模型 / 供应商（点击配置）"
                  onClick={() => openSettings("providers")}
                >
                  <Icon name="cloud-upload" size={12} style={{ marginRight: 4 }} />
                  {provider?.configured ? provider.model : "未配置模型"}
                </button>
                <span style={styles.spacer} />
                {busy ? (
                  <>
                    <Icon name="spinner" size={14} className="spinner" style={styles.spinnerInline} />
                    <button type="button" className="chip" style={styles.chip} onClick={stop} title="停止生成">
                      <Icon name="stop" size={12} style={{ marginRight: 4 }} />
                      停止
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
          api={api}
          initialSection={settingsSection as never}
          onClose={() => {
            setSettingsOpen(false);
            void api?.settings.getPermissions().then(setPermSummary).catch(() => {});
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
          {notice}
        </button>
      ) : null}
    </div>
  );
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
  body: { display: "flex", flex: 1, minHeight: 0 },
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
  sidebar: {
    display: "flex",
    flexDirection: "column",
    borderLeft: `1px solid ${BRAND.border}`,
    background: BRAND.inkPanel,
    flexShrink: 0,
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
    borderRadius: 12,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    padding: "8px 8px 6px",
  },
  chipRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" },
  chip: {
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
  spacer: { flex: 1 },
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
