/**
 * browser 域：多标签控制 + 浮层遮挡修复（setOverlay）。
 * 原则：标签状态由浏览器宿主推送事件（browser:tabs），渲染层只做展示与操作转发。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { BrowserHost } from "../browserHost.js";
import type { BrowserHistoryStore } from "../browserHistoryStore.js";
import type { DownloadsBridge } from "../electronBrowser.js";

export interface BrowserDeps extends TrustedIpcDeps {
  browser?: BrowserHost;
  downloads?: DownloadsBridge;
  /** 全局历史（跨标签/跨会话共享，持久化）；未装配时 browser:history 返回空列表。 */
  history?: BrowserHistoryStore;
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

  // 侧栏调宽：拖拽（animate 缺省 = false）必须立即跟手；收起/展开按钮传 animate:true，
  // 由宿主用与 DOM 侧栏相同的曲线/时长逐帧重算原生视图，消除「侧栏先动、网页后动」。
  handleTrusted(deps, "browser:setSidebarWidth", (payload) => {
    const p = (payload ?? {}) as { width?: unknown; animate?: unknown };
    const width = typeof p.width === "number" ? p.width : 0;
    deps.browser?.setSidebarWidth(width, p.animate === true);
    return { width };
  });

  // 底部 DOM 面板（全宽终端）高度：原生网页视图让出这一段，否则会被面板盖住。
  // 契约已限制 0..2000 整数，这里再夹一次并回显实际生效值（UI 可用返回值校准）。
  handleTrusted(deps, "browser:setBottomInset", (payload) => {
    const raw = (payload as { bottom: number }).bottom;
    const bottom = Math.max(0, Math.min(2000, Number.isFinite(raw) ? Math.round(raw) : 0));
    deps.browser?.setBottomInset(bottom);
    return { bottom };
  });

  // 修复遮挡：设置等应用内浮层打开时隐藏原生浏览器视图
  handleTrusted(deps, "browser:setOverlay", (payload) => {
    const open = (payload as { open: boolean }).open;
    deps.browser?.setOverlayOpen(open);
    return { open };
  });

  // 前进 / 后退 / 刷新（应用内导航历史栈）
  handleTrusted(deps, "browser:back", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    return deps.browser.goBack((payload as { tabId?: string } | null)?.tabId);
  });

  handleTrusted(deps, "browser:forward", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    return deps.browser.goForward((payload as { tabId?: string } | null)?.tabId);
  });

  handleTrusted(deps, "browser:reload", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    return deps.browser.reload((payload as { tabId?: string } | null)?.tabId);
  });

  // 全局历史（跨标签/跨会话共享，持久化）：历史面板的唯一数据源。
  // 兼容字段 `tab`：当前标签的内部历史栈（后退/前进语义），旧调用方/诊断仍可用，但不再作为面板数据源。
  handleTrusted(deps, "browser:history", (payload) => ({
    entries: deps.history?.list() ?? [],
    tab: deps.browser?.history((payload as { tabId?: string } | null)?.tabId) ?? [],
  }));

  // 下载管理（electron 会话级 will-download → DownloadsBridge）
  handleTrusted(deps, "browser:downloads", () => ({
    downloads: deps.downloads?.list() ?? [],
  }));

  handleTrusted(deps, "browser:downloadAction", (payload) => {
    const p = payload as { id: string; action: "cancel" | "open" | "showInFolder" | "remove" };
    return { ok: deps.downloads?.action(p.id, p.action) ?? false };
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
