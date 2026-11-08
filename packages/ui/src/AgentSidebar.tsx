/**
 * Agent 侧栏外壳（从 App 抽出）：侧栏头部（复制会话 / Agent 名 / 收起 / 小窗化）+
 * 工作区条 + 会话切换条（含会话历史下拉与删除）+ 插槽 children（消息列表 / 终端 / 输入区）。
 *
 * 三态（由 App 通过 preferences.sidebarMode 持久化，组件只受控渲染）：
 *   · docked    常驻右侧（默认）；根节点 data-mode="docked"
 *   · collapsed 收起为 48px 竖条，只显示右上角的星标开关方块（点开即展开）；内容**不卸载**，
 *               用 opacity 淡出 + 指针禁用，宽度与透明度同步过渡 → 展开时布局不跳变
 *   · float     浮动小窗：外面包一层 `floatCard`（圆角/阴影/外边距由 .is-float/.floatCard 的 CSS 负责）
 *
 * 宽度所有权（避免「收起/展开位置反逻辑」）：
 *   · 外层 wrapper（App.tsx）拥有唯一可过渡的 width；本组件根节点恒为 width:100% 跟随父级，
 *     这样收起/展开时是父级裁切窗口在动，而不是组件内部宽度和父级各动一套（会被父级瞬间裁掉）。
 *   · 内容 `.agent-sidebar-inner` 固定为展开态基准宽度（`width` prop）并用 margin-left:auto 钉右缘：
 *     宽度变窄时裁掉左侧、内容不重排（slime 的不变式：右边栏始终钉住窗口右缘）。
 *   · 收起/展开开关 `.sidebar-toggle` 绝对定位在右上角，两态共用同一元素：
 *     收起 = 32×32 方块（仅星标）；展开 = 长方形（星标左移 + 右侧渐入收起箭头），
 *     宽度过渡时右缘固定，所以动作只有「向右展开 / 向左收起」一个方向。
 *
 * 约定类名（V1 主题任务按此写 CSS，组件只提供结构与内联骨架）：
 *   `.agent-sidebar[data-mode="docked|collapsed|float"]`、`.agent-sidebar.is-float`、`.agent-sidebar.is-collapsed`、
 *   `.agent-sidebar-inner`、`.agent-sidebar-content`、`.floatCard`、`.sidebar-toggle`、`.sidebar-mode-btn`
 *
 * 纯展示 + 受控 props：所有业务动作（切换会话、新建、删除、复制、打开工作区面板、模式切换）由 App 实现；
 * 宽度拖拽仍由 App 的 splitter 控制。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND, MOTION, NO_DRAG_REGION, RADIUS, SHADOW } from "./theme.js";
import { Icon } from "./Icon.js";
import { menuStyles } from "./BrowserMenus.js";
import Popover from "./AnchoredPopover.js";
import { getLanguage, useT } from "./i18n.js";
import type { ChatMessage } from "./chatStreamState.js";
import type { SessionMeta, SidebarMode, WorkspaceRecord } from "./types.js";
import type { TimelineStep } from "./timeline.js";

export interface AgentSidebarProps {
  /**
   * 内容基准宽度（px）：展开态下会话栏内容的固定宽度（收起/展开过程中不重排）。
   * 传 0 表示铺满父容器（Agent 独立窗口 / mini 模式）。
   */
  width: number;
  /** 侧栏模式：docked 常驻 / collapsed 收起 / float 小窗浮动（App 持久化到 preferences.sidebarMode）。 */
  mode: SidebarMode;
  /** 模式切换回调（收起/展开/小窗化按钮触发；App 负责持久化 + 原生视图宽度重算）。 */
  onModeChange: (mode: SidebarMode) => void;
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
      const who = m.role === "user" ? tr("chat.user") : "Loopsoar";
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
  mode,
  onModeChange,
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
  const isCollapsed = mode === "collapsed";
  const isFloat = mode === "float";

  /**
   * i18n 兜底：词典里还没有侧栏模式 key 时用中/英兜底文案（i18n 任务补 key 后自动切换）。
   * 不直接 tr(key) 是因为缺失 key 会回显 key 本身，界面上会很怪。
   */
  const localized = React.useCallback(
    (key: string, zh: string, en: string): string => {
      const text = tr(key);
      if (text !== key) return text;
      return getLanguage() === "en-US" ? en : zh;
    },
    [tr],
  );

  /** 会话下拉的锚点：展开态在会话 chip 上（Portal 按实际位置定位）。 */
  const sessionAnchorRef = React.useRef<HTMLSpanElement | null>(null);
  /** 记住收起前的非收起态（expand 时回到 docked 或 float，而不是永远 docked）。 */
  const lastExpandedModeRef = React.useRef<Exclude<SidebarMode, "collapsed">>("docked");
  React.useEffect(() => {
    if (mode !== "collapsed") lastExpandedModeRef.current = mode;
  }, [mode]);

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

  const collapseLabel = localized("chat.sidebarCollapse", "收起会话栏", "Collapse sidebar");
  const expandLabel = localized("chat.sidebarExpand", "展开会话栏", "Expand sidebar");
  const floatLabel = isFloat
    ? localized("chat.sidebarDock", "恢复常驻", "Dock sidebar")
    : localized("chat.sidebarFloat", "小窗化", "Float sidebar");

  const fill = width <= 0;
  const contentWidth = fill ? "100%" : width;
  const rootClassName = `agent-sidebar${isFloat ? " is-float" : ""}${isCollapsed ? " is-collapsed" : ""}`;
  const innerClassName = isFloat ? "floatCard agent-sidebar-inner" : "agent-sidebar-inner";

  return (
    <aside className={rootClassName} data-mode={mode} style={{ ...styles.sidebar, ...(isFloat ? styles.sidebarFloat : {}) }}>
      {/* 收起/展开开关：同一个绝对定位元素在两态间连续变形（右缘钉住窗口右边）。
          收起 = 32×32 圆角方块（仅 Loopsoar 星标）；展开 = 长方形，星标随容器左扩平滑左移，
          右侧让出的空间渐入「收起」箭头。点击方块展开、点击箭头收起，不再有两个分散的按钮。 */}
      {fill ? null : (
        <button
          type="button"
          className="sidebar-toggle"
          data-expanded={isCollapsed ? "false" : "true"}
          style={{
            ...styles.toggle,
            width: isCollapsed ? 32 : 62,
          }}
          title={isCollapsed ? expandLabel : collapseLabel}
          aria-label={isCollapsed ? expandLabel : collapseLabel}
          aria-expanded={!isCollapsed}
          onClick={() => onModeChange(isCollapsed ? lastExpandedModeRef.current : "collapsed")}
        >
          <span style={styles.toggleStar} aria-hidden="true">
            <Icon name="agent" size={16} />
          </span>
          <span
            style={{
              ...styles.toggleChevron,
              opacity: isCollapsed ? 0 : 1,
              transitionDelay: isCollapsed ? "0ms" : "90ms",
            }}
            aria-hidden="true"
          >
            <Icon name="forward" size={12} />
          </span>
        </button>
      )}

      {/* float 态外包 floatCard；collapsed 态整体 opacity:0 + pointer-events:none（常驻 DOM 不卸载） */}
      <div
        className={innerClassName}
        style={{
          ...styles.inner,
          ...(isFloat ? styles.floatCard : {}),
          width: contentWidth,
          opacity: isCollapsed ? 0 : 1,
          pointerEvents: isCollapsed ? "none" : "auto",
        }}
      >
        <div className="agent-sidebar-content" style={styles.content} aria-hidden={isCollapsed || undefined}>
          <div className="agent-sidebar-header" style={styles.sidebarHeader}>
            <span style={styles.sidebarTitle}>
              <Icon name="agent" size={14} style={{ marginRight: 6 }} />
              {tr("chat.sidebarTitle")}
            </span>
            <span style={styles.sidebarActions}>
              <button type="button" className="icon-btn" title={tr("chat.copyConversationTitle")} onClick={copyConversation}>
                <Icon name="file" size={13} />
              </button>
              <span style={styles.sidebarAgent}>{agentLabel}</span>
              <button
                type="button"
                className="icon-btn sidebar-mode-btn"
                title={floatLabel}
                aria-label={floatLabel}
                aria-pressed={isFloat}
                onClick={() => onModeChange(isFloat ? "docked" : "float")}
              >
                <Icon name={isFloat ? "maximize" : "restore"} size={13} />
              </button>
            </span>
          </div>
          <div className="agent-sidebar-workspace" style={styles.workspaceBar}>
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
          <div className="agent-sidebar-sessionbar" style={styles.sessionBar}>
            <span ref={sessionAnchorRef} style={styles.anchor} data-popover-trigger>
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
            {/* 会话历史下拉：Portal + placePopover 定位（原 absolute 在窗口边缘会被裁切） */}
            <Popover
              anchorRef={sessionAnchorRef}
              open={sessionOpen}
              onClose={() => undefined}
              width={300}
            >
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
            </Popover>
          </div>
          {children}
        </div>
      </div>
    </aside>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    display: "flex",
    flexDirection: "column",
    position: "relative",
    flexShrink: 0,
    // 宽度由外层 wrapper 唯一拥有（收起/展开靠父级 width 过渡 + overflow 裁切）；
    // 这里恒为 100%，不能再自己再动一套 width（父级会瞬间裁掉，动画就看不见了）。
    width: "100%",
    minWidth: 0,
    overflow: "hidden",
    boxSizing: "border-box",
    // 会话栏这一竖行与第二行网址工具条同底色（BRAND.inkRaised = --ls-surface-raised），
    // 两行拼成同一块抬高的面；地址栏胶囊则用更暗的 ink 内凹其中。
    borderLeft: "none",
    background: BRAND.inkRaised,
    // 只过渡颜色类属性：width 由父级驱动，不能在本节点再过渡（否则每一帧都落后于父级）
    transition: `opacity ${MOTION.sidebarDuration} ${MOTION.ease}, border-radius ${MOTION.sidebarDuration} ${MOTION.ease}, box-shadow ${MOTION.sidebarDuration} ${MOTION.ease}`,
  },
  /** 小窗：外层透明，卡片视觉交给 floatCard（CSS 负责 8px 外边距与视口宽度夹取）。 */
  sidebarFloat: {
    background: "transparent",
    borderLeft: "none",
  },
  inner: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    // 内容固定为展开态宽度（由 width prop 内联），收起过程中由父级 overflow 裁掉左侧：
    // 文字不重排、不换行，展开时也不会出现「先挤扁再撑开」的跳变。
    minWidth: 0,
    marginLeft: "auto",
    transition: `opacity ${MOTION.sidebarDuration} ${MOTION.ease}`,
  },
  /** 浮动卡片骨架：圆角/阴影用主题 token（与 V1 设计规范一致，CSS 可再覆写）。 */
  floatCard: {
    minWidth: 0,
    minHeight: 0,
    background: BRAND.inkPanel,
    borderRadius: RADIUS.lg,
    boxShadow: SHADOW.float,
    overflow: "hidden",
  },
  content: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  },
  /**
   * 收起/展开开关：两态共用的绝对定位元素。右缘固定（right:8），宽度 32↔62 变化时
   * 容器只会向左生长，所以视觉动作始终是「向右展开 / 向左收起」一个方向。
   * 星标绝对 left:8 会随容器左缘一起左移；收起箭头绝对 right:8，在腾出的右半边渐入。
   */
  toggle: {
    position: "absolute",
    top: 8,
    right: 8,
    zIndex: 3,
    display: "flex",
    alignItems: "center",
    height: 32,
    padding: 0,
    border: "none",
    borderRadius: RADIUS.sm,
    cursor: "pointer",
    overflow: "hidden",
    ...NO_DRAG_REGION,
    // 底/字色由 index.html 的 .sidebar-toggle 规则提供（内联 background 会压过 hover 反馈）
    transition: `width ${MOTION.sidebarDuration} ${MOTION.ease}`,
  },
  toggleStar: {
    position: "absolute",
    left: 8,
    top: 0,
    bottom: 0,
    display: "inline-flex",
    alignItems: "center",
  },
  toggleChevron: {
    position: "absolute",
    right: 8,
    top: 0,
    bottom: 0,
    display: "inline-flex",
    alignItems: "center",
    transition: "opacity 160ms ease",
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    // 纵向拉长到与第二行网址工具条同高：会话栏头部按钮与网页工具条处在同一横带，
    // 不再缩在列顶，顶部的「两块面」因此连成一条。
    height: LAYOUT.TOP_BAR_HEIGHT,
    // 右侧留出绝对定位的收起/展开开关宽度（62px + 右缘 8px + 间距 8px），按钮不会互相压住。
    padding: "0 78px 0 12px",
    fontWeight: 600,
    fontSize: 13,
    color: BRAND.linen,
  },
  sidebarTitle: { display: "inline-flex", alignItems: "center" },
  sidebarAgent: { fontSize: 11, color: BRAND.linenFaint, fontWeight: 400 },
  sidebarActions: { display: "inline-flex", alignItems: "center", gap: 6 },
  workspaceBar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 12px 4px",
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
  sessionBar: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 10px 8px",
    // 减噪：会话条不再用边框分隔，靠留白区分
  },
  anchor: { position: "relative", display: "inline-flex" },
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
