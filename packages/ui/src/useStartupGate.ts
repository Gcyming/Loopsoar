/**
 * 启动门（参考 slime 的 A-1039 启动面板设计）：
 * 首屏数据（壳层状态/偏好）+ 恢复标签到齐后才允许退场；最短展示 1.1s、总超时 8s 兜底，
 * 避免任何一个慢数据源把启动界面卡死。原生网页视图由 baseOverlay 同源隐藏。
 */
import { useEffect, useMemo, useState } from "react";

export interface SplashStep {
  label: string;
  done: boolean;
}

export interface StartupGate {
  splashVisible: boolean;
  /** 原生网页视图的隐藏信号：比 splashVisible 多留 280ms，让启动面板在网页出现前完成淡出。 */
  splashOverlay: boolean;
  splashStatus: string;
  splashSteps: SplashStep[];
}

export function useStartupGate(input: { boot: unknown; preferences: unknown; tabs: unknown[] }): StartupGate {
  const [minDone, setMinDone] = useState(false);
  const [deadline, setDeadline] = useState(false);

  // 首帧静态启动页由 React 接管（小窗/主窗都加载同一 index.html，必须都由这里移除）。
  useEffect(() => {
    document.getElementById("boot-splash")?.remove();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinDone(true), 1100);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDeadline(true), 8000);
    return () => window.clearTimeout(timer);
  }, []);

  const [overlayHeld, setOverlayHeld] = useState(true);
  const bootDone = Boolean(input.boot);
  const prefsDone = Boolean(input.preferences);
  const tabsDone = input.tabs.length > 0;
  const uiReady = (bootDone && prefsDone && tabsDone) || deadline;
  const splashVisible = !minDone || !uiReady;
  useEffect(() => {
    if (splashVisible) {
      setOverlayHeld(true);
      return;
    }
    const timer = window.setTimeout(() => setOverlayHeld(false), 280);
    return () => window.clearTimeout(timer);
  }, [splashVisible]);
  const splashStatus = !bootDone
    ? "正在启动…"
    : !prefsDone
      ? "正在加载设置与会话…"
      : !tabsDone
        ? "正在恢复网页标签…"
        : "正在进入…";

  const splashSteps = useMemo<SplashStep[]>(
    () => [
      { label: "启动壳层", done: bootDone },
      { label: "设置与会话", done: prefsDone },
      { label: "恢复网页标签", done: tabsDone },
    ],
    [bootDone, prefsDone, tabsDone],
  );

  return { splashVisible, splashOverlay: overlayHeld || splashVisible, splashStatus, splashSteps };
}
