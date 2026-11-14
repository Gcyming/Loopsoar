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
  /** 工作区列表是否展开（展开时 App 还会隐藏原生网页视图，见 browser:setOverlay）。 */
  workspaceExpanded: boolean;
  onToggleWorkspace: () => void;
  onSelectBoundTab: (tabId: string) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}

export default function BrowserTabs({
  tabs,
  boundTabs,
  workspaceExpanded,
  onToggleWorkspace,
  onSelectBoundTab,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: BrowserTabsProps): React.ReactElement {
  const tr = useT();
  return (
    // wrap 才是绝对定位面板的包含块：strip 自己 overflow:hidden（标签超宽裁切），
    // 面板必须挂在 strip 之外，否则会被一起裁掉。
    <div style={styles.wrap}>
      <div style={styles.strip} role="tablist" aria-label={tr("browser.tabsAria")}>
        {boundTabs.length > 0 ? (
          <button
            type="button"
            style={{ ...styles.chip, ...(workspaceExpanded ? styles.chipOpen : null) }}
            title={tr("browser.agentWorkspace")}
            aria-label={`${tr("browser.agentWorkspace")} · ${tr("browser.agentWorkspaceCount", { n: boundTabs.length })}`}
            aria-expanded={workspaceExpanded}
            aria-haspopup="menu"
            onClick={onToggleWorkspace}
          >
            <Icon name="layers-linked" size={12} style={styles.chipIcon} />
            <span style={styles.chipLabel}>{tr("browser.agentWorkspace")}</span>
            <span style={styles.chipCount}>{tr("browser.agentWorkspaceCount", { n: boundTabs.length })}</span>
            <Icon
              name="chevron-down"
              size={10}
              style={{
                flex: "none",
                transform: workspaceExpanded ? "rotate(180deg)" : "none",
                transition: `transform ${MOTION.fast} ${MOTION.ease}`,
              }}
            />
          </button>
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
      {workspaceExpanded ? (
        <div style={styles.panel} role="menu" aria-label={tr("browser.agentWorkspace")}>
          {boundTabs.length === 0 ? (
            <div style={styles.panelEmpty}>{tr("browser.agentWorkspaceEmpty")}</div>
          ) : (
            boundTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="menuitem"
                style={{ ...styles.panelItem, ...(tab.active ? styles.panelItemActive : null) }}
                title={tab.url || tab.title}
                onClick={() => onSelectBoundTab(tab.id)}
              >
                {tab.favicon ? (
                  <img src={tab.favicon} alt="" width={14} height={14} style={styles.tabFavicon} />
                ) : (
                  <span style={styles.tabLetter}>{(tab.title || tab.url || "·").trim().charAt(0).toUpperCase() || "·"}</span>
                )}
                <span style={styles.panelTitle}>{tab.title || tab.url}</span>
                {tab.active ? <Icon name="check" size={12} style={styles.panelCheck} /> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
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
  chip: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 26,
    marginBottom: 2,
    padding: "0 9px",
    borderRadius: RADIUS.pill,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.inkPanel,
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    flex: "none",
    maxWidth: 220,
    userSelect: "none",
    transition: MOTION.hover,
  },
  chipOpen: { background: BRAND.ochreSoft, borderColor: BRAND.ochre, color: BRAND.linen },
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
  panel: {
    position: "absolute",
    top: "100%",
    left: 0,
    minWidth: 280,
    maxHeight: 320,
    overflow: "auto",
    zIndex: 60,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: 6,
    borderRadius: RADIUS.md,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxShadow: SHADOW.card,
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties,
  panelItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 9px",
    border: "none",
    borderRadius: RADIUS.sm,
    background: "transparent",
    color: BRAND.linen,
    fontSize: 12,
    textAlign: "left",
    cursor: "pointer",
    transition: MOTION.hover,
  },
  panelItemActive: { background: BRAND.ochreSoft },
  panelTitle: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  panelCheck: { flex: "none", color: BRAND.ochreHover },
  panelEmpty: { padding: "10px 9px", color: BRAND.linenFaint, fontSize: 12 },
};
