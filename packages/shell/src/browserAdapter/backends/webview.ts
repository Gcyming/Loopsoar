/**
 * BrowserAdapter 兼容后端占位：<webview>（Electron 官方已不建议，仅作兼容层，ADR-0003）。
 * 不新增任何功能依赖；D0 前禁止真实现。
 */
import type { BrowserAdapter } from "../types.js";

export function createWebviewCompatAdapter(): BrowserAdapter {
  const notImpl = (m: string) => () => {
    throw new Error(`BrowserAdapter.${m}（webview 兼容后端未实现，仅保留接口）`);
  };
  return {
    navigate: notImpl("navigate"),
    snapshot: notImpl("snapshot"),
    click: notImpl("click"),
    type: notImpl("type"),
    scroll: notImpl("scroll"),
    screenshot: notImpl("screenshot"),
    wait: notImpl("wait"),
    executeJs: notImpl("executeJs"),
    close: notImpl("close"),
  };
}
