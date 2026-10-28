/**
 * browser 域：多标签控制 + 浮层遮挡修复（setOverlay）。
 * 原则：标签状态由浏览器宿主推送事件（browser:tabs），渲染层只做展示与操作转发。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { BrowserHost } from "../browserHost.js";

export interface BrowserDeps extends TrustedIpcDeps {
  browser?: BrowserHost;
}

export function registerBrowserDomain(deps: BrowserDeps): void {
  handleTrusted(deps, "browser:navigate", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    return deps.browser.navigate((payload as { url: string }).url);
  });

  handleTrusted(deps, "browser:newTab", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    const p = (payload ?? {}) as { url?: string };
    return deps.browser.newTab(p.url);
  });

  handleTrusted(deps, "browser:closeTab", async (payload) => {
    if (!deps.browser) return { closed: false };
    return { closed: await deps.browser.closeTab((payload as { tabId: string }).tabId) };
  });

  handleTrusted(deps, "browser:selectTab", (payload) => {
    if (!deps.browser) return { selected: false };
    return { selected: deps.browser.selectTab((payload as { tabId: string }).tabId) };
  });

  handleTrusted(deps, "browser:listTabs", () => ({
    tabs: deps.browser?.listTabs() ?? [],
  }));

  // 侧栏拖拽调宽：原生视图区域随之重算
  handleTrusted(deps, "browser:setSidebarWidth", (payload) => {
    const width = (payload as { width: number }).width;
    deps.browser?.setSidebarWidth(width);
    return { width };
  });

  // 修复遮挡：设置等应用内浮层打开时隐藏原生浏览器视图
  handleTrusted(deps, "browser:setOverlay", (payload) => {
    const open = (payload as { open: boolean }).open;
    deps.browser?.setOverlayOpen(open);
    return { open };
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
