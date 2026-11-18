/**
 * Agent 独立窗口（?mini=1）的布局状态机（P2-1 状态自持子系统）。
 *
 * 这里拥有：小窗开合、图标化/浮点过渡几何、拖拽还原手势，以及主进程
 * `chrome:agentWindowClosed` / `chrome:applyLayout` 事件对应的窗口编排。
 * App 只消费派生样式与回调，不再自己维护这些 ref/effect。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { LoopsoarAPI, Preferences, SidebarMode } from "./types.js";
import { getLanguage, t } from "./i18n.js";

export interface AgentWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentFloatTransition {
  phase: "minimize" | "restore";
  durationMs: number;
  from: AgentWindowRect;
  to: AgentWindowRect;
}

export interface AgentWindowLayoutOptions {
  api: LoopsoarAPI | null;
  miniWindow: boolean;
  preferences: Preferences | null;
  setPreferences: React.Dispatch<React.SetStateAction<Preferences | null>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  currentSession: string | null;
  setSessionOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface AgentWindowLayout {
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
  beginIconDrag: (event: React.PointerEvent<HTMLDivElement>) => void;
  changeSidebarMode: (next: SidebarMode) => void;
  agentWindowOpen: boolean;
  agentIconMode: boolean;
  agentFloat: AgentFloatTransition | null;
  floatRect: AgentWindowRect | null;
  stableIconRect: AgentWindowRect | null;
  contentHidden: boolean;
  iconShown: boolean;
  contentBaseOpacity: number;
  iconTransition: string;
  panelTransition: string;
  freezeW: number | undefined;
  freezeH: number | undefined;
}

/** 把主进程传来的几何夹紧成合法的有限矩形；非法值返回 null。 */
function toRect(value?: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): AgentWindowRect | null {
  if (!value) return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    x: x as number,
    y: y as number,
    width: Math.max(1, width as number),
    height: Math.max(1, height as number),
  };
}

export function useAgentWindowLayout(options: AgentWindowLayoutOptions): AgentWindowLayout {
  const { api, miniWindow, preferences, setPreferences, setNotice, currentSession, setSessionOpen } = options;

  const [agentWindowOpen, setAgentWindowOpen] = useState(false);
  /**
   * 小窗开合与偏好的「最新值」镜像：chrome:applyLayout 的事件回调只绑一次，
   * 直接闭包 state 会读到开通/关窗之前的旧值；写进依赖数组又会让回调随每次偏好更新重订阅。
   */
  const agentWindowOpenRef = useRef(false);
  const preferencesRef = useRef<Preferences | null>(null);
  useEffect(() => {
    agentWindowOpenRef.current = agentWindowOpen;
  }, [agentWindowOpen]);
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  /**
   * 最小化（缩成图标按钮）状态：由主进程 chrome:agentWindowIconMode 驱动。
   * 图标模式只换视图，不卸载会话；点击图标 → ui:restoreAgentWindow 还原。
   */
  const [agentIconMode, setAgentIconMode] = useState(false);
  useEffect(() => {
    if (!miniWindow || !api) return;
    return api.on("chrome:agentWindowIconMode", (payload) => {
      setAgentIconMode(Boolean((payload as { icon?: boolean } | null)?.icon));
    });
  }, [miniWindow, api]);

  /**
   * 最小化/还原的「面板几何过渡」：minimize 时窗口尺寸不动，面板 left/top/width/height
   * 从整窗过渡到图标矩形；restore 反向展开。内容钉在原尺寸 + overflow:hidden 裁切。
   */
  const [agentFloat, setAgentFloat] = useState<AgentFloatTransition | null>(null);
  const [agentFloatStarted, setAgentFloatStarted] = useState(false);
  /** 图标态稳定后面板停留的矩形（相对窗口）。 */
  const [agentIconRect, setAgentIconRect] = useState<AgentWindowRect | null>(null);
  const [agentFloatFreeze, setAgentFloatFreeze] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!miniWindow || !api) return;
    return api.on("chrome:agentWindowTransition", (payload) => {
      const p = (payload ?? {}) as {
        phase?: string;
        durationMs?: number;
        from?: { x?: number; y?: number; width?: number; height?: number };
        to?: { x?: number; y?: number; width?: number; height?: number };
      };
      if (p.phase !== "minimize" && p.phase !== "restore") return;
      const from = toRect(p.from);
      const to = toRect(p.to);
      if (!from || !to) return;
      const full = p.phase === "minimize" ? from : to;
      if (p.phase === "restore") setAgentIconRect(null);
      setAgentFloat({
        phase: p.phase,
        durationMs: Number(p.durationMs) || 400,
        from,
        to,
      });
      setAgentFloatStarted(false);
      setAgentFloatFreeze({ width: Math.round(full.width), height: Math.round(full.height) });
    });
  }, [miniWindow, api]);
  useEffect(() => {
    if (!agentFloat) return;
    // 先以起点几何挂载一帧，再切到终点 → 触发 CSS transition（Slime 用同一手法）。
    const raf = requestAnimationFrame(() => setAgentFloatStarted(true));
    return () => cancelAnimationFrame(raf);
  }, [agentFloat]);
  useEffect(() => {
    if (!agentFloat) return;
    // 兜底清理（主进程正常会在动画结束后通知 iconMode 切换，这里防丢事件卡在过渡态）。
    const timer = window.setTimeout(() => setAgentFloat(null), agentFloat.durationMs + 240);
    return () => window.clearTimeout(timer);
  }, [agentFloat]);
  useEffect(() => {
    if (!agentFloat) return;
    if (agentFloat.phase === "minimize" && agentIconMode) {
      setAgentIconRect(agentFloat.to);
      setAgentFloat(null);
    } else if (agentFloat.phase === "restore" && !agentIconMode) {
      setAgentFloat(null);
      setAgentFloatFreeze(null);
      setAgentIconRect(null);
    }
  }, [agentFloat, agentIconMode]);

  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!agentFloat) return;
    // 按面板宽度进度驱动内容透明度；宽度 > 90% 全亮，90%→45% smoothstep 淡出/淡入。
    const node = contentRef.current;
    if (!node) return;
    const fromW = agentFloat.from.width;
    const toW = agentFloat.to.width;
    const span = Math.max(1, Math.abs(fromW - toW));
    const minW = Math.min(fromW, toW);
    const lo = minW + span * 0.45;
    const hi = minW + span * 0.9;
    const band = Math.max(1, hi - lo);
    const duration = Math.max(1, agentFloat.durationMs);
    const started = performance.now();
    let raf = 0;
    node.style.transition = "none";
    const step = (): void => {
      const u = Math.min(1, (performance.now() - started) / duration);
      const width = fromW + (toW - fromW) * u;
      const raw = Math.max(0, Math.min(1, (width - lo) / band));
      const opacity = raw * raw * (3 - 2 * raw);
      node.style.opacity = String(opacity);
      if (u < 1) raf = requestAnimationFrame(step);
      else node.style.opacity = "";
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      node.style.transition = "";
      node.style.opacity = "";
    };
  }, [agentFloat]);

  useEffect(() => {
    if (!miniWindow) return;
    document.documentElement.dataset.mini = "1";
    return () => {
      delete document.documentElement.dataset.mini;
    };
  }, [miniWindow]);

  /** 独立窗口被用户关闭（或主进程回收）→ 主窗口恢复侧栏。 */
  useEffect(() => {
    if (!api || miniWindow) return;
    return api.on("chrome:agentWindowClosed", () => {
      agentWindowOpenRef.current = false;
      setAgentWindowOpen(false);
    });
  }, [api, miniWindow]);

  /**
   * Agent 第一次打开网页前的「会话窗口布局」安排：壳层已完成询问/记忆，
   * 这里只执行窗口动作：agentWindow 打开独立小窗；docked 收起小窗并落库常驻侧栏。
   */
  useEffect(() => {
    if (!api || miniWindow) return;
    return api.on("chrome:applyLayout", (payload) => {
      const { mode, sessionId } = (payload ?? {}) as { mode?: string; sessionId?: string };
      if (mode === "agentWindow") {
        if (agentWindowOpenRef.current) {
          void api.ui.openAgentWindow({ sessionId }).catch(() => {});
          return;
        }
        // 先占位再开：同一 tick 内再来一条事件也不会并发创建两个窗口。
        agentWindowOpenRef.current = true;
        void api.ui
          .openAgentWindow({ sessionId })
          .then((result) => {
            if (result.ok) {
              setAgentWindowOpen(true);
              return;
            }
            agentWindowOpenRef.current = false;
            setNotice(
              t(getLanguage(), "browser.layout.openFailed", {
                error: result.error ?? t(getLanguage(), "common.unknownError"),
              }),
            );
          })
          .catch(() => {
            agentWindowOpenRef.current = false;
            setNotice(
              t(getLanguage(), "browser.layout.openFailed", { error: t(getLanguage(), "common.unknownError") }),
            );
          });
        return;
      }
      if (mode !== "docked") return;
      if (agentWindowOpenRef.current) {
        agentWindowOpenRef.current = false;
        void api.ui.closeAgentWindow().catch(() => {});
        setAgentWindowOpen(false);
      }
      const prefs = preferencesRef.current;
      if (!prefs || prefs.sidebarMode === "docked") return;
      void api.settings
        .setPreferences({ ...prefs, sidebarMode: "docked" })
        .then((result) => setPreferences(result.preferences))
        .catch(() => {});
    });
  }, [api, miniWindow]);

  /** 侧栏模式切换：收起/展开写偏好；「小窗化」打开独立 Agent 窗口。 */
  const changeSidebarMode = useCallback(
    (next: SidebarMode): void => {
      if (!api) return;
      setSessionOpen(false);
      if (next === "float") {
        if (agentWindowOpen) {
          void api.ui.closeAgentWindow().catch(() => {});
          return;
        }
        void api.ui
          .openAgentWindow({ sessionId: currentSession ?? undefined })
          .then((r) => {
            if (r.ok) setAgentWindowOpen(true);
            else setNotice(`小窗打开失败：${r.error ?? "未知错误"}`);
          })
          .catch(() => setNotice("小窗打开失败"));
        return;
      }
      if (!preferences) return;
      const persist = (): void => {
        void api.settings
          .setPreferences({ ...preferences, sidebarMode: next })
          .then((r) => setPreferences(r.preferences))
          .catch(() => {});
      };
      persist();
    },
    [api, preferences, agentWindowOpen, currentSession],
  );

  // 图标态：整窗透明 + 单层圆角图标。按下拖动=移动窗口，单击（位移 < 4px）=还原会话视图。
  const iconDragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const beginIconDrag = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    iconDragRef.current = { x: event.screenX, y: event.screenY, moved: false };
    const move = (ev: PointerEvent): void => {
      const state = iconDragRef.current;
      if (!state) return;
      const dx = ev.screenX - state.x;
      const dy = ev.screenY - state.y;
      if (!state.moved && Math.abs(dx) + Math.abs(dy) > 4) state.moved = true;
      if (!state.moved || (dx === 0 && dy === 0)) return;
      state.x = ev.screenX;
      state.y = ev.screenY;
      void api?.ui.moveAgentWindow({ dx, dy }).catch(() => undefined);
    };
    const finish = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      iconDragRef.current = null;
    };
    const up = (): void => {
      const state = iconDragRef.current;
      finish();
      if (!state?.moved) void api?.ui.restoreAgentWindow().catch(() => undefined);
    };
    const cancel = (): void => {
      finish();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }, [api]);

  const floatRect = agentFloat ? (agentFloatStarted ? agentFloat.to : agentFloat.from) : null;
  const stableIconRect = !agentFloat && agentIconMode ? agentIconRect : null;
  const floatMs = agentFloat?.durationMs ?? 400;
  const floatEase = "cubic-bezier(0,0,0.2,1)";
  const contentHidden =
    agentFloat?.phase === "minimize" ? true : agentFloat?.phase === "restore" ? false : agentIconMode;
  const iconShown =
    agentFloat?.phase === "minimize" ? true : agentFloat?.phase === "restore" ? false : agentIconMode;
  const contentBaseOpacity = contentHidden || agentFloat?.phase === "restore" ? 0 : 1;
  const iconTransition =
    agentFloat?.phase === "minimize"
      ? "opacity 180ms ease 120ms"
      : agentFloat?.phase === "restore"
        ? "opacity 160ms ease"
        : "none";
  const panelTransition =
    agentFloat && agentFloatStarted
      ? `left ${floatMs}ms ${floatEase}, top ${floatMs}ms ${floatEase}, width ${floatMs}ms ${floatEase}, height ${floatMs}ms ${floatEase}`
      : "none";
  const freezeW = agentFloatFreeze?.width;
  const freezeH = agentFloatFreeze?.height;

  return {
    contentRef,
    beginIconDrag,
    changeSidebarMode,
    agentWindowOpen,
    agentIconMode,
    agentFloat,
    floatRect,
    stableIconRect,
    contentHidden,
    iconShown,
    contentBaseOpacity,
    iconTransition,
    panelTransition,
    freezeW,
    freezeH,
  };
}
