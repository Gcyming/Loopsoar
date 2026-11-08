/**
 * 单条消息视图（用户气泡 / 助手区块）——从 App 抽出的纯展示组件。
 *
 * 只接收消息与回调，不订阅事件、不做 IPC；数据来自 chatStreamState 维护的消息。
 * 助手块包含：时间线（TimelineView）、流式正文（StreamFadeText）、中断横幅、LiveStatus、
 * 产物面板与悬停元信息（复制/重新生成；回复耗时在思考过程卡标题行，不在悬停行）。
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
import { formatDurationMs } from "./timeline.js";
import { renderRich } from "./Markdown.js";
import { useT } from "./i18n.js";
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
  const tr = useT();
  const timelineSteps = m.timeline ?? [];
  const hasStructuredTimeline = timelineSteps.some((step) => step.kind !== "body");
  // 回复耗时只在思考过程卡标题行展示；没有思考过程（纯文本回复）时省略，避免塞回悬停行换行。
  const replyDurationText =
    hasStructuredTimeline && m.timing?.totalMs
      ? tr("chat.replyDuration", { time: formatDurationMs(m.timing.totalMs) })
      : undefined;
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
      <div className="msg-row" style={styles.msgRowUser} data-rail-label={tr("chat.railUser", { text: m.text.slice(0, 24) })} data-rail-role="user">
        <div className="msg-user-bubble" style={styles.userBubble}>
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
          <span style={styles.msgTime}>· {timeText}</span>
          <button type="button" className="msg-action" style={styles.msgAction} title={tr("chat.rollbackTitle")} onClick={() => onRollback(m.id)}>
            <Icon name="reload" size={12} />
          </button>
          <button type="button" className="msg-action" style={styles.msgAction} title={tr("chat.copyMessageTitle")} onClick={() => void navigator.clipboard?.writeText(displayText).catch(() => {})}>
            <Icon name="copy" size={12} />
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
      data-rail-label={tr("chat.railAssistant", { text: (displayText || tr("chat.replyFallback")).slice(0, 26) })}
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
        {hasStructuredTimeline ? (
          <Timeline
            steps={timelineSteps}
            liveStream={streaming}
            expandAll={expandAllGroups}
            open={thinkingOpen}
            durationText={replyDurationText}
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
                ? tr("chat.compressSummary", {
                    dropped: m.compressStats.dropped,
                    before: m.compressStats.beforeChars,
                    after: m.compressStats.afterChars,
                    pct: Math.max(
                      0,
                      Math.round((1 - m.compressStats.afterChars / Math.max(1, m.compressStats.beforeChars)) * 100),
                    ),
                  })
                : m.compressNote}
            </span>
            {m.compressStats ? <span style={styles.compressHint}>{tr("chat.compressHint")}</span> : null}
          </div>
        ) : null}

        {/* 思考与正文之间的分隔线（slime 同款；折叠展开时也保持稳定） */}
        <div className="msg-body-divider" />

        <div className="msg-body-text" style={styles.assistantBody}>
          {m.errorText ? null : streaming ? (
            /* 正文后置闸门：本轮结束前正文不开闸，只显示阶段占位；
               期间穿插正文由时间线的 body 节点（13.5px）承载，避免"正文抢跑" */
            <span className="stream-gate">
              <span className="text-scan-light">{runningTool ? tr("chat.runningTool") : tr("chat.thinkingActive")}</span>
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
            <span>{tr("chat.interrupted", { reason: m.interrupted.reason })}</span>
          </div>
        ) : null}
        {streaming ? <LiveStatus startedAt={m.createdAt ?? Date.now()} contextPct={contextPct} runningTool={runningTool} hasText={m.text.length > 0} /> : null}

        {/* 元信息行：移到回复最底部（用户 m02010「悬停行下移」）；「思考」按钮已删，
            点「思考过程」卡标题即可展开。顺序：Build · 模型（省略号） · 时间，右侧复制/重新生成。 */}
        <div className="msg-hover msg-hover-bottom" style={styles.msgHover}>
          <span style={styles.msgHoverTag}>{mode === "build" ? "Build" : "Plan"}</span>
          {m.model ? (
            <span style={styles.msgModel} title={m.provider ? `${m.provider} · ${m.model}` : m.model}>
              · {m.model}
            </span>
          ) : null}
          <span style={styles.msgTime}>· {timeText}</span>
          <span style={styles.msgHoverActions}>
            <button
              type="button"
              className="msg-action"
              style={styles.msgAction}
              title={tr("chat.copyReplyTitle")}
              onClick={() => void navigator.clipboard?.writeText(displayText).catch(() => {})}
            >
              <Icon name="copy" size={12} />
            </button>
            {!streaming && m.text ? (
              <button type="button" className="msg-action" style={styles.msgAction} title={tr("chat.regenerateTitle")} onClick={() => onRegenerate(m.id)}>
                <Icon name="reload" size={12} />
              </button>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}

const thumbCache = new Map<string, string>();

/** 图片附件缩略图：通过 fs:readImage 读 data URL（6MB/扩展名白名单在壳层兜底）。 */
function AttachmentThumb({ path }: { path: string }): React.ReactElement {
  const tr = useT();
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
    <span style={styles.attachChip} title={failed ? tr("chat.attachPreviewFailed", { path }) : path}>
      <Icon name="file" size={11} style={{ marginRight: 4 }} />
      {baseName(path)}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  msgRowUser: { display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: 14 },
  msgRowAssistant: { display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 18 },
  /** 助手流式输出中的小圆点（头部状态指示，避免 0/0 上下文环之外的空白）。 */
  streamDot: {
    display: "inline-block",
    width: 6,
    height: 6,
    marginLeft: 2,
    borderRadius: "50%",
    background: BRAND.ochre,
    animation: "pulseDot 1.2s ease-in-out infinite",
    flexShrink: 0,
  },
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
  /** 悬停元信息行：单行不换行；窄侧栏下把模型名省略号收尾（用户反馈 Build · model 换行很难看）。 */
  msgHover: {
    display: "flex",
    alignItems: "center",
    flexWrap: "nowrap",
    gap: 7,
    minWidth: 0,
    overflow: "hidden",
    minHeight: 18,
    margin: "1px 0 6px",
    fontSize: 10.5,
    color: BRAND.linenFaint,
  },
  msgHoverTag: { fontWeight: 600, color: BRAND.linenMuted, flexShrink: 0 },
  /** 操作按钮固定宽度，不参与悬停行的收缩（否则窄侧栏会被挤扁）。 */
  msgAction: { flexShrink: 0 },
  /** 模型名过长时省略号截断（完整值留在 title 里），不再把整行挤成两行。 */
  msgModel: {
    minWidth: 0,
    flexShrink: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /** 时间戳（无 timing 时）不参与收缩。 */
  msgTime: { flexShrink: 0, whiteSpace: "nowrap" },
  /** 底部元信息行右侧动作组（复制/重新生成）：固定贴右，不参与左侧文本收缩。 */
  msgHoverActions: { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 7, flexShrink: 0 },
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
    color: "var(--ls-danger, #f87171)",
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
