/**
 * 浏览器顶栏：后退/前进/刷新/历史/收藏 + 地址搜索框 + 下载/保存页面/快照/设置 + 标签栏。
 *
 * 后退/前进/历史/下载/保存/快照仍走 App 回调（依赖各自的业务状态）；
 * 收藏（书签）是本组件自己的浏览器功能：经 preload 的 bookmarks 域拉列表，
 * 星标按「当前页是否已收藏」高亮，点击即 add/remove，浮层里可跳转或删除。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import Popover from "./AnchoredPopover.js";
import { usePopover } from "./popover.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { useT } from "./i18n.js";
import type { BookmarkItem, TabState } from "./types.js";

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
  /** 刷新当前页（走 browser:reload，不是重新导航）。 */
  onReload: () => void;
  onToggleHistory: () => void;
  onToggleDownloads: () => void;
  /** 保存当前页面 HTML 全页（App 负责 toast 路径）。 */
  onSavePage: () => void;
  onSnapshot: () => void;
  onOpenSettings: () => void;
  /** 打开一条书签（当前标签导航）。 */
  onOpenBookmark: (url: string) => void;
  /** 面板内操作提示（收藏/删除结果）。 */
  onNotice: (text: string) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}

/** 书签同一性判据：忽略 URL hash 与末尾斜杠（同页锚点不产生第二条书签）。 */
function pageKey(url: string): string {
  const trimmed = url.trim().replace(/#.*$/, "");
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
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
  onReload,
  onToggleHistory,
  onToggleDownloads,
  onSavePage,
  onSnapshot,
  onOpenSettings,
  onOpenBookmark,
  onNotice,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: BrowserChromeProps): React.ReactElement {
  const api = useLoopsoarApi();
  const tr = useT();
  const active = tabs.find((tab) => tab.active);
  const historyButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const downloadsButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const bookmarkListRef = React.useRef<HTMLButtonElement | null>(null);

  const [bookmarks, setBookmarks] = React.useState<BookmarkItem[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = React.useState(false);
  // 与历史/下载/输入区菜单共用全局浮层仲裁：同一时刻只展开一个
  usePopover("browser-bookmarks", bookmarksOpen, setBookmarksOpen);

  const refreshBookmarks = React.useCallback(async (): Promise<void> => {
    if (!api?.bookmarks) {
      setBookmarks([]);
      return;
    }
    try {
      const result = await api.bookmarks.list();
      setBookmarks(Array.isArray(result?.bookmarks) ? result.bookmarks : []);
    } catch {
      setBookmarks([]); // 旧 shell 未装配书签域：静默空列表，不影响浏览
    }
  }, [api]);

  // 挂载 / 页面切换时刷新（决定星标高亮）；浮层展开时再拉一次（别处可能新增过）
  React.useEffect(() => {
    void refreshBookmarks();
  }, [refreshBookmarks, currentUrl]);
  React.useEffect(() => {
    if (bookmarksOpen) void refreshBookmarks();
  }, [bookmarksOpen, refreshBookmarks]);

  /** 仅 http/https 页面可收藏（书签 store 也只接受这两种协议）。 */
  const canBookmark = /^https?:\/\//i.test(currentUrl);
  const currentBookmark = React.useMemo(() => {
    if (!canBookmark) return null;
    const key = pageKey(currentUrl);
    return bookmarks.find((item) => pageKey(item.url) === key) ?? null;
  }, [bookmarks, canBookmark, currentUrl]);

  const toggleBookmark = React.useCallback(async (): Promise<void> => {
    if (!api?.bookmarks || !currentUrl || !canBookmark) return;
    try {
      if (currentBookmark) {
        const result = await api.bookmarks.remove({ id: currentBookmark.id });
        setBookmarks((prev) => prev.filter((item) => item.id !== currentBookmark.id));
        onNotice(result?.ok ? tr("browser.bookmarkRemoved") : tr("browser.bookmarkMissing"));
        return;
      }
      const result = await api.bookmarks.add({
        url: currentUrl,
        ...(active?.title ? { title: active.title } : {}),
      });
      if (!result?.ok) {
        onNotice(tr("browser.bookmarkAddFailed", { error: result?.error ?? tr("common.unknownError") }));
        return;
      }
      onNotice(result.duplicate ? tr("browser.bookmarkExists") : tr("browser.bookmarkAdded"));
      await refreshBookmarks();
    } catch (err) {
      onNotice(tr("browser.bookmarkAddFailed", { error: err instanceof Error ? err.message : String(err) }));
    }
  }, [api, active?.title, canBookmark, currentBookmark, currentUrl, onNotice, refreshBookmarks, tr]);

  const removeBookmark = React.useCallback(
    async (item: BookmarkItem): Promise<void> => {
      if (!api?.bookmarks) return;
      try {
        const result = await api.bookmarks.remove({ id: item.id });
        setBookmarks((prev) => prev.filter((x) => x.id !== item.id));
        onNotice(result?.ok ? tr("browser.bookmarkRemoved") : tr("browser.bookmarkMissing"));
      } catch (err) {
        onNotice(tr("browser.bookmarkRemoveFailed", { error: err instanceof Error ? err.message : String(err) }));
      }
    },
    [api, onNotice, tr],
  );

  return (
    <>
      <header style={{ ...styles.topBar, height: LAYOUT.TOP_BAR_HEIGHT }}>
        <div style={styles.navGroup}>
          <button type="button" className="icon-btn" title={tr("browser.back")} disabled={!active?.canBack} onClick={onBack}>
            <Icon name="back" size={16} />
          </button>
          <button type="button" className="icon-btn" title={tr("browser.forward")} disabled={!active?.canForward} onClick={onForward}>
            <Icon name="forward" size={16} />
          </button>
          <button type="button" className="icon-btn" title={tr("browser.reload")} disabled={!currentUrl} onClick={onReload}>
            <Icon name="reload" size={16} />
          </button>
          <span style={styles.anchor} data-popover-trigger>
            <button ref={historyButtonRef} type="button" className="icon-btn" title={tr("browser.history")} onClick={onToggleHistory}>
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
            placeholder={tr("browser.addressPlaceholder")}
            style={styles.omnibox}
            aria-label={tr("browser.addressAria")}
          />
          <span style={styles.starWrap} data-popover-trigger>
            <button
              type="button"
              className={`icon-btn${currentBookmark ? " is-bookmarked" : ""}`}
              style={styles.omniboxStar}
              title={
                !canBookmark
                  ? tr("browser.bookmarkUnavailable")
                  : currentBookmark
                    ? tr("browser.bookmarkRemove")
                    : tr("browser.bookmarkAdd")
              }
              aria-label={currentBookmark ? tr("browser.bookmarkRemove") : tr("browser.bookmarkAdd")}
              aria-pressed={Boolean(currentBookmark)}
              disabled={!canBookmark}
              onClick={() => void toggleBookmark()}
            >
              <Icon name={currentBookmark ? "star-filled" : "star"} size={15} />
            </button>
            <button
              ref={bookmarkListRef}
              type="button"
              className="icon-btn bookmark-list-btn"
              style={styles.bookmarkListBtn}
              title={tr("browser.bookmarkList")}
              aria-label={tr("browser.bookmarkList")}
              onClick={() => setBookmarksOpen((value) => !value)}
            >
              <Icon name="more" size={13} />
            </button>
            <Popover anchorRef={bookmarkListRef} open={bookmarksOpen} onClose={() => setBookmarksOpen(false)} width={340}>
              <div className="bookmark-panel">
                <div className="bookmark-head">
                  <span>{tr("browser.bookmarks")}</span>
                  <span className="bookmark-count">{bookmarks.length}</span>
                </div>
                {bookmarks.length === 0 ? (
                  <div className="bookmark-empty">{tr("browser.bookmarkEmpty")}</div>
                ) : (
                  <div className="bookmark-list" aria-label={tr("browser.bookmarkList")}>
                    {bookmarks.map((item) => (
                      <div key={item.id} className="bookmark-row">
                        <button
                          type="button"
                          className="bookmark-open"
                          title={item.url}
                          onClick={() => {
                            onOpenBookmark(item.url);
                            setBookmarksOpen(false);
                          }}
                        >
                          <span className="bookmark-title">{item.title || item.url}</span>
                          <span className="bookmark-url">{item.url}</span>
                        </button>
                        <button
                          type="button"
                          className="icon-btn bookmark-del"
                          title={tr("browser.bookmarkDelete")}
                          aria-label={tr("browser.bookmarkDeleteAria", { label: item.title || item.url })}
                          onClick={() => void removeBookmark(item)}
                        >
                          <Icon name="close" size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Popover>
          </span>
        </div>

        <div style={styles.topActions}>
          <span style={styles.anchor} data-popover-trigger>
            <button
              ref={downloadsButtonRef}
              type="button"
              className="icon-btn"
              title={tr("browser.downloads")}
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
          <button
            type="button"
            className="icon-btn"
            title={currentUrl ? tr("browser.savePage") : tr("browser.openPageFirst")}
            aria-label={tr("browser.savePage")}
            onClick={onSavePage}
            disabled={!currentUrl}
          >
            <Icon name="file" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={currentUrl ? tr("browser.snapshot") : tr("browser.openPageFirst")}
            onClick={onSnapshot}
            disabled={!currentUrl}
          >
            <Icon name="capture" size={17} />
          </button>
          <button type="button" className="icon-btn" title={tr("browser.browserSettings")} onClick={onOpenSettings}>
            <Icon name="settings" size={17} />
          </button>
          <button type="button" className="icon-btn" title={tr("browser.morePending")} disabled>
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
            <span style={styles.tabTitle}>{tab.title || tr("browser.startNewTabTitle")}</span>
            <button
              type="button"
              className="icon-btn tab-close"
              title={tr("browser.closeTab")}
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
        <button type="button" className="icon-btn" title={tr("browser.newTab")} style={styles.tabAdd} onClick={onNewTab}>
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
  starWrap: { position: "relative", display: "inline-flex", alignItems: "center", flex: "none" },
  omniboxStar: { width: 24, height: 24, flex: "none" },
  bookmarkListBtn: { width: 18, height: 24, flex: "none", opacity: 0.75 },
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
