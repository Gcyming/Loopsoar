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
import type { BrowserAdapter, BrowserLoadFailure, BrowserSnapshot } from "../browserAdapter/types.js";
import { sanitizeBrowserState, type PersistedBrowserState, type PersistedBrowserTab } from "./browserSessionState.js";
import { easeCubicBezier } from "./agentWindow.js";

/** 侧栏展开/收起动画时长：与 UI 侧栏 DOM 过渡同一条 cubic-bezier(0.2,0,0.2,1) 曲线（单产地在 agentWindow.easeCubicBezier）。 */
export const SIDEBAR_ANIMATION_MS = 320;
/** 动画帧间隔（目标 120fps；实际以主进程计时器为准，按时间插值保证总时长固定）。 */
export const SIDEBAR_ANIMATION_TICK_MS = 8;

export type { PersistedBrowserState, PersistedBrowserTab } from "./browserSessionState.js";

export interface HostView extends WebContentsViewLike {
  setBounds(bounds: BrowserViewBounds): void;
  setVisible?(visible: boolean): void;
  /** 真实视图几何（Electron WebContentsView.getBounds；假 View 可不实现）。 */
  getBounds?(): { x: number; y: number; width: number; height: number };
}

export interface BrowserHostDeps {
  createView: () => HostView;
  /**
   * 把原生视图挂到主窗口（contentView.addChildView）。
   * 返回 false 表示窗口还没就绪（典型场景：启动恢复时窗口尚未创建）→ 宿主在下一次 applyLayout
   * 重试挂载；返回 true/void 都视为已挂上（void 兼容既有实现）。
   */
  attachView: (view: HostView) => boolean | void;
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
  /** 页面图标抓取（主进程实现：URL → data URL；缺省不抓，测试不联网）。 */
  fetchFavicon?: (url: string) => Promise<string | null>;
  /** 页面图标变化：壳层用它刷新全局历史里同 URL 条目的图标。 */
  onFaviconChanged?: (url: string, favicon: string) => void;
  /** 底部开发者工具面板：打开指定 WebContents 的调试前端（返回是否成功）。 */
  openDevToolsPanel?: (webContents: unknown) => boolean;
  /** 关闭底部开发者工具面板。 */
  closeDevToolsPanel?: () => void;
  /** 底部开发者工具面板是否已打开。 */
  isDevToolsPanelOpen?: () => boolean;
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
  /** 主框架加载中：渲染层显示加载页（原生视图被隐藏）。 */
  loading: boolean;
  /** 最近一次主框架加载失败（已过滤 ERR_ABORTED）：渲染层显示分类错误页。 */
  loadFailure: BrowserLoadFailure | null;
  /** 站点图标（data: URL；渲染层 CSP 只允许 self/data:）。 */
  favicon?: string;
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
  /**
   * 原生视图是否已挂到主窗口。启动恢复发生在 createMainWindow 之前，当时 attachView 拿不到
   * 窗口会返回 false（旧实现静默 no-op）→ applyLayout 发现未挂载时补挂，页面才会真正显示。
   */
  attached: boolean;
  /** 页面正在加载（主框架）：为 true 时隐藏原生视图，由 DOM 加载页接管。 */
  loading: boolean;
  /** 最近一次 setVisible 的值：动画帧里避免对同一视图重复调用 setVisible。 */
  lastVisible?: boolean;
  /** 最近一次 setBounds 的矩形：几何未变时跳过 setBounds。 */
  lastBounds?: { x: number; y: number; width: number; height: number };
  /** 最近一次主框架加载失败（-3 ERR_ABORTED 已过滤）；非空时隐藏原生视图、DOM 错误页接管。 */
  loadFailure: BrowserLoadFailure | null;
  /** 站点图标（data: URL，来自 page-favicon-updated）。 */
  favicon?: string;
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

  /** 指定 WebContents 是否属于本宿主的浏览器标签（浏览器页 preload 的 IPC 来源校验用）。 */
  hasWebContents(webContentsId: number): boolean {
    for (const group of this.groups.values()) {
      for (const entry of group.tabs.values()) {
        if (entry.view.webContents.id === webContentsId) return true;
      }
    }
    return false;
  }

  /** 当前可见会话（UI 的"文件夹"）。 */
  currentSessionId(): string {
    return this.activeSession;
  }

  /**
   * 尝试把视图挂到主窗口。
   * 返回 false = 窗口未就绪（启动恢复）/挂载失败 → 保持 attached=false，applyLayout 会重试。
   */
  private tryAttach(view: HostView): boolean {
    return this.deps.attachView(view) !== false;
  }

  private createTab(sessionId: string): TabEntry {
    const view = this.deps.createView();
    const attached = this.tryAttach(view);
    const id = this.nextId();
    /** 事件回调可能早于 entry 创建（loadURL 前的同步事件），用闭包引用兜底。 */
    let entryRef: TabEntry | null = null;
    // 网页内点击/重定向/SPA 路由：同步地址、标题与历史栈，让地址栏与网页始终一致。
    const adapter = createWebContentsViewAdapter({
      view,
      onDevToolsRequest: (): void => {
        this.toggleDevTools(id, sessionId);
      },
      fetchFavicon: this.deps.fetchFavicon,
      onFavicon: (dataUrl: string): void => {
        const entry = entryRef ?? this.group(sessionId).tabs.get(id);
        if (!entry || entry.favicon === dataUrl) return;
        entry.favicon = dataUrl;
        this.emitTabs(sessionId);
        if (entry.url) this.deps.onFaviconChanged?.(entry.url, dataUrl);
      },
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
      // 加载中/失败：渲染层据此显示「加载页 / 分类错误页」（原生视图在 applyLayout 里被隐藏）。
      onLoadStart: (): void => {
        const entry = entryRef;
        if (!entry || entry.loading) return;
        entry.loading = true;
        entry.loadFailure = null;
        this.emitTabs(sessionId);
      },
      onLoadEnd: (): void => {
        const entry = entryRef;
        if (!entry || !entry.loading) return;
        entry.loading = false;
        this.emitTabs(sessionId);
      },
      onLoadFailure: (failure: BrowserLoadFailure): void => {
        const entry = entryRef;
        if (!entry) return;
        entry.loading = false;
        entry.loadFailure = failure;
        // 失败也把地址栏落到「尝试访问的 URL」：用户能看到自己打错/失败的地址，
        // 且地址栏由此恢复为无功能放大镜（不再显示可切换的搜索引擎图标）。
        if (failure.url && entry.url !== failure.url) entry.url = failure.url;
        if (!entry.title || entry.title === "新标签页") entry.title = this.hostnameOf(failure.url);
        this.emitTabs(sessionId);
      },
    });
    const entry: TabEntry = {
      view,
      adapter,
      url: "",
      title: "新标签页",
      history: [],
      index: -1,
      attached,
      loading: false,
      loadFailure: null,
    };
    entryRef = entry;
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
    const startedAt = Date.now();
    const totalFrames = Math.max(1, Math.round(SIDEBAR_ANIMATION_MS / SIDEBAR_ANIMATION_TICK_MS));
    let frame = 0;
    const setIntervalImpl =
      this.deps.setIntervalFn ??
      ((callback: () => void, ms: number): unknown => setInterval(callback, ms));
    this.sidebarAnimation = setIntervalImpl(() => {
      frame += 1;
      // 按真实时间插值，保证 320ms 总时长；同时用帧数兜底（测试/被系统合并时也能推进）。
      const linear = Math.min(
        1,
        Math.max((Date.now() - startedAt) / SIDEBAR_ANIMATION_MS, frame / totalFrames),
      );
      this.sidebarWidth = from + (target - from) * easeCubicBezier(linear);
      this.applyLayout(true);
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
    /** 活动标签的原生视图是否已挂到主窗口（重启恢复 bug 的直接观测点）。 */
    attached: boolean;
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
      attached: entry?.attached ?? false,
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

  /**
   * @param activeOnly 动画帧只更新「当前会话的当前标签」：其余标签的视图是隐藏的，
   *   每帧对它们 setBounds/setVisible 纯属浪费，正是侧栏逐帧动画在有网页时的卡顿来源。
   */
  private applyLayout(activeOnly = false): void {
    // 几何单一产地：侧栏宽度与底部 DOM 面板（全宽终端）高度都作为 options 传入，
    // 原生视图让出这两块区域，否则会被 DOM 盖住/盖住 DOM。
    const bounds = computeBrowserViewBounds(this.deps.getWindowSize(), LAYOUT, {
      sidebarWidth: this.sidebarWidth,
      bottomInset: this.bottomInset,
    });
    for (const [sessionId, group] of this.groups) {
      if (activeOnly && sessionId !== this.activeSession) continue;
      for (const [id, entry] of group.tabs) {
        if (activeOnly && id !== group.activeId) continue;
        // 启动恢复先于窗口创建：createTab 时 attachView 拿不到主窗口（旧实现静默 no-op），
        // 窗口就绪后必须在这里补挂，否则恢复的页面永远不会出现在窗口里（刷新也无效）。
        // 幂等：attached 为 true 时不重复 addChildView。
        if (!entry.attached) entry.attached = this.tryAttach(entry.view);
        const last = entry.lastBounds;
        if (
          !last ||
          last.x !== bounds.x ||
          last.y !== bounds.y ||
          last.width !== bounds.width ||
          last.height !== bounds.height
        ) {
          entry.view.setBounds(bounds);
          entry.lastBounds = bounds;
        }
        // 空标签（新建页）不显示原生视图：否则透明视图会覆盖整个内容区并吞掉鼠标事件
        // 加载中/失败也不显示：让 DOM 的加载页/错误页露出来（原生视图只能显示 Chromium 白屏/默认错误页）
        const visible =
          sessionId === this.activeSession &&
          id === group.activeId &&
          !this.overlayOpen &&
          Boolean(entry.url) &&
          !entry.loading &&
          entry.loadFailure === null;
        if (entry.lastVisible !== visible) {
          entry.view.setVisible?.(visible);
          entry.lastVisible = visible;
        }
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
      loading: entry.loading,
      loadFailure: entry.loadFailure,
      favicon: entry.favicon,
    }));
  }

  /** E2E 探针：在活动标签页执行一段 JS（真实网页动作验证，如商店安装按钮点击）。 */
  async executeInActiveTab(code: string): Promise<unknown> {
    const entry = this.activeEntry();
    if (!entry) throw new Error("无活动标签页");
    return entry.adapter.executeJs(code);
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

  /**
   * 开发者工具：停靠到底部面板（与终端同区域），不再开独立窗口。
   * 面板的几何/开合由 electronBrowser 的 BrowserDevToolsPanel 管理。
   */
  toggleDevTools(tabId?: string, sessionId?: string): { ok: boolean; open?: boolean; error?: string } {
    if (this.deps.isDevToolsPanelOpen?.()) {
      this.deps.closeDevToolsPanel?.();
      return { ok: true, open: false };
    }
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return { ok: false, error: "无标签页" };
    if (!this.deps.openDevToolsPanel) return { ok: false, error: "底部调试面板未装配" };
    const ok = this.deps.openDevToolsPanel(resolved[1].view.webContents as unknown);
    return ok ? { ok: true, open: true } : { ok: false, error: "无法打开开发者工具" };
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

  /**
   * 删除会话时关闭它名下的全部网页（一个会话可以有多张网页）。
   * 对应关系：工作区 > 会话 > 网页——网页需要会话，关网页不动会话；删会话才关网页。
   */
  async closeSessionTabs(sessionId: string): Promise<number> {
    const group = this.groups.get(sessionId);
    if (!group) return 0;
    const ids = [...group.tabs.keys()];
    for (const id of ids) await this.closeTab(id, sessionId);
    this.groups.delete(sessionId);
    return ids.length;
  }

  async closeAll(): Promise<void> {
    for (const [sessionId, group] of [...this.groups.entries()]) {
      for (const id of [...group.tabs.keys()]) await this.closeTab(id, sessionId);
    }
  }

  /**
   * 在指定会话的指定标签执行 JS（缺省 = 该会话的活动标签）。
   * tabId 由 Slice D 引入：ref 注册表按标签绑定，动作必须能落在「快照的那个标签」上。
   */
  async executeScript(script: string, sessionId?: string, tabId?: string): Promise<unknown> {
    const entry = this.resolveTab(tabId, sessionId)?.[1] ?? null;
    if (!entry) throw new Error("当前会话没有打开的网页标签");
    return entry.adapter.executeJs(script);
  }

  /**
   * 快照：缺省取活动标签；返回值带上 tabId。
   * 工具层据此把 ref 令牌绑定到「产生它的标签」，跨标签引用才会被判 STALE_REF。
   */
  async snapshot(sessionId?: string, tabId?: string): Promise<BrowserSnapshot | null> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return null;
    const [id, entry] = resolved;
    const snapshot = await entry.adapter.snapshot();
    return { ...snapshot, tabId: id };
  }

  /**
   * 单个标签的当前状态（工具层动作后状态行用：URL/标题/是否加载中）。
   * 不存在返回 null（标签刚被关闭时工具层仍能拿到 null 而不是抛错）。
   */
  getTab(sessionId?: string, tabId?: string): TabState | null {
    const group = this.group(sessionId);
    const id = tabId ?? group.activeId;
    if (!id) return null;
    return this.listTabs(sessionId).find((tab) => tab.id === id) ?? null;
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
      } catch (err) {
        // 加载失败也要把 URL 留在标签里（视图显示 Chromium 错误页，用户能看到失败而不是白屏；
        // 地址栏/刷新也能针对该 URL 重试）。旧行为是留空白标签 + 静默，重启后页面像是「丢了」。
        entry.url = tab.url;
        console.warn(
          "[browser] 恢复页面失败，保留 URL 供刷新重试",
          tab.url,
          err instanceof Error ? err.message : String(err),
        );
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
