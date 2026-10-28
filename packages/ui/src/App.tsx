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
 * Loopsoar 主界面（GUI-1）：
 * 顶部栏（品牌 + omnibox + 操作）｜左侧浏览器区（原生 WebContentsView 覆盖）｜右侧 Agent 面板｜底部状态条。
 * 全部数据经 preload 白名单（window.loopsoarAPI），渲染进程不直接触达 Node/Electron。
 */

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "reasoning" | "tool" | "system";
  text: string;
  status?: "streaming" | "done" | "error";
}

const ROLE_LABEL: Record<ChatMessage["role"], string> = {
  user: "你",
  assistant: "Loopsoar",
  reasoning: "推理",
  tool: "工具",
  system: "系统",
};

function useLoopsoarApi(): LoopsoarAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { loopsoarAPI?: LoopsoarAPI }).loopsoarAPI ?? null;
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function App(): React.JSX.Element {
  const api = useLoopsoarApi();
  const [boot, setBoot] = useState<BootStatus | null>(null);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
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
      const [bootResult, providerResult, agentsResult] = await Promise.allSettled([
        api.runtime.status(),
        api.settings.getProvider(),
        api.agents.list(),
      ]);
      if (bootResult.status === "fulfilled") setBoot(bootResult.value);
      if (providerResult.status === "fulfilled") setProvider(providerResult.value);
      if (agentsResult.status === "fulfilled") setAgents(agentsResult.value.agents);
    })();

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
      api.on("chat:stream:heartbeat", () => {
        /* 心跳不渲染，仅维持连接 */
      }),
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
      setNotice(result.ok ? `页面快照：${result.title ?? ""}（${(result.text ?? "").length} 字符）` : `快照失败：${result.error}`);
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
      <header style={{ ...styles.topBar, height: LAYOUT.TOP_BAR_HEIGHT }}>
        <div style={styles.brand}>
          <img src="./logo.png" alt="Loopsoar" width={26} height={26} style={styles.logo} />
          <span style={styles.brandName}>Loopsoar</span>
        </div>
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
          <button type="button" style={styles.button} onClick={navigate}>
            导航
          </button>
          <button type="button" style={styles.buttonGhost} onClick={snapshot}>
            快照
          </button>
        </div>
      </header>

      <div style={styles.body}>
        <section style={styles.browserPane}>
          <div style={styles.startPage}>
            <div style={styles.startTitle}>Loopsoar</div>
            <div style={styles.startSubtitle}>浏览器优先的本地 AI Agent</div>
            <ul style={styles.startHints}>
              <li>在顶部地址栏输入网址或搜索内容，回车后由智能判断导航或搜索</li>
              <li>右侧面板与 Agent 对话：它能在你授权的范围内读写文件、执行命令、操控网页</li>
              <li>原生浏览器视图覆盖此区域（WebContentsView · D0 已验证）</li>
            </ul>
            <div style={styles.startUrl}>{currentUrl ? `当前页面：${currentUrl}` : "尚未打开网页"}</div>
          </div>
        </section>

        <aside style={{ ...styles.sidebar, width: LAYOUT.SIDEBAR_WIDTH }}>
          <div style={styles.sidebarHeader}>Agent 对话</div>
          <div style={styles.messageList}>
            {messages.length === 0 ? (
              <div style={styles.emptyHint}>和 Loopsoar 说点什么，例如「帮我总结当前网页」。</div>
            ) : (
              messages.map((m) => (
                <div key={m.id} style={styles.message}>
                  <span style={{ ...styles.roleTag, ...roleTagColor(m.role) }}>{ROLE_LABEL[m.role]}</span>
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
              <button type="button" style={styles.button} onClick={send} disabled={!api || busy || input.trim() === ""}>
                发送
              </button>
              <button type="button" style={styles.buttonGhost} onClick={stop} disabled={!api || !busy}>
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
        <span style={{ ...styles.statusItem, ...styles.statusUrl }}>
          {currentUrl || "about:start"}
        </span>
      </footer>
    </div>
  );
}

function roleTagColor(role: ChatMessage["role"]): React.CSSProperties {
  switch (role) {
    case "user":
      return { color: "#93c5fd" };
    case "assistant":
      return { color: "#5eead4" };
    case "reasoning":
      return { color: "#c4b5fd" };
    case "tool":
      return { color: "#fbbf24" };
    default:
      return { color: "#9ca3af" };
  }
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    margin: 0,
    background: "#0b1021",
    color: "#e8eaed",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    boxSizing: "border-box",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "0 16px",
    background: "#111827",
    borderBottom: "1px solid #1f2937",
    flexShrink: 0,
  },
  brand: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  logo: { borderRadius: 6, display: "block" },
  brandName: { fontWeight: 700, fontSize: 15, letterSpacing: 0.3 },
  omnibox: {
    flex: 1,
    height: 32,
    padding: "0 14px",
    borderRadius: 16,
    border: "1px solid #374151",
    background: "#0b1021",
    color: "#e8eaed",
    fontSize: 13,
    outline: "none",
  },
  topActions: { display: "flex", gap: 8, flexShrink: 0 },
  button: {
    height: 30,
    padding: "0 14px",
    borderRadius: 8,
    border: "none",
    background: "#0ea5e9",
    color: "#06121f",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
  },
  buttonGhost: {
    height: 30,
    padding: "0 12px",
    borderRadius: 8,
    border: "1px solid #374151",
    background: "transparent",
    color: "#cbd5e1",
    fontSize: 13,
    cursor: "pointer",
  },
  body: { display: "flex", flex: 1, minHeight: 0 },
  browserPane: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "radial-gradient(circle at 30% 20%, #12203a 0%, #0b1021 60%)",
  },
  startPage: { maxWidth: 560, padding: 32 },
  startTitle: { fontSize: 34, fontWeight: 800, letterSpacing: 0.5, color: "#f8fafc" },
  startSubtitle: { marginTop: 6, fontSize: 14, color: "#7dd3fc" },
  startHints: {
    marginTop: 18,
    paddingLeft: 18,
    color: "#94a3b8",
    fontSize: 13,
    lineHeight: 1.9,
  },
  startUrl: { marginTop: 18, fontSize: 12, color: "#64748b" },
  sidebar: {
    display: "flex",
    flexDirection: "column",
    borderLeft: "1px solid #1f2937",
    background: "#0f172a",
    flexShrink: 0,
  },
  sidebarHeader: {
    padding: "12px 16px",
    fontWeight: 600,
    fontSize: 14,
    borderBottom: "1px solid #1f2937",
    color: "#e2e8f0",
  },
  messageList: { flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 },
  emptyHint: { color: "#64748b", fontSize: 13, lineHeight: 1.7 },
  message: { display: "flex", flexDirection: "column", gap: 3 },
  roleTag: { fontSize: 11, fontWeight: 700, letterSpacing: 0.4 },
  messageText: { fontSize: 13, lineHeight: 1.65, color: "#e2e8f0", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  composer: { borderTop: "1px solid #1f2937", padding: 10 },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    resize: "none",
    borderRadius: 8,
    border: "1px solid #374151",
    background: "#0b1021",
    color: "#e8eaed",
    padding: 10,
    fontSize: 13,
    lineHeight: 1.5,
    outline: "none",
  },
  composerRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 },
  notice: { flex: 1, fontSize: 11, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  statusBar: {
    display: "flex",
    alignItems: "center",
    gap: 18,
    padding: "0 14px",
    background: "#111827",
    borderTop: "1px solid #1f2937",
    fontSize: 11,
    color: "#94a3b8",
    flexShrink: 0,
  },
  statusItem: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  statusUrl: { marginLeft: "auto", fontFamily: "ui-monospace, Consolas, monospace", color: "#64748b" },
};
