/**
 * BrowserHost（多标签）：每个标签一个 WebContentsView，只有活动标签可见。
 * 关键修复：
 *  ① 网页里的 target=_blank / window.open 不再由 Electron 弹独立窗口，而是经 openInNewTab
 *     在应用内新建标签（与主流浏览器一致）；
 *  ② 打开应用内浮层（设置等）时隐藏原生视图，避免 WebContentsView 盖住 HTML 浮层；
 *  ③ 原生视图几何来自 contracts/layout（标题栏 + 顶栏 + 标签栏 + 状态条）。
 */
import {
  computeBrowserViewBounds,
  LAYOUT,
  type BrowserViewBounds,
  type WindowSize,
} from "loopsoar-contracts/layout";
import { normalizeNavigateUrl } from "loopsoar-contracts/navigation";
import {
  createWebContentsViewAdapter,
  type WebContentsViewLike,
} from "../browserAdapter/backends/webContentsView.js";
import type { BrowserAdapter, BrowserSnapshot } from "../browserAdapter/types.js";

export interface HostView extends WebContentsViewLike {
  setBounds(bounds: BrowserViewBounds): void;
  setVisible?(visible: boolean): void;
}

export interface BrowserHostDeps {
  createView: () => HostView;
  attachView: (view: HostView) => void;
  detachView: (view: HostView) => void;
  getWindowSize: () => WindowSize;
  /** 标签变化推送（UI 标签栏）。 */
  onTabsChanged?: (tabs: TabState[]) => void;
  /** 网页请求新窗口时由宿主转为新标签。 */
  openInNewTab?: (url: string) => void;
}

export interface TabState {
  id: string;
  url: string;
  title: string;
  active: boolean;
  canBack: boolean;
  canForward: boolean;
}

interface TabEntry {
  view: HostView;
  adapter: BrowserAdapter;
  url: string;
  title: string;
  /** 导航历史（仅记录应用内发起的导航；后退/前进按栈移动）。 */
  history: string[];
  index: number;
}

export type NavigateOutcome = { ok: true; url: string; tabId: string } | { ok: false; error: string };

export class BrowserHost {
  private tabs = new Map<string, TabEntry>();
  private activeId: string | null = null;
  private overlayOpen = false;
  /** 侧栏当前宽度（用户可拖拽；偏好持久化在 UI 层）。 */
  private sidebarWidth: number = LAYOUT.SIDEBAR_WIDTH;
  private seq = 0;

  constructor(private deps: BrowserHostDeps) {}

  private nextId(): string {
    this.seq += 1;
    return `tab-${this.seq}`;
  }

  private createTab(): TabEntry {
    const view = this.deps.createView();
    const adapter = createWebContentsViewAdapter({ view });
    this.deps.attachView(view);
    const id = this.nextId();
    const entry: TabEntry = { view, adapter, url: "", title: "新标签页", history: [], index: -1 };
    this.tabs.set(id, entry);
    if (!this.activeId) this.activeId = id;
    return entry;
  }

  private activeEntry(): TabEntry | null {
    return this.activeId ? this.tabs.get(this.activeId) ?? null : null;
  }

  /** 几何与可见性统一收敛：所有标签同一区域，只有活动标签可见且非浮层态。 */
  /** 侧栏拖拽调宽：原生视图区域随之重算。 */
  setSidebarWidth(width: number): void {
    this.sidebarWidth = Math.max(240, Math.min(720, Math.round(width)));
    this.applyLayout();
  }

  private applyLayout(): void {
    const bounds = computeBrowserViewBounds(this.deps.getWindowSize(), {
      ...LAYOUT,
      SIDEBAR_WIDTH: this.sidebarWidth,
    } as unknown as typeof LAYOUT);
    for (const [id, entry] of this.tabs) {
      entry.view.setBounds(bounds);
      const visible = id === this.activeId && !this.overlayOpen;
      entry.view.setVisible?.(visible);
    }
  }

  private emitTabs(): void {
    this.deps.onTabsChanged?.(this.listTabs());
  }

  listTabs(): TabState[] {
    return [...this.tabs.entries()].map(([id, entry]) => ({
      id,
      url: entry.url,
      title: entry.title,
      active: id === this.activeId,
      canBack: entry.index > 0,
      canForward: entry.index >= 0 && entry.index < entry.history.length - 1,
    }));
  }

  /** 指定标签（缺省=活动标签）。 */
  private resolveTab(tabId?: string): [string, TabEntry] | null {
    const id = tabId ?? this.activeId;
    if (!id) return null;
    const entry = this.tabs.get(id);
    return entry ? [id, entry] : null;
  }

  /** 后退 / 前进 / 刷新：基于本地历史栈（应用内导航）。 */
  async goBack(tabId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const resolved = this.resolveTab(tabId);
    if (!resolved) return { ok: false, error: "无标签页" };
    const [id, entry] = resolved;
    if (entry.index <= 0) return { ok: false, error: "没有可后退的历史" };
    entry.index -= 1;
    return this.navigateRecorded(entry.history[entry.index], id, false);
  }

  async goForward(tabId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const resolved = this.resolveTab(tabId);
    if (!resolved) return { ok: false, error: "无标签页" };
    const [id, entry] = resolved;
    if (entry.index >= entry.history.length - 1) return { ok: false, error: "没有可前进的历史" };
    entry.index += 1;
    return this.navigateRecorded(entry.history[entry.index], id, false);
  }

  async reload(tabId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const resolved = this.resolveTab(tabId);
    if (!resolved) return { ok: false, error: "无标签页" };
    const [id, entry] = resolved;
    if (!entry.url) return { ok: false, error: "当前标签没有页面" };
    return this.navigateRecorded(entry.url, id, false);
  }

  history(tabId?: string): { url: string; index: number; current: boolean }[] {
    const resolved = this.resolveTab(tabId);
    if (!resolved) return [];
    const [, entry] = resolved;
    return entry.history.map((url, i) => ({ url, index: i, current: i === entry.index }));
  }

  activeTabId(): string | null {
    return this.activeId;
  }

  hasAnyTab(): boolean {
    return this.tabs.size > 0;
  }

  /** 修复 ②：应用内浮层打开时隐藏原生视图。 */
  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open;
    this.applyLayout();
  }

  syncBounds(): void {
    this.applyLayout();
  }

  /** 导航：默认在活动标签内；无标签则先建一个（记录历史）。 */
  async navigate(rawUrl: string, tabId?: string): Promise<NavigateOutcome> {
    return this.navigateRecorded(rawUrl, tabId, true);
  }

  private async navigateRecorded(rawUrl: string, tabId?: string, record = true): Promise<NavigateOutcome> {
    const normalized = normalizeNavigateUrl(rawUrl);
    if (!normalized.ok) return { ok: false, error: normalized.reason };

    let id = tabId ?? this.activeId;
    if (!id || !this.tabs.has(id)) {
      const entry = this.createTab();
      id = this.activeId!;
      void entry;
    }
    this.activeId = id;
    const entry = this.tabs.get(id)!;
    try {
      const result = await entry.adapter.navigate(normalized.url);
      entry.url = result.url;
      if (record) {
        entry.history = entry.history.slice(0, entry.index + 1);
        entry.history.push(result.url);
        entry.index = entry.history.length - 1;
      }
      try {
        const title = await entry.adapter.executeJs("document.title");
        if (typeof title === "string" && title.trim()) entry.title = title.trim().slice(0, 80);
      } catch {
        entry.title = this.hostnameOf(result.url);
      }
      this.applyLayout();
      this.emitTabs();
      return { ok: true, url: result.url, tabId: id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private hostnameOf(url: string): string {
    try {
      return new URL(url).hostname || url;
    } catch {
      return url;
    }
  }

  /** 新建标签（可带初始 URL）并切为活动标签；同 URL 已存在时复用（防重复标签）。 */
  async newTab(rawUrl?: string): Promise<{ tabId: string; url?: string; ok: boolean; error?: string }> {
    if (rawUrl) {
      const normalized = normalizeNavigateUrl(rawUrl);
      if (normalized.ok) {
        for (const [id, tab] of this.tabs) {
          if (tab.url === normalized.url) {
            this.activeId = id;
            this.applyLayout();
            this.emitTabs();
            return { tabId: id, ok: true, url: tab.url };
          }
        }
      }
    }
    const entry = this.createTab();
    const id = this.activeId!;
    this.activeId = id;
    this.applyLayout();
    this.emitTabs();
    if (!rawUrl) return { tabId: id, ok: true };
    const outcome = await this.navigate(rawUrl, id);
    if (!outcome.ok) return { tabId: id, ok: false, error: outcome.error };
    void entry;
    return { tabId: id, ok: true, url: outcome.url };
  }

  selectTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) return false;
    this.activeId = tabId;
    this.applyLayout();
    this.emitTabs();
    return true;
  }

  async closeTab(tabId: string): Promise<boolean> {
    const entry = this.tabs.get(tabId);
    if (!entry) return false;
    this.tabs.delete(tabId);
    try {
      await entry.adapter.close();
    } finally {
      this.deps.detachView(entry.view);
    }
    if (this.activeId === tabId) {
      this.activeId = this.tabs.keys().next().value ?? null;
    }
    this.applyLayout();
    this.emitTabs();
    return true;
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.tabs.keys()]) await this.closeTab(id);
  }

  async snapshot(): Promise<BrowserSnapshot | null> {
    return this.activeEntry()?.adapter.snapshot() ?? null;
  }

  async screenshot(): Promise<string | null> {
    return this.activeEntry()?.adapter.screenshot() ?? null;
  }
}
