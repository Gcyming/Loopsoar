/**
 * Agent 侧栏外壳（从 App 抽出）：侧栏头部（复制会话 Markdown / Agent 名）+
 * 工作区条 + 会话切换条（含会话历史下拉与删除）+ 插槽 children（消息列表 / 终端 / 输入区）。
 *
 * 纯展示 + 受控 props：所有业务动作（切换会话、新建、删除、复制、打开工作区面板）由 App 实现；
 * 本组件只负责 `aside` 的宽度与内部布局，宽度拖拽仍由 App 的 splitter 控制。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { menuStyles } from "./BrowserMenus.js";
import { useT } from "./i18n.js";
import type { ChatMessage } from "./chatStreamState.js";
import type { SessionMeta, WorkspaceRecord } from "./types.js";
import type { TimelineStep } from "./timeline.js";

export interface AgentSidebarProps {
  /** 侧栏宽度（px），由 App 的 splitter 拖拽维护。 */
  width: number;
  /** 默认 Agent 名称（状态栏与侧栏头部展示）。 */
  agentLabel: string;
  /** 当前会话消息：仅用于「复制整段会话为 Markdown」。 */
  messages: ChatMessage[];
  sessions: SessionMeta[];
  currentSession: string | null;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
  compactUi: boolean;
  sessionOpen: boolean;
  /** 点会话 chip：刷新列表并切换下拉开合（App 侧组合两个动作）。 */
  onToggleSession: () => void;
  onNewSession: () => void;
  onSwitchSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenWorkspacePanel: () => void;
  onNotice: (text: string) => void;
  /** 消息列表 / 终端抽屉 / 输入区（保留在 App 装配）。 */
  children: React.ReactNode;
}

/** useT 返回的翻译函数类型（组件内传入，避免纯函数直接依赖 hook）。 */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 把当前会话导出为 Markdown（用户/AI 气泡 + 引用式思考过程）。 */
function conversationToMarkdown(messages: ChatMessage[], tr: Translate): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const who = m.role === "user" ? (m.steer ? tr("chat.userSteer") : tr("chat.user")) : "Loopsoar";
      const thinkText = (m.timeline ?? [])
        .filter((step): step is Extract<TimelineStep, { kind: "think" }> => step.kind === "think")
        .map((step) => step.text)
        .join("\n");
      const think = thinkText ? `> ${tr("chat.thinkingPrefix")}${thinkText.replace(/\n/g, "\n> ")}\n\n` : "";
      return `### ${who}\n\n${think}${m.text}`;
    })
    .join("\n\n---\n\n");
}

export default function AgentSidebar({
  width,
  agentLabel,
  messages,
  sessions,
  currentSession,
  workspaces,
  activeWorkspaceId,
  compactUi,
  sessionOpen,
  onToggleSession,
  onNewSession,
  onSwitchSession,
  onDeleteSession,
  onOpenWorkspacePanel,
  onNotice,
  children,
}: AgentSidebarProps): React.JSX.Element {
  const tr = useT();
  const copyConversation = (): void => {
    const markdown = conversationToMarkdown(messages, tr);
    if (!markdown.trim()) {
      onNotice(tr("chat.copyConversationEmpty"));
      return;
    }
    void navigator.clipboard
      ?.writeText(markdown)
      .then(() => onNotice(tr("chat.copyConversationDone")))
      .catch(() => onNotice(tr("chat.copyFailed")));
  };

  const activeSession = sessions.find((x) => x.id === currentSession) ?? null;
  const currentWorkspaceId = activeSession?.workspaceId ?? activeWorkspaceId;
  const workspaceName = workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.name ?? tr("chat.workspaceFallback");

  return (
    <aside style={{ ...styles.sidebar, width }}>
      <div style={styles.sidebarHeader}>
        <span style={styles.sidebarTitle}>
          <Icon name="agent" size={14} style={{ marginRight: 6 }} />
          {tr("chat.sidebarTitle")}
        </span>
        <span style={styles.sidebarActions}>
          <button type="button" className="icon-btn" title={tr("chat.copyConversationTitle")} onClick={copyConversation}>
            <Icon name="file" size={13} />
          </button>
          <span style={styles.sidebarAgent}>{agentLabel}</span>
        </span>
      </div>
      <div style={styles.workspaceBar}>
        <button
          type="button"
          className="chip"
          style={{ ...styles.chip, ...styles.workspaceChip }}
          title={tr("chat.workspaceTitle")}
          onClick={onOpenWorkspacePanel}
        >
          <Icon name="folder" size={12} style={{ marginRight: 5 }} />
          <span style={styles.workspaceChipName}>{workspaceName}</span>
        </button>
        <button type="button" className="icon-btn" title={tr("chat.manageWorkspace")} onClick={onOpenWorkspacePanel}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      <div style={styles.sessionBar}>
        <span style={styles.anchor} data-popover-trigger>
          <button
            type="button"
            className="chip"
            style={{ ...styles.chip, maxWidth: 220, ...(compactUi ? styles.chipCompact : {}) }}
            onClick={onToggleSession}
            title={tr("chat.switchSessionTitle", {
              title: `${activeSession?.title ?? tr("chat.newSessionLabel")}${compactUi ? tr("chat.compactHint") : ""}`,
            })}
            aria-label={tr("chat.switchSessionAria")}
          >
            <Icon name="notes" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
            {compactUi ? null : activeSession?.title ?? tr("chat.newSessionLabel")}
          </button>
        </span>
        <button type="button" className="icon-btn" title={tr("chat.newSession")} onClick={onNewSession}>
          <Icon name="plus" size={13} />
        </button>
        {sessionOpen ? (
          <div data-popover style={styles.sessionMenu}>
            <div style={menuStyles.dropTitle}>{tr("chat.sessionHistory")}</div>
            {sessions.length === 0 ? <div style={menuStyles.dropEmpty}>{tr("chat.noSessions")}</div> : null}
            {sessions.map((x) => (
              <div key={x.id} style={styles.sessionRow}>
                <button
                  type="button"
                  className="model-item"
                  style={{ ...styles.sessionItem, ...(x.id === currentSession ? menuStyles.dropItemActive : {}) }}
                  onClick={() => onSwitchSession(x.id)}
                  title={x.preview}
                >
                  <span style={styles.sessionTitle}>{x.title}</span>
                  <span style={styles.sessionMeta}>{new Date(x.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                </button>
                <button type="button" className="icon-btn" title={tr("chat.deleteSession")} onClick={() => onDeleteSession(x.id)}>
                  <Icon name="close" size={11} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {children}
    </aside>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
  workspaceBar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 12px 6px",
  },
  workspaceChip: { flex: 1, minWidth: 0, justifyContent: "flex-start", fontSize: 11.5 },
  workspaceChipName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
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
  sessionBar: { position: "relative", display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderBottom: `1px solid ${BRAND.border}` },
  anchor: { position: "relative", display: "inline-flex" },
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
};
