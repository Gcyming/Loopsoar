/**
 * 浏览器顶栏（精简版）：后退/前进/刷新 + 地址搜索框（内嵌收藏星标）+ 快照/更多 + 标签栏。
 *
 * 布局约定（用户反馈「太杂乱」后收敛）：
 *   · 左侧只留导航三键；地址栏内右侧只留收藏星标；
 *   · 右侧只留「快照」和「更多（⋯）」；原下载/保存页面/设置/书签列表全部收进「更多」菜单；
 *   · 历史记录/下载仍由 App 持有开合状态（onToggleHistory / onToggleDownloads），
 *     其浮层仍在本组件渲染，锚点改为「更多」按钮。
 *
 * 遮挡修复：本组件任何浮层（更多/收藏夹，以及 App 持有的历史/下载浮层）打开时
 * 通过 onOverlayChange(true) 通知 App 隐藏原生 WebContentsView，关闭时再通知 false
 * （关闭通知做 150ms 合并，避免菜单项触发历史/下载时「先关假、后开真」的闪烁）。
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
  /** 「更多 → 设置」；未接入时该菜单项禁用（可选，便于逐步接线）。 */
  onOpenSettings?: () => void;
  /** 打开一条书签（当前标签导航）。 */
  onOpenBookmark: (url: string) => void;
  /** 面板内操作提示（收藏/删除结果）。 */
  onNotice: (text: string) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  /**
   * 本组件浮层开合通知：任一浮层（更多/收藏夹/历史/下载）打开 → true，
   * 全部关闭 → false。App 用它调 browser.setOverlay 隐藏原生 WebContentsView，
   * 否则菜单会被网页区域盖住。
   */
  onOverlayChange?: (open: boolean) => void;
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
  onOverlayChange,
}: BrowserChromeProps): React.ReactElement {
  const api = useLoopsoarApi();
  const tr = useT();
  const active = tabs.find((tab) => tab.active);
  /** 「更多」按钮：同时作为菜单 / 历史 / 下载 / 收藏夹浮层的锚点（精简后都收在这里）。 */
  const moreButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  const [bookmarks, setBookmarks] = React.useState<BookmarkItem[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  // 与历史/下载/输入区菜单共用全局浮层仲裁：同一时刻只展开一个
  usePopover("browser-bookmarks", bookmarksOpen, setBookmarksOpen);
  usePopover("browser-more", moreOpen, setMoreOpen);

  /** 用 ref 转存回调：App 传内联箭头函数时也不会让下面的 effect 反复重建/抖动。 */
  const overlayChangeRef = React.useRef(onOverlayChange);
  overlayChangeRef.current = onOverlayChange;

  /** 本组件全部浮层：任一打开都需要 App 隐藏原生 WebContentsView（否则菜单被网页盖住）。 */
  const overlayOpen = moreOpen || bookmarksOpen || historyOpen || downloadsOpen;
  const hideOverlayTimerRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (overlayOpen) {
      if (hideOverlayTimerRef.current !== null) {
        window.clearTimeout(hideOverlayTimerRef.current);
        hideOverlayTimerRef.current = null;
      }
      overlayChangeRef.current?.(true);
      return undefined;
    }
    // 关闭合并 150ms：菜单项「关菜单 → 开历史/下载」的连续状态只通知一次 true
    if (hideOverlayTimerRef.current !== null) window.clearTimeout(hideOverlayTimerRef.current);
    hideOverlayTimerRef.current = window.setTimeout(() => {
      hideOverlayTimerRef.current = null;
      overlayChangeRef.current?.(false);
    }, 150);
    return () => {
      if (hideOverlayTimerRef.current !== null) {
        window.clearTimeout(hideOverlayTimerRef.current);
        hideOverlayTimerRef.current = null;
      }
    };
  }, [overlayOpen]);

  // 「更多」菜单键盘可达：打开聚焦第一项，关闭把焦点还给触发按钮
  React.useEffect(() => {
    if (!moreOpen) return undefined;
    window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>(".browser-more-item:not(:disabled)")?.focus();
    });
    return () => {
      moreButtonRef.current?.focus();
    };
  }, [moreOpen]);

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

  /** 菜单项动作：先收起菜单再执行（历史/下载浮层复用「更多」按钮做锚点）。 */
  const runMenuAction = (action: () => void): void => {
    setMoreOpen(false);
    action();
  };
  const openBookmarksFromMenu = (): void => {
    setMoreOpen(false);
    setBookmarksOpen(true);
  };

  /** 菜单键盘导航：↑↓ 循环、Home/End 跳首尾（Esc/外部点击由 usePopover 统一处理）。 */
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(".browser-more-item:not(:disabled)") ?? []);
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current <= 0 ? items.length - 1 : current - 1;
    items[next]?.focus();
  };

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
          <span style={styles.starWrap}>
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
          </span>
        </div>

        <div style={styles.topActions}>
          <button
            type="button"
            className="icon-btn"
            title={currentUrl ? tr("browser.snapshot") : tr("browser.openPageFirst")}
            aria-label={tr("browser.snapshot")}
            onClick={onSnapshot}
            disabled={!currentUrl}
          >
            <Icon name="capture" size={17} />
          </button>
          <span style={styles.anchor} data-popover-trigger>
            <button
              ref={moreButtonRef}
              type="button"
              className="icon-btn"
              title={tr("browser.more")}
              aria-label={tr("browser.more")}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((value) => !value)}
            >
              <Icon name="more" size={17} />
            </button>
            <Popover anchorRef={moreButtonRef} open={moreOpen} onClose={() => setMoreOpen(false)} width={240}>
              <div ref={menuRef} className="browser-more-menu" role="menu" aria-label={tr("browser.more")} onKeyDown={onMenuKeyDown}>
                <button type="button" role="menuitem" className="browser-more-item" onClick={() => runMenuAction(onToggleHistory)}>
                  <Icon name="history" size={14} className="browser-more-icon" />
                  <span className="browser-more-label">{tr("browser.menuHistory")}</span>
                  {historyOpen ? <span className="browser-more-dot" aria-hidden /> : null}
                </button>
                <button type="button" role="menuitem" className="browser-more-item" onClick={() => runMenuAction(onToggleDownloads)}>
                  <Icon name="download" size={14} className="browser-more-icon" />
                  <span className="browser-more-label">{tr("browser.menuDownloads")}</span>
                  {downloadsActive ? <span className="browser-more-dot" aria-hidden /> : null}
                </button>
                <button type="button" role="menuitem" className="browser-more-item" onClick={openBookmarksFromMenu}>
                  <Icon name="star" size={14} className="browser-more-icon" />
                  <span className="browser-more-label">{tr("browser.menuBookmarks")}</span>
                </button>
                <div className="browser-more-sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="browser-more-item"
                  disabled={!currentUrl}
                  title={!currentUrl ? tr("browser.openPageFirst") : tr("browser.menuSavePage")}
                  onClick={() => runMenuAction(onSavePage)}
                >
                  <Icon name="file" size={14} className="browser-more-icon" />
                  <span className="browser-more-label">{tr("browser.menuSavePage")}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="browser-more-item"
                  disabled={!onOpenSettings}
                  onClick={() => runMenuAction(() => onOpenSettings?.())}
                >
                  <Icon name="settings" size={14} className="browser-more-icon" />
                  <span className="browser-more-label">{tr("browser.menuSettings")}</span>
                </button>
              </div>
            </Popover>
          </span>
        </div>
      </header>

      {/* 历史 / 下载浮层：开合状态仍由 App 持有，锚点统一到「更多」按钮（App 已用 usePopover 仲裁） */}
      <Popover anchorRef={moreButtonRef} open={historyOpen} onClose={onToggleHistory} width={380}>
        {historyPanel}
      </Popover>
      <Popover anchorRef={moreButtonRef} open={downloadsOpen} onClose={onToggleDownloads} width={420}>
        {downloadsPanel}
      </Popover>
      {/* 收藏夹浮层：从「更多」菜单打开，列表与删除逻辑不变 */}
      <Popover anchorRef={moreButtonRef} open={bookmarksOpen} onClose={() => setBookmarksOpen(false)} width={340}>
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
  topActions: { display: "flex", gap: 2, flexShrink: 0 },
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
