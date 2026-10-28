/**
 * browser 域：真实 BrowserHost 接线（D0 已通过，ADR-0003 接口冻结）。
 * 错误一律结构化返回（{ok:false,error}），不向渲染进程抛裸异常。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { BrowserHost } from "../browserHost.js";

export interface BrowserDeps extends TrustedIpcDeps {
  browser?: BrowserHost;
  /** 布局变化（窗口缩放）时让原生视图重新对齐。 */
  syncBrowserBounds?: () => void;
}

export function registerBrowserDomain(deps: BrowserDeps): void {
  handleTrusted(deps, "browser:navigate", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    const result = await deps.browser.navigate((payload as { url: string }).url);
    return result;
  });

  handleTrusted(deps, "browser:snapshot", async () => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    const snapshot = await deps.browser.snapshot();
    if (!snapshot) return { ok: false, error: "无活动网页（先导航）" };
    return { ok: true, ...snapshot };
  });

  handleTrusted(deps, "browser:screenshot", async () => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    const data = await deps.browser.screenshot();
    if (!data) return { ok: false, error: "无活动网页（先导航）" };
    return { ok: true, data };
  });
}
