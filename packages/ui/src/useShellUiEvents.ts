/**
 * 主进程 → 渲染层的「界面意图」订阅：托盘菜单打开设置、网页右键引用到对话。
 *
 * 这些事件只表达用户意图（去哪、填什么），不直接暴露 DOM/IPC 细节；
 * 统一放这里，App 不再因每个新入口膨胀，且订阅/清理逻辑只有一份。
 */
import * as React from "react";
import type { LoopsoarAPI } from "./types.js";

export function useShellUiEvents(options: {
  api: LoopsoarAPI | null;
  openSettings: (section?: string) => void;
  appendComposer: (text: string) => void;
}): void {
  const { api, openSettings, appendComposer } = options;
  React.useEffect(() => {
    if (!api) return undefined;
    const offSettings = api.on("ui:openSettings", (payload) => {
      openSettings((payload as { section?: string } | null)?.section);
    });
    const offCompose = api.on("ui:compose", (payload) => {
      const text = (payload as { text?: string } | null)?.text?.trim();
      if (!text) return;
      appendComposer(text);
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
      });
    });
    return () => {
      offSettings?.();
      offCompose?.();
    };
  }, [api, openSettings, appendComposer]);
}
