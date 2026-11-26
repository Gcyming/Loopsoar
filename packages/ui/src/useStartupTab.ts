/**
 * 启动首帧的「新会话草稿 + 空白标签」编排（从 App 抽出，避免组合根膨胀）。
 *
 * 关键时序：shell 的重新打开恢复是异步的，而本 effect 之前固定 120ms 就调用
 * createFreshSessionAndTab。恢复慢一点时 listTabs() 还是空的，就会凭空创建/选中一个
 * 空白标签，用户看到的现象是「网页已恢复显示，但标签栏一个都没有，点新建后全蹦出来」。
 * 这里先等恢复标签出现（最多约 1s），再执行原有「每次启动新会话」规则。
 */
import { useEffect, useRef } from "react";
import type { LoopsoarAPI } from "./types.js";

export interface StartupTabOptions {
  api: LoopsoarAPI | null;
  miniWindow: boolean;
  boot: unknown;
  createFreshSessionAndTab: () => Promise<void>;
  setNotice: (text: string) => void;
}

export function useStartupTab({
  api,
  miniWindow,
  boot,
  createFreshSessionAndTab,
  setNotice,
}: StartupTabOptions): void {
  const ensuredRef = useRef(false);
  useEffect(() => {
    if (!api || miniWindow || ensuredRef.current || !boot) return;
    ensuredRef.current = true;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        // 启动恢复是异步的（多标签 restore 还要等页面导航）：给主进程最多 ~2.5s 建出恢复标签，
        // 避免抢跑创建多余空白页/空标签栏。
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const existing = await api.browser.listTabs().catch(() => null);
          if (cancelled) return;
          if (existing && existing.tabs.length > 0) break;
          await new Promise((resolve) => window.setTimeout(resolve, 200));
        }
        if (cancelled) return;
        await createFreshSessionAndTab().catch((err: unknown) => {
          if (!cancelled) setNotice("新建会话失败：" + (err instanceof Error ? err.message : String(err)));
        });
      })();
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, miniWindow, boot, createFreshSessionAndTab, setNotice]);
}
