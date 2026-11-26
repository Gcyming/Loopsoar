/**
 * browser 域：多标签控制 + 浮层遮挡修复（setOverlay）。
 * 原则：标签状态由浏览器宿主推送事件（browser:tabs），渲染层只做展示与操作转发。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { BrowserHost } from "../browserHost.js";
import { USER_TABS_SESSION } from "../browserHost.js";
import type { BrowserHistoryStore } from "../browserHistoryStore.js";
import type { DownloadsBridge } from "../electronBrowser.js";
import type { BrowserExtensionHost } from "../browserExtensions.js";

export interface BrowserDeps extends TrustedIpcDeps {
  browser?: BrowserHost;
  downloads?: DownloadsBridge;
  /** 全局历史（跨标签/跨会话共享，持久化）；未装配时 browser:history 返回空列表。 */
  history?: BrowserHistoryStore;
  /** 浏览器扩展宿主（未装配时列表为空、安装返回错误）。 */
  browserExtensions?: BrowserExtensionHost;
  /** 结束任务：关掉工作区全部页面、清任务快照与任务标记（关工作区 ≠ 留旧快照复活）。 */
  endTask?: (sessionId: string) => Promise<void> | void;
  /** 跨会话任务条：已落盘但尚未打开的任务会话（live listTasks 之外的持久化部分）。 */
  listTaskSessions?: () => { sessionId: string; tabs: Array<{ id: string; url: string; title: string; active: boolean; agentBound?: boolean }> }[];
  /** 历史/快捷入口缺图标时按页面 URL 回抓（主进程实现，含 HTML link 解析）。 */
  resolveFavicon?: (pageUrl: string) => Promise<string | null>;
  /** 底部开发者工具面板（开合/高度/可见性）。 */
  devtoolsPanel?: { setPanel: (height: number) => void; close: () => void; isOpen: () => boolean; setVisible: (visible: boolean) => void };
}

export function registerBrowserDomain(deps: BrowserDeps): void {
  handleTrusted(deps, "browser:navigate", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    const p = (payload ?? {}) as { url: string; sessionId?: string; origin?: "user" | "agent" };
    return deps.browser.navigate(
      p.url,
      undefined,
      p.sessionId ?? deps.browser.visibleSessionId(),
      p.origin ?? "user",
    );
  });

  handleTrusted(deps, "browser:newTab", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    const p = (payload ?? {}) as { url?: string; afterTabId?: string; openerTabId?: string };
    // 用户点「+」永远开在全局用户标签里：即使当前正在看任务工作区，也不该把空白页塞进任务组。
    const result = await deps.browser.newTab(p.url, USER_TABS_SESSION, "user", {
      ...(p.afterTabId ? { afterTabId: p.afterTabId, forceNew: true } : {}),
      ...(p.openerTabId ? { openerId: p.openerTabId } : {}),
    });
    deps.browser.showUserTabs();
    return result;
  });

  handleTrusted(deps, "browser:closeTab", async (payload) => {
    if (!deps.browser) return { closed: false };
    return { closed: await deps.browser.closeTab((payload as { tabId: string }).tabId, deps.browser.visibleSessionId()) };
  });

  handleTrusted(deps, "browser:closeTabs", async (payload) => {
    if (!deps.browser) return { closed: 0 };
    return { closed: await deps.browser.closeTabs((payload as { tabIds: string[] }).tabIds, deps.browser.visibleSessionId()) };
  });

  handleTrusted(deps, "browser:duplicateTab", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    return deps.browser.duplicateTab((payload as { tabId: string }).tabId, deps.browser.visibleSessionId());
  });

  handleTrusted(deps, "browser:setTabMuted", async (payload) => {
    if (!deps.browser) return { ok: false };
    const p = payload as { tabId: string; muted: boolean };
    return { ok: await deps.browser.setTabMuted(p.tabId, p.muted, deps.browser.visibleSessionId()) };
  });

  handleTrusted(deps, "browser:setTabPinned", async (payload) => {
    if (!deps.browser) return { ok: false };
    const p = payload as { tabId: string; pinned: boolean };
    return { ok: await deps.browser.setTabPinned(p.tabId, p.pinned, deps.browser.visibleSessionId()) };
  });

  handleTrusted(deps, "browser:reopenClosedTab", async () => {
    if (!deps.browser) return { ok: false };
    return deps.browser.reopenClosedTab(deps.browser.visibleSessionId());
  });

  handleTrusted(deps, "browser:closeSessionTabs", async (payload) => {
    if (!deps.browser) return { closed: 0 };
    return { closed: await deps.browser.closeSessionTabs((payload as { sessionId: string }).sessionId) };
  });

  handleTrusted(deps, "browser:selectTab", (payload) => {
    if (!deps.browser) return { selected: false };
    return { selected: deps.browser.selectTab((payload as { tabId: string }).tabId, deps.browser.visibleSessionId()) };
  });

  handleTrusted(deps, "browser:moveTab", (payload) => {
    if (!deps.browser) return { ok: false };
    const p = payload as { tabId: string; targetTabId: string; after?: boolean };
    return { ok: deps.browser.moveTab(p.tabId, p.targetTabId, p.after === true, deps.browser.visibleSessionId()) };
  });

  handleTrusted(deps, "browser:listTabs", () => ({
    tabs: deps.browser?.listTabs(deps.browser.visibleSessionId()) ?? [],
    visibleSession: deps.browser?.visibleSessionId() ?? USER_TABS_SESSION,
  }));
  handleTrusted(deps, "browser:endTask", async (payload) => {
    const sessionId = (payload as { sessionId?: string } | null)?.sessionId;
    if (!sessionId || !deps.endTask) return { ok: false };
    await deps.endTask(sessionId);
    return { ok: true };
  });
  handleTrusted(deps, "browser:setCornerColor", (payload) => {
    const color = (payload as { color?: string } | null)?.color;
    if (color) deps.browser?.setCornerColor(color);
    return { ok: Boolean(color) };
  });
  handleTrusted(deps, "browser:listTasks", () => {
    const merged = new Map<string, { sessionId: string; tabs: unknown[] }>();
    for (const task of deps.browser?.listTasks() ?? []) merged.set(task.sessionId, task);
    for (const task of deps.listTaskSessions?.() ?? []) {
      if (!merged.has(task.sessionId)) merged.set(task.sessionId, task);
    }
    return {
      tasks: [...merged.values()],
      visibleSession: deps.browser?.visibleSessionId() ?? USER_TABS_SESSION,
    };
  });
  handleTrusted(deps, "browser:showTask", (payload) => {
    if (!deps.browser) return { ok: false, tabs: [] };
    const sessionId = (payload as { sessionId?: string } | null)?.sessionId;
    if (!sessionId) return { ok: false, tabs: [] };
    deps.browser.showTask(sessionId);
    return { ok: true, tabs: deps.browser.listTabs(sessionId) };
  });
  handleTrusted(deps, "browser:showUserTabs", () => {
    deps.browser?.showUserTabs();
    return { ok: true, tabs: deps.browser?.listTabs(USER_TABS_SESSION) ?? [] };
  });

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
    deps.devtoolsPanel?.setVisible(!open);
    return { open };
  });

  // 前进 / 后退 / 刷新（应用内导航历史栈）
  handleTrusted(deps, "browser:back", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    // UI 控制的是「用户当前看到的标签组」：必须用 visibleSession，不能落到后台 activeSession，
    // 否则用户看着用户标签时点后退/刷新，改的是另一个会话里隐藏的页面。
    return deps.browser.goBack((payload as { tabId?: string } | null)?.tabId, deps.browser.visibleSessionId());
  });

  handleTrusted(deps, "browser:forward", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    return deps.browser.goForward((payload as { tabId?: string } | null)?.tabId, deps.browser.visibleSessionId());
  });

  handleTrusted(deps, "browser:reload", async (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    return deps.browser.reload((payload as { tabId?: string } | null)?.tabId, deps.browser.visibleSessionId());
  });

  // 底部开发者工具面板：渲染层在布局变化时把高度同步给主进程；open=false 表示用户收起。
  handleTrusted(deps, "browser:setDevToolsPanel", (payload) => {
    const p = (payload ?? {}) as { open?: boolean; height?: number };
    if (typeof p.height === "number") deps.devtoolsPanel?.setPanel(p.height);
    if (p.open === false) deps.devtoolsPanel?.close();
    return { open: deps.devtoolsPanel?.isOpen() ?? false };
  });

  // 开发者工具：当前标签切换底部调试面板（F12 / 状态栏按钮）。
  handleTrusted(deps, "browser:toggleDevTools", (payload) => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    return deps.browser.toggleDevTools((payload as { tabId?: string } | null)?.tabId);
  });

  // 浏览器扩展（Chrome/Edge 系，Electron 子集）：列表 / 安装（本地目录或 Chrome 商店）/ 卸载。
  handleTrusted(deps, "browser:listExtensions", () => ({
    extensions: deps.browserExtensions?.list() ?? [],
  }));
  handleTrusted(deps, "browser:installExtension", async (payload) => {
    if (!deps.browserExtensions) return { ok: false, error: "扩展宿主未装配" };
    const p = (payload ?? {}) as { path?: string; url?: string };
    try {
      if (p.path) return { ok: true, extension: await deps.browserExtensions.installFromFolder(p.path) };
      if (p.url) return { ok: true, extension: await deps.browserExtensions.installFromStore(p.url) };
      return { ok: false, error: "需要 path（本地目录）或 url（Chrome 商店链接/扩展 ID）" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  handleTrusted(deps, "browser:removeExtension", async (payload) => {
    if (!deps.browserExtensions) return { ok: false, error: "扩展宿主未装配" };
    return deps.browserExtensions.remove((payload as { id: string }).id);
  });

  // 历史条目缺图标（旧数据/抓取失败）时补抓一次，并写回历史。
  handleTrusted(deps, "browser:resolveFavicon", async (payload) => {
    const url = (payload as { url: string }).url;
    const favicon = (await deps.resolveFavicon?.(url)) ?? null;
    if (favicon) deps.history?.updateFavicon(url, favicon);
    return { favicon };
  });

  // 全局历史（跨标签/跨会话共享，持久化）：历史面板的唯一数据源。
  // 兼容字段 `tab`：当前标签的内部历史栈（后退/前进语义），旧调用方/诊断仍可用，但不再作为面板数据源。
  handleTrusted(deps, "browser:history", (payload) => ({
    entries: deps.history?.list() ?? [],
    tab: deps.browser?.history((payload as { tabId?: string } | null)?.tabId) ?? [],
  }));

  /** 历史页勾选删除：按 url 批量移除（幂等；返回实际删除条数）。 */
  handleTrusted(deps, "browser:historyRemove", (payload) => ({
    removed: deps.history?.remove((payload as { urls: string[] }).urls) ?? 0,
  }));

  // 下载管理（electron 会话级 will-download → DownloadsBridge）
  handleTrusted(deps, "browser:downloads", () => ({
    downloads: deps.downloads?.list() ?? [],
  }));

  handleTrusted(deps, "browser:downloadAction", (payload) => {
    const p = payload as { id: string; action: "cancel" | "open" | "showInFolder" | "remove" | "deleteFile" | "start" | "alwaysOpen" };
    return { ok: deps.downloads?.action(p.id, p.action) ?? false };
  });

  handleTrusted(deps, "browser:snapshot", async () => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    const snapshot = await deps.browser.snapshot(deps.browser.visibleSessionId());
    if (!snapshot) return { ok: false, error: "无活动网页（先导航）" };
    return { ok: true, ...snapshot };
  });

  handleTrusted(deps, "browser:screenshot", async () => {
    if (!deps.browser) return { ok: false, error: "浏览器宿主未装配" };
    const data = await deps.browser.screenshot(deps.browser.visibleSessionId());
    if (!data) return { ok: false, error: "无活动网页（先导航）" };
    return { ok: true, data };
  });
}
