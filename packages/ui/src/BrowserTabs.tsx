/**
 * 最顶行标签页（Chrome/Edge 式）：与窗口控制按钮同一行，由 TitleBar 的 tabs 插槽渲染。
 *
 * 视觉契约（用户第 10 轮反馈）：
 *   · 非活动标签：透明底、次级文字色，不画任何描边/白框；
 *   · 活动标签：填充为工具条同色（与下一行导航栏连成一片），文字高亮；
 *   · 关闭按钮只在悬停时出现（预留宽度，不引起重排）；
 *   · 整条标签区都是 `no-drag`（WebkitAppRegion），否则点击标签会被当成拖动窗口。
 *
 * 纯展示：选择/关闭/新建全部由 App 注入，组件不碰浏览器状态。
 */
import * as React from "react";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import type { TabState } from "./types.js";

export interface BrowserTabsProps {
  tabs: TabState[];
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}

export default function BrowserTabs({
  tabs,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: BrowserTabsProps): React.ReactElement {
  const tr = useT();
  return (
    <div style={styles.strip} role="tablist" aria-label={tr("browser.tabsAria")}>
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
          <span style={styles.tabTitle}>{tab.title || tr("browser.startNewTabTitle")}</span>
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
  );
}

const styles: Record<string, React.CSSProperties> = {
  strip: {
    display: "flex",
    alignItems: "flex-end",
    gap: 2,
    height: "100%",
    minWidth: 0,
    overflow: "hidden",
    paddingLeft: 6,
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties,
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
  tabTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto" },
  tabClose: { width: 18, height: 18, flex: "none" },
  tabAdd: { width: 26, height: 26, flex: "none", marginBottom: 2, marginLeft: 2 },
};
