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
import { usePopover } from "./popover.js";
import SessionListPanel from "./SessionListPanel.js";
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
  /** 会话列表工作区/会话操作（Vibe 内嵌列表与普通下拉共用）。 */
  onNewSessionInWorkspace?: (workspaceId: string) => void;
  onRenameWorkspace?: (workspaceId: string, name: string) => void;
  onRemoveWorkspace?: (workspaceId: string) => void;
  onOpenWorkspaceFolder?: (workspaceId: string) => void;
  sessions: SessionMeta[];
  currentSession: string | null;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
  sessionOpen: boolean;
  /** 点会话 chip：刷新列表并切换下拉开合（App 侧组合两个动作）。 */
  onToggleSession: () => void;
  /** 收起会话历史下拉（usePopover 的点击外部 / dismissAllPopovers 统一收起时机回调）。 */
  onCloseSession: () => void;
  onNewSession: () => void;
  onSwitchSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string) => void;
  onForkSession?: (sessionId: string, keepCount: number) => void;
  onOpenWorkspacePanel: () => void;
  /** 会话列表底部「添加工作区」（原生文件夹选择器 → 新工作区 + 新会话）。 */
  onAddWorkspace?: () => void;
  onNotice: (text: string) => void;
  /** 新标签页/整页会话处于 Vibecoding：会话按钮平滑变成「会话列表」按钮。 */
  vibeMode?: boolean;
  /** 收起态竖条：悬停足够久或点条目后，展开侧栏并打开会话列表。 */
  onExpandFromRail?: () => void;
  /**
   * 宽度是否处于「拖拽/铺满」等实时跟随状态（true 时内容宽度立即跟手）。
   * false（模式/模式切换的 320ms 过渡）时内容宽度冻结到过渡结束，避免文字在过渡中被挤到换行。
   */
  /** Agent 独立小窗口内嵌：隐藏「小窗化」这类只属于主窗口的入口。 */
  embeddedInAgentWindow?: boolean;
  /** 消息列表 / 终端抽屉 / 输入区（保留在 App 装配）。 */
  children: React.ReactNode;
}

/** useT 返回的翻译函数类型（组件内传入，避免纯函数直接依赖 hook）。 */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 把当前会话导出为 Markdown（用户/AI 气泡 + 引用式思考过程）。
 *  导出/复制必须使用消息的权威全文（m.text / 完整 think 文本），不得用任何 preview/截断字段。 */
export function conversationToMarkdown(messages: ChatMessage[], tr: Translate): string {
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
  sessionOpen,
  onToggleSession,
  onCloseSession,
  onNewSession,
  onNewSessionInWorkspace,
  onRenameWorkspace,
  onRemoveWorkspace,
  onOpenWorkspaceFolder,
  onSwitchSession,
  onDeleteSession,
  onRenameSession,
  onForkSession,
  onAddWorkspace,
  onNotice,
  vibeMode = false,
  onExpandFromRail,
  embeddedInAgentWindow = false,
  children,
}: AgentSidebarProps): React.JSX.Element {
  const tr = useT();
  const isCollapsed = mode === "collapsed";
  // 会话历史下拉：走全局浮层协调（点击外部 / Esc / 其它浮层打开 / dismissAllPopovers 统一收起）。
  usePopover("app-session", sessionOpen, (next) => {
    if (!next) onCloseSession();
  });
  /** 收起态竖条悬停展开：判定时间刻意放长（1000ms），避免鼠标路过就弹开。 */
  const railTimerRef = React.useRef<number | null>(null);
  const cancelRailExpand = React.useCallback((): void => {
    if (railTimerRef.current !== null) {
      window.clearTimeout(railTimerRef.current);
      railTimerRef.current = null;
    }
  }, []);
  const scheduleRailExpand = React.useCallback((): void => {
    if (railTimerRef.current !== null) return;
    railTimerRef.current = window.setTimeout(() => {
      railTimerRef.current = null;
      onExpandFromRail?.();
    }, 1000);
  }, [onExpandFromRail]);
  React.useEffect(() => cancelRailExpand, [cancelRailExpand]);
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

  const collapseLabel = localized("chat.sidebarCollapse", "收起会话栏", "Collapse sidebar");
  const expandLabel = localized("chat.sidebarExpand", "展开会话栏", "Expand sidebar");
  const floatLabel = isFloat
    ? localized("chat.sidebarDock", "恢复常驻", "Dock sidebar")
    : localized("chat.sidebarFloat", "小窗化", "Float sidebar");

  const fill = width <= 0;
  /**
   * 内容宽度：与外层 wrapper 用同一条 320ms 过渡同步变化。
   * 之前「冻结内容宽度」会让变宽的那几帧出现「宽栏里窄内容贴右」的挤压感（用户 m06058）；
   * 现在 inner 与 wrapper 同曲线同帧收缩/展开，任何时候内容宽度都等于可见栏宽；拖拽/铺满时不过渡。
   */
  const contentWidth = fill ? "100%" : width;
  /**
   * 模式（搜索 ↔ Vibecoding）切换时：内容先隐藏，外层宽度过渡完成后再淡入。
   * 为什么需要它：即使 inner 与 wrapper 同曲线变宽，中途宽度仍会让标题/正文在「半宽」下重排一帧；
   * 用户 m06108 仍能截到挤压换行。隐藏内容（而非冻结宽度）既不会出现宽栏窄内容，也不会出现换行帧。
   */
  const [modeSwitching, setModeSwitching] = React.useState(false);
  /** 搜索↔Vibecoding 切换时先藏内容，动画结束再淡入（侧栏宽度动画恢复内容可见）。 */
  const contentMasked = modeSwitching;
  const prevVibeRef = React.useRef(vibeMode);
  // useLayoutEffect：必须在浏览器绘制前把内容藏起来。若用 useEffect，effect 在首帧 paint 之后才执行，
  // 某些调度时机下第一帧会带着「旧宽度内容 + 新宽度布局」被画出来（用户视频里概率出现的一帧挤压）。
  React.useLayoutEffect(() => {
    if (prevVibeRef.current === vibeMode) return;
    prevVibeRef.current = vibeMode;
    setModeSwitching(true);
    const timer = window.setTimeout(
      () => setModeSwitching(false),
      Number.parseInt(MOTION.sidebarDuration, 10) + 20,
    );
    return () => window.clearTimeout(timer);
  }, [vibeMode]);
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
            <span style={{ ...styles.toggleIconLayer, opacity: vibeMode ? 0 : 1, transform: vibeMode ? "scale(0.78)" : "scale(1)" }}>
              <Icon name="agent" size={16} />
            </span>
            <span
              style={{
                ...styles.toggleIconLayer,
                ...styles.toggleIconLayerOverlay,
                opacity: vibeMode ? 1 : 0,
                transform: vibeMode ? "scale(1)" : "scale(0.78)",
              }}
            >
              <Icon name="list-details" size={16} />
            </span>
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

      {/* 收起态简易会话列表：占住原先右侧那条空白竖列；悬停 1s 自动展开侧栏并打开会话列表 */}
      {isCollapsed && !fill ? (
        <div
          className="sidebar-collapsed-rail"
          style={styles.collapsedRail}
          onMouseEnter={scheduleRailExpand}
          onMouseLeave={cancelRailExpand}
          data-testid="sidebar-collapsed-rail"
        >
          {/* 展开按钮与会话列表之间的分隔线：中间实、两端渐隐（用户 2026-11-14）。 */}
          <span className="sidebar-rail-separator" aria-hidden="true" />
          <div style={styles.railSessions}>
            {sessions.slice(0, 9).map((session) => (
              <button
                key={session.id}
                type="button"
                className={`rail-item${session.id === currentSession ? " is-active" : ""}`}
                style={styles.railItem}
                title={`${session.title}${session.preview ? ` · ${session.preview.slice(0, 32)}` : ""}`}
                aria-label={session.title}
                onClick={() => {
                  onSwitchSession(session.id);
                  onExpandFromRail?.();
                }}
                data-testid="rail-session"
              >
                <span style={styles.railAvatar}>{(session.title.trim().charAt(0) || "·").toUpperCase()}</span>
              </button>
            ))}
          </div>
          <div style={styles.railSpacer} />
          <button
            type="button"
            className="icon-btn"
            style={styles.railAdd}
            title={tr("chat.newSession")}
            aria-label={tr("chat.newSession")}
            onClick={onNewSession}
            data-testid="rail-new"
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
      ) : null}

      {/* float 态外包 floatCard；collapsed 态整体 opacity:0 + pointer-events:none（常驻 DOM 不卸载） */}
      <div
        className={innerClassName}
        style={{
          ...styles.inner,
          ...(isFloat ? styles.floatCard : {}),
          width: contentWidth,
          transition: contentMasked
            ? `width ${MOTION.sidebarDuration} ${MOTION.ease}, opacity 0ms`
            : `width ${MOTION.sidebarDuration} ${MOTION.ease}, opacity 160ms ease`,
          opacity: isCollapsed || contentMasked ? 0 : 1,
          pointerEvents: isCollapsed || contentMasked ? "none" : "auto",
        }}
      >
        <div className="agent-sidebar-content" style={styles.content} aria-hidden={isCollapsed || undefined}>
          <div className="agent-sidebar-header" style={styles.sidebarHeader}>
            {embeddedInAgentWindow ? (
              <span data-popover-trigger style={{ display: "inline-flex" }}>
                <button
                  type="button"
                  className="icon-btn"
                  style={styles.miniSessionToggle}
                  title={tr("chat.sessionListTitle")}
                  aria-label={tr("chat.sessionListTitle")}
                  aria-pressed={sessionOpen}
                  data-testid="agent-mini-session-toggle"
                  onClick={onToggleSession}
                >
                  <Icon name="list-details" size={15} />
                </button>
              </span>
            ) : (
              <>
                <span style={styles.headerLeft}>
                  {vibeMode ? null : (
                    <span data-popover-trigger style={{ display: "inline-flex" }}>
                      <button
                        type="button"
                        className="icon-btn"
                        style={styles.miniSessionToggle}
                        title={tr("chat.sessionListTitle")}
                        aria-label={tr("chat.sessionListTitle")}
                        aria-pressed={sessionOpen}
                        data-testid="agent-sidebar-session-toggle"
                        onClick={onToggleSession}
                      >
                        <Icon name="list-details" size={15} />
                      </button>
                    </span>
                  )}
                <span style={styles.sidebarTitle}>
                  <Icon name={vibeMode ? "list-details" : "agent"} size={14} style={{ marginRight: 6 }} />
                  {vibeMode ? tr("chat.sessionListTitle") : tr("chat.sidebarTitle")}
                </span>
                </span>
                <span style={styles.sidebarActions}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: vibeMode ? 0 : 24,
                      opacity: vibeMode ? 0 : 1,
                      overflow: "hidden",
                      transition: "width 240ms ease, opacity 220ms ease",
                      pointerEvents: vibeMode ? "none" : "auto",
                    }}
                    aria-hidden={vibeMode || undefined}
                    data-testid="sidebar-copy-slot"
                  >
                    <button type="button" className="icon-btn" title={tr("chat.copyConversationTitle")} onClick={copyConversation}>
                      <Icon name="copy" size={13} />
                    </button>
                  </span>
                  <span style={styles.sidebarAgent}>{agentLabel}</span>
                  <span
                    style={{
                      display: embeddedInAgentWindow ? "none" : "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: vibeMode ? 0 : 26,
                      opacity: vibeMode ? 0 : 1,
                      overflow: "hidden",
                      transition: "width 240ms ease, opacity 220ms ease",
                      pointerEvents: vibeMode ? "none" : "auto",
                    }}
                    aria-hidden={vibeMode || embeddedInAgentWindow || undefined}
                    data-testid="sidebar-float-slot"
                  >
                    <button
                      type="button"
                      className="icon-btn sidebar-mode-btn"
                      title={floatLabel}
                      aria-label={floatLabel}
                      aria-pressed={isFloat}
                      onClick={() => onModeChange(isFloat ? "docked" : "float")}
                    >
                      <Icon name={isFloat ? "float-exit" : "float"} size={13} />
                    </button>
                  </span>
                </span>
              </>
            )}
          </div>
          {embeddedInAgentWindow ? (
            <div style={styles.miniBody}>
              {children}
              {sessionOpen ? (
                <div
                  className="agent-mini-session-overlay"
                  style={styles.miniSessionOverlay}
                  data-popover
                  data-testid="agent-mini-session-list"
                >
                  <SessionListPanel
                    sessions={sessions}
                    workspaces={workspaces}
                    currentSession={currentSession}
                    onSwitchSession={(sessionId) => {
                      onSwitchSession(sessionId);
                      onCloseSession();
                    }}
                    onDeleteSession={onDeleteSession}
                    onRenameSession={onRenameSession}
                    onForkSession={onForkSession}
                    onNewSession={() => {
                      onNewSession();
                      onCloseSession();
                    }}
                    onNewSessionInWorkspace={
                      onNewSessionInWorkspace
                        ? (workspaceId) => {
                            onNewSessionInWorkspace(workspaceId);
                            onCloseSession();
                          }
                        : undefined
                    }
                    onRenameWorkspace={onRenameWorkspace}
                    onRemoveWorkspace={onRemoveWorkspace}
                    onOpenWorkspaceFolder={onOpenWorkspaceFolder}
                    onAddWorkspace={onAddWorkspace}
                    onNotice={onNotice}
                    inline
                  />
                </div>
              ) : null}
            </div>
          ) : vibeMode ? (
            /* 会话已移到左侧主页；Vibecoding 下右侧栏就是「会话列表」本身（不再重复显示对话） */
            <div style={styles.vibeListWrap}>
              <SessionListPanel
                sessions={sessions}
                workspaces={workspaces}
                currentSession={currentSession}
                onSwitchSession={onSwitchSession}
                onDeleteSession={onDeleteSession}
                onNewSession={onNewSession}
                onNewSessionInWorkspace={onNewSessionInWorkspace}
                onRenameWorkspace={onRenameWorkspace}
                onRemoveWorkspace={onRemoveWorkspace}
                onOpenWorkspaceFolder={onOpenWorkspaceFolder}
                onAddWorkspace={onAddWorkspace}
                onNotice={onNotice}
                inline
              />
            </div>
          ) : (
            <>
              {children}
              {sessionOpen ? (
                <div
                  className="agent-mini-session-overlay"
                  style={styles.sidebarSessionOverlay}
                  data-popover
                  data-testid="agent-sidebar-session-list"
                >
                  <SessionListPanel
                    sessions={sessions}
                    workspaces={workspaces}
                    currentSession={currentSession}
                    onSwitchSession={(sessionId) => {
                      onSwitchSession(sessionId);
                      onCloseSession();
                    }}
                    onDeleteSession={onDeleteSession}
                    onRenameSession={onRenameSession}
                    onForkSession={onForkSession}
                    onNewSession={() => {
                      onNewSession();
                      onCloseSession();
                    }}
                    onNewSessionInWorkspace={
                      onNewSessionInWorkspace
                        ? (workspaceId) => {
                            onNewSessionInWorkspace(workspaceId);
                            onCloseSession();
                          }
                        : undefined
                    }
                    onRenameWorkspace={onRenameWorkspace}
                    onRemoveWorkspace={onRemoveWorkspace}
                    onOpenWorkspaceFolder={onOpenWorkspaceFolder}
                    onAddWorkspace={onAddWorkspace}
                    onNotice={onNotice}
                    inline
                  />
                </div>
              ) : null}
            </>
          )}
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
    position: "relative",
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
  /** 星标/列表图标双层：同尺寸、同位置交叉淡入 + 轻微缩放（平滑衔接，不跳变）。 */
  toggleIconLayer: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    height: 32,
    transition: "opacity 200ms ease, transform 200ms ease",
  },
  toggleIconLayerOverlay: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 16,
    height: 32,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
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
  vibeListWrap: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "2px 12px 12px" },
  /** 小窗头部：只留一个会话列表图标（点击展开/收起浮层列表）。 */
  miniSessionToggle: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    borderRadius: RADIUS.sm,
  },
  /** 小窗内容区：对话常驻，会话列表以浮层覆盖（不转换界面）。 */
  miniBody: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  },
  /** 小窗会话列表浮层：从头部下方展开，覆盖在对话之上；点外部/Esc/再点图标收起。 */
  miniSessionOverlay: {
    position: "absolute",
    left: 8,
    right: 8,
    // 高度固定为小窗内容区（实时）的约 1/4；窄窗再压一个 120px 下限，避免搜索框都放不下。
    height: "max(25%, 120px)",
    zIndex: 40,
    top: 52,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    padding: 8,
    background: BRAND.inkPanel,
    border: `1px solid ${BRAND.border}`,
    borderRadius: RADIUS.lg,
    // 用户 2026-11-14：展开列表四周的深色投影「黑不溜秋」，去掉；保留边框区分层次。
    overflow: "hidden",
  },
  /** 头部左侧：会话列表图标 + 标题。 */
  headerLeft: { display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 },
  /** 搜索页侧栏的会话列表浮层：从头部下方展开，覆盖部分对话（与悬浮窗同一套列表）。 */
  sidebarSessionOverlay: {
    position: "absolute",
    left: 8,
    right: 8,
    height: "min(420px, 55%)",
    zIndex: 40,
    top: 52,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    padding: 8,
    background: BRAND.inkPanel,
    border: `1px solid ${BRAND.border}`,
    borderRadius: RADIUS.lg,
    // 用户 2026-11-14：去掉四周深色投影（影响观感），保留边框。
    overflow: "hidden",
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

  chipDual: { position: "relative", display: "inline-flex", alignItems: "center", minWidth: 90, minHeight: 16 },
  chipLayer: { display: "inline-flex", alignItems: "center", transition: "opacity 180ms ease", pointerEvents: "none" },
  chipLayerOverlay: { position: "absolute", left: 0, top: 0, bottom: 0, right: 0, justifyContent: "flex-start" },
  collapsedRail: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: LAYOUT.SIDEBAR_COLLAPSED_WIDTH,
    zIndex: 2,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    // 分隔线上边界与网页内容区上边界齐平：窗口 y=96（标题栏 40 + 工具条 48 + 网页留白 8）→ 竖条内 56px；
    // 会话按钮从分隔线下方 9px 开始（56 + 1 + 9 = 66），避免与分隔线贴在一起（用户 2026-11-14）。
    padding: "66px 0 8px",
    boxSizing: "border-box",
    gap: 4,
  },
  railSpacer: { flex: 1 },
  railSessions: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minHeight: 0, overflow: "hidden" },
  railItem: {
    width: 30,
    height: 30,
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    // 用户 2026-11-14：不要再画框/加底色，只保留 hover 与选中高亮。
    // 注意：底色与文字色必须交给 index.html 的 .rail-item 规则 —— 内联样式优先级更高，
    // 一旦在这里写 background/color，:hover 就被压掉（曾导致悬浮无反馈）。
    border: "none",
    cursor: "pointer",
    padding: 0,
  },
  railItemActive: { color: BRAND.ochreHover },
  railAvatar: { fontSize: 11.5, fontWeight: 700, lineHeight: 1 },
  railAdd: {
    width: 30,
    height: 30,
    flex: "none",
    marginTop: 4,
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
