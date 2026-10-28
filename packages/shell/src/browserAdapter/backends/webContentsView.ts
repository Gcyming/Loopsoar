/**
 * BrowserAdapter 主实现占位：WebContentsView（Electron 官方推荐路线，ADR-0003）。
 * D0 验证阶段（P0 决策门）通过前禁止真实现——所有方法抛 LoopsoarNotImplementedError。
 */
import type { BrowserAdapter } from "../types.js";

class LoopsoarNotImplementedError extends Error {
  constructor(what: string) {
    super(`${what}（D0 验证阶段实现）`);
    this.name = "LoopsoarNotImplementedError";
  }
}

export function createWebContentsViewAdapter(): BrowserAdapter {
  const notImpl = (m: string) => () => {
    throw new LoopsoarNotImplementedError(`BrowserAdapter.${m}`);
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
