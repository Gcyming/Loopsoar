/**
 * 单条消息视图（用户气泡 / 助手区块）——从 App 抽出的纯展示组件。
 *
 * 只接收消息与回调，不订阅事件、不做 IPC；数据来自 chatStreamState 维护的消息。
 * 助手块包含：时间线（TimelineView）、流式正文（StreamFadeText）、中断横幅、LiveStatus、
 * 产物面板与悬停元信息（复制/重新生成/耗时）。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import ContextRing from "./ContextRing.js";
import LiveStatus from "./LiveStatus.js";
import Timeline from "./TimelineView.js";
import { ProductPanel } from "./ArtifactPanels.js";
import { collectProducts, stripDiffMarkers } from "./artifacts.js";
import { baseName, splitAttachments } from "./attachments.js";
import { renderRich } from "./Markdown.js";
import type { ChatMessage } from "./chatStreamState.js";
import type { LoopsoarAPI } from "./types.js";

export interface ChatMessageViewProps {
  message: ChatMessage;
  mode: "build" | "plan";
  contextUsed: number;
  contextCap: number;
  contextPct: number;
  thinkingOpen: boolean;
  expandAllGroups?: boolean;
  openProducts?: boolean;
  onToggleThinking: () => void;
  onRollback: (id: string) => void;
  onRegenerate: (id: string) => void;
  onOpenUrl: (url: string) => void;
}

function fmtMs(ms: number | undefined): string {
  if (!ms || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function ChatMessageView({
  message: m,
  mode,
  contextUsed,
  contextCap,
  contextPct,
  thinkingOpen,
  expandAllGroups = false,
  openProducts = false,
  onToggleThinking,
  onRollback,
  onRegenerate,
  onOpenUrl,
}: ChatMessageViewProps): React.ReactElement {
  const timelineSteps = m.timeline ?? [];
  const hasStructuredTimeline = timelineSteps.some((step) => step.kind !== "body");
  const products = hasStructuredTimeline ? collectProducts(timelineSteps) : [];
  const displayText = stripDiffMarkers(m.text);
  const showThinking = m.status === "streaming" && !m.text && !hasStructuredTimeline;
  const timeText = new Date(m.createdAt ?? Date.now()).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (m.role === "user") {
    const { body, docs } = splitAttachments(m.text);
    return (
      <div className="msg-row" style={styles.msgRowUser} data-rail-label={`你：${m.text.slice(0, 24)}`} data-rail-role="user">
        <div className={`msg-user-bubble${m.steer ? " is-steer" : ""}`} style={{ ...styles.userBubble, ...(m.steer ? styles.userBubbleSteer : {}) }}>
          {m.steer ? <span style={styles.steerBadge}>转向</span> : null}
          {docs.length > 0 ? (
            <div style={styles.attachRow}>
              {docs.map((path) =>
                /\.(png|jpe?g|webp|gif)$/i.test(path) ? (
                  <AttachmentThumb key={path} path={path} />
                ) : (
                  <span key={path} style={styles.attachChip} title={path}>
                    <Icon name="file" size={11} style={{ marginRight: 4 }} />
                    {baseName(path)}
                  </span>
                ),
              )}
            </div>
          ) : null}
          {body ? <span>{body}</span> : null}
        </div>
        <div className="msg-hover" style={styles.msgHover}>
          <span style={styles.msgHoverTag}>{mode === "build" ? "Build" : "Plan"}</span>
          <span>· {timeText}</span>
          <button type="button" className="msg-action" title="回滚：撤销此消息及之后的对话（内容放回输入框）" onClick={() => onRollback(m.id)}>
            <Icon name="reload" size={12} />
          </button>
          <button type="button" className="msg-action" title="复制消息" onClick={() => void navigator.clipboard?.writeText(displayText).catch(() => {})}>
            <Icon name="file" size={12} />
          </button>
        </div>
      </div>
    );
  }

  const runningTool = timelineSteps.some((step) => step.kind === "tool" && step.state === "running");
  const streaming = m.status === "streaming";
  return (
    <div
      className="msg-row msg-row-assistant"
      style={styles.msgRowAssistant}
      data-rail-label={`Loopsoar：${(displayText || "回复").slice(0, 26)}`}
      data-rail-role="assistant"
    >
      <span style={styles.avatar}>L</span>
      <div style={styles.assistantMain}>
        <div style={styles.assistantHead}>
          <span style={styles.assistantName}>Loopsoar</span>
          {streaming ? <span style={styles.streamDot} /> : null}
          {/* 上下文环：真实渲染在助手头部（空数据不渲染，避免 0/0 误导） */}
          {contextCap > 0 && contextUsed > 0 ? (
            <span style={styles.contextRingWrap}>
              <ContextRing used={contextUsed} cap={contextCap} loading={streaming} />
            </span>
          ) : null}
        </div>
        {/* 悬停元信息：复制 / 模式 / 模型 / 耗时 / 思考开关（与 slime 一样位于正文之前） */}
        <div className="msg-hover" style={styles.msgHover}>
          <button
            type="button"
            className="msg-action"
            title="复制回复"
            onClick={() => void navigator.clipboard?.writeText(displayText).catch(() => {})}
          >
            <Icon name="file" size={12} />
          </button>
          <span style={styles.msgHoverTag}>{mode === "build" ? "Build" : "Plan"}</span>
          {m.model ? <span title={m.provider ? `${m.provider} · ${m.model}` : m.model}>· {m.model}</span> : null}
          {m.timing ? (
            <span style={styles.msgTiming}>
              · 回复耗时 {fmtMs(m.timing.totalMs)}
              {m.timing.tokens ? ` · ${m.timing.tokens} tokens` : ""}
              {m.timing.toolCalls ? ` · ${m.timing.toolCalls} 次工具` : ""}
            </span>
          ) : (
            <span>· {timeText}</span>
          )}
          {hasStructuredTimeline ? (
            <button
              type="button"
              className={`msg-think-toggle${thinkingOpen ? " is-open" : ""}`}
              title={thinkingOpen ? "收起思考过程" : "展开思考过程"}
              onClick={onToggleThinking}
            >
              <Icon name="notes" size={11} />
              <span>思考</span>
            </button>
          ) : null}
          {!streaming && m.text ? (
            <button type="button" className="msg-action" title="重新生成（回滚到上一条提问并重发）" onClick={() => onRegenerate(m.id)}>
              <Icon name="reload" size={12} />
            </button>
          ) : null}
        </div>

        {hasStructuredTimeline ? (
          <Timeline
            steps={timelineSteps}
            liveStream={streaming}
            expandAll={expandAllGroups}
            open={thinkingOpen}
            onToggleOpen={onToggleThinking}
            Markdown={({ text, compact }) => renderRich(text, { compact })}
            onOpenUrl={onOpenUrl}
          />
        ) : null}

        {m.compressNote ? (
          <div className="compress-note" title={m.compressNote}>
            <span className="compress-note-mark" aria-hidden>⤵</span>
            <span style={styles.compressText}>
              {m.compressStats
                ? `上下文自动压缩 ${m.compressStats.dropped} 条早期消息 · ${m.compressStats.beforeChars} → ${m.compressStats.afterChars} 字符（节省 ${Math.max(
                    0,
                    Math.round((1 - m.compressStats.afterChars / Math.max(1, m.compressStats.beforeChars)) * 100),
                  )}%）`
                : m.compressNote}
            </span>
            {m.compressStats ? <span style={styles.compressHint}>已保留最近原文，早期内容为确定性摘要</span> : null}
          </div>
        ) : null}

        {/* 思考与正文之间的分隔线（slime 同款；折叠展开时也保持稳定） */}
        <div className="msg-body-divider" />

        <div className="msg-body-text" style={styles.assistantBody}>
          {m.errorText ? null : streaming ? (
            /* 正文后置闸门：本轮结束前正文不开闸，只显示阶段占位；
               期间穿插正文由时间线的 body 节点（13.5px）承载，避免"正文抢跑" */
            <span className="stream-gate">
              <span className="text-scan-light">{runningTool ? "思考与工具调用进行中" : "正在思考"}</span>
              <span className="stream-dot-row">
                <span className="stream-dot" />
                <span className="stream-dot" style={{ animationDelay: "0.2s" }} />
                <span className="stream-dot" style={{ animationDelay: "0.4s" }} />
              </span>
            </span>
          ) : (
            renderRich(displayText)
          )}
          {streaming ? <span className="stream-cursor" aria-hidden /> : null}
        </div>

        {products.length > 0 ? <ProductPanel products={products} defaultOpen={openProducts} /> : null}
        {m.errorText ? <div style={styles.errBox}>{m.errorText}</div> : null}
        {m.interrupted ? (
          <div style={styles.interruptBox}>
            <span style={styles.interruptTag}>{m.interrupted.status}</span>
            <span>本轮已中断：{m.interrupted.reason}</span>
          </div>
        ) : null}
        {streaming ? <LiveStatus startedAt={m.createdAt ?? Date.now()} contextPct={contextPct} runningTool={runningTool} hasText={m.text.length > 0} /> : null}
      </div>
    </div>
  );
}

const thumbCache = new Map<string, string>();

/** 图片附件缩略图：通过 fs:readImage 读 data URL（6MB/扩展名白名单在壳层兜底）。 */
function AttachmentThumb({ path }: { path: string }): React.ReactElement {
  const [src, setSrc] = React.useState<string | null>(thumbCache.get(path) ?? null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (src || failed) return;
    const api = (window as unknown as { loopsoarAPI?: LoopsoarAPI }).loopsoarAPI;
    let alive = true;
    void api?.fs
      .readImage({ path })
      .then((result) => {
        if (!alive) return;
        if (result.ok && result.dataUrl) {
          thumbCache.set(path, result.dataUrl);
          setSrc(result.dataUrl);
        } else {
          setFailed(true);
        }
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [path, src, failed]);
  if (src) {
    return (
      <img
        src={src}
        alt={baseName(path)}
        title={path}
        style={styles.attachThumb}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span style={styles.attachChip} title={failed ? `${path}（无法预览）` : path}>
      <Icon name="file" size={11} style={{ marginRight: 4 }} />
      {baseName(path)}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  msgRowUser: { display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: 14 },
  msgRowAssistant: { display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 18 },
  userBubble: {
    maxWidth: "82%",
    padding: "8px 12px",
    borderRadius: "14px 14px 4px 14px",
    background: BRAND.ochre,
    color: "#1a140f",
    fontSize: 13.5,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  userBubbleSteer: { background: BRAND.ochreSoft, border: `1px dashed ${BRAND.ochre}` },
  steerBadge: {
    display: "inline-block",
    fontSize: 10,
    padding: "0 5px",
    marginRight: 6,
    borderRadius: 999,
    background: "rgba(0,0,0,0.18)",
    color: "#1a140f",
    fontWeight: 600,
  },
  compressText: { flex: 1, minWidth: 0 },
  compressHint: { flexShrink: 0, color: BRAND.linenFaint, fontSize: 10 },
  attachRow: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 5 },
  attachThumb: {
    display: "block",
    width: 108,
    maxHeight: 76,
    objectFit: "cover",
    borderRadius: 6,
    border: "1px solid rgba(0,0,0,0.2)",
    marginBottom: 2,
  },
  attachChip: {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 10.5,
    padding: "1px 6px",
    borderRadius: 6,
    background: "rgba(0,0,0,0.16)",
    color: "#2a2118",
    maxWidth: 220,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  msgHover: { display: "flex", alignItems: "center", gap: 7, minHeight: 18, margin: "1px 0 6px", fontSize: 10.5, color: BRAND.linenFaint },
  msgHoverTag: { fontWeight: 600, color: BRAND.linenMuted },
  msgTiming: { color: BRAND.linenFaint, fontSize: 10 },
  assistantHead: { display: "flex", alignItems: "center", gap: 6, minHeight: 20 },
  /** 上下文环靠右（与助手名/生成中圆点同一行，LiveStatus 风格的小组件）。 */
  contextRingWrap: { marginLeft: "auto", display: "inline-flex", alignItems: "center", flexShrink: 0 },
  avatar: {
    width: 32,
    height: 32,
    marginTop: 2,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: BRAND.ochreSoft,
    color: BRAND.ochreHover,
    fontSize: 14,
    fontWeight: 700,
    flexShrink: 0,
  },
  assistantName: { fontSize: 12, fontWeight: 700, color: BRAND.linenMuted },
  assistantMain: { flex: 1, minWidth: 0 },
  assistantBody: { fontSize: 15, lineHeight: 1.75, color: BRAND.linen, wordBreak: "break-word" },
  errBox: {
    marginTop: 6,
    padding: "6px 9px",
    borderRadius: 6,
    border: "1px solid rgba(248,113,113,0.4)",
    background: "rgba(248,113,113,0.08)",
    color: "#f87171",
    fontSize: 12,
    whiteSpace: "pre-wrap",
  },
  interruptBox: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    margin: "4px 0",
    padding: "5px 8px",
    borderRadius: 6,
    border: "1px solid rgba(242,184,85,0.35)",
    background: "rgba(242,184,85,0.08)",
    color: "#f2b855",
    fontSize: 11,
    lineHeight: 1.6,
  },
  interruptTag: {
    flex: "none",
    padding: "0 5px",
    borderRadius: 4,
    border: "1px solid rgba(242,184,85,0.5)",
    fontSize: 9.5,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
};
