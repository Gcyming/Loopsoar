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
import { buildAgentDrivingScript, buildUserLockScript } from "../browserAdapter/refs.js";
import { sanitizeBrowserState, type PersistedBrowserState, type PersistedBrowserTab } from "./browserSessionState.js";
import type { BrowserHostDeps, BrowserVisit, HostView, TabState } from "./browserHostTypes.js";
export type { BrowserHostDeps, BrowserVisit, HostView, TabState } from "./browserHostTypes.js";

/**
 * 单个标签最多向页面注入几次接管锁脚本。
 * 为什么不无限重试：注入失败几乎都发生在「页面还没就绪/正在导航」的瞬间，
 * 有上限才能保证挂死的页面不会把每次 emitTabs 都变成一次无意义的 executeJavaScript。
 */
const USER_LOCK_MAX_ATTEMPTS = 3;

/** 全局用户标签组（不属于任何会话）：网页 ＜ 会话 的解耦锚点。 */
export const USER_TABS_SESSION = "__user_tabs__";

/** sendInputEvent/getZoomFactor 的最小面：真实 WebContents 满足，测试假件可选实现。 */
interface AgentInputWebContents {
  sendInputEvent?: (event: Record<string, unknown>) => void;
  getZoomFactor?: () => number;
  /** 输入法式插入（CJK 等无法用单键字符表达的文字）；可信输入，会触发 beforeinput/input。 */
  insertText?: (text: string) => void;
  isDestroyed?: () => boolean;
}

/** 按键白名单里的命名键 → Electron keyCode（单字符直接用字符本身）。 */
const ELECTRON_KEY_CODES: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

export type { PersistedBrowserState, PersistedBrowserTab } from "./browserSessionState.js";

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
  /** 由 Agent 打开或导航过（UI 据此折叠进「Agent 工作区」标签组；用户导航不撤销）。 */
  agentBound: boolean;
  /** 接管锁脚本已推送到当前文档：导航/加载开始时会重置（用于去重与失败重试）。 */
  lockPushed: boolean;
}

interface SessionGroup {
  tabs: Map<string, TabEntry>;
  activeId: string | null;
}

export type NavigateOutcome = { ok: true; url: string; tabId: string } | { ok: false; error: string };

export class BrowserHost {
  private groups = new Map<string, SessionGroup>();
  private activeSession: string;
  /** 当前显示的标签组：默认用户全局标签；进入任务会话时指向该会话的 Agent 工作区。 */
  private visibleSession: string;
  private overlayOpen = false;
  /** 侧栏当前宽度（用户可拖拽；偏好持久化在 UI 层）。 */
  private sidebarWidth: number = LAYOUT.SIDEBAR_WIDTH;
  /** 底部 DOM 面板（全宽终端）占用的高度：原生视图必须让出，否则会被面板盖住。 */
  private bottomInset = 0;
  /** 顶部 DOM 面板（Agent 工作区展开列表）占用的高度：原生视图下移，页面不被隐藏。 */
  private topInset = 0;
  private seq = 0;
  /** 会话 → 接管锁（运行中的会话锁住它绑定/启动的网页，停止后解锁）。 */
  private userLocks = new Map<string, { locked: boolean; label: string }>();
  /** `${sessionId}::${tabId}` → 当前文档的注入尝试次数（导航/加载开始清零）。 */
  private lockAttempts = new Map<string, number>();

  constructor(private deps: BrowserHostDeps) {
    this.activeSession = deps.initialSessionId?.trim() || "default";
    this.ensureGroup(this.activeSession);
    this.ensureGroup(USER_TABS_SESSION);
    // 初始仍显示当前会话（启动恢复测试与旧行为兼容）；index 启动时会显式 showUserTabs()。
    this.visibleSession = this.activeSession;
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
        // 新文档开始加载：上一份文档里的接管锁浮层已随文档销毁，注入状态清零，
        // 加载完成后由 emitTabs 重新盖上（否则锁只在首个页面生效，一导航就失效）。
        this.resetUserLockTracking(sessionId, id, entry);
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
      agentBound: false,
      lockPushed: false,
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
   * 侧栏宽度：原生视图必须跟手，直接设置并立即重算 bounds。
   *
   * 动画由 UI 侧栏的 CSS 过渡负责；主进程不再用 setInterval 逐帧重排 WebContentsView
   * （实测会同时触发全部标签的 setBounds，是侧栏收起时的卡顿来源）。`animate` 参数
   * 仅为兼容旧 IPC 保留，不再产生任何延迟。
   *
   * 收起态宽度可以是 48（甚至 0）：不能沿用拖拽最小值 240，否则收起后原生网页视图
   * 仍让出 240px，用户看到的就是「左侧没有铺满」。
   */
  setSidebarWidth(width: number, _animate = false): void {
    this.sidebarWidth = Math.max(0, Math.min(720, Number.isFinite(width) ? Math.round(width) : 0));
    this.applyLayout();
  }

  /** 当前侧栏宽度（debugBounds 之外的显式读取；诊断/测试断言用）。 */
  getSidebarWidth(): number {
    return this.sidebarWidth;
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

  /** 顶部 DOM 面板高度（Agent 工作区展开列表）：页面整体下移，不隐藏原生视图。 */
  setTopInset(height: number): void {
    const next = Number.isFinite(height) ? Math.round(height) : 0;
    this.topInset = Math.max(0, Math.min(2000, next));
    this.applyLayout();
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
    /** 侧栏宽度、底部/顶部让位高度（诊断/回归断言用，说明 bounds 是怎么算出来的）。 */
    sidebarWidth: number;
    bottomInset: number;
    topInset: number;
  } {
    const windowSize = this.deps.getWindowSize();
    const bounds = computeBrowserViewBounds(windowSize, LAYOUT, {
      sidebarWidth: this.sidebarWidth,
      bottomInset: this.bottomInset,
      topInset: this.topInset,
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
      topInset: this.topInset,
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
      topInset: this.topInset,
    });
    for (const [sessionId, group] of this.groups) {
      for (const [id, entry] of group.tabs) {
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
          // setBounds 之后重新声明圆角：视图重建/重新挂载后半径可能丢，四角会回到直角。
          entry.view.setBorderRadius?.(LAYOUT.BROWSER_VIEW_RADIUS);
          entry.lastBounds = bounds;
        }
        // 空标签（新建页）不显示原生视图：否则透明视图会覆盖整个内容区并吞掉鼠标事件
        // 加载中/失败也不显示：让 DOM 的加载页/错误页露出来（原生视图只能显示 Chromium 白屏/默认错误页）
        const visible =
          sessionId === this.visibleSession &&
          id === group.activeId &&
          !this.overlayOpen &&
          Boolean(entry.url) &&
          !entry.loading &&
          entry.loadFailure === null;
        if (entry.lastVisible !== visible) {
          entry.view.setVisible?.(visible);
          entry.view.setBorderRadius?.(LAYOUT.BROWSER_VIEW_RADIUS);
          entry.lastVisible = visible;
        }
      }
    }
    // 覆盖窗口只跟随「当前会话的当前标签」：后台会话的页面不可见，指针也不该出现在屏幕上
    // （会话隔离要求：只有进入对应会话才看到对应内容）。几何与原生视图同源，避免两套坐标。
    const activeGroup = this.groups.get(this.visibleSession);
    const activeEntry = activeGroup?.activeId ? activeGroup.tabs.get(activeGroup.activeId) : null;
    this.deps.onViewLayout?.(
      activeEntry?.lastVisible
        ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        : null,
    );
  }

  /**
   * 把「某个标签的当前文档该不该有接管锁」的记账清掉。
   * 导航/加载开始 = 旧文档已销毁：注入状态与尝试次数都必须重置，新文档重新计次。
   */
  private resetUserLockTracking(sessionId: string, tabId: string, entry?: TabEntry): void {
    this.lockAttempts.delete(`${sessionId}::${tabId}`);
    const target = entry ?? this.groups.get(sessionId)?.tabs.get(tabId);
    if (target) target.lockPushed = false;
  }

  /**
   * 把当前锁状态推进某个标签的当前文档。
   *
   * 为什么吞掉注入失败：页面尚未就绪（about:blank、正在导航、渲染进程刚崩）时
   * executeJavaScript 会抛错，这是时序问题而不是配置问题；锁只影响「用户能不能点」，
   * 不该让 Agent 的会话启动/导航因此失败。失败的标签保持 lockPushed=false，等下一次重试。
   */
  private async pushUserLock(sessionId: string, tabId: string, entry: TabEntry): Promise<void> {
    const key = `${sessionId}::${tabId}`;
    const attempts = this.lockAttempts.get(key) ?? 0;
    if (attempts >= USER_LOCK_MAX_ATTEMPTS) return;
    const state = this.userLocks.get(sessionId);
    const locked = state?.locked === true;
    this.lockAttempts.set(key, attempts + 1);
    try {
      await entry.adapter.executeJs(buildUserLockScript(locked, state?.label ?? ""));
      this.lockAttempts.delete(key);
      entry.lockPushed = true;
    } catch {
      // 保持 lockPushed=false：下一次 emitTabs（加载完成/标题变化）继续补注入
    }
  }

  /**
   * 迟到注入：新建的标签、导航完成的标签、以及上次注入失败的标签在这里补一次。
   * 只在会话处于锁定且页面可写时执行——加载中注入会被下一次文档销毁，等于白费一次机会。
   */
  private retryUserLocks(sessionId: string): void {
    if (this.userLocks.get(sessionId)?.locked !== true) return;
    const group = this.groups.get(sessionId);
    if (!group) return;
    for (const [tabId, entry] of group.tabs) {
      if (!entry.agentBound) continue;
      if (entry.lockPushed || entry.loading || !entry.url) continue;
      if ((this.lockAttempts.get(`${sessionId}::${tabId}`) ?? 0) >= USER_LOCK_MAX_ATTEMPTS) continue;
      void this.pushUserLock(sessionId, tabId, entry).catch(() => undefined);
    }
  }

  /** 会话销毁时丢掉锁状态，避免同名会话重建后新标签被「幽灵锁」盖住。 */
  private forgetUserLock(sessionId: string): void {
    this.userLocks.delete(sessionId);
    const prefix = `${sessionId}::`;
    for (const key of [...this.lockAttempts.keys()]) {
      if (key.startsWith(prefix)) this.lockAttempts.delete(key);
    }
  }

  private emitTabs(sessionId: string = this.visibleSession): void {
    this.applyLayout();
    // 会话锁定期间每次状态变化都补注入：新标签/导航完成都在这里对齐（已注入的会被跳过）。
    this.retryUserLocks(sessionId);
    // 持久化回调覆盖所有会话（后台 Agent 在自己会话里导航也要落盘）
    this.deps.onSessionStateChanged?.(sessionId, this.snapshotSession(sessionId));
    if (sessionId === this.visibleSession) {
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
      agentBound: entry.agentBound,
    }));
  }

  /**
   * 会话接管锁：锁定 = 给它名下每个网页注入浮层（只拦真实用户事件）；
   * 解锁 = 注入清理脚本（停止会话后用户立刻拿回页面）。
   *
   * 锁状态按会话记下来，而不是只写进当前页面：之后新建的标签、以及导航完成的标签
   * 都会在 emitTabs 里按这份状态自动补注入，Agent 翻到下一页时锁不会掉。
   */
  async lockForSession(sessionId: string, locked: boolean, label?: string): Promise<void> {
    const sid = sessionId.trim();
    if (!sid) return;
    this.userLocks.set(sid, { locked, label: label ?? "" });
    const group = this.groups.get(sid);
    if (!group) return;
    for (const [tabId, entry] of group.tabs) {
      // 只锁 Agent 绑定/操作过的网页：用户自己开的页在同一会话里也不该被 Agent 的运行挡住。
      if (!entry.agentBound) continue;
      // 显式调用 = 用户/会话状态真的变了：重置尝试计数，让这次推送拿到完整预算
      this.resetUserLockTracking(sid, tabId, entry);
      await this.pushUserLock(sid, tabId, entry);
    }
  }

  /** E2E 探针：在活动标签页执行一段 JS（真实网页动作验证，如商店安装按钮点击）。 */
  async executeInActiveTab(code: string): Promise<unknown> {
    const entry = this.activeEntry();
    if (!entry) throw new Error("无活动标签页");
    return entry.adapter.executeJs(code);
  }

  /**
   * 输入注入前的最小存活检查：标签可能在我们 await 的几十毫秒里被关闭/导航销毁，
   * 对已销毁的 WebContents 调 sendInputEvent 会走到 Chromium 的空指针（进程级崩溃，无法 try/catch）。
   */
  private inputAlive(entry: TabEntry, sessionId: string | undefined, tabId: string): boolean {
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) return false;
    // 隐藏中的 WebContentsView 没有可接收输入的 RenderWidgetHostView：对隐藏视图 sendInputEvent
    // 会走到原生空指针（electron.exe 直接 AV，JS try/catch 接不住）。
    if (entry.lastVisible === false) return false;
    return this.groups.get(sessionId ?? this.activeSession)?.tabs.get(tabId) === entry;
  }

  /** 等页面真正可见再注入输入（刚克隆/正在加载时视图是隐藏的）。最多等 900ms。 */
  private async waitInputReady(entry: TabEntry, sessionId: string | undefined, tabId: string): Promise<boolean> {
    const deadline = Date.now() + 900;
    while (Date.now() < deadline) {
      if (this.inputAlive(entry, sessionId, tabId) && entry.lastVisible === true) return true;
      if (!this.inputAlive(entry, sessionId, tabId)) return false;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return this.inputAlive(entry, sessionId, tabId) && entry.lastVisible === true;
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
    const result = await this.navigateRecorded(entry.history[entry.index], id, false, sessionId);
    // 导航失败必须回滚指针：否则 index 与真实页面脱钩，canBack/canForward 与地址栏永久错位（再点会跨两页）。
    if (!result.ok) entry.index += 1;
    return result;
  }

  async goForward(tabId?: string, sessionId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return { ok: false, error: "无标签页" };
    const [id, entry] = resolved;
    if (entry.index >= entry.history.length - 1) return { ok: false, error: "没有可前进的历史" };
    entry.index += 1;
    const result = await this.navigateRecorded(entry.history[entry.index], id, false, sessionId);
    if (!result.ok) entry.index -= 1;
    return result;
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

  /**
   * 导航：默认在当前会话的活动标签内；无标签则先建一个（记录历史）。
   * origin="agent" = Agent 发起的导航：目标标签从此归属「Agent 工作区」（UI 折叠标签组）。
   */
  async navigate(
    rawUrl: string,
    tabId?: string,
    sessionId?: string,
    origin: "agent" | "user" = "user",
  ): Promise<NavigateOutcome> {
    // 导航是明确的「我要看这个页面」：把切会话时收起的网页重新展开。
    return this.navigateRecorded(rawUrl, tabId, true, sessionId, origin);
  }

  private async navigateRecorded(
    rawUrl: string,
    tabId?: string,
    record = true,
    sessionId?: string,
    origin: "agent" | "user" = "user",
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
    // Agent 导航过的标签永久属于 Agent 工作区：用户之后在同一标签点链接/输入地址也不撤销绑定，
    // 否则「Agent 打开的页面」会因为用户碰了一下就从折叠组里掉出去。
    if (origin === "agent") entry.agentBound = true;
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

  /**
   * 新建标签（可带初始 URL）并切为该会话的活动标签；同 URL 已存在时复用。
   * origin="agent" = Agent 新建：被复用的那个标签同样归属「Agent 工作区」。
   */
  async newTab(
    rawUrl?: string,
    sessionId?: string,
    origin: "agent" | "user" = "user",
  ): Promise<{ tabId: string; url?: string; ok: boolean; error?: string }> {
    const sid = sessionId ?? this.activeSession;
    const group = this.group(sid);
    if (rawUrl) {
      const normalized = normalizeNavigateUrl(rawUrl);
      if (normalized.ok) {
        for (const [id, tab] of group.tabs) {
          if (tab.url === normalized.url) {
            if (origin === "agent") tab.agentBound = true;
            group.activeId = id;
            this.emitTabs(sid);
            return { tabId: id, ok: true, url: tab.url };
          }
        }
      }
    }
    const entry = this.createTab(sid);
    const id = group.activeId!;
    if (origin === "agent") entry.agentBound = true;
    this.emitTabs(sid);
    if (!rawUrl) return { tabId: id, ok: true };
    const outcome = await this.navigate(rawUrl, id, sid, origin);
    if (!outcome.ok) return { tabId: id, ok: false, error: outcome.error };
    return { tabId: id, ok: true, url: outcome.url };
  }

  /**
   * 网页里的 window.open / target=_blank 进入新标签。
   *
   * 必须落在 **当前可见会话**，而不是 activeSession：用户可能在全局用户标签/搜索页里，
   * activeSession 仍是某个聊天会话；若按 activeSession 建页，新标签会落进不可见分组，
   * 页面看起来就是“点了没反应”。Agent 的工具调用仍用 newTab(activeSession)，不受影响。
   */
  async newTabInVisibleSession(rawUrl?: string): Promise<{ tabId: string; url?: string; ok: boolean; error?: string }> {
    return this.newTab(rawUrl, this.visibleSession);
  }

  selectTab(tabId: string, sessionId?: string): boolean {
    const group = this.group(sessionId);
    if (!group.tabs.has(tabId)) return false;
    group.activeId = tabId;
    this.emitTabs(sessionId ?? this.activeSession);
    return true;
  }

  /**
   * 该 webContents 是否属于「Agent 绑定的任务标签」（供出网守卫判定）。
   *
   * 用途：用户标签允许访问 localhost（本地预览是正常浏览行为），Agent 标签默认不允许——
   * 否则 Agent 可以顶层导航到本机服务再用 snapshot 读正文，等价绕过 web_fetch 的 SSRF 钉扎。
   * 找不到该 id 时返回 false（按用户标签处理，保持人类浏览能力）。
   */
  isAgentWebContents(webContentsId: number): boolean {
    for (const group of this.groups.values()) {
      for (const entry of group.tabs.values()) {
        try {
          if (entry.view.webContents.id === webContentsId) return entry.agentBound === true;
        } catch {
          // 视图已销毁：忽略该条目
        }
      }
    }
    return false;
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
    const sid = sessionId ?? this.activeSession;
    // 关页即释放该标签的接管锁重试计数，否则 Map 随标签数单调增长（closeSessionTabs 才按会话清）。
    this.lockAttempts.delete(`${sid}::${tabId}`);
    this.emitTabs(sid);
    // 任务工作区的最后一个页面关掉：回到用户全局标签，而不是停在一片空白。
    if (group.tabs.size === 0 && sid !== USER_TABS_SESSION && this.visibleSession === sid) {
      this.showUserTabs();
    }
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
    this.forgetUserLock(sessionId);
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
   * 这个会话的网页此刻是否真的显示在界面上（当前会话 + 活动标签 + 可见）。
   * Agent 覆盖指针只在「用户正看着这个网页」时出现——后台会话的动作不能把光标画到前台。
   */
  isSessionVisible(sessionId?: string): boolean {
    const sid = sessionId ?? this.activeSession;
    if (sid !== this.activeSession) return false;
    const group = this.groups.get(sid);
    const entry = group?.activeId ? group.tabs.get(group.activeId) : null;
    return Boolean(entry?.lastVisible);
  }

  /** 页面缩放系数：覆盖层与真实输入都按「CSS 像素 × 缩放」换算（假视图没有实现时按 1）。 */
  getPageZoom(sessionId?: string, tabId?: string): number {
    const entry = this.resolveTab(tabId, sessionId)?.[1] ?? null;
    const wc = entry?.view.webContents as AgentInputWebContents | undefined;
    const factor = typeof wc?.getZoomFactor === "function" ? wc.getZoomFactor() : 1;
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  }

  /**
   * Agent 点击：按页面 CSS 坐标派发**真实鼠标事件**（mouseMove → mouseDown → mouseUp）。
   *
   * 为什么不用 el.click()：用户 m02991 要求 Agent 像人一样用鼠标——只有真实输入事件才会经过
   * Chromium 的命中测试、焦点、:active/hover 与页面自己的 pointer 事件链路；el.click() 只触发 click。
   * 返回 false = 视图不支持 sendInputEvent（测试假件/旧后端），调用方回退到脚本点击。
   */
  async agentClick(
    sessionId: string | undefined,
    tabId: string | undefined,
    point: { x: number; y: number },
  ): Promise<boolean> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.activeSession;
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const zoom = this.getPageZoom(sessionId, tabId);
    const x = Math.round(point.x * zoom);
    const y = Math.round(point.y * zoom);
    if (!(await this.waitInputReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginAgentDriving(entry);
    try {
      if (!this.inputAlive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "mouseMove", x, y });
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      // 真实按压有几十毫秒的停留：立刻 up 会让 :active 一闪而过，部分站点的手势识别也收不到。
      await new Promise((resolve) => setTimeout(resolve, 35));
      if (!this.inputAlive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    } finally {
      this.endAgentDriving(entry, drivingToken);
    }
    if (process.env.LOOPSOAR_DEBUG_BROWSER === "1") {
      console.log("[agent-click]", JSON.stringify({ zoom, x, y }));
    }
    return true;
  }

  /**
   * Agent 逐字输入：像用户一样先全选再一个字一个字敲。
   *
   * - 开始先用 Ctrl+A 选中已有内容（首字自然替换），空文本则 Backspace 清空；
   * - ASCII 可见字符逐字派发 keyDown/char/keyUp（真实键盘事件，React 受控组件、onKeyDown 都生效）；
   * - CJK 等非 ASCII 走 insertText（等价输入法上屏；单键事件无法表达汉字），成段插入后让出一次事件循环保证顺序；
   * - 多行（textarea/contenteditable）用 Enter 换行；单行 input 把换行折成空格（input 本身也不接受换行）。
   *
   * 返回 false = 视图不支持 sendInputEvent（测试假件/旧后端），调用方回退原生 setter。
   */
  async agentType(
    sessionId: string | undefined,
    tabId: string | undefined,
    text: string,
    options: { multiline?: boolean } = {},
  ): Promise<boolean> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.activeSession;
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const multiline = options.multiline === true;
    const normalized = text.replace(/\r\n?/g, "\n");
    const body = multiline ? normalized : normalized.replace(/\n/g, " ");
    if (!(await this.waitInputReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginAgentDriving(entry);
    try {
      // 全选 + 退格 = 清空当前内容（和用户「点进来、全选、重输」完全一致）。
      // macOS 全选是 Command+A，Control+A 只会把光标移到行首。
      const selectAll = process.platform === "darwin" ? ["meta"] : ["control"];
      wc.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: selectAll });
      wc.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: selectAll });
      wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
      const chars = Array.from(body);
      let pendingText = "";
      const flushText = async (): Promise<void> => {
        if (!pendingText || !this.inputAlive(entry, sid, tid)) return;
        const chunk = pendingText;
        pendingText = "";
        if (typeof wc.insertText === "function") {
          wc.insertText(chunk);
          // 让 IPC/渲染进程把这段文本上屏，避免后续按键插到它前面（顺序敏感）。
          await new Promise((resolve) => setTimeout(resolve, 0));
        } else {
          for (const ch of chunk) wc.sendInputEvent?.({ type: "char", keyCode: ch });
        }
      };
      for (const ch of chars) {
        if (!this.inputAlive(entry, sid, tid)) return false;
        if (ch === "\n") {
          await flushText();
          wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          continue;
        }
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x20 && code <= 0x7e) {
          await flushText();
          wc.sendInputEvent({ type: "keyDown", keyCode: ch });
          wc.sendInputEvent({ type: "char", keyCode: ch });
          wc.sendInputEvent({ type: "keyUp", keyCode: ch });
        } else {
          pendingText += ch;
        }
      }
      await flushText();
    } finally {
      this.endAgentDriving(entry, drivingToken);
    }
    return true;
  }

  /** 真实鼠标移动（悬停）：像用户把鼠标移过去停住，触发 CSS :hover / pointerover / mouseover。 */
  async agentHover(
    sessionId: string | undefined,
    tabId: string | undefined,
    point: { x: number; y: number },
  ): Promise<boolean> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.activeSession;
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const zoom = this.getPageZoom(sessionId, tabId);
    const x = Math.round(point.x * zoom);
    const y = Math.round(point.y * zoom);
    if (!(await this.waitInputReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginAgentDriving(entry);
    try {
      if (!this.inputAlive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "mouseMove", x, y });
    } finally {
      this.endAgentDriving(entry, drivingToken);
    }
    return true;
  }

  /** 页面视口中心（CSS 像素）：滚动/悬停前把虚拟光标停到页面中间。 */
  async getViewportCenter(
    sessionId: string | undefined,
    tabId: string | undefined,
  ): Promise<{ x: number; y: number } | null> {
    const entry = this.resolveTab(tabId, sessionId)?.[1] ?? null;
    if (!entry) return null;
    try {
      const size = (await entry.adapter.executeJs("({ w: window.innerWidth, h: window.innerHeight })")) as
        | { w?: number; h?: number }
        | null;
      const w = typeof size?.w === "number" && size.w > 0 ? size.w : 800;
      const h = typeof size?.h === "number" && size.h > 0 ? size.h : 600;
      return { x: Math.round(w / 2), y: Math.round(h / 2) };
    } catch {
      return { x: 400, y: 300 };
    }
  }

  /**
   * Agent 拖拽：真实按下 → 分帧移动（像人手拖动）→ 抬起。
   * 用于滑块、拖拽排序、画布/编辑器等需要按下-移动-抬起序列的场景。
   */
  async agentDrag(
    sessionId: string | undefined,
    tabId: string | undefined,
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 10,
  ): Promise<boolean> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.activeSession;
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const zoom = this.getPageZoom(sessionId, tabId);
    const fx = Math.round(from.x * zoom);
    const fy = Math.round(from.y * zoom);
    const tx = Math.round(to.x * zoom);
    const ty = Math.round(to.y * zoom);
    const frames = Math.max(3, Math.min(20, Math.round(steps)));
    if (!(await this.waitInputReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginAgentDriving(entry);
    try {
      if (!this.inputAlive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "mouseMove", x: fx, y: fy });
      wc.sendInputEvent({ type: "mouseDown", x: fx, y: fy, button: "left", clickCount: 1 });
      for (let i = 1; i <= frames; i += 1) {
        if (!this.inputAlive(entry, sid, tid)) return false;
        const ratio = i / frames;
        const x = Math.round(fx + (tx - fx) * ratio);
        const y = Math.round(fy + (ty - fy) * ratio);
        wc.sendInputEvent({ type: "mouseMove", x, y });
        await new Promise((resolve) => setTimeout(resolve, 14));
      }
      if (!this.inputAlive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "mouseUp", x: tx, y: ty, button: "left", clickCount: 1 });
    } finally {
      this.endAgentDriving(entry, drivingToken);
    }
    return true;
  }

  /**
   * 真实滚轮：按 notch（120px）把滚动量拆成多帧 mouseWheel 派发，页面收到的是可信滚轮事件，
   * 滚动动画、滚动监听、懒加载、吸顶效果都与用户操作一致（脚本 window.scrollBy 不具备这些）。
   * 返回 false = 视图不支持 sendInputEvent，调用方回退脚本滚动。
   */
  async agentWheel(
    sessionId: string | undefined,
    tabId: string | undefined,
    deltaY: number,
  ): Promise<boolean> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.activeSession;
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const center = (await this.getViewportCenter(sessionId, tabId)) ?? { x: 400, y: 300 };
    const zoom = this.getPageZoom(sessionId, tabId);
    const x = Math.round(center.x * zoom);
    const y = Math.round(center.y * zoom);
    const total = Math.round(deltaY);
    if (!Number.isFinite(total) || total === 0) return false;
    const dir = total > 0 ? 1 : -1;
    const ticks = Math.min(42, Math.max(1, Math.ceil(Math.abs(total) / 120)));
    if (!(await this.waitInputReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginAgentDriving(entry);
    try {
      for (let i = 0; i < ticks; i += 1) {
        if (!this.inputAlive(entry, sid, tid)) return false;
        wc.sendInputEvent({
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          // 一律整数值：Chromium 的滚轮输入对非整数 delta / wheelTicks 存在原生边界，
          // 之前用 fractional step 是这次 electron.exe 崩溃的重点怀疑对象。
          deltaY: dir * 120,
          wheelTicksX: 0,
          wheelTicksY: dir,
          canScroll: true,
        });
        if (i < ticks - 1) await new Promise((resolve) => setTimeout(resolve, 12));
      }
    } finally {
      this.endAgentDriving(entry, drivingToken);
    }
    return true;
  }

  /**
   * Agent 按键：sendInputEvent 派发真实键盘事件（Enter/Tab/Esc/方向键/单字符）。
   * 与点击同理——页面拿到的是可信事件，表单默认行为（提交/跳转/关闭）才会真的发生。
   */
  async agentKey(sessionId: string | undefined, tabId: string | undefined, key: string): Promise<boolean> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return false;
    const [tid, entry] = resolved;
    const sid = sessionId ?? this.activeSession;
    const wc = entry.view.webContents as AgentInputWebContents | undefined;
    if (!wc || typeof wc.sendInputEvent !== "function") return false;
    const keyCode = ELECTRON_KEY_CODES[key] ?? (key.length === 1 ? key : null);
    if (!keyCode) return false;
    if (!(await this.waitInputReady(entry, sid, tid))) return false;
    const drivingToken = await this.beginAgentDriving(entry);
    try {
      if (!this.inputAlive(entry, sid, tid)) return false;
      wc.sendInputEvent({ type: "keyDown", keyCode });
      if (key.length === 1) wc.sendInputEvent({ type: "char", keyCode });
      wc.sendInputEvent({ type: "keyUp", keyCode });
    } finally {
      this.endAgentDriving(entry, drivingToken);
    }
    return true;
  }

  /** 每次开始输入都递增的 epoch：旧的 120ms 释放定时器不能清掉新一次输入的放行。 */
  private drivingTokens = new Map<TabEntry, number>();

  /** 置位「Agent 正在派发真实输入」并返回本次 epoch，页面接管锁据此放行。 */
  private async beginAgentDriving(entry: TabEntry): Promise<number> {
    const token = (this.drivingTokens.get(entry) ?? 0) + 1;
    this.drivingTokens.set(entry, token);
    try {
      await entry.adapter.executeJs(buildAgentDrivingScript(true));
    } catch {
      // 页面正在导航/未就绪：锁同样不存在，无需放行
    }
    return token;
  }

  /** 只释放自己那次放行；事件异步派发，留 120ms 窗口，但不能把后续输入的一起清掉。 */
  private endAgentDriving(entry: TabEntry, token: number): void {
    setTimeout(() => {
      if (this.drivingTokens.get(entry) !== token) return;
      this.drivingTokens.delete(entry);
      try {
        void entry.adapter.executeJs(buildAgentDrivingScript(false));
      } catch {
        // 页面已销毁/未就绪
      }
    }, 120);
  }

  /**
   * 快照：缺省取活动标签；返回值带上 tabId。
   * 工具层据此把 ref 令牌绑定到「产生它的标签」，跨标签引用才会被判 STALE_REF。
   */
  async snapshot(sessionId?: string, tabId?: string): Promise<BrowserSnapshot | null> {
    // 会话还没有自己的任务页时，「看」用户当前页不算工作：只读快照回落到全局用户标签。
    const resolved = this.resolveTab(tabId, sessionId) ?? (tabId ? null : this.resolveTab(undefined, USER_TABS_SESSION));
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
    return (this.activeEntry(sessionId) ?? this.activeEntry(USER_TABS_SESSION))?.adapter.screenshot() ?? null;
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
        ...(entry.agentBound ? { agentBound: true } : {}),
      });
    }
    return { tabs, activeIndex };
  }

  /**
   * Agent 首次「动手」前的任务化准备：确保这个会话有一个 Agent 专属标签。
   *
   * 规则（用户 m02991 后续补充）：不接管用户当前页，而是用它的 URL **新开**一个同地址标签，
   * 原页保持不变；新标签标 agentBound，折叠进「Agent 工作区」。之后这个会话的所有动作都在
   * 这个克隆页上进行（同一任务可再开多个 agent 标签）。
   *
   * 只应在「动作类」工具执行前调用：只读（快照/截图）不算工作，不该克隆页面。
   */
  async ensureAgentTab(sessionId?: string): Promise<string | null> {
    const sid = (sessionId ?? this.activeSession).trim();
    if (!sid) return null;
    // Agent 要动手：把网页展开，用户能看见它在操作克隆页。
    const group = this.ensureGroup(sid);
    // 正在使用的 Agent 标签优先，其次任意一个已存在的任务标签（多标签任务不来回跳）。
    const current = group.activeId ? group.tabs.get(group.activeId) : null;
    if (current?.agentBound) return group.activeId;
    for (const [id, entry] of group.tabs) {
      if (!entry.agentBound) continue;
      group.activeId = id;
      return id;
    }
    const source = group.activeId ? group.tabs.get(group.activeId) : null;
    // 会话里没有自己的页：克隆用户当前正在看的那一页（这是「Agent 克隆原页」的主路径）。
    const userGroup = this.groups.get(USER_TABS_SESSION);
    const userActive = userGroup?.activeId ? userGroup.tabs.get(userGroup.activeId) : null;
    const sourceUrl = source?.url || userActive?.url || "";
    const entry = this.createTab(sid);
    const id = group.activeId!;
    entry.agentBound = true;
    // 先标记任务身份，再 emit 落盘：否则第一次保存会因为「还不知道是任务」而丢掉标记。
    this.deps.onTaskCreated?.(sid);
    if (sourceUrl) {
      const outcome = await this.navigate(sourceUrl, id, sid, "agent");
      if (!outcome.ok) entry.url = sourceUrl;
    }
    // Agent 工作区成为可见组：折叠页与任务标签条同时出现。
    this.showTask(sid);
    // 页面此刻才真正可见：把「常驻光标」从现在开始算，而不是等用户看到第一次点击。
    this.deps.onAgentActing?.(sid);
    return id;
  }

  /** 切换到某个会话；restore 只在该会话还没有任何标签时使用（不覆盖内存里的活页面）。 */
  /** 显示全局用户标签（普通会话/搜索页）。 */
  showUserTabs(): void {
    this.visibleSession = USER_TABS_SESSION;
    this.emitTabs(USER_TABS_SESSION);
  }

  /** 把 from 的标签组整体过户给 to（首次动作结束后，原会话留讨论、任务归分支会话）。 */
  reassignSession(from: string, to: string): void {
    const src = from.trim();
    const dst = to.trim();
    if (!src || !dst || src === dst) return;
    const group = this.groups.get(src);
    if (!group) return;
    this.groups.delete(src);
    this.groups.set(dst, group);
    this.forgetUserLock(src);
    if (this.activeSession === src) this.activeSession = dst;
    if (this.visibleSession === src) this.visibleSession = dst;
    this.emitTabs(dst);
  }

  /** 显示某个任务会话的 Agent 工作区（折叠标签页）。 */
  showTask(sessionId: string): void {
    const sid = sessionId.trim();
    if (!sid) return;
    this.ensureGroup(sid);
    this.visibleSession = sid;
    this.emitTabs(sid);
  }

  /** 当前显示的标签组（USER_TABS_SESSION = 用户全局标签）。 */
  visibleSessionId(): string {
    return this.visibleSession;
  }

  /** 所有「有 Agent 绑定页面」的任务（跨会话任务条的数据源）。 */
  listTasks(): { sessionId: string; tabs: TabState[] }[] {
    const tasks: { sessionId: string; tabs: TabState[] }[] = [];
    for (const sessionId of this.groups.keys()) {
      if (sessionId === USER_TABS_SESSION) continue;
      const tabs = this.listTabs(sessionId);
      if (tabs.some((tab) => tab.agentBound === true)) tasks.push({ sessionId, tabs });
    }
    return tasks;
  }

  async switchSession(sessionId: string, restore?: PersistedBrowserState): Promise<TabState[]> {
    const sid = sessionId.trim();
    if (!sid) return this.listTabs();
    if (sid !== this.activeSession) {
      // 先把旧会话的页面状态交给持久化层，再换会话
      this.deps.onSessionStateChanged?.(this.activeSession, this.snapshotSession(this.activeSession));
      this.activeSession = sid;
    }
    const group = this.ensureGroup(sid);
    const willRestore = Boolean(restore && group.tabs.size === 0 && restore.tabs.length > 0);
    if (willRestore && restore) {
      await this.restoreInto(sid, restore);
    }
    // 任务会话：显示它自己的折叠工作区；普通会话：显示全局用户标签（绝不把会话的页面当门面）。
    const isTask = [...group.tabs.values()].some((entry) => entry.agentBound === true);
    if (isTask || willRestore) this.showTask(sid);
    else this.showUserTabs();
    return this.listTabs(sid);
  }

  /** 主题外壳色：同步给四角遮罩与所有网页视图的切角背景。 */
  setCornerColor(color: string): void {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
    this.deps.onCornerColor?.(color);
    for (const group of this.groups.values()) {
      for (const entry of group.tabs.values()) entry.view.setBackgroundColor?.(color);
    }
  }

  /** 启动恢复全局用户标签（不属于任何会话）。 */
  async restoreUserTabs(restore: PersistedBrowserState): Promise<void> {
    const group = this.ensureGroup(USER_TABS_SESSION);
    if (group.tabs.size === 0) await this.restoreInto(USER_TABS_SESSION, restore);
    this.showUserTabs();
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
      // 折叠标签页的归属必须跟着页面一起恢复：否则重启后 Agent 工作区凭空消失。
      entry.agentBound = tab.agentBound === true;
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
      this.forgetUserLock(sessionId);
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
