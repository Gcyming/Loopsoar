/**
 * window 域：自定义标题栏的窗口控制（无原生 frame 时由渲染层按钮驱动）。
 * 依赖注入：真实实现由 index.ts 接 BrowserWindow；测试用假控制器（不启窗口）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

let contextMenuSuppressCount = 0;

/** 应用内菜单（RowContextMenu 等）打开时，主进程原生右键菜单应静默。 */
export function isContextMenuSuppressed(): boolean {
  return contextMenuSuppressCount > 0;
}

/** 主窗口重载时清空计数，避免渲染层卸载未走 cleanup 导致原生菜单永久失效。 */
export function resetContextMenuSuppression(): void {
  contextMenuSuppressCount = 0;
}

export interface WindowControls {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): boolean;
  isFocused?(): boolean;
}

export interface WindowDeps extends TrustedIpcDeps {
  windowControls?: WindowControls;
}

export function registerWindowDomain(deps: WindowDeps): void {
  handleTrusted(deps, "ui:setContextMenuSuppressed", (payload) => {
    const suppressed = Boolean((payload as { suppressed?: boolean })?.suppressed);
    contextMenuSuppressCount = Math.max(0, contextMenuSuppressCount + (suppressed ? 1 : -1));
    return { ok: true };
  });

  handleTrusted(deps, "window:minimize", () => {
    deps.windowControls?.minimize();
    return { ok: Boolean(deps.windowControls) };
  });

  handleTrusted(deps, "window:maximize", () => {
    deps.windowControls?.toggleMaximize();
    return { ok: Boolean(deps.windowControls), maximized: deps.windowControls?.isMaximized() ?? false };
  });

  handleTrusted(deps, "window:close", () => {
    deps.windowControls?.close();
    return { ok: Boolean(deps.windowControls) };
  });

  handleTrusted(deps, "window:state", () => ({
    maximizeSupported: Boolean(deps.windowControls),
    maximized: deps.windowControls?.isMaximized() ?? false,
    focused: deps.windowControls?.isFocused?.() ?? false,
  }));
}
