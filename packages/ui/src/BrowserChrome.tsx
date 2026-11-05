/**
 * 浏览器顶栏（极简版）：后退/前进/刷新 + 地址搜索框（内嵌收藏星标）+ 快照/更多。
 *
 * 标签页已移到最顶行的 TitleBar（与最小化/最大化/关闭同列，见 BrowserTabs.tsx），
 * 本组件只负责第二行的导航工具条。
 *
 * 浮层策略（M3 之后）：工具栏不再自己渲染任何菜单/浮层——
 * 收藏星标与「更多」按钮**悬停 250ms**（或点击）时调用 `api.ui.openPopover({kind,anchor,lang})`，
 * 由主进程弹出独立透明子窗口（PopoverApp 渲染预览、限条数、「查看更多」）。
 * 这样浮层永远浮在原生 WebContentsView 之上，也不再需要「打开浮层时隐藏网页」的回调。
 *
 * 收藏星标：点击仍执行原收藏/取消收藏（bookmarks.add/remove），hover 打开收藏夹预览。
 * 快照：保持点击行为。
 */
import * as React from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { getLanguage, useT } from "./i18n.js";
import type { BookmarkItem, ChromePopoverKind, TabState } from "./types.js";

export interface BrowserChromeProps {
  tabs: TabState[];
  address: string;
  currentUrl: string;
  omniboxRef?: React.RefObject<HTMLInputElement | null>;
  onAddressChange: (value: string) => void;
  onNavigate: () => void;
  onBack: () => void;
  onForward: () => void;
  /** 刷新当前页（走 browser:reload，不是重新导航）。 */
  onReload: () => void;
  onSnapshot: () => void;
  /** 工具条内操作提示（收藏/取消收藏结果）。 */
  onNotice: (text: string) => void;
}


/** 悬停触发延迟：太快误触、太慢像没反应（用户要求「悬停即弹出」）。 */
const HOVER_DELAY_MS = 250;

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
  onAddressChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onSnapshot,
  onNotice,
}: BrowserChromeProps): React.ReactElement {
  const api = useLoopsoarApi();
  const tr = useT();
  const active = tabs.find((tab) => tab.active);
  const starButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const hoverTimerRef = React.useRef<number | null>(null);

  const [bookmarks, setBookmarks] = React.useState<BookmarkItem[]>([]);

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

  // 挂载 / 页面切换时刷新（决定星标高亮）
  React.useEffect(() => {
    void refreshBookmarks();
  }, [refreshBookmarks, currentUrl]);

  // 卸载清理悬停定时器
  React.useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    };
  }, []);

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

  /* ------------------------- 独立浮层窗口（主进程） ------------------------- */

  /** 调主进程弹出独立浮层窗口；anchor 用按钮在内容区的 CSS px 矩形（主进程换算屏幕坐标）。 */
  const openPopover = React.useCallback(
    (kind: ChromePopoverKind, element: HTMLElement | null): void => {
      const ui = api?.ui;
      if (!ui?.openPopover || !element) return;
      const rect = element.getBoundingClientRect();
      void ui
        .openPopover({
          kind,
          anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          lang: getLanguage(),
        })
        .catch(() => {
          // 旧 shell / 主进程未接线：静默降级为无预览（按钮本身仍然可用）
        });
    },
    [api],
  );

  const cancelHover = React.useCallback((): void => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  /** 悬停 250ms 后打开预览；离开按钮即取消（鼠标进入浮层由主进程命中测试处理）。 */
  const scheduleHover = React.useCallback(
    (kind: ChromePopoverKind, element: HTMLElement | null): void => {
      cancelHover();
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        openPopover(kind, element);
      }, HOVER_DELAY_MS);
    },
    [cancelHover, openPopover],
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
              ref={starButtonRef}
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
              onMouseEnter={() => {
                if (!canBookmark) return;
                scheduleHover("bookmarks", starButtonRef.current);
              }}
              onMouseLeave={cancelHover}
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
          <button
            ref={moreButtonRef}
            type="button"
            className="icon-btn"
            title={tr("browser.more")}
            aria-label={tr("browser.more")}
            aria-haspopup="menu"
            onMouseEnter={() => scheduleHover("more", moreButtonRef.current)}
            onMouseLeave={cancelHover}
            onClick={() => {
              cancelHover();
              openPopover("more", moreButtonRef.current);
            }}
          >
            <Icon name="more" size={17} />
          </button>
        </div>
      </header>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 10px",
    // 抬高一档的「工具条底」：与右侧会话栏同色，地址栏作为更暗的胶囊嵌在上面（参考 Tabbit）。
    background: BRAND.inkRaised,
    flexShrink: 0,
  },
  navGroup: { display: "flex", gap: 2, flexShrink: 0 },
  omniboxWrap: {
    flex: 1,
    // 地址栏不再一路顶到会话栏：留出右侧余量，让「网址输入栏」与右侧会话栏之间有呼吸；
    // 剩余空间由 topActions 的 marginLeft:auto 吃掉，星标/快照/更多仍贴网页列右缘。
    maxWidth: 720,
    display: "flex",
    alignItems: "center",
    gap: 8,
    height: 30,
    padding: "0 6px 0 12px",
    borderRadius: 15,
    border: `1px solid ${BRAND.border}`,
    // 地址栏胶囊比工具条再暗一档，形成「条带抬高一档 + 输入框内凹」的层次
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
  topActions: { display: "flex", gap: 2, flexShrink: 0, marginLeft: "auto" },
};
