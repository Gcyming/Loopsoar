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
}

interface TabEntry {
  view: HostView;
  adapter: BrowserAdapter;
  url: string;
  title: string;
}

export type NavigateOutcome = { ok: true; url: string; tabId: string } | { ok: false; error: string };

export class BrowserHost {
  private tabs = new Map<string, TabEntry>();
  private activeId: string | null = null;
  private overlayOpen = false;
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
    const entry: TabEntry = { view, adapter, url: "", title: "新标签页" };
    this.tabs.set(id, entry);
    if (!this.activeId) this.activeId = id;
    return entry;
  }

  private activeEntry(): TabEntry | null {
    return this.activeId ? this.tabs.get(this.activeId) ?? null : null;
  }

  /** 几何与可见性统一收敛：所有标签同一区域，只有活动标签可见且非浮层态。 */
  private applyLayout(): void {
    const bounds = computeBrowserViewBounds(this.deps.getWindowSize());
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
    }));
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

  /** 导航：默认在活动标签内；无标签则先建一个。 */
  async navigate(rawUrl: string, tabId?: string): Promise<NavigateOutcome> {
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

  /** 新建标签（可带初始 URL）并切为活动标签。 */
  async newTab(rawUrl?: string): Promise<{ tabId: string; url?: string; ok: boolean; error?: string }> {
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
