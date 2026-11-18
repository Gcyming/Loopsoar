/**
 * 侧栏布局状态机（P2-1 状态自持子系统）。
 *
 * 拥有侧栏宽度、Vibecoding 独立宽度、拖拽手势、窗口 resize 夹紧，以及
 * 原生网页视图的逐帧宽度同步。App 只消费有效宽度和拖拽回调。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { LAYOUT, computeSidebarMaxWidth, computeSidebarMinWidth, computeVibeSidebarBounds } from "loopsoar-contracts/layout";
import type { LoopsoarAPI, Preferences, SidebarMode } from "./types.js";

/** 与 DOM 侧栏 CSS 过渡保持一致（MOTION.sidebarDuration = 320ms）。 */
const SIDEBAR_ANIMATION_MS_UI = 320;

/** 与侧栏 DOM 同一条 cubic-bezier(0.2,0,0.2,1) 曲线。 */
function easeSidebar(t: number): number {
  let x = t;
  for (let i = 0; i < 6; i++) {
    const cx = 3 * 0.2 * (1 - x) * (1 - x) * x + 3 * 0.2 * (1 - x) * x * x + x * x * x;
    const dx = 3 * 0.2 * (1 - x) * (1 - 2 * x) + 3 * 0.2 * (2 * x - 3 * x * x) + 3 * x * x;
    if (Math.abs(cx - t) < 1e-4 || Math.abs(dx) < 1e-6) break;
    x -= (cx - t) / dx;
    x = Math.max(0, Math.min(1, x));
  }
  return 3 * (1 - x) * (1 - x) * x * 0 + 3 * (1 - x) * x * x * 1 + x * x * x;
}

export interface SidebarLayoutOptions {
  api: LoopsoarAPI | null;
  preferences: Preferences | null;
  setPreferences: React.Dispatch<React.SetStateAction<Preferences | null>>;
  sidebarMode: SidebarMode;
  vibeModeActive: boolean;
  miniWindow: boolean;
  agentWindowOpen: boolean;
}

export interface SidebarLayout {
  sidebarWidth: number;
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>;
  vibeSidebarWidth: number;
  sidebarDragging: boolean;
  startResize: (event: React.MouseEvent<HTMLDivElement>) => void;
  activeVibeWidth: number;
  effectiveSidebarWidth: number;
}

export function useSidebarLayout(options: SidebarLayoutOptions): SidebarLayout {
  const { api, preferences, setPreferences, sidebarMode, vibeModeActive, miniWindow, agentWindowOpen } = options;

  const [sidebarWidth, setSidebarWidth] = useState<number>(360);
  /** Vibecoding 模式独立侧栏宽度（0 = 未初始化，进入时用 vibe 最小宽度）。 */
  const [vibeSidebarWidth, setVibeSidebarWidth] = useState<number>(0);
  /** 侧栏拖拽中：拖拽时宽度必须逐帧跟手，不能开 CSS 过渡。 */
  const [sidebarDragging, setSidebarDragging] = useState(false);
  /** 供 IPC effect 同步读取（state 更新是异步的，拖拽时序里必须用 ref）。 */
  const sidebarDraggingRef = useRef(false);
  /** 最近一次逻辑对齐宽度（诊断/动画回退用）。 */
  const nativeSidebarWidthRef = useRef<number | null>(null);
  /** 渲染层 rAF 驱动的侧栏宽度动画。 */
  const sidebarRafRef = useRef<number | null>(null);
  /** 原生视图宽度是否已完成启动水合：首次同步瞬时落位，之后才允许过渡。 */
  const nativeSidebarReadyRef = useRef(false);

  // 侧栏宽度硬约束（ADR-0037）：窗口 resize 与偏好水合后重新夹紧。
  useEffect(() => {
    const clamp = (): void => {
      const min = computeSidebarMinWidth(window.innerWidth);
      const max = computeSidebarMaxWidth(window.innerWidth);
      setSidebarWidth((w) => Math.min(Math.max(min, w), max));
      const vibe = computeVibeSidebarBounds(window.innerWidth);
      setVibeSidebarWidth((w) => (w > 0 ? Math.min(Math.max(vibe.min, w), vibe.max) : vibe.min));
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [preferences?.sidebarWidth, preferences?.vibeSidebarWidth]);

  // 偏好水合：读取用户上次在 Vibecoding 模式拖出的宽度。
  useEffect(() => {
    const vibe = computeVibeSidebarBounds(window.innerWidth);
    const saved = preferences?.vibeSidebarWidth;
    setVibeSidebarWidth((w) => {
      const base = w > 0 ? w : (typeof saved === "number" ? saved : vibe.min);
      return Math.min(Math.max(vibe.min, base), vibe.max);
    });
  }, [preferences?.vibeSidebarWidth]);

  // 侧栏拖拽：mousemove 实时改 DOM 宽度，松开时持久化 + 同步原生视图。
  const startResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const startX = event.clientX;
      // Vibecoding 模式用独立窄区间；切回搜索模式恢复标准区间。
      const vibe = computeVibeSidebarBounds(window.innerWidth);
      const bounds = vibeModeActive
        ? { min: vibe.min, max: vibe.max }
        : { min: computeSidebarMinWidth(window.innerWidth), max: computeSidebarMaxWidth(window.innerWidth) };
      const startWidth = vibeModeActive
        ? Math.min(Math.max(vibe.min, vibeSidebarWidth || vibe.min), vibe.max)
        : sidebarWidth;
      // 拖拽期间隐藏原生 WebContentsView，否则鼠标移入浏览器区后 mousemove 会被它吞掉。
      void api?.browser.setOverlay({ open: true }).catch(() => {});
      sidebarDraggingRef.current = true;
      setSidebarDragging(true);
      const onMove = (e: MouseEvent): void => {
        const next = Math.max(bounds.min, Math.min(bounds.max, startWidth - (e.clientX - startX)));
        if (vibeModeActive) setVibeSidebarWidth(next);
        else setSidebarWidth(next);
      };
      const onUp = (e: MouseEvent): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        sidebarDraggingRef.current = false;
        setSidebarDragging(false);
        const next = Math.max(bounds.min, Math.min(bounds.max, startWidth - (e.clientX - startX)));
        if (vibeModeActive) setVibeSidebarWidth(next);
        else setSidebarWidth(next);
        void api?.browser.setOverlay({ open: false }).catch(() => {});
        // 松手时原生视图宽度直接落位（拖拽过程视图是隐藏的，不需要补动画）。
        void api?.browser.setSidebarWidth({ width: next, animate: false }).catch(() => {});
        if (api && preferences) {
          void api.settings
            .setPreferences(
              vibeModeActive
                ? { ...preferences, vibeSidebarWidth: next }
                : { ...preferences, sidebarWidth: next },
            )
            .then((r) => setPreferences(r.preferences))
            .catch(() => {});
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [api, preferences, sidebarWidth, vibeModeActive, vibeSidebarWidth, setPreferences],
  );

  useEffect(() => {
    if (!vibeModeActive) return;
    const vibe = computeVibeSidebarBounds(window.innerWidth);
    setVibeSidebarWidth(vibe.min);
  }, [vibeModeActive]);

  /** 生效的侧栏宽度（收起态只用图标条宽度，让网页区自然变宽）。 */
  const vibeBounds = computeVibeSidebarBounds(typeof window === "undefined" ? 1440 : window.innerWidth);
  /** Vibecoding 生效宽度：始终夹在 [vibe.min, vibe.max]。 */
  const activeVibeWidth = Math.min(
    Math.max(vibeBounds.min, vibeSidebarWidth > 0 ? vibeSidebarWidth : vibeBounds.min),
    vibeBounds.max,
  );
  const effectiveSidebarWidth = agentWindowOpen
    ? 0
    : sidebarMode === "collapsed"
      ? LAYOUT.SIDEBAR_COLLAPSED_WIDTH
      : vibeModeActive
        ? activeVibeWidth
        : sidebarWidth;

  useEffect(() => {
    if (!api || miniWindow || !preferences) return;
    const target = effectiveSidebarWidth;
    const previous = nativeSidebarWidthRef.current;
    // 启动水合必须瞬时落位；拖拽时逐帧跟手且不播动画。
    const animate = nativeSidebarReadyRef.current && !sidebarDraggingRef.current;
    nativeSidebarReadyRef.current = true;
    // 宽度没变（只是其它偏好更新导致 effect 重跑）：不重播动画，否则会留下静态快照遮住网页。
    if (previous === target) {
      return;
    }
    nativeSidebarWidthRef.current = target;
    if (!animate) {
      void api.browser.setSidebarWidth({ width: target, animate: false }).catch(() => {});
      return;
    }
    // 左右同拍：DOM 侧栏 CSS 过渡 320ms；原生网页视图由渲染层 rAF 逐帧驱动。
    const from = typeof previous === "number" ? previous : target;
    const startedAt = performance.now();
    if (sidebarRafRef.current !== null) cancelAnimationFrame(sidebarRafRef.current);
    const step = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / SIDEBAR_ANIMATION_MS_UI);
      const eased = easeSidebar(t);
      const width = Math.round(from + (target - from) * eased);
      void api.browser.setSidebarWidth({ width, animate: false }).catch(() => {});
      if (t < 1) {
        sidebarRafRef.current = requestAnimationFrame(step);
      } else {
        sidebarRafRef.current = null;
        void api.browser.setSidebarWidth({ width: target, animate: false }).catch(() => {});
      }
    };
    sidebarRafRef.current = requestAnimationFrame(step);
    return () => {
      if (sidebarRafRef.current !== null) {
        cancelAnimationFrame(sidebarRafRef.current);
        sidebarRafRef.current = null;
      }
    };
  }, [api, effectiveSidebarWidth, miniWindow, preferences]);

  return {
    sidebarWidth,
    setSidebarWidth,
    vibeSidebarWidth,
    sidebarDragging,
    startResize,
    activeVibeWidth,
    effectiveSidebarWidth,
  };
}
