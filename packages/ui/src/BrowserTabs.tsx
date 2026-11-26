/**
 * 最顶行标签页（Chrome/Edge 式）：与窗口控制按钮同一行，由 TitleBar 的 tabs 插槽渲染。
 *
 * 视觉契约（用户第 10 轮反馈）：
 *   · 非活动标签：透明底、次级文字色，不画任何描边/白框；
 *   · 活动标签：填充为工具条同色（与下一行导航栏连成一片），文字高亮；
 *   · 关闭按钮只在悬停时出现（预留宽度，不引起重排）；
 *   · 整条标签区都是 `no-drag`（WebkitAppRegion），否则点击标签会被当成拖动窗口。
 *
 * Agent 工作区（Slice H）：Agent 打开/导航过的网页不再占用普通标签位，
 * 而是折叠进标签条最前面的一个 chip；点开在 chip 下方展开列表，点某项进入它所属的页面。
 *
 * 纯展示：选择/关闭/新建/展开全部由 App 注入，组件不碰浏览器状态。
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { BRAND, MOTION, RADIUS } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import type { TabState } from "./types.js";

export type TabMenuAction =
  | "new-right"
  | "reload"
  | "duplicate"
  | "mute"
  | "unmute"
  | "pin"
  | "unpin"
  | "close"
  | "reopen"
  | "close-others"
  | "close-right"
  | "copy-url";

export interface BrowserTabsProps {
  /** 普通标签（用户自己的标签；Agent 绑定标签已由调用方分到 boundTabs）。 */
  tabs: TabState[];
  /** Agent 工作区里的标签（顺序与宿主 listTabs 一致）。 */
  boundTabs: TabState[];
  /** 点 chip：由 App 打开独立浮层（网页既不消失也不被挤）。 */
  onToggleWorkspace: () => void;
  /** 关掉整个 Agent 工作区（chip 右侧 ×）：关闭全部绑定页，任务会话本身保留。 */
  onCloseWorkspace: () => void;
  onSelectTab: (tabId: string) => void;
  /** 拖拽重排：把 tabId 插到 targetTabId 左侧/右侧。 */
  onMoveTab: (tabId: string, targetTabId: string, after: boolean) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  /** 标签右键菜单动作统一交给 App：组件不直接碰 IPC，保持纯展示。 */
  onTabAction: (action: TabMenuAction, tabId: string) => void;
  /** 右键标签：交给 App 打开独立浮层窗口（浮在原生网页之上，不隐藏/不重绘网页）。 */
  onOpenTabMenu: (tabId: string, anchor: { x: number; y: number; width: number; height: number }) => void;
  /** 跨会话任务条：所有带 Agent 工作区的会话。 */
  agentTasks: { sessionId: string; tabs: TabState[] }[];
  /** 当前会话（当前任务的 chip 由 boundTabs 那条渲染，避免重复）。 */
  currentSessionId?: string | null;
  onOpenTask: (sessionId: string) => void;
}

function BrowserTabs({
  tabs,
  boundTabs,
  onToggleWorkspace,
  onCloseWorkspace,
  onSelectTab,
  onMoveTab,
  onCloseTab,
  onNewTab,
  onTabAction,
  onOpenTabMenu,
  agentTasks,
  currentSessionId,
  onOpenTask,
}: BrowserTabsProps): React.ReactElement {
  const tr = useT();
  const boundTabIds = new Set(boundTabs.map((tab) => tab.id));
  const [dragTabId, setDragTabId] = React.useState<string | null>(null);
  /** 拖拽期间的本地顺序：拖动时实时重排，松手才提交给宿主。 */
  const [dragOrder, setDragOrder] = React.useState<string[] | null>(null);
  /** 拖拽中的浮层标签：位置被限制在标签条内，绝不跟着鼠标跑到网页上。 */
  const [ghost, setGhost] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const stripRef = React.useRef<HTMLDivElement | null>(null);
  const tabElsRef = React.useRef(new Map<string, HTMLDivElement>());
  const prevRectsRef = React.useRef(new Map<string, number>());
  const flipPendingRef = React.useRef(false);
  const dragIdRef = React.useRef<string | null>(null);
  const dragOrderRef = React.useRef<string[] | null>(null);
  const ghostElRef = React.useRef<HTMLDivElement | null>(null);
  const pointerRef = React.useRef<{
    tabId: string;
    pointerId: number;
    startX: number;
    startY: number;
    grabOffset: number;
    stripRect: DOMRect;
    left: number;
    top: number;
    width: number;
    height: number;
    /** 右侧功能键/侧栏左缘：浮层最多到这里。 */
    maxRight: number;
    started: boolean;
  } | null>(null);

  const openMenu = (event: React.MouseEvent, tabId: string): void => {
    event.preventDefault();
    event.stopPropagation();
    onOpenTabMenu(tabId, { x: Math.round(event.clientX), y: Math.round(event.clientY), width: 1, height: 1 });
  };
  const orderedTabs = React.useMemo(() => {
    if (!dragOrder) return tabs;
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    const list = dragOrder.map((id) => byId.get(id)).filter((tab): tab is TabState => Boolean(tab));
    for (const tab of tabs) if (!dragOrder.includes(tab.id)) list.push(tab);
    return list;
  }, [dragOrder, tabs]);

  const commitDrag = React.useCallback((): void => {
    const source = dragIdRef.current;
    const order = dragOrderRef.current;
    dragIdRef.current = null;
    dragOrderRef.current = null;
    setDragTabId(null);
    setDragOrder(null);
    setGhost(null);
    if (!source || !order) return;
    if (order.join("\u0000") === tabs.map((tab) => tab.id).join("\u0000")) return;
    const index = order.indexOf(source);
    const nextId = order[index + 1];
    const prevId = order[index - 1];
    if (nextId) onMoveTab(source, nextId, false);
    else if (prevId) onMoveTab(source, prevId, true);
  }, [onMoveTab, tabs]);

  const cancelDrag = React.useCallback((): void => {
    dragIdRef.current = null;
    dragOrderRef.current = null;
    setDragTabId(null);
    setDragOrder(null);
    setGhost(null);
  }, []);

  const captureRects = React.useCallback((): void => {
    const rects = new Map<string, number>();
    for (const [id, el] of tabElsRef.current) rects.set(id, el.getBoundingClientRect().left);
    prevRectsRef.current = rects;
  }, []);

  // FLIP：顺序变化后让让位的标签从旧位置滑到新位置，而不是瞬移。
  React.useLayoutEffect(() => {
    if (!flipPendingRef.current) return;
    flipPendingRef.current = false;
    for (const [id, el] of tabElsRef.current) {
      if (id === dragTabId) continue;
      const prev = prevRectsRef.current.get(id);
      if (prev == null) continue;
      // 先停掉上一段 FLIP，再量布局位置，避免把动画中的 transform 当成新位置。
      for (const animation of el.getAnimations()) animation.cancel();
      const next = el.getBoundingClientRect().left;
      const delta = prev - next;
      if (Math.abs(delta) < 0.5) continue;
      el.animate(
        [{ transform: `translateX(${delta}px)` }, { transform: "translateX(0)" }],
        { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
  }, [dragOrder, dragTabId]);

  React.useEffect(() => {
    flipPendingRef.current = false;
  });

  const draggedTab = dragTabId ? orderedTabs.find((tab) => tab.id === dragTabId) ?? null : null;

  /** 指针落在哪个标签的哪一侧：以当前视觉顺序（orderedTabs）为准。 */
  const findTarget = (clientX: number, dragId: string): { id: string; after: boolean } | null => {
    let last: string | null = null;
    for (const tab of orderedTabs) {
      if (tab.id === dragId) continue;
      const el = tabElsRef.current.get(tab.id);
      if (!el) continue;
      last = tab.id;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return { id: tab.id, after: false };
    }
    return last ? { id: last, after: true } : null;
  };

  const reorderTo = (target: { id: string; after: boolean }, dragId: string): void => {
    const dragged = tabs.find((tab) => tab.id === dragId);
    const targetTab = tabs.find((tab) => tab.id === target.id);
    if (!dragged || !targetTab || (dragged.pinned === true) !== (targetTab.pinned === true)) return;
    const current = dragOrderRef.current;
    if (!current) return;
    const next = current.filter((id) => id !== dragId);
    const targetIndex = next.indexOf(target.id);
    if (targetIndex < 0) return;
    next.splice(target.after ? targetIndex + 1 : targetIndex, 0, dragId);
    if (next.join("\u0000") === current.join("\u0000")) return;
    captureRects();
    flipPendingRef.current = true;
    dragOrderRef.current = next;
    setDragOrder(next);
  };

  const beginPointer = (tab: TabState, event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("button")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const stripRect = stripRef.current?.getBoundingClientRect();
    if (!stripRect) return;
    // 右界 = 最小化按钮左侧；左界 = 标签条左缘（展开工作区按钮右侧）。
    const minimize = document.querySelector('[data-window-control="minimize"]');
    const maxRight = Math.max(stripRect.left, (minimize?.getBoundingClientRect().left ?? window.innerWidth) - 4);
    pointerRef.current = {
      tabId: tab.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabOffset: event.clientX - rect.left,
      stripRect,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      maxRight,
      started: false,
    };
    try {
      // 捕获在标签条上，而不是会被重排移动的标签本身：
      // 标签 DOM 一旦 insertBefore，元素级 pointer capture 可能丢失，拖动就“断”了。
      stripRef.current?.setPointerCapture(event.pointerId);
    } catch {
      // 指针已失效时忽略；后续 pointerup 仍会走取消路径。
    }
  };

  const movePointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const p = pointerRef.current;
    if (!p) return;
    if (!p.started) {
      if (Math.hypot(event.clientX - p.startX, event.clientY - p.startY) < 4) return;
      p.started = true;
      dragIdRef.current = p.tabId;
      dragOrderRef.current = tabs.map((item) => item.id);
      setDragTabId(p.tabId);
      setDragOrder(dragOrderRef.current);
      setGhost({ left: p.left, top: p.top, width: p.width, height: p.height });
    }
    event.preventDefault();
    const stripRect = p.stripRect;
    const left = Math.min(
      Math.max(event.clientX - p.grabOffset, p.stripRect.left),
      Math.max(p.stripRect.left, p.maxRight - p.width),
    );
    // 直接改 DOM transform，不走 setState：每帧移动不再触发整棵标签树重渲染。
    if (ghostElRef.current) ghostElRef.current.style.transform = `translate3d(${left}px, 0, 0)`;
    else setGhost((prev) => (prev ? { ...prev, left } : prev));
    // 只要还在拖，就按横向位置继续让位；指针划到标签条上方/下方也不中断挤压效果。
    const target = findTarget(event.clientX, p.tabId);
    if (target) reorderTo(target, p.tabId);
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const p = pointerRef.current;
    if (!p) return;
    pointerRef.current = null;
    try {
      stripRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // 已释放时忽略。
    }
    if (p.started) commitDrag();
    else onSelectTab(p.tabId);
  };

  const cancelPointer = React.useCallback((): void => {
    const p = pointerRef.current;
    pointerRef.current = null;
    if (p) {
      try {
        stripRef.current?.releasePointerCapture(p.pointerId);
      } catch {
        // 已释放时忽略。
      }
    }
    cancelDrag();
  }, [cancelDrag]);

  React.useEffect(() => {
    if (!dragTabId) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") cancelPointer();
    };
    const onBlur = (): void => cancelPointer();
    const onVisibility = (): void => {
      if (document.hidden) cancelPointer();
    };
    // 切到其他应用/最小化/指针捕获丢失时 pointerup 可能永远不来：主动复位。
    const onPointerEnd = (event: PointerEvent): void => {
      const strip = stripRef.current;
      if (!strip || !(event.target instanceof Node) || !strip.contains(event.target)) cancelPointer();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
    };
  }, [cancelPointer, dragTabId]);

  return (
    // strip 的 overflow:hidden 负责标签超宽裁切；右键菜单已改由独立浮层窗口渲染，
    // 不再需要为了露出 DOM 菜单而隐藏网页视图。
    <div style={styles.wrap}>
      <div
        ref={stripRef}
        style={styles.strip}
        role="tablist"
        aria-label={tr("browser.tabsAria")}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onPointerCancel={cancelPointer}
      >
        {agentTasks
          // 可见组的任务由 boundTabs 那条 chip 代表；即使 sessionId 还没对齐，
          // 只要它包含当前工作区的标签，也不能再画第二个「任务工作区」。
          .filter((task) => task.sessionId !== (currentSessionId ?? null) && !task.tabs.some((tab) => boundTabIds.has(tab.id)))
          .map((task) => (
            <button
              key={task.sessionId}
              type="button"
              style={styles.chip}
              title={tr("browser.agentWorkspace")}
              onClick={() => onOpenTask(task.sessionId)}
              data-agent-task={task.sessionId}
            >
              <Icon name="layers-linked" size={12} style={styles.chipIcon} />
              <span style={styles.chipLabel}>{tr("browser.taskWorkspace")}</span>
              <span style={styles.chipCount}>{task.tabs.length}</span>
            </button>
          ))}
        {boundTabs.length > 0 ? (
          <span className="workspace-chip-wrap" style={styles.chipWrap}>
            <button
              type="button"
              style={styles.chip}
              title={tr("browser.agentWorkspace")}
              aria-label={`${tr("browser.agentWorkspace")} · ${tr("browser.agentWorkspaceCount", { n: boundTabs.length })}`}
              aria-haspopup="menu"
              data-chrome-popover-trigger=""
              data-workspace-chip="1"
              onClick={onToggleWorkspace}
            >
              <Icon name="layers-linked" size={12} style={styles.chipIcon} />
              <span style={styles.chipLabel}>{tr("browser.agentWorkspace")}</span>
              <span style={styles.chipCount}>{tr("browser.agentWorkspaceCount", { n: boundTabs.length })}</span>
              <Icon name="chevron-down" size={10} style={{ flex: "none" }} />
            </button>
            <button
              type="button"
              className="workspace-chip-close"
              title={tr("browser.closeWorkspace")}
              aria-label={tr("browser.closeWorkspace")}
              data-workspace-close="1"
              onClick={(event) => {
                event.stopPropagation();
                onCloseWorkspace();
              }}
            >
              <Icon name="close" size={10} />
            </button>
          </span>
        ) : null}
        {orderedTabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.active}
            tabIndex={0}
            className={`tab-item${tab.active ? " is-active" : ""}`}
            ref={(el) => {
              if (el) tabElsRef.current.set(tab.id, el);
              else tabElsRef.current.delete(tab.id);
            }}
            style={{
              ...styles.tab,
              ...(dragTabId === tab.id ? { opacity: 0 } : null),
            }}
            title={tab.url || tab.title}
            onPointerDown={(event) => beginPointer(tab, event)}
            onContextMenu={(event) => openMenu(event, tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectTab(tab.id);
              }
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                onOpenTabMenu(tab.id, {
                  x: Math.round(rect.left),
                  y: Math.round(rect.top),
                  width: 300,
                  height: Math.max(1, Math.round(rect.height)),
                });
              }
            }}
          >
            {tab.pinned ? <Icon name="pin" size={11} style={styles.tabPinned} /> : null}
            {tab.url ? (
              tab.favicon ? (
                <img src={tab.favicon} alt="" width={14} height={14} style={styles.tabFavicon} />
              ) : (
                <span style={styles.tabLetter}>{(tab.title || tab.url).trim().charAt(0).toUpperCase() || "·"}</span>
              )
            ) : (
              <Icon name="globe" size={12} style={styles.tabFaviconFallback} />
            )}
            <span style={styles.tabTitle}>{tab.url || tab.pageKind ? tab.title : tr("browser.startNewTabTitle")}</span>
            {tab.audible || tab.muted ? (
              <button
                type="button"
                className="icon-btn tab-audio"
                title={tab.muted ? tr("browser.tabAudioUnmute") : tr("browser.tabAudioMute")}
                aria-label={tab.muted ? tr("browser.tabAudioUnmute") : tr("browser.tabAudioMute")}
                aria-pressed={tab.muted === true}
                style={styles.tabAudio}
                data-tab-audio={tab.muted ? "muted" : "audible"}
                onClick={(event) => {
                  event.stopPropagation();
                  onTabAction(tab.muted ? "unmute" : "mute", tab.id);
                }}
              >
                <Icon name={tab.muted ? "volume-x" : "volume-2"} size={18} />
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn tab-close"
              title={tr("browser.closeTab")}
              aria-label={tr("browser.closeTab")}
              style={styles.tabClose}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <Icon name="close" size={10} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="icon-btn"
          title={tr("browser.newTab")}
          aria-label={tr("browser.newTab")}
          style={{
            ...styles.tabAdd,
            opacity: dragTabId ? 0 : 1,
            pointerEvents: dragTabId ? "none" : "auto",
            transition: "opacity 120ms ease",
          }}
          onClick={onNewTab}
        >
          <Icon name="plus" size={13} />
        </button>
        {draggedTab && ghost ? createPortal(
          <div
            ref={ghostElRef}
            className="tab-item is-active"
            aria-hidden="true"
            style={{
              ...styles.tab,
              ...styles.ghost,
              left: 0,
              top: ghost.top,
              width: ghost.width,
              height: ghost.height,
              transform: `translate3d(${ghost.left}px, 0, 0)`,
            }}
          >
            {draggedTab.pinned ? <Icon name="pin" size={11} style={styles.tabPinned} /> : null}
            {draggedTab.url ? (
              draggedTab.favicon ? (
                <img src={draggedTab.favicon} alt="" width={14} height={14} style={styles.tabFavicon} />
              ) : (
                <span style={styles.tabLetter}>{(draggedTab.title || draggedTab.url).trim().charAt(0).toUpperCase() || "·"}</span>
              )
            ) : (
              <Icon name="globe" size={12} style={styles.tabFaviconFallback} />
            )}
            <span style={styles.tabTitle}>
              {draggedTab.url || draggedTab.pageKind ? draggedTab.title : tr("browser.startNewTabTitle")}
            </span>
            <Icon name="close" size={10} style={{ ...styles.tabClose, opacity: 1 }} />
          </div>,
          document.body,
        ) : null}
      </div>
    </div>
  );
}

export default React.memo(BrowserTabs);

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: "relative", display: "flex", alignItems: "flex-end", minWidth: 0, height: "100%" },
  strip: {
    position: "relative",
    display: "flex",
    alignItems: "flex-end",
    gap: 2,
    height: "100%",
    minWidth: 0,
    flex: "0 1 auto",
    overflow: "hidden",
    paddingLeft: 6,
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties,
  chipWrap: { position: "relative", display: "inline-flex", alignItems: "center", flex: "none" },
  chip: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 26,
    marginBottom: 2,
    padding: "0 9px",
    borderRadius: RADIUS.pill,
    // 无边框：交互反馈只用高亮（用户 m01968：反馈不要框，高亮就够了）。
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    flex: "none",
    maxWidth: 220,
    userSelect: "none",
    transition: MOTION.hover,
  },
  chipIcon: { flex: "none", color: BRAND.ochreHover },
  chipLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 },
  chipCount: { flex: "none", color: BRAND.linenFaint, fontSize: 11 },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    maxWidth: 200,
    minWidth: 84,
    padding: "0 6px 0 11px",
    borderRadius: "9px 9px 0 0",
    fontSize: 12,
    cursor: "pointer",
    flex: "0 1 auto",
    minHeight: 0,
    userSelect: "none",
    overflow: "hidden",
  },
  /** 拖拽浮层：固定到视口，但 top 锁定在标题栏；形状与真实标签一致（上圆下方、无边框/阴影），和下方工具栏连成一片。 */
  ghost: {
    position: "fixed",
    zIndex: 9999,
    pointerEvents: "none",
    borderRadius: "9px 9px 0 0",
    boxSizing: "border-box",
    opacity: 1,
    cursor: "grabbing",
  },
  tabFavicon: { flex: "none", borderRadius: 3, objectFit: "contain" },
  tabLetter: { flex: "none", width: 16, height: 16, borderRadius: 3, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.06)", color: BRAND.linenMuted, fontSize: 10, fontWeight: 700 },
  tabFaviconFallback: { flex: "none", color: BRAND.linenFaint },
  tabTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto" },
  tabPinned: { flex: "none", color: BRAND.linenFaint, transform: "rotate(45deg)" },
  tabAudio: { width: 20, height: 20, flex: "none", color: BRAND.linenMuted },
  tabClose: { width: 18, height: 18, flex: "none" },
  tabAdd: { width: 26, height: 26, flex: "none", marginBottom: 2, marginLeft: 2 },
};
