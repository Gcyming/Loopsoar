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
import { BRAND, MOTION, RADIUS, SHADOW } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import type { TabState } from "./types.js";

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
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  /** 跨会话任务条：所有带 Agent 工作区的会话。 */
  agentTasks: { sessionId: string; tabs: TabState[] }[];
  /** 当前会话（当前任务的 chip 由 boundTabs 那条渲染，避免重复）。 */
  currentSessionId?: string | null;
  onOpenTask: (sessionId: string) => void;
}

export default function BrowserTabs({
  tabs,
  boundTabs,
  onToggleWorkspace,
  onCloseWorkspace,
  onSelectTab,
  onCloseTab,
  onNewTab,
  agentTasks,
  currentSessionId,
  onOpenTask,
}: BrowserTabsProps): React.ReactElement {
  const tr = useT();
  const boundTabIds = new Set(boundTabs.map((tab) => tab.id));
  return (
    // wrap 才是绝对定位面板的包含块：strip 自己 overflow:hidden（标签超宽裁切），
    // 面板必须挂在 strip 之外，否则会被一起裁掉。
    <div style={styles.wrap}>
      <div style={styles.strip} role="tablist" aria-label={tr("browser.tabsAria")}>
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
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.active}
            tabIndex={0}
            className={`tab-item${tab.active ? " is-active" : ""}`}
            style={styles.tab}
            title={tab.url || tab.title}
            onClick={() => onSelectTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectTab(tab.id);
              }
            }}
          >
            {tab.url ? (
              tab.favicon ? (
                <img src={tab.favicon} alt="" width={14} height={14} style={styles.tabFavicon} />
              ) : (
                <span style={styles.tabLetter}>{(tab.title || tab.url).trim().charAt(0).toUpperCase() || "·"}</span>
              )
            ) : (
              <Icon name="globe" size={12} style={styles.tabFaviconFallback} />
            )}
            <span style={styles.tabTitle}>{tab.url ? tab.title : tr("browser.startNewTabTitle")}</span>
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
          style={styles.tabAdd}
          onClick={onNewTab}
        >
          <Icon name="plus" size={13} />
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: "relative", display: "flex", alignItems: "flex-end", minWidth: 0, height: "100%" },
  strip: {
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
  chipOpen: { background: BRAND.ochreSoft, color: BRAND.linen },
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
  tabFavicon: { flex: "none", borderRadius: 3, objectFit: "contain" },
  tabLetter: { flex: "none", width: 16, height: 16, borderRadius: 3, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.06)", color: BRAND.linenMuted, fontSize: 10, fontWeight: 700 },
  tabFaviconFallback: { flex: "none", color: BRAND.linenFaint },
  tabTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto" },
  tabClose: { width: 18, height: 18, flex: "none" },
  tabAdd: { width: 26, height: 26, flex: "none", marginBottom: 2, marginLeft: 2 },

  panelItemActive: { background: BRAND.ochreSoft },
  panelTitle: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  panelCheck: { flex: "none", color: BRAND.ochreHover },
  panelEmpty: { padding: "10px 9px", color: BRAND.linenFaint, fontSize: 12 },
};
