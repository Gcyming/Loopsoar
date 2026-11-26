/**
 * 下载状态 + 下载反馈（从 App 抽出）。
 *
 * 反馈目标：用户点下载后必须立刻看到「有东西在下载」——
 *   · 工具栏下载按钮出现脉冲圆点（active/percent 供 BrowserChrome 画）；
 *   · 新下载开始且主窗口有焦点时，自动展开「下载」浮层（Edge 式小窗，直接看进度/操作）。
 * 注意：浮层是独立子窗口（openPopover），所以不会被原生网页视图盖住。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DownloadItem, LoopsoarAPI } from "./types.js";

export interface DownloadSummary {
  active: number;
  percent: number;
  /** 只有存在进行中的下载任务时才显示工具栏入口；任务结束即隐藏（历史从「更多」菜单进）。 */
  visible: boolean;
}

export interface DownloadsState {
  downloads: DownloadItem[];
  setDownloads: (value: DownloadItem[]) => void;
  summary: DownloadSummary;
}

export function useDownloads({ api }: { api: LoopsoarAPI | null }): DownloadsState {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  /** 已见过的下载 id：只对「新出现的进行中条目」弹一次浮层。 */
  const seenRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  /** 自动展开下载小窗的节流：连续多文件下载只弹一次，避免抢焦点。 */
  const lastOpenAtRef = useRef(0);
  /** 本批次是否已经自动弹过下载浮层（只弹一次）。 */
  const autoOpenedRef = useRef(false);
  /** 用户主动关闭自动弹出的浮层后，本批次不再自动弹（收为按钮）。 */
  const dismissedRef = useRef(false);
  /** 下载浮层当前是否打开（含用户手动打开）：关闭时据此判定「用户主动收起」。 */
  const downloadsOpenRef = useRef(false);

  useEffect(() => {
    if (!primedRef.current) {
      primedRef.current = true;
      for (const item of downloads) seenRef.current.add(item.id);
      return;
    }
    const fresh = downloads.filter((item) => !seenRef.current.has(item.id));
    for (const item of downloads) seenRef.current.add(item.id);
    const started = fresh.find((item) => item.state === "progressing");
    // 下载点击发生在原生网页视图里，主窗口 renderer 的 document.hasFocus() 此时可能为 false；
    // 用页面可见性判断即可，否则自动反馈永远不触发。
    if (!started || document.visibilityState === "hidden") return;
    // 只有主窗口自动弹：Agent 小窗/独立窗口也挂 App，不能每个窗口都弹一次。
    if (new URLSearchParams(location.search).get("mini") === "1") return;
    // 只在本批次首次自动弹；用户关掉后收为按钮，不再打扰。
    if (autoOpenedRef.current || dismissedRef.current) return;
    if (Date.now() - lastOpenAtRef.current < 2500) return;
    const trigger = document.querySelector<HTMLElement>("[data-downloads-trigger]");
    if (!trigger) return;
    lastOpenAtRef.current = Date.now();
    autoOpenedRef.current = true;
    const rect = trigger.getBoundingClientRect();
    void api?.ui
      ?.openPopover({
        kind: "downloads",
        anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      })
      .catch(() => undefined);
  }, [api, downloads]);

  // 任何来源（自动/手动）的下载浮层关闭，都视为用户主动收起 → 本批次不再自动弹。
  // 下载列表清空（新批次）→ 复位。
  useEffect(() => {
    if (!api?.on) return;
    const offAction = api.on("chrome:popoverAction", (payload) => {
      const p = payload as { action?: string; payload?: { kind?: string } } | null;
      if (p?.action === "popoverKind" && p.payload?.kind === "downloads") {
        downloadsOpenRef.current = true;
      }
    });
    const offClosed = api.on("chrome:popoverClosed", () => {
      if (downloadsOpenRef.current) {
        downloadsOpenRef.current = false;
        autoOpenedRef.current = false;
        dismissedRef.current = true;
      }
    });
    return () => {
      offAction?.();
      offClosed?.();
    };
  }, [api]);

  useEffect(() => {
    if (downloads.length === 0) {
      autoOpenedRef.current = false;
      dismissedRef.current = false;
      downloadsOpenRef.current = false;
    }
  }, [downloads.length]);

  const setDownloadsStable = useCallback((value: DownloadItem[]): void => setDownloads(value), []);

  const summary = useMemo<DownloadSummary>(() => {
    const active = downloads.filter((item) => item.state === "progressing");
    const percent =
      active.length === 0
        ? 0
        : Math.round(
            (active.reduce((sum, item) => sum + (item.total > 0 ? item.received / item.total : 0), 0) /
              active.length) *
              100,
          );
    // 无进行中的任务就收起入口：按钮不常驻（用户要求「没有下载任务时不要自然出现」）。
    // 下载历史仍可从「更多」菜单里的下载浮层进入，不靠这个常驻按钮。
    return { active: active.length, percent, visible: active.length > 0 };
  }, [downloads]);

  return { downloads, setDownloads: setDownloadsStable, summary };
}
