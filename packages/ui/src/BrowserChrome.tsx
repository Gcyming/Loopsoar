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
import type { SearchEngine } from "loopsoar-contracts/omnibox";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { usePopover } from "./popover.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { getLanguage, useT } from "./i18n.js";
import type { BookmarkItem, ChromePopoverKind, TabState } from "./types.js";

export interface BrowserChromeProps {
  tabs: TabState[];
  address: string;
  currentUrl: string;
  omniboxRef?: React.RefObject<HTMLInputElement | null>;
  /** 当前默认搜索引擎（新建标签页 / 地址栏左侧切换按钮显示它的图标）。 */
  searchEngine: SearchEngine;
  /** 用户在地址栏下拉里切换搜索引擎。 */
  onSearchEngineChange: (engine: SearchEngine) => void;
  onAddressChange: (value: string) => void;
  onNavigate: () => void;
  onBack: () => void;
  onForward: () => void;
  /** 刷新当前页（走 browser:reload，不是重新导航）。 */
  onReload: () => void;
  onSnapshot: () => void;
  /** 工具条内操作提示（收藏/取消收藏结果）。 */
  onNotice: (text: string) => void;
  /** 下载状态摘要：只有存在进行中的下载任务时才出现按钮；脉冲 + 点击展开下载浮层。 */
  downloadsSummary?: { active: number; percent: number; visible: boolean };
}

/** 地址栏引擎下拉可选项（与 Preferences.searchEngine 枚举一致）。 */
const ENGINE_OPTIONS: { id: SearchEngine; name: string }[] = [
  { id: "bing", name: "Bing" },
  { id: "google", name: "Google" },
  { id: "baidu", name: "百度" },
];

function engineName(engine: SearchEngine): string {
  return ENGINE_OPTIONS.find((item) => item.id === engine)?.name ?? engine;
}


/** 悬停触发延迟：太快误触、太慢像没反应。用户要求放慢（m01845：放上去就展开太急）→ 600ms。 */
const HOVER_DELAY_MS = 600;

/**
 * 工具栏按钮的渐入/渐出容器：宽度 + 透明度一起过渡，收起时用负 margin 抵消 flex gap，
 * 避免按钮出现/消失时整排图标硬跳（topActions 的 gap 是 2px）。
 */
function ActionSlot({
  open,
  instant,
  children,
}: {
  open: boolean;
  instant?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      className={`chrome-action-slot${open ? " is-open" : ""}${instant ? " is-instant" : ""}`}
      aria-hidden={!open}
    >
      {children}
    </span>
  );
}

/** 书签同一性判据：忽略 URL hash 与末尾斜杠（同页锚点不产生第二条书签）。 */
function pageKey(url: string): string {
  const trimmed = url.trim().replace(/#.*$/, "");
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function BrowserChrome({
  tabs,
  address,
  currentUrl,
  omniboxRef,
  searchEngine,
  onSearchEngineChange,
  onAddressChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onSnapshot,
  onNotice,
  downloadsSummary,
}: BrowserChromeProps): React.ReactElement {
  const api = useLoopsoarApi();
  const downloadsButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const tr = useT();
  const active = tabs.find((tab) => tab.active);
  const starButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const hoverTimerRef = React.useRef<number | null>(null);
  /** 点击收起后指针仍停在按钮上：抑制 hover 立刻重开（否则会「关→开」连闪）。 */
  const suppressHoverRef = React.useRef(false);
  /** 地址栏左侧搜索引擎下拉（只在新建标签页显示；页面打开后恢复普通放大镜）。 */
  const [engineMenuOpen, setEngineMenuOpen] = React.useState(false);
  usePopover("browser-engine", engineMenuOpen, setEngineMenuOpen);
  /** 当前打开的是哪一类工具栏浮层（主进程推送）：在“更多”左侧显示对应的“认领”按钮。 */
  const [popoverKind, setPopoverKind] = React.useState<ChromePopoverKind | null>(null);
  /** 收起时保留最后一次的认领类型，让按钮能把渐出动画播完。 */
  const claimKindRef = React.useRef<"bookmarks" | "history" | null>(null);
  if (popoverKind === "bookmarks" || popoverKind === "history") claimKindRef.current = popoverKind;
  const claimKind =
    popoverKind === "bookmarks" || popoverKind === "history" ? popoverKind : claimKindRef.current;
  React.useEffect(() => {
    if (!api?.on) return;
    const offKind = api.on("chrome:popoverAction", (payload) => {
      const p = payload as { action?: string; payload?: { kind?: string } } | null;
      if (p?.action === "popoverKind") setPopoverKind((p.payload?.kind as ChromePopoverKind) ?? null);
    });
    const offClosed = api.on("chrome:popoverClosed", () => setPopoverKind(null));
    return () => {
      offKind?.();
      offClosed?.();
    };
  }, [api]);

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

  // 开始搜索/打开页面后，地址栏左侧恢复为「无功能放大镜」：收起引擎下拉，避免中途切引擎。
  React.useEffect(() => {
    setEngineMenuOpen(false);
  }, [currentUrl]);

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

  const cancelHover = React.useCallback((): void => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

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

  /**
   * 点击触发按钮：**原子 toggle**（主进程判断当前是否已打开）。
   * 不能依赖渲染层记录的 open 状态：浮层是独立子窗口，点击按钮时子窗口先失焦关闭，
   * 等 click 回调再判断会变成「关→开」连闪（用户 m02263 实测）。
   */
  const togglePopover = React.useCallback(
    (kind: ChromePopoverKind, element: HTMLElement | null): void => {
      const ui = api?.ui;
      if (!element) return;
      cancelHover();
      // 旧主进程/preload 可能还没有 togglePopover：退回 openPopover，保证按钮至少能打开列表。
      if (!ui?.togglePopover) {
        suppressHoverRef.current = true;
        openPopover(kind, element);
        return;
      }
      const rect = element.getBoundingClientRect();
      // 点击后先抑制 hover 重开，直到鼠标离开按钮（否则收起瞬间 hover 又把它打开）
      suppressHoverRef.current = true;
      void ui
        .togglePopover({
          kind,
          anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          lang: getLanguage(),
        })
        .then((result) => {
          // 仍处于打开状态（例如把另一个列表切换成这个）→ 允许后续 hover 行为
          if (result?.open) {
            suppressHoverRef.current = false;
            setPopoverKind(kind);
          }
        })
        .catch(() => {
          // toggle 失败（旧主进程未接线等）→ 退回普通打开，按钮不能变成死键。
          suppressHoverRef.current = false;
          openPopover(kind, element);
        });
    },
    [api, cancelHover, openPopover],
  );

  /** 悬停 600ms 后打开预览；离开按钮即取消（鼠标进入浮层由主进程命中测试处理）。 */
  const scheduleHover = React.useCallback(
    (kind: ChromePopoverKind, element: HTMLElement | null): void => {
      if (suppressHoverRef.current) return; // 刚点击收起：等鼠标离开按钮后才允许 hover 再开
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
      <header className="browser-toolbar" style={{ ...styles.topBar, height: LAYOUT.TOP_BAR_HEIGHT }}>
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

        <div className="browser-omnibox" style={styles.omniboxWrap}>
          {currentUrl ? (
            <Icon name="search" size={14} style={styles.omniboxIcon} />
          ) : (
            <span style={styles.engineWrap} data-popover-trigger>
              <button
                type="button"
                className="icon-btn"
                style={styles.engineButton}
                title={tr("browser.searchEngineChoose", { engine: engineName(searchEngine) })}
                aria-label={tr("browser.searchEngineChoose", { engine: engineName(searchEngine) })}
                aria-haspopup="menu"
                aria-expanded={engineMenuOpen}
                onClick={() => setEngineMenuOpen((open) => !open)}
              >
                <img
                  src={`./icons/engine-${searchEngine}.svg`}
                  width={15}
                  height={15}
                  alt=""
                  draggable={false}
                  style={styles.engineIcon}
                />
              </button>
              {engineMenuOpen ? (
                <div className="engine-menu" data-popover role="menu" style={styles.engineMenu}>
                  {ENGINE_OPTIONS.map((engine) => {
                    const activeEngine = engine.id === searchEngine;
                    return (
                      <button
                        key={engine.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={activeEngine}
                        style={{ ...styles.engineItem, ...(activeEngine ? styles.engineItemActive : {}) }}
                        onClick={() => {
                          onSearchEngineChange(engine.id);
                          setEngineMenuOpen(false);
                          omniboxRef?.current?.focus();
                        }}
                      >
                        <img
                          src={`./icons/engine-${engine.id}.svg`}
                          width={16}
                          height={16}
                          alt=""
                          draggable={false}
                          style={styles.engineIcon}
                        />
                        <span style={styles.engineItemName}>{engine.name}</span>
                        {activeEngine ? <Icon name="check" size={12} style={styles.engineItemCheck} /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </span>
          )}
          <input
            value={address}
            onChange={(event) => onAddressChange(event.target.value)}
            onKeyDown={(event) => {
              // 中文输入法选词的回车不能触发导航（部分 IME 会补发 isComposing=false 的 Enter）。
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") onNavigate();
            }}
            onFocus={(event) => event.currentTarget.select()}
            ref={omniboxRef}
            placeholder={tr("browser.addressPlaceholder")}
            style={styles.omnibox}
            aria-label={tr("browser.addressAria")}
          />
          <span style={styles.starWrap}>
            <button
              ref={starButtonRef}
              type="button"
              data-chrome-popover-trigger
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
              onMouseLeave={() => {
                suppressHoverRef.current = false;
                cancelHover();
              }}
              onClick={() => {
                void toggleBookmark();
                // 预览已展开时点击星标 = 收起（与「再次点击对应按钮收起」规则一致）
                void api?.ui?.closePopover?.().catch(() => undefined);
              }}
            >
              <Icon name={currentBookmark ? "star-filled" : "star"} size={15} />
            </button>
          </span>
        </div>

        {active?.loading ? (
          <div style={styles.loadingBar} aria-hidden="true">
            <span style={styles.loadingBarFill} />
          </div>
        ) : null}
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
          <ActionSlot
            open={Boolean(downloadsSummary?.visible || popoverKind === "downloads")}
            instant={(downloadsSummary?.active ?? 0) > 0}
          >
            <button
              ref={downloadsButtonRef}
              type="button"
              data-downloads-trigger
              data-chrome-popover-trigger
              className={`icon-btn${popoverKind === "downloads" ? " is-popover-claim" : ""}${
                (downloadsSummary?.active ?? 0) > 0 ? " is-downloading" : ""
              }`}
              title={
                (downloadsSummary?.active ?? 0) > 0
                  ? tr("browser.menuDownloads") + ` · ${downloadsSummary?.percent ?? 0}%`
                  : tr("browser.menuDownloads")
              }
              aria-label={tr("browser.menuDownloads")}
              aria-haspopup="menu"
              style={styles.downloadsButton}
              onClick={() => togglePopover("downloads", downloadsButtonRef.current)}
            >
              <Icon name="download" size={17} />
              {(downloadsSummary?.active ?? 0) > 0 ? <span style={styles.downloadDot} aria-hidden="true" /> : null}
            </button>
          </ActionSlot>
          <ActionSlot open={popoverKind === "bookmarks" || popoverKind === "history"}>
            {claimKind ? (
              <button
                type="button"
                data-chrome-popover-trigger
                className="icon-btn is-popover-claim"
                title={claimKind === "bookmarks" ? tr("browser.menuBookmarks") : tr("browser.menuHistory")}
                aria-label={claimKind === "bookmarks" ? tr("browser.menuBookmarks") : tr("browser.menuHistory")}
                aria-haspopup="menu"
                onClick={() => {
                  void api?.ui?.closePopover?.().catch(() => undefined);
                }}
              >
                <Icon name={claimKind === "bookmarks" ? "star-filled" : "history"} size={17} />
              </button>
            ) : null}
          </ActionSlot>
          <button
            ref={moreButtonRef}
            type="button"
            data-chrome-popover-trigger
            className={popoverKind === "more" ? "icon-btn is-popover-claim" : "icon-btn"}
            title={tr("browser.more")}
            aria-label={tr("browser.more")}
            aria-haspopup="menu"
            onMouseEnter={() => scheduleHover("more", moreButtonRef.current)}
            onMouseLeave={() => {
              suppressHoverRef.current = false;
              cancelHover();
            }}
            onClick={() => togglePopover("more", moreButtonRef.current)}
          >
            <Icon name="more" size={17} />
          </button>
        </div>
      </header>
    </>
  );
}

export default React.memo(BrowserChrome);

const styles: Record<string, React.CSSProperties> = {
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 10px",
    position: "relative",
    // 抬高一档的「工具条底」：与右侧会话栏同色，地址栏作为更暗的胶囊嵌在上面（参考 Tabbit）。
    background: BRAND.inkRaised,
    flexShrink: 0,
  },
  navGroup: { display: "flex", gap: 2, flexShrink: 0 },
  omniboxWrap: {
    flex: 1,
    // 地址栏占满网页列（工具条本身只被 pageColumn 裁切，不会再伸进会话栏）。
    // 不再设 maxWidth：侧栏收起时网页列变宽，地址栏会自然跟着向右延伸。
    position: "relative",
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
  // 地址栏左侧搜索源切换：新建标签页时显示当前引擎图标，点开是引擎列表。
  engineWrap: { position: "relative", display: "inline-flex", alignItems: "center", flex: "none" },
  engineButton: { width: 24, height: 24, padding: 0, borderRadius: 7, flex: "none" },
  engineIcon: { display: "block", borderRadius: 4 },
  engineMenu: {
    position: "absolute",
    top: 32,
    left: -6,
    zIndex: 60,
    minWidth: 168,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: 5,
    borderRadius: 10,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
    animation: "fadeUp 120ms ease both",
  },
  engineItem: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "7px 9px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 12.5,
    cursor: "pointer",
    textAlign: "left",
  },
  engineItemActive: { background: "rgba(200,118,60,0.14)", color: BRAND.ochreHover },
  engineItemName: { flex: 1 },
  engineItemCheck: { color: BRAND.ochreHover },
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
  downloadsButton: { position: "relative" },
  /** 下载中角标：小圆点 + 呼吸动画（进度百分比在 title 与浮层里）。 */
  downloadDot: {
    position: "absolute",
    right: 4,
    bottom: 4,
    width: 6,
    height: 6,
    borderRadius: 999,
    background: "var(--ls-accent, #c8763c)",
    boxShadow: "0 0 0 2px rgba(200,118,60,0.25)",
    animation: "loopsoar-download-pulse 1.1s ease-in-out infinite",
  },
  /** 加载进度条：页面视图在导航期间保持可见，加载反馈只能放在工具条上（不遮网页）。 */
  loadingBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    overflow: "hidden",
    pointerEvents: "none",
    background: "rgba(200,118,60,0.16)",
  },
  loadingBarFill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "38%",
    background: "var(--ls-accent, #c8763c)",
    animation: "loopsIndeterminate 1.2s cubic-bezier(0.4,0,0.2,1) infinite",
  },
};
