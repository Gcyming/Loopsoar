import { useCallback, useEffect, useRef, useState } from "react";
import { LAYOUT } from "loopsoar-contracts/layout";
import type { LoopsoarAPI } from "./types.js";

/** 终端抽屉高度持久化键（与 railParams 等本地设置一致，放 localStorage）。 */
const TERMINAL_HEIGHT_STORAGE_KEY = "loopsoar_terminal_height";

/** 读取持久化的终端抽屉高度：夹紧到契约范围，读失败回默认值。 */
function readTerminalHeight(): number {
  const fallback = LAYOUT.TERMINAL_PANEL_HEIGHT;
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(
      LAYOUT.TERMINAL_PANEL_MAX_HEIGHT,
      Math.max(LAYOUT.TERMINAL_PANEL_MIN_HEIGHT, Math.round(value)),
    );
  } catch {
    return fallback; // 隐私模式等不允许访问 localStorage
  }
}

export interface BottomDockOptions {
  api: LoopsoarAPI | null;
  activeTabId: string | null;
  setNotice: (text: string) => void;
}

/**
 * 底部终端/DevTools 抽屉：状态、持久化、主进程几何同步与快捷键。
 *
 * 为什么独立：终端与 DevTools 共享底部区域，开合、底部 inset、F12、切标签收起
 * 是同一组约束；放在 App 里会和会话/浏览器状态缠在一起，无法单独验证。
 */
export function useBottomDock({ api, activeTabId, setNotice }: BottomDockOptions) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [devtoolsHeight] = useState(360);
  const [terminalHeight, setTerminalHeight] = useState<number>(() => readTerminalHeight());

  /** 最近一次下发给原生视图的底部 inset（动画起点）。 */
  const lastBottomRef = useRef<number | null>(null);
  const bottomRafRef = useRef<number | null>(null);

  // 全宽终端/DevTools 占用的底部高度 → 原生网页视图必须让出，否则面板会被 WebContentsView 盖住。
  // 面板本身有 240ms 的高度过渡；inset 也必须逐帧跟随，否则过渡期间网页底边与面板之间会露出
  // 应用底色（用户看到的“黑边”）。用与 CSS 近似的 easeOutCubic 在 240ms 内同步。
  useEffect(() => {
    if (!api) return;
    const target = terminalOpen ? terminalHeight : devtoolsOpen ? devtoolsHeight : 0;
    if (bottomRafRef.current !== null) {
      cancelAnimationFrame(bottomRafRef.current);
      bottomRafRef.current = null;
    }
    const previous = lastBottomRef.current;
    lastBottomRef.current = target;
    if (previous === null || previous === target) {
      void api.browser.setBottomInset({ bottom: target }).catch(() => {});
      return;
    }
    const from = previous;
    const startedAt = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / 240);
      const eased = 1 - Math.pow(1 - t, 3);
      void api.browser
        .setBottomInset({ bottom: Math.round(from + (target - from) * eased) })
        .catch(() => {});
      if (t < 1) {
        bottomRafRef.current = requestAnimationFrame(step);
      } else {
        bottomRafRef.current = null;
        void api.browser.setBottomInset({ bottom: target }).catch(() => {});
      }
    };
    bottomRafRef.current = requestAnimationFrame(step);
    return () => {
      if (bottomRafRef.current !== null) {
        cancelAnimationFrame(bottomRafRef.current);
        bottomRafRef.current = null;
      }
    };
  }, [api, terminalOpen, terminalHeight, devtoolsOpen, devtoolsHeight]);

  // 底部开发者工具：主进程负责面板开合（含页面内 F12 / devtools 自身关闭），渲染层只同步状态。
  useEffect(() => {
    if (!api) return;
    return api.on("chrome:devToolsPanel", (payload) => {
      const open = Boolean((payload as { open?: boolean } | null)?.open);
      setDevtoolsOpen(open);
    });
  }, [api]);

  // 面板高度/开合同步给主进程（窗口 resize 由主进程自己重算）。
  useEffect(() => {
    if (!api) return;
    const timer = window.setTimeout(() => {
      void api.browser.setDevToolsPanel({ open: devtoolsOpen, height: devtoolsHeight }).catch(() => undefined);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [api, devtoolsOpen, devtoolsHeight]);

  const toggleDevtools = useCallback((): void => {
    if (!api) return;
    if (terminalOpen) setTerminalOpen(false);
    void api.browser
      .toggleDevTools({})
      .then((result) => {
        if (!result.ok) setNotice(result.error ?? "无法打开开发者工具");
      })
      .catch((err: unknown) =>
        setNotice(`无法打开开发者工具：${err instanceof Error ? err.message : String(err)}`),
      );
  }, [api, terminalOpen, setNotice]);

  // F12 / Ctrl+Shift+I：DOM 焦点在主窗口时也能开关底部调试面板（网页内由浏览器 adapter 处理）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const inspect = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i";
      if (event.key !== "F12" && !inspect) return;
      event.preventDefault();
      toggleDevtools();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleDevtools]);

  // 切标签时收起调试面板（面板绑定的是原标签的 WebContents，避免显示错页）。
  useEffect(() => {
    if (!devtoolsOpen || !api) return;
    void api.browser.setDevToolsPanel({ open: false }).catch(() => undefined);
    // 只在标签切换时触发；devtoolsOpen 作为守卫读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, api]);

  const toggleTerminal = useCallback((): void => {
    if (!terminalOpen && devtoolsOpen) {
      void api?.browser.setDevToolsPanel({ open: false }).catch(() => undefined);
    }
    setTerminalOpen((value) => !value);
  }, [api, terminalOpen, devtoolsOpen]);

  // 终端抽屉高度：夹紧到契约范围并持久化（TerminalPanel 拖拽/键盘调整后回调）
  const changeTerminalHeight = useCallback((next: number): void => {
    const clamped = Math.min(
      LAYOUT.TERMINAL_PANEL_MAX_HEIGHT,
      Math.max(LAYOUT.TERMINAL_PANEL_MIN_HEIGHT, Math.round(next)),
    );
    setTerminalHeight(clamped);
    try {
      localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(clamped));
    } catch {
      // 忽略（隐私模式等）
    }
  }, []);

  return {
    terminalOpen,
    setTerminalOpen,
    devtoolsOpen,
    devtoolsHeight,
    terminalHeight,
    toggleDevtools,
    toggleTerminal,
    changeTerminalHeight,
  };
}
