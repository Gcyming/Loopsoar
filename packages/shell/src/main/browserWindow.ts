/** 独立浏览器窗口域：只做 IPC 适配；真正的 BrowserWindow 创建在 electronBrowser.ts（允许碰 electron 的薄适配层）。 */
import { handleTrusted, type TrustedIpcDeps } from "./trustedIpc.js";

export interface BrowserWindowDomainDeps extends TrustedIpcDeps {
  openWindow: (url: string) => { ok: boolean; error?: string };
}

export function registerBrowserWindowDomain(deps: BrowserWindowDomainDeps): void {
  handleTrusted(deps, "ui:openBrowserWindow", (payload) =>
    deps.openWindow((payload as { url?: string })?.url ?? ""),
  );
}
