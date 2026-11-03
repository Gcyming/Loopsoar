/**
 * BrowserHost（会话级多标签）：每个会话拥有自己的标签集合，只有**当前会话**的活动标签可见。
 *
 * 会话即"文件夹"：切换会话 = 换一组标签与页面；后台会话的标签仍然存活，
 * Agent 工具按 ctx.sessionId 直接操作自己会话的标签（不会串到用户正在看的会话）。
 *
 * 其他既有约束保持不变：
 *  ① 网页 target=_blank/window.open 由宿主转为应用内新标签；
 *  ② 浮层打开时隐藏原生视图；
 *  ③ 几何来自 contracts/layout（含分隔条宽度让位）。
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
import { sanitizeBrowserState, type PersistedBrowserState, type PersistedBrowserTab } from "./browserSessionState.js";
import { easeCubicBezier } from "./agentWindow.js";

/** 侧栏展开/收起动画时长：与 UI 侧栏 DOM 过渡同一条 cubic-bezier(0.2,0,0.2,1) 曲线（单产地在 agentWindow.easeCubicBezier）。 */
export const SIDEBAR_ANIMATION_MS = 320;
/** 动画帧间隔（约 60fps）。 */
export const SIDEBAR_ANIMATION_TICK_MS = 16;

export type { PersistedBrowserState, PersistedBrowserTab } from "./browserSessionState.js";

export interface HostView extends WebContentsViewLike {
  setBounds(bounds: BrowserViewBounds): void;
  setVisible?(visible: boolean): void;
  /** 真实视图几何（Electron WebContentsView.getBounds；假 View 可不实现）。 */
  getBounds?(): { x: number; y: number; width: number; height: number };
}

export interface BrowserHostDeps {
  createView: () => HostView;
  attachView: (view: HostView) => void;
  detachView: (view: HostView) => void;
  getWindowSize: () => WindowSize;
  /** 当前会话标签变化推送（UI 标签栏）。 */
  onTabsChanged?: (tabs: TabState[]) => void;
  /** 任一会话的标签状态变化（持久化用）；index 侧做防抖落盘。 */
  onSessionStateChanged?: (sessionId: string, state: PersistedBrowserState) => void;
  /**
   * 成功访问（应用内导航 / 网页内跳转 / 新标签首个页面）。壳层据此追加**全局历史**：
   * 历史面板跨标签/跨会话共享，与标签内部的后退/前进栈互不影响。
   */
  onVisited?: (visit: BrowserVisit) => void;
  /** 页面标题变化：壳层用它刷新全局历史里同 URL 条目的标题（不新增访问）。 */
  onTitleChanged?: (url: string, title: string) => void;
  /** 网页请求新窗口时由宿主转为新标签。 */
  openInNewTab?: (url: string) => void;
  /** 初始会话（默认 default）。 */
  initialSessionId?: string;
  /**
   * 测试注入：定时器（缺省全局 setInterval/clearInterval）。
   * 侧栏宽度动画需要逐帧触发 applyLayout；测试用手动 scheduler 驱动，避免真实等待 320ms。
   */
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface TabState {
  id: string;
  url: string;
  title: string;
  active: boolean;
  canBack: boolean;
  canForward: boolean;
}

/** 一次成功访问（供壳层追加「全局历史」；与标签内部后退/前进栈无关）。 */
export interface BrowserVisit {
  url: string;
  /** 访问当下已知的页面标题（可能缺省：网页内跳转时标题还没回来）。 */
  title?: string;
  sessionId: string;
  tabId: string;
}

interface TabEntry {
  view: HostView;
  adapter: BrowserAdapter;
  url: string;
  title: string;
  /** 导航历史（应用内导航与网页内点击都会追加；后退/前进按栈移动）。 */
  history: string[];
  index: number;
  /** 外壳发起的导航进行中：此期间忽略 WebContents 的导航事件，避免重复入栈。 */
  navigating?: boolean;
}

interface SessionGroup {
  tabs: Map<string, TabEntry>;
  activeId: string | null;
}

export type NavigateOutcome = { ok: true; url: string; tabId: string } | { ok: false; error: string };

export class BrowserHost {
  private groups = new Map<string, SessionGroup>();
  private activeSession: string;
  private overlayOpen = false;
  /** 侧栏当前宽度（用户可拖拽；偏好持久化在 UI 层）。 */
  private sidebarWidth: number = LAYOUT.SIDEBAR_WIDTH;
  /** 侧栏宽度动画的 interval 句柄（同一时刻至多一个；新调用取消旧动画）。 */
  private sidebarAnimation: unknown = null;
  /** 底部 DOM 面板（全宽终端）占用的高度：原生视图必须让出，否则会被面板盖住。 */
  private bottomInset = 0;
  private seq = 0;

  constructor(private deps: BrowserHostDeps) {
    this.activeSession = deps.initialSessionId?.trim() || "default";
    this.ensureGroup(this.activeSession);
  }

  private ensureGroup(sessionId: string): SessionGroup {
    let group = this.groups.get(sessionId);
    if (!group) {
      group = { tabs: new Map(), activeId: null };
      this.groups.set(sessionId, group);
    }
    return group;
  }

  private group(sessionId?: string): SessionGroup {
    return this.ensureGroup(sessionId ?? this.activeSession);
  }

  private nextId(): string {
    this.seq += 1;
    return `tab-${this.seq}`;
  }

  /** 当前可见会话（UI 的"文件夹"）。 */
  currentSessionId(): string {
    return this.activeSession;
  }

  private createTab(sessionId: string): TabEntry {
    const view = this.deps.createView();
    this.deps.attachView(view);
    const id = this.nextId();
    // 网页内点击/重定向/SPA 路由：同步地址、标题与历史栈，让地址栏与网页始终一致。
    const adapter = createWebContentsViewAdapter({
      view,
      onNavigate: (url: string): void => {
        const entry = this.group(sessionId).tabs.get(id);
        if (!entry || entry.navigating || !url || entry.url === url) return;
        entry.url = url;
        const current = entry.index >= 0 ? entry.history[entry.index] : undefined;
        if (current !== url) {
          entry.history = entry.history.slice(0, entry.index + 1);
          entry.history.push(url);
          entry.index = entry.history.length - 1;
        }
        // 网页内点击/重定向/SPA 路由也是一次真实访问 → 追加全局历史（标题可能稍后由 onTitle 补）
        this.deps.onVisited?.({ url, sessionId, tabId: id });
        this.emitTabs(sessionId);
      },
      onTitle: (title: string): void => {
        const entry = this.group(sessionId).tabs.get(id);
        if (!entry) return;
        const next = title.trim().slice(0, 80) || this.hostnameOf(entry.url);
        if (next === entry.title) return;
        entry.title = next;
        // 标题迟到：刷新全局历史里同 URL 的标题，不新增访问、不改变排序
        if (entry.url) this.deps.onTitleChanged?.(entry.url, next);
        this.emitTabs(sessionId);
      },
    });
    const entry: TabEntry = { view, adapter, url: "", title: "新标签页", history: [], index: -1 };
    const group = this.group(sessionId);
    group.tabs.set(id, entry);
    // 新标签必须立即成为该会话的活动标签
    group.activeId = id;
    return entry;
  }

  private activeEntry(sessionId?: string): TabEntry | null {
    const group = this.group(sessionId);
    return group.activeId ? group.tabs.get(group.activeId) ?? null : null;
  }

  /**
   * 侧栏宽度：
   *   · animate=false（拖拽/首帧恢复）→ 直接设置，立即重算原生视图（必须跟手，不能有动画延迟）；
   *   · animate=true（侧栏收起/展开按钮、快捷键）→ 用 320ms cubic-bezier(0,0,0.2,1) 逐帧插值，
   *     每一帧都 applyLayout，让原生网页视图与 DOM 侧栏**同拍**滑动（此前侧栏是 CSS 过渡、
   *     网页视图瞬间跳变，用户看到的就是「侧栏先动、网页后动」）。
   *
   * 收起态宽度可以是 48（甚至 0）：不能沿用拖拽最小值 240，否则收起后原生网页视图
   * 仍让出 240px，用户看到的就是「左侧没有铺满」。
   * 新调用会取消尚未完成的旧动画，从**当前插值位置**继续，避免来回点击时跳变。
   */
  setSidebarWidth(width: number, animate = false): void {
    const target = Math.max(0, Math.min(720, Number.isFinite(width) ? Math.round(width) : 0));
    this.cancelSidebarAnimation();
    if (!animate || target === this.sidebarWidth) {
      this.sidebarWidth = target;
      this.applyLayout();
      return;
    }
    const from = this.sidebarWidth;
    const totalFrames = Math.max(1, Math.round(SIDEBAR_ANIMATION_MS / SIDEBAR_ANIMATION_TICK_MS));
    let frame = 0;
    const setIntervalImpl =
      this.deps.setIntervalFn ??
      ((callback: () => void, ms: number): unknown => setInterval(callback, ms));
    this.sidebarAnimation = setIntervalImpl(() => {
      frame += 1;
      const linear = Math.min(1, frame / totalFrames);
      this.sidebarWidth = from + (target - from) * easeCubicBezier(linear);
      this.applyLayout();
      if (linear >= 1) {
        this.cancelSidebarAnimation();
        // 最后一帧对齐精确目标值（插值在 1 处应已相等，这里防御浮点误差）
        this.sidebarWidth = target;
        this.applyLayout();
      }
    }, SIDEBAR_ANIMATION_TICK_MS);
  }

  /** 当前侧栏宽度（debugBounds 之外的显式读取；诊断/测试断言用）。 */
  getSidebarWidth(): number {
    return this.sidebarWidth;
  }

  /** 取消正在进行的侧栏宽度动画（停止逐帧重排；不改变当前宽度）。 */
  cancelSidebarAnimation(): void {
    if (this.sidebarAnimation === null) return;
    const handle = this.sidebarAnimation;
    this.sidebarAnimation = null;
    try {
      const clearIntervalImpl =
        this.deps.clearIntervalFn ??
        ((value: unknown): void => clearInterval(value as ReturnType<typeof setInterval>));
      clearIntervalImpl(handle);
    } catch {
      // 句柄已失效：忽略
    }
  }

  /**
   * 底部 DOM 面板（全宽终端）高度：原生视图让出这一段，否则面板会被 WebContentsView 盖住。
   * 契约/UI 层已校验 0..2000，这里再夹一次（宿主也可能被测试或其它内部路径直接调用）。
   */
  setBottomInset(height: number): void {
    const next = Number.isFinite(height) ? Math.round(height) : 0;
    this.bottomInset = Math.max(0, Math.min(2000, next));
    this.applyLayout();
  }

  /** 当前底部让位高度（UI 恢复终端高度时可先读回，避免首帧跳动）。 */
  getBottomInset(): number {
    return this.bottomInset;
  }

  /**
   * E2E/诊断：当前窗口尺寸、**计算出的** bounds 与**活动视图真实 getBounds()**。
   * 三者对比才能定位「网页不随窗口自适应」的真实断点：
   *   window 变 / bounds 变 / actual 不变 → setBounds 没生效（视图未挂载/不可见）；
   *   actual 也变、但页面 innerWidth 不变 → 内容层问题（DPR/缩放/页面自身）。
   */
  debugBounds(): {
    window: WindowSize;
    bounds: BrowserViewBounds | null;
    actual: { x: number; y: number; width: number; height: number } | null;
    sessionId: string;
    tabId: string | null;
    /** 侧栏宽度与底部让位高度（诊断/回归断言用，说明 bounds 是怎么算出来的）。 */
    sidebarWidth: number;
    bottomInset: number;
  } {
    const windowSize = this.deps.getWindowSize();
    const bounds = computeBrowserViewBounds(windowSize, LAYOUT, {
      sidebarWidth: this.sidebarWidth,
      bottomInset: this.bottomInset,
    });
    const entry = this.activeEntry();
    let actual: { x: number; y: number; width: number; height: number } | null = null;
    try {
      actual = entry?.view.getBounds?.() ?? null;
    } catch {
      actual = null;
    }
    return {
      window: windowSize,
      bounds,
      actual,
      sessionId: this.activeSession,
      tabId: this.activeEntryId(),
      sidebarWidth: this.sidebarWidth,
      bottomInset: this.bottomInset,
    };
  }

  private activeEntryId(sessionId?: string): string | null {
    const group = this.group(sessionId);
    return group.activeId ?? null;
  }

  /**
   * E2E/诊断：在**活动标签**里执行一段 JS 并取回 JSON-safe 结果（无活动标签返回 null）。
   * 为什么单独加而不是让 E2E 调 executeScript：executeScript 在无标签时抛错，
   * 而 E2E 的目标是「打印现状用于对比」，不应因为没标签而中断整个截图/验收流程。
   */
  async debugEval(script: string, sessionId?: string): Promise<unknown> {
    const entry = this.activeEntry(sessionId);
    if (!entry) return null;
    try {
      return await entry.adapter.executeJs(script);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private applyLayout(): void {
    // 几何单一产地：侧栏宽度与底部 DOM 面板（全宽终端）高度都作为 options 传入，
    // 原生视图让出这两块区域，否则会被 DOM 盖住/盖住 DOM。
    const bounds = computeBrowserViewBounds(this.deps.getWindowSize(), LAYOUT, {
      sidebarWidth: this.sidebarWidth,
      bottomInset: this.bottomInset,
    });
    for (const [sessionId, group] of this.groups) {
      for (const [id, entry] of group.tabs) {
        entry.view.setBounds(bounds);
        // 空标签（新建页）不显示原生视图：否则透明视图会覆盖整个内容区并吞掉鼠标事件
        const visible =
          sessionId === this.activeSession && id === group.activeId && !this.overlayOpen && Boolean(entry.url);
        entry.view.setVisible?.(visible);
      }
    }
  }

  private emitTabs(sessionId: string = this.activeSession): void {
    this.applyLayout();
    // 持久化回调覆盖所有会话（后台 Agent 在自己会话里导航也要落盘）
    this.deps.onSessionStateChanged?.(sessionId, this.snapshotSession(sessionId));
    if (sessionId === this.activeSession) {
      this.deps.onTabsChanged?.(this.listTabs(sessionId));
    }
  }

  listTabs(sessionId?: string): TabState[] {
    const group = this.group(sessionId);
    return [...group.tabs.entries()].map(([id, entry]) => ({
      id,
      url: entry.url,
      title: entry.title,
      active: id === group.activeId,
      canBack: entry.index > 0,
      canForward: entry.index >= 0 && entry.index < entry.history.length - 1,
    }));
  }

  /** 指定标签（缺省=该会话语种的活动标签）。 */
  private resolveTab(tabId?: string, sessionId?: string): [string, TabEntry] | null {
    const group = this.group(sessionId);
    const id = tabId ?? group.activeId;
    if (!id) return null;
    const entry = group.tabs.get(id);
    return entry ? [id, entry] : null;
  }

  /** 后退 / 前进 / 刷新：基于本地历史栈（应用内导航）。 */
  async goBack(tabId?: string, sessionId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return { ok: false, error: "无标签页" };
    const [id, entry] = resolved;
    if (entry.index <= 0) return { ok: false, error: "没有可后退的历史" };
    entry.index -= 1;
    return this.navigateRecorded(entry.history[entry.index], id, false, sessionId);
  }

  async goForward(tabId?: string, sessionId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return { ok: false, error: "无标签页" };
    const [id, entry] = resolved;
    if (entry.index >= entry.history.length - 1) return { ok: false, error: "没有可前进的历史" };
    entry.index += 1;
    return this.navigateRecorded(entry.history[entry.index], id, false, sessionId);
  }

  async reload(tabId?: string, sessionId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return { ok: false, error: "无标签页" };
    const [id, entry] = resolved;
    if (!entry.url) return { ok: false, error: "当前标签没有页面" };
    return this.navigateRecorded(entry.url, id, false, sessionId);
  }

  history(tabId?: string, sessionId?: string): { url: string; index: number; current: boolean }[] {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return [];
    const [, entry] = resolved;
    return entry.history.map((url, i) => ({ url, index: i, current: i === entry.index }));
  }

  activeTabId(sessionId?: string): string | null {
    return this.group(sessionId).activeId;
  }

  hasAnyTab(sessionId?: string): boolean {
    return this.group(sessionId).tabs.size > 0;
  }

  /** 修复 ②：应用内浮层打开时隐藏原生视图。 */
  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open;
    this.applyLayout();
  }

  syncBounds(): void {
    this.applyLayout();
  }

  /** 导航：默认在当前会话的活动标签内；无标签则先建一个（记录历史）。 */
  async navigate(rawUrl: string, tabId?: string, sessionId?: string): Promise<NavigateOutcome> {
    return this.navigateRecorded(rawUrl, tabId, true, sessionId);
  }

  private async navigateRecorded(
    rawUrl: string,
    tabId?: string,
    record = true,
    sessionId?: string,
  ): Promise<NavigateOutcome> {
    const normalized = normalizeNavigateUrl(rawUrl);
    if (!normalized.ok) return { ok: false, error: normalized.reason };
    const sid = sessionId ?? this.activeSession;
    const group = this.group(sid);

    let id = tabId ?? group.activeId;
    if (!id || !group.tabs.has(id)) {
      this.createTab(sid);
      id = group.activeId!;
    }
    group.activeId = id;
    const entry = group.tabs.get(id)!;
    entry.navigating = true;
    try {
      const result = await entry.adapter.navigate(normalized.url);
      entry.url = result.url;
      if (record) {
        const current = entry.index >= 0 ? entry.history[entry.index] : undefined;
        if (current !== result.url) {
          entry.history = entry.history.slice(0, entry.index + 1);
          entry.history.push(result.url);
          entry.index = entry.history.length - 1;
        }
      }
      try {
        const title = await entry.adapter.executeJs("document.title");
        if (typeof title === "string" && title.trim()) entry.title = title.trim().slice(0, 80);
      } catch {
        entry.title = this.hostnameOf(result.url);
      }
      // 应用内导航成功（含后退/前进/刷新）→ 追加全局历史；同 URL 由 store 去重合并（不重复占位）
      this.deps.onVisited?.({ url: result.url, title: entry.title, sessionId: sid, tabId: id });
      this.emitTabs(sid);
      return { ok: true, url: result.url, tabId: id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      entry.navigating = false;
    }
  }

  private hostnameOf(url: string): string {
    try {
      return new URL(url).hostname || url;
    } catch {
      return url;
    }
  }

  /** 新建标签（可带初始 URL）并切为该会话的活动标签；同 URL 已存在时复用。 */
  async newTab(rawUrl?: string, sessionId?: string): Promise<{ tabId: string; url?: string; ok: boolean; error?: string }> {
    const sid = sessionId ?? this.activeSession;
    const group = this.group(sid);
    if (rawUrl) {
      const normalized = normalizeNavigateUrl(rawUrl);
      if (normalized.ok) {
        for (const [id, tab] of group.tabs) {
          if (tab.url === normalized.url) {
            group.activeId = id;
            this.emitTabs(sid);
            return { tabId: id, ok: true, url: tab.url };
          }
        }
      }
    }
    this.createTab(sid);
    const id = group.activeId!;
    this.emitTabs(sid);
    if (!rawUrl) return { tabId: id, ok: true };
    const outcome = await this.navigate(rawUrl, id, sid);
    if (!outcome.ok) return { tabId: id, ok: false, error: outcome.error };
    return { tabId: id, ok: true, url: outcome.url };
  }

  selectTab(tabId: string, sessionId?: string): boolean {
    const group = this.group(sessionId);
    if (!group.tabs.has(tabId)) return false;
    group.activeId = tabId;
    this.emitTabs(sessionId ?? this.activeSession);
    return true;
  }

  async closeTab(tabId: string, sessionId?: string): Promise<boolean> {
    const group = this.group(sessionId);
    const entry = group.tabs.get(tabId);
    if (!entry) return false;
    group.tabs.delete(tabId);
    try {
      await entry.adapter.close();
    } finally {
      this.deps.detachView(entry.view);
    }
    if (group.activeId === tabId) {
      group.activeId = group.tabs.keys().next().value ?? null;
    }
    this.emitTabs(sessionId ?? this.activeSession);
    return true;
  }

  async closeAll(): Promise<void> {
    for (const [sessionId, group] of [...this.groups.entries()]) {
      for (const id of [...group.tabs.keys()]) await this.closeTab(id, sessionId);
    }
  }

  /** 在指定会话的活动标签执行 JS（Agent 工具用；返回 JSON-safe 结果）。 */
  async executeScript(script: string, sessionId?: string): Promise<unknown> {
    const entry = this.activeEntry(sessionId);
    if (!entry) throw new Error("当前会话没有打开的网页标签");
    return entry.adapter.executeJs(script);
  }

  async snapshot(sessionId?: string): Promise<BrowserSnapshot | null> {
    return this.activeEntry(sessionId)?.adapter.snapshot() ?? null;
  }

  /** 页面缩放：0.5～2.0，按会话的活动标签生效（Ctrl + +/-/0）。 */
  setZoom(nextFactor: number, sessionId?: string): { ok: boolean; factor?: number; error?: string } {
    const entry = this.activeEntry(sessionId);
    if (!entry || !entry.url) return { ok: false, error: "当前没有打开的网页" };
    const factor = Math.max(0.5, Math.min(2, Math.round(nextFactor * 10) / 10));
    entry.adapter.setZoom?.(factor);
    return { ok: true, factor };
  }

  async screenshot(sessionId?: string): Promise<string | null> {
    return this.activeEntry(sessionId)?.adapter.screenshot() ?? null;
  }

  /** 当前/指定会话的标签快照（持久化用）。空白标签不写入。 */
  snapshotSession(sessionId: string = this.activeSession): PersistedBrowserState {
    const group = this.group(sessionId);
    const tabs: PersistedBrowserTab[] = [];
    let activeIndex = 0;
    for (const [id, entry] of group.tabs) {
      if (!entry.url) continue;
      if (id === group.activeId) activeIndex = tabs.length;
      tabs.push({
        url: entry.url,
        ...(entry.title ? { title: entry.title } : {}),
        history: entry.history.slice(),
        index: entry.index,
      });
    }
    return { tabs, activeIndex };
  }

  /** 切换到某个会话；restore 只在该会话还没有任何标签时使用（不覆盖内存里的活页面）。 */
  async switchSession(sessionId: string, restore?: PersistedBrowserState): Promise<TabState[]> {
    const sid = sessionId.trim();
    if (!sid) return this.listTabs();
    if (sid !== this.activeSession) {
      // 先把旧会话的页面状态交给持久化层，再换可见会话
      this.deps.onSessionStateChanged?.(this.activeSession, this.snapshotSession(this.activeSession));
      this.activeSession = sid;
    }
    const group = this.ensureGroup(sid);
    if (restore && group.tabs.size === 0 && restore.tabs.length > 0) {
      await this.restoreInto(sid, restore);
    }
    this.emitTabs(sid);
    return this.listTabs(sid);
  }

  private async restoreInto(sessionId: string, restore: PersistedBrowserState): Promise<void> {
    // 持久化文件可能被手工改过/旧版本残留：只接受净化后的 http(s) 标签
    const safe = sanitizeBrowserState(restore);
    if (!safe) return;
    const group = this.ensureGroup(sessionId);
    const ids: string[] = [];
    for (const tab of safe.tabs) {
      const entry = this.createTab(sessionId);
      const id = group.activeId!;
      ids.push(id);
      entry.title = tab.title ?? this.hostnameOf(tab.url);
      entry.history = Array.isArray(tab.history) && tab.history.length > 0 ? tab.history.slice() : [tab.url];
      entry.index =
        typeof tab.index === "number" ? Math.max(0, Math.min(tab.index, entry.history.length - 1)) : entry.history.length - 1;
      entry.navigating = true;
      try {
        const result = await entry.adapter.navigate(tab.url);
        entry.url = result.url;
      } catch {
        // 加载失败保留空白标签，用户可重试
      } finally {
        entry.navigating = false;
      }
    }
    const active = ids[Math.max(0, Math.min(safe.activeIndex, ids.length - 1))];
    if (active) group.activeId = active;
  }

  /** 删除会话时销毁它的全部标签（页面/内存），不影响其它会话。 */
  async deleteSession(sessionId: string): Promise<void> {
    const group = this.groups.get(sessionId);
    if (group) {
      for (const id of [...group.tabs.keys()]) await this.closeTab(id, sessionId);
      this.groups.delete(sessionId);
    }
    if (this.activeSession === sessionId) {
      const next = this.groups.keys().next().value as string | undefined;
      this.activeSession = next ?? "default";
      this.ensureGroup(this.activeSession);
      this.emitTabs(this.activeSession);
    }
  }
}

/**
 * 窗口几何变化的重排防抖器（默认 50ms，纯定时器、不依赖 electron，可单测）。
 *
 * 为什么需要：一次窗口变化会连发多个事件——拖拽缩放连续 resize；maximize/unmaximize 在部分
 * 平台先发「中间尺寸」的 resize 再定格；全屏切换甚至可能不伴随 resize。每次都 applyLayout
 * 会让原生视图抖动并可能把旧尺寸设为最终值，因此统一「最后一次事件后 50ms 再重排」。
 */
export function createDebouncedRunner(
  run: () => void,
  delayMs = 50,
): { schedule(): void; cancel(): void; pending(): boolean } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        run();
      }, Math.max(0, delayMs));
    },
    cancel(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    pending(): boolean {
      return timer !== null;
    },
  };
}
