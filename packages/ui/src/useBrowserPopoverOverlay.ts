import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { LoopsoarAPI } from "./types.js";

/**
 * 浮层与原生网页视图的让位策略。
 *
 * Electron 的 WebContentsView 位于渲染层 DOM 之上，菜单压到网页时只能隐藏视图；
 * 但「任意菜单打开就隐藏」会让整个网页变空白。这里只在菜单矩形真的与网页列相交时
 * 才隐藏，并在隐藏前抓一张静态底图，让网页内容在菜单打开期间仍然可见。
 *
 * 这是 UI 层唯一的隐藏判定入口：新增菜单仍通过 usePopover 注册，不需要再改 App。
 */
export interface BrowserPopoverOverlayState {
  pageColumnRef: RefObject<HTMLDivElement | null>;
  popoverOverPage: boolean;
  browserPreview: string | null;
}

export interface BrowserPopoverOverlayOptions {
  api: LoopsoarAPI | null;
  anyPopoverOpen: boolean;
  /** 设置/权限等整页 DOM 已经遮住网页时为 true：此时不需要再抓底图。 */
  baseOverlay: boolean;
}

export function useBrowserPopoverOverlay({
  api,
  anyPopoverOpen,
  baseOverlay,
}: BrowserPopoverOverlayOptions): BrowserPopoverOverlayState {
  const [popoverOverPage, setPopoverOverPage] = useState(false);
  const [browserPreview, setBrowserPreview] = useState<string | null>(null);
  const pageColumnRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const sync = async (): Promise<void> => {
      let overPage = false;
      if (anyPopoverOpen && !baseOverlay) {
        const menu = document.querySelector<HTMLElement>("[data-popover]");
        const page = pageColumnRef.current;
        if (menu && page) {
          const a = menu.getBoundingClientRect();
          const b = page.getBoundingClientRect();
          overPage = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        }
      }
      if (overPage) {
        // 必须在 setOverlay 之前抓图：视图一旦隐藏，capturePage 只会得到空白。
        const shot = await api.browser.screenshot({}).catch(() => null);
        if (cancelled) return;
        if (shot?.ok && shot.data) {
          setBrowserPreview(`data:image/png;base64,${shot.data}`);
          setPopoverOverPage(true);
        } else {
          // 抓不到底图就不隐藏视图：宁可菜单暂时被盖住，也不要把网页整块变黑。
          setPopoverOverPage(false);
          setBrowserPreview(null);
        }
      } else {
        setPopoverOverPage(false);
        setBrowserPreview(null);
      }
    };
    void sync();
    return () => {
      cancelled = true;
    };
  }, [api, anyPopoverOpen, baseOverlay]);

  return { pageColumnRef, popoverOverPage, browserPreview };
}
