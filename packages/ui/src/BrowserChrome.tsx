/**
 * 浏览器顶栏：后退/前进/刷新/历史 + 地址搜索框 + 下载/快照/设置 + 标签栏。
 * 纯展示 + 回调注入；历史/下载浮层由 App 传入（它们依赖各自的业务状态）。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import Popover from "./AnchoredPopover.js";
import type { TabState } from "./types.js";

export interface BrowserChromeProps {
  tabs: TabState[];
  address: string;
  currentUrl: string;
  omniboxRef?: React.RefObject<HTMLInputElement | null>;
  historyOpen: boolean;
  downloadsOpen: boolean;
  downloadsActive: boolean;
  historyPanel: React.ReactNode;
  downloadsPanel: React.ReactNode;
  onAddressChange: (value: string) => void;
  onNavigate: () => void;
  onBack: () => void;
  onForward: () => void;
  onToggleHistory: () => void;
  onToggleDownloads: () => void;
  onSnapshot: () => void;
  onOpenSettings: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}

export default function BrowserChrome({
  tabs,
  address,
  currentUrl,
  omniboxRef,
  historyOpen,
  downloadsOpen,
  downloadsActive,
  historyPanel,
  downloadsPanel,
  onAddressChange,
  onNavigate,
  onBack,
  onForward,
  onToggleHistory,
  onToggleDownloads,
  onSnapshot,
  onOpenSettings,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: BrowserChromeProps): React.ReactElement {
  const active = tabs.find((tab) => tab.active);
  const historyButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const downloadsButtonRef = React.useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <header style={{ ...styles.topBar, height: LAYOUT.TOP_BAR_HEIGHT }}>
        <div style={styles.navGroup}>
          <button type="button" className="icon-btn" title="后退" disabled={!active?.canBack} onClick={onBack}>
            <Icon name="back" size={16} />
          </button>
          <button type="button" className="icon-btn" title="前进" disabled={!active?.canForward} onClick={onForward}>
            <Icon name="forward" size={16} />
          </button>
          <button type="button" className="icon-btn" title="刷新" disabled={!currentUrl} onClick={onNavigate}>
            <Icon name="reload" size={16} />
          </button>
          <span style={styles.anchor} data-popover-trigger>
            <button ref={historyButtonRef} type="button" className="icon-btn" title="历史记录" onClick={onToggleHistory}>
              <Icon name="history" size={16} />
            </button>
            <Popover anchorRef={historyButtonRef} open={historyOpen} onClose={onToggleHistory} width={380}>
              {historyPanel}
            </Popover>
          </span>
        </div>

        <div style={styles.omniboxWrap}>
          <Icon name="search" size={14} style={styles.omniboxIcon} />
          <input
            value={address}
            onChange={(event) => onAddressChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onNavigate();
            }}
            ref={omniboxRef}
            placeholder="输入地址或搜索内容，回车导航…"
            style={styles.omnibox}
            aria-label="地址与搜索"
          />
          <button type="button" className="icon-btn" title="收藏（待接）" disabled style={styles.omniboxStar}>
            <Icon name="star" size={15} />
          </button>
        </div>

        <div style={styles.topActions}>
          <span style={styles.anchor} data-popover-trigger>
            <button
              ref={downloadsButtonRef}
              type="button"
              className="icon-btn"
              title="下载"
              onClick={onToggleDownloads}
              style={{ position: "relative" }}
            >
              <Icon name="download" size={17} />
              {downloadsActive ? <span style={styles.dlDot} /> : null}
            </button>
            <Popover anchorRef={downloadsButtonRef} open={downloadsOpen} onClose={onToggleDownloads} width={420}>
              {downloadsPanel}
            </Popover>
          </span>
          <button type="button" className="icon-btn" title={currentUrl ? "页面快照" : "先打开一个网页"} onClick={onSnapshot} disabled={!currentUrl}>
            <Icon name="capture" size={17} />
          </button>
          <button type="button" className="icon-btn" title="设置" onClick={onOpenSettings}>
            <Icon name="settings" size={17} />
          </button>
          <button type="button" className="icon-btn" title="更多（待接）" disabled>
            <Icon name="more" size={17} />
          </button>
        </div>
      </header>

      <div style={{ ...styles.tabBar, height: LAYOUT.TAB_BAR_HEIGHT }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-item${tab.active ? " is-active" : ""}`}
            style={{ ...styles.tab, ...(tab.active ? styles.tabActive : {}) }}
            onClick={() => onSelectTab(tab.id)}
            title={tab.url || tab.title}
          >
            <span style={styles.tabTitle}>{tab.title || "新建标签页"}</span>
            <button
              type="button"
              className="icon-btn tab-close"
              title="关闭标签"
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
        <button type="button" className="icon-btn" title="新建标签页" style={styles.tabAdd} onClick={onNewTab}>
          <Icon name="plus" size={13} />
        </button>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 10px",
    background: BRAND.inkRaised,
    borderBottom: `1px solid ${BRAND.border}`,
    flexShrink: 0,
  },
  navGroup: { display: "flex", gap: 2, flexShrink: 0 },
  anchor: { position: "relative", display: "inline-flex" },
  omniboxWrap: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 8,
    height: 30,
    padding: "0 6px 0 12px",
    borderRadius: 15,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    minWidth: 0,
  },
  omniboxIcon: { color: BRAND.linenFaint, flex: "none" },
  omnibox: {
    flex: 1,
    height: "100%",
    border: "none",
    outline: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 13,
    minWidth: 0,
  },
  omniboxStar: { width: 24, height: 24, flex: "none" },
  topActions: { display: "flex", gap: 2, flexShrink: 0 },
  dlDot: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: BRAND.ochreHover,
  },
  tabBar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 8px",
    background: BRAND.inkRaised,
    borderBottom: `1px solid ${BRAND.border}`,
    flexShrink: 0,
    overflowX: "auto",
    overflowY: "hidden",
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    maxWidth: 220,
    height: 26,
    padding: "0 6px 0 10px",
    borderRadius: 7,
    border: "1px solid transparent",
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    flex: "0 1 auto",
    minWidth: 0,
    transition: "background 120ms, color 120ms, border-color 120ms",
  },
  tabActive: { background: BRAND.inkPanel, borderColor: BRAND.borderStrong, color: BRAND.linen },
  tabTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tabClose: { width: 18, height: 18 },
  tabAdd: { width: 24, height: 24, flex: "none" },
};
