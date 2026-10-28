import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { normalizeNavigateUrl } from "loopsoar-contracts/navigation";
import type {
  AgentSummary,
  BootStatus,
  LoopsoarAPI,
  ProviderStatus,
} from "./types.js";

/**
 * Loopsoar 主界面（GUI-2）：品牌三色主题 + 自定义标题栏。
 * 品牌色（来自官方图标）：深墨 #111318 / 亚麻白 #F4EFE6 / 赭石 #C8763C。
 * 原生标题栏与菜单栏已移除（主进程 titleBarStyle:hidden + Menu.setApplicationMenu(null)），
 * 标题栏的拖动区域、窗口控制按钮都由本文件渲染，经 window:* 受信通道驱动主进程。
 */

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "reasoning" | "tool" | "system";
  text: string;
  status?: "streaming" | "done" | "error";
}

/** 品牌色板（单一来源；界面任何颜色都必须从这里取）。 */
const BRAND = {
  ink: "#111318",
  inkRaised: "#17191e",
  inkPanel: "#15171c",
  inkHover: "#1e2127",
  border: "#262a31",
  borderStrong: "#333842",
  linen: "#f4efe6",
  linenMuted: "#a8a29a",
  linenFaint: "#6f6a63",
  ochre: "#c8763c",
  ochreHover: "#d98a4f",
  ochreSoft: "rgba(200,118,60,0.16)",
  danger: "#c2453a",
} as const;

/** 窗口拖动区域（Electron 非标准 CSS 属性，需断言类型）。 */
const DRAG_REGION = { WebkitAppRegion: "drag" } as unknown as React.CSSProperties;
const NO_DRAG_REGION = { WebkitAppRegion: "no-drag" } as unknown as React.CSSProperties;

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
          className="win-btn"
          style={styles.windowButton}
          onClick={() => void api?.window.minimize()}
        >
          &#x2500;
        </button>
        <button
          type="button"
          aria-label={maximized ? "还原" : "最大化"}
          className="win-btn"
          style={styles.windowButton}
          onClick={() => void api?.window.maximize()}
        >
          {maximized ? "\u2750" : "\u25A1"}
        </button>
        <button
          type="button"
          aria-label="关闭"
          className="win-btn win-close"
          style={styles.windowButton}
          onClick={() => void api?.window.close()}
        >
          &#x2715;
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
  const sessionIdRef = useRef<string>(nextId("sess"));
  const activeAssistantRef = useRef<string | null>(null);

  // 挂载：拉取状态 + 订阅流式事件（事件名来自契约 EVENTS 白名单）
  useEffect(() => {
    if (!api) {
      setNotice("未在 Electron shell 中运行（window.loopsoarAPI 不存在）");
      return;
    }
    void (async () => {
      const [bootResult, providerResult, agentsResult, stateResult] = await Promise.allSettled([
        api.runtime.status(),
        api.settings.getProvider(),
        api.agents.list(),
        api.window.state(),
      ]);
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

    const upsertAssistant = (text: string, status: ChatMessage["status"] = "streaming"): void => {
      const id = activeAssistantRef.current ?? nextId("a");
      activeAssistantRef.current = id;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) return [...prev, { id, role: "assistant", text, status }];
        const next = [...prev];
        next[idx] = { ...next[idx], text: next[idx].text + text, status };
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
      api.on("chat:stream:done", (payload) => {
        const p = payload as { content?: string };
        activeAssistantRef.current = null;
        setBusy(false);
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
        pushTransient("system", `错误：${p.message ?? p.content ?? "未知错误"}`);
      }),
    ];
    return () => {
      window.removeEventListener("resize", syncMaximized);
      for (const unsub of unsubscribers) unsub();
    };
  }, [api]);

  const send = useCallback((): void => {
    const text = input.trim();
    if (!text || !api) return;
    setInput("");
    setBusy(true);
    setNotice("");
    setMessages((prev) => [...prev, { id: nextId("u"), role: "user", text, status: "done" }]);
    activeAssistantRef.current = null;
    void api.chat.stream({ message: text, sessionId: sessionIdRef.current }).catch((err: unknown) => {
      setBusy(false);
      setNotice(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    });
  }, [api, input]);

  const stop = useCallback((): void => {
    if (!api) return;
    void api.chat.stop({ sessionId: sessionIdRef.current });
  }, [api]);

  const navigate = useCallback((): void => {
    if (!api) return;
    const normalized = normalizeNavigateUrl(address);
    if (!normalized.ok) {
      setNotice(`导航被拒绝：${normalized.reason}`);
      return;
    }
    setNotice("导航中…");
    void api.browser.navigate({ url: normalized.url }).then((result) => {
      if (result.ok) {
        setCurrentUrl(result.url ?? normalized.url);
        setNotice("导航完成");
      } else {
        setNotice(`导航失败：${result.error ?? "未知"}`);
      }
    });
  }, [address, api]);

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

  const providerLabel = useMemo(() => {
    if (!provider) return "provider: 读取中…";
    if (!provider.configured) return "provider: 未配置";
    return provider.usable
      ? `provider: ${provider.provider} · ${provider.model}`
      : `provider: ${provider.provider}（${provider.reason ?? "不可用"}）`;
  }, [provider]);

  const agentLabel = agents.find((a) => a.isDefault)?.name ?? "—";

  return (
    <div style={styles.app}>
      <TitleBar maximized={maximized} />

      <header style={{ ...styles.topBar, height: LAYOUT.TOP_BAR_HEIGHT }}>
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
        <div style={styles.topActions}>
          <button type="button" className="btn-primary" style={styles.primaryButton} onClick={navigate}>
            导航
          </button>
          <button type="button" className="btn-ghost" style={styles.ghostButton} onClick={snapshot}>
            快照
          </button>
        </div>
      </header>

      <div style={styles.body}>
        <section style={styles.browserPane}>
          <div style={styles.startPage}>
            <div style={styles.startMark}>
              <img src="./logo.png" alt="Loopsoar" width={64} height={64} />
            </div>
            <div style={styles.startTitle}>Loopsoar</div>
            <div style={styles.startSubtitle}>浏览器优先的本地 AI Agent</div>
            <div style={styles.startHints}>
              <div>在顶部输入网址或搜索内容，回车打开页面</div>
              <div>右侧与 Agent 对话：可在授权范围内读写文件、执行命令、操控网页</div>
              <div>原生浏览器视图会覆盖此区域（WebContentsView · D0 已验证）</div>
            </div>
            <div style={styles.startUrl}>{currentUrl ? `当前页面：${currentUrl}` : "尚未打开网页"}</div>
          </div>
        </section>

        <aside style={{ ...styles.sidebar, width: LAYOUT.SIDEBAR_WIDTH }}>
          <div style={styles.sidebarHeader}>
            <span>Agent 对话</span>
            <span style={styles.sidebarAgent}>{agentLabel}</span>
          </div>
          <div style={styles.messageList}>
            {messages.length === 0 ? (
              <div style={styles.emptyHint}>和 Loopsoar 说点什么，例如「帮我总结当前网页」。</div>
            ) : (
              messages.map((m) => (
                <div key={m.id} style={styles.message}>
                  <span style={{ ...styles.roleTag, color: roleColor(m.role) }}>{ROLE_LABEL[m.role]}</span>
                  <span style={styles.messageText}>{m.text}</span>
                </div>
              ))
            )}
          </div>
          <div style={styles.composer}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              style={styles.textarea}
              rows={3}
            />
            <div style={styles.composerRow}>
              <span style={styles.notice}>{notice || (busy ? "生成中…" : "")}</span>
              <button
                type="button"
                className="btn-primary"
                style={styles.primaryButton}
                onClick={send}
                disabled={!api || busy || input.trim() === ""}
              >
                发送
              </button>
              <button
                type="button"
                className="btn-ghost"
                style={styles.ghostButton}
                onClick={stop}
                disabled={!api || !busy}
              >
                停止
              </button>
            </div>
          </div>
        </aside>
      </div>

      <footer style={{ ...styles.statusBar, height: LAYOUT.STATUS_BAR_HEIGHT }}>
        <span style={styles.statusItem}>shell: {boot?.status ?? "—"}</span>
        <span style={styles.statusItem}>agent: {agentLabel}</span>
        <span style={styles.statusItem}>{providerLabel}</span>
        <span style={{ ...styles.statusItem, ...styles.statusUrl }}>{currentUrl || "about:start"}</span>
      </footer>
    </div>
  );
}

/* ---------------------------------- 样式 ---------------------------------- */

const styles: Record<string, React.CSSProperties> = {
  app: {
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
  titleText: {
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 0.6,
    color: BRAND.linenMuted,
  },
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
  windowClose: { fontSize: 13 },
  // 顶部操作栏
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 12px",
    background: BRAND.inkRaised,
    borderBottom: `1px solid ${BRAND.border}`,
    flexShrink: 0,
  },
  omnibox: {
    flex: 1,
    height: 30,
    padding: "0 14px",
    borderRadius: 15,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    color: BRAND.linen,
    fontSize: 13,
    outline: "none",
  },
  topActions: { display: "flex", gap: 8, flexShrink: 0 },
  primaryButton: {
    height: 28,
    padding: "0 14px",
    borderRadius: 7,
    border: "none",
    background: BRAND.ochre,
    color: BRAND.ink,
    fontWeight: 700,
    fontSize: 12.5,
    cursor: "pointer",
  },
  ghostButton: {
    height: 28,
    padding: "0 12px",
    borderRadius: 7,
    border: `1px solid ${BRAND.borderStrong}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 12.5,
    cursor: "pointer",
  },
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
  startHints: {
    marginTop: 20,
    color: BRAND.linenMuted,
    fontSize: 12.5,
    lineHeight: 2,
    display: "grid",
    gap: 2,
  },
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
  sidebarAgent: { fontSize: 11, color: BRAND.linenFaint, fontWeight: 400 },
  messageList: {
    flex: 1,
    overflowY: "auto",
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
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
  statusUrl: {
    marginLeft: "auto",
    fontFamily: "ui-monospace, Consolas, monospace",
    color: BRAND.linenFaint,
  },
};
