/**
 * 设置入口与主进程界面事件的接线（从 App 抽出，避免组合根继续膨胀）。
 */
import * as React from "react";
import { dismissAllPopovers } from "./popover.js";
import { useShellUiEvents } from "./useShellUiEvents.js";
import type { LoopsoarAPI } from "./types.js";

export function useSettingsEntry(options: {
  api: LoopsoarAPI | null;
  setSection: (section: string) => void;
  setOpen: (open: boolean) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
}): (section?: string) => void {
  const { api, setSection, setOpen, setInput } = options;
  const openSettings = React.useCallback(
    (section?: string): void => {
      // 进入设置属于「切换界面」：任何展开中的列表/浮层（含 Composer 权限菜单）先收起。
      dismissAllPopovers();
      setSection(section ?? "general");
      setOpen(true);
    },
    [setOpen, setSection],
  );
  const appendComposer = React.useCallback(
    (text: string): void => {
      setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${text}` : text));
    },
    [setInput],
  );
  useShellUiEvents({ api, openSettings, appendComposer });
  return openSettings;
}
