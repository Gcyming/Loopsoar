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
import { computeBrowserViewBounds,
  LAYOUT,
  type BrowserViewBounds,
  type WindowSize,
} from "loopsoar-contracts/layout";
import { normalizeNavigateUrl } from "loopsoar-contracts/navigation";
import { pathToFileURL } from "node:url";
import { officeDocumentTitle, officeFileFromUrl } from "./officePreview.js";
import { closeBlankDownloadTab, type DownloadSourceHost } from "./downloadSource.js";
import { activateTab, activeAfterClose } from "./tabActivation.js";
import { moveTabRelative } from "./tabOrder.js";
import {
  createWebContentsViewAdapter,
  type WebContentsViewLike,
} from "../browserAdapter/backends/webContentsView.js";
import type { BrowserAdapter, BrowserLoadFailure, BrowserSnapshot } from "../browserAdapter/types.js";
import { buildAgentDrivingScript, buildUserLockScript } from "../browserAdapter/refs.js";
import { uploadFileInput } from "./browserUpload.js";
import { BrowserObservability } from "./browserObservability.js";
import { sanitizeBrowserState, type PersistedBrowserState, type PersistedBrowserTab } from "./browserSessionState.js";
import type { BrowserHostDeps, BrowserVisit, HostView, TabState } from "./browserHostTypes.js";
import { AgentInputDriver } from "./agentInput.js";
import { BrowserViewLayout, type LayoutGroup } from "./browserViewLayout.js";
import { mergeRecent, toTabStates } from "./browserTabView.js";
import { ClosedTabStack, type ClosedTabView } from "./closedTabStack.js";
import { downloadCompatibleReferer, refererForNavigation } from "./browserNavigationSupport.js";
export type { BrowserHostDeps, BrowserVisit, HostView, TabState } from "./browserHostTypes.js";

/**
 * 单个标签最多向页面注入几次接管锁脚本。
 * 为什么不无限重试：注入失败几乎都发生在「页面还没就绪/正在导航」的瞬间，
 * 有上限才能保证挂死的页面不会把每次 emitTabs 都变成一次无意义的 executeJavaScript。
 */
const USER_LOCK_MAX_ATTEMPTS = 3;
/** 全局用户标签组（不属于任何会话）：网页 ＜ 会话 的解耦锚点。 */
export const USER_TABS_SESSION = "__user_tabs__";

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
  /** 页面正在加载（主框架）：只用于标签加载条/UI 状态，**不再隐藏原生视图**。 */
  loading: boolean;
  /** 最近一次 setVisible 的值：动画帧里避免对同一视图重复调用 setVisible。 */
  lastVisible?: boolean;
  /** 最近一次 setBounds 的矩形：几何未变时跳过 setBounds。 */
  lastBounds?: { x: number; y: number; width: number; height: number };
  /** 隐藏期间被标记：切回可见时强制重新布局一次（P2-3，避免隐藏标签每次 resize 都 setBounds）。 */
  layoutDirty?: boolean;
  /** 最近一次主框架加载失败（-3 ERR_ABORTED 已过滤）；非空时隐藏原生视图、DOM 错误页接管。 */
  loadFailure: BrowserLoadFailure | null;
  /** 站点图标（data: URL，来自 page-favicon-updated）。 */
  favicon?: string;
  /** 由 Agent 打开或导航过（UI 据此折叠进「Agent 工作区」标签组；用户导航不撤销）。 */
  agentBound: boolean;
  /** 打开它的来源标签（页面内链接/window.open）：关闭时优先回到它。 */
  openerId?: string;
  /** 页面是否在出声 / 是否被静音（音频事件同步；只影响展示与静音按钮）。 */
  audible?: boolean;
  muted?: boolean;
  /** 固定标签（持久化；固定标签排在最左侧）。 */
  pinned?: boolean;
  /** 本地文档预览：file:// PDF；不写入浏览器持久化状态，避免重启恢复时被 URL 策略拒绝。 */
  localPreview?: boolean;
  /** 接管锁脚本已推送到当前文档：导航/加载开始时会重置（用于去重与失败重试）。 */
  lockPushed: boolean;
}

interface SessionGroup {
  tabs: Map<string, TabEntry>;
  activeId: string | null;
  previousActiveId: string | null;
}

export type NavigateOutcome = { ok: true; url: string; tabId: string } | { ok: false; error: string };
export class BrowserHost {
  private groups = new Map<string, SessionGroup>();
  /** 控制台/网络旁路观测：不参与标签生命周期，只保留最近 N 条。 */
  private observability = new BrowserObservability();
  /** 最近关闭（Chrome 式；只在内存，退出后清空）——倒序读/按下标取都在 ClosedTabStack 里。 */
  private closedTabs = new ClosedTabStack((entries) => this.deps.onClosedTabsChanged?.(entries));
  private activeSession: string;
  /** 当前显示的标签组：默认用户全局标签；进入任务会话时指向该会话的 Agent 工作区。 */
  private visibleSession: string;
  /** 几何单一产地：侧栏/上下让位/覆盖层开关 → 唯一矩形（见 browserViewLayout）。 */
  private layout: BrowserViewLayout;
  /** 真实输入驱动（存活检查/可见等待/驱动令牌见 agentInput）。 */
  private input: AgentInputDriver;
  private seq = 0;
  /** 会话 → 接管锁（运行中的会话锁住它绑定/启动的网页，停止后解锁）。 */
  private userLocks = new Map<string, { locked: boolean; label: string }>();
  /** `${sessionId}::${tabId}` → 当前文档的注入尝试次数（导航/加载开始清零）。 */
  private lockAttempts = new Map<string, number>();
  /** 同一 webContents+file URL 的 file:// 导航可能同时触发 will-navigate 与请求守卫，短时间去重。 */
  private localDropHandled = new Map<string, number>();

  constructor(private deps: BrowserHostDeps) {
    this.layout = new BrowserViewLayout({
      getWindowSize: () => this.deps.getWindowSize(),
      onViewLayout: (rect) => this.deps.onViewLayout?.(rect),
    });
    this.input = new AgentInputDriver({
      activeSessionId: () => this.activeSession,
      resolve: (tabId, sessionId) => this.resolveTab(tabId, sessionId),
      zoom: (sessionId, tabId) => this.getPageZoom(sessionId, tabId),
      owns: (entry, sessionId, tabId) =>
        this.groups.get(sessionId ?? this.activeSession)?.tabs.get(tabId) === (entry as unknown as TabEntry),
    });
    this.activeSession = deps.initialSessionId?.trim() || "default";
    this.ensureGroup(this.activeSession);
    this.ensureGroup(USER_TABS_SESSION);
    // 初始仍显示当前会话（启动恢复测试与旧行为兼容）；index 启动时会显式 showUserTabs()。
    this.visibleSession = this.activeSession;
  }
  private ensureGroup(sessionId: string): SessionGroup {
    let group = this.groups.get(sessionId);
    if (!group) {
      group = { tabs: new Map(), activeId: null, previousActiveId: null };
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
    const view = this.deps.createView(sessionId);
    const attached = this.tryAttach(view);
    const id = this.nextId();
    /** 事件回调可能早于 entry 创建（loadURL 前的同步事件），用闭包引用兜底。 */
    let entryRef: TabEntry | null = null;
    // 网页内点击/重定向/SPA 路由：同步地址、标题与历史栈，让地址栏与网页始终一致。
    const adapter = createWebContentsViewAdapter({
      view,
      ...(this.deps.onShortcut ? { onShortcut: this.deps.onShortcut } : {}),
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
        // 本地文档预览的标题由文档名决定，不能被 PDF 查看器内部的 document.title（文件哈希）覆盖。
        if (entry.localPreview) return;
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
        // 不隐藏原生视图：让 Chromium 继续画旧页面，直到新页面可绘制。
        // 首次加载（entry.url 还是空）也要把视图亮出来（白底），避免露出 DOM 深色加载页。
        this.applyLayout();
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
        // 失败时收起原生视图，让 DOM 错误页露出来（视图只能显示 Chromium 默认错误页）。
        this.applyLayout();
        // 失败也把地址栏落到「尝试访问的 URL」：用户能看到自己打错/失败的地址，
        // 且地址栏由此恢复为无功能放大镜（不再显示可切换的搜索引擎图标）。
        if (failure.url && entry.url !== failure.url) entry.url = failure.url;
        if (!entry.title || entry.title === "新标签页") entry.title = this.hostnameOf(failure.url);
        this.emitTabs(sessionId);
      },
      onAudioState: (audible: boolean): void => {
        const entry = entryRef ?? this.group(sessionId).tabs.get(id);
        // 事件可能晚于视图销毁（关标签时会先静音、再移除 WebContentsView），
        // 此时 view.webContents 已不存在；直接读取会让主进程抛未捕获异常并退出。
        const wc = view.webContents as { isAudioMuted?: () => boolean } | undefined;
        if (!entry || entry.audible === audible) return;
        entry.audible = audible;
        entry.muted = wc?.isAudioMuted?.() ?? entry.muted ?? false;
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
      audible: view.webContents.isCurrentlyAudible?.() === true,
      muted: view.webContents.isAudioMuted?.() === true,
      pinned: false,
      lockPushed: false,
    };
    entryRef = entry;
    // 网页里直接拖入 Office 文件时，Chromium 会尝试导航到 file:// 并触发下载/白页。
    // 在导航发生前截获：交给壳层转 PDF 后用应用内标签页展示。
    if (this.deps.onLocalFileDrop) {
      view.webContents.on("will-navigate", (...args) => {
        const event = args[0] as { preventDefault?: () => void } | undefined;
        const url = String(args[1] ?? "");
        const file = officeFileFromUrl(url);
        if (!file) return;
        // 本地 PDF 预览标签自身的初始 loadURL 不是用户拖拽：避免自己拦截自己。
        // 不能再用 entry.url === url 判断：did-start-navigation 可能已先把 entry.url
        // 更新成 file://，导致 will-navigate 里误判为「自身导航」而漏掉拖拽。
        if (entry.localPreview) return;
        event?.preventDefault?.();
        this.handleLocalFileRequest(Number(view.webContents.id ?? -1), url);
      });
    }
    const group = this.group(sessionId);
    group.tabs.set(id, entry);
    // 新标签必须立即成为该会话的活动标签
    activateTab(group, id);
    this.observability.attach(sessionId, id, view.webContents);
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
    this.layout.setSidebarWidth(width);
    this.applyLayout();
  }

  /** 当前侧栏宽度（debugBounds 之外的显式读取；诊断/测试断言用）。 */
  getSidebarWidth(): number {
    return this.layout.getSidebarWidth();
  }

  /**
   * 底部 DOM 面板（全宽终端）高度：原生视图让出这一段，否则面板会被 WebContentsView 盖住。
   * 契约/UI 层已校验 0..2000，这里再夹一次（宿主也可能被测试或其它内部路径直接调用）。
   */
  setBottomInset(height: number): void {
    this.layout.setBottomInset(height);
    this.applyLayout();
  }

  /** 当前底部让位高度（UI 恢复终端高度时可先读回，避免首帧跳动）。 */
  getBottomInset(): number {
    return this.layout.getBottomInset();
  }

  /** 顶部 DOM 面板高度（Agent 工作区展开列表）：页面整体下移，不隐藏原生视图。 */
  setTopInset(height: number): void {
    this.layout.setTopInset(height);
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
    const entry = this.activeEntry();
    let actual: { x: number; y: number; width: number; height: number } | null = null;
    try {
      actual = entry?.view.getBounds?.() ?? null;
    } catch {
      actual = null;
    }
    return {
      window: this.deps.getWindowSize(),
      bounds: this.layout.bounds(),
      actual,
      sessionId: this.activeSession,
      tabId: this.activeEntryId(),
      attached: entry?.attached ?? false,
      ...this.layout.insets(),
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
   * 重排所有视图（唯一入口）。几何规则全在 BrowserViewLayout：
   * 宿主只提供「当前有哪些组」「哪个组可见」「怎么把视图挂到窗口」。
   */
  private applyLayout(): void {
    this.layout.apply(this.groups as unknown as Map<string, LayoutGroup>, this.visibleSession, (view) =>
      this.tryAttach(view as unknown as HostView),
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
    return toTabStates(this.group(sessionId));
  }

  /**
   * 只读工具的回退地址：会话自己的任务页 → 用户全局标签。
   * 与 browser_snapshot 的回落规则一致：Agent 还没克隆页面时，「看」用户当前页是允许的，
   * cookie / 诊断这类只读查询不该因此返回空。
   */
  readableUrl(sessionId?: string): string {
    const resolved = this.resolveTab(undefined, sessionId) ?? this.resolveTab(undefined, USER_TABS_SESSION);
    return resolved?.[1].url ?? "";
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

  /** 指定标签（缺省=该会话语种的活动标签；用户可见标签优先）。 */
  private resolveTab(tabId?: string, sessionId?: string): [string, TabEntry] | null {
    const resolveIn = (sid: string): [string, TabEntry] | null => {
      const group = this.ensureGroup(sid);
      const id = tabId ?? group.activeId;
      if (!id) return null;
      const entry = group.tabs.get(id);
      return entry ? [id, entry] : null;
    };
    if (sessionId) return resolveIn(sessionId);
    // 状态栏「调试」/F12 不带 sessionId：先找当前会话，再找用户可见标签（__user_tabs__），
    // 最后找当前实际显示的会话；否则按钮会报「无标签页」。
    return (
      resolveIn(this.activeSession) ??
      resolveIn(USER_TABS_SESSION) ??
      (this.visibleSession !== this.activeSession ? resolveIn(this.visibleSession) : null)
    );
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

  /**
   * 给活动标签里的 input[type=file] 选择本地文件。
   * 只在 Agent 的浏览器工具里调用；文件路径已由工具层基于会话根目录校验。
   */
  async uploadFiles(
    sessionId: string | undefined,
    selector: string,
    files: string[],
  ): Promise<{ ok: boolean; message: string }> {
    const entry = this.activeEntry(sessionId);
    if (!entry) return { ok: false, message: "当前会话没有活动标签" };
    return uploadFileInput(entry.view.webContents, selector, files);
  }

  /** 当前会话最近的控制台日志（诊断工具用；不写入会话历史）。 */
  console(sessionId: string | undefined, limit: number): ReturnType<BrowserObservability["console"]> {
    const own = this.observability.console(sessionId, limit);
    // 会话还没有自己的任务页：诊断与快照一样回落到用户全局标签，别让「页面明明报错」读成空。
    if (!sessionId || this.listTabs(sessionId).length > 0) return own;
    return mergeRecent(own, this.observability.console(USER_TABS_SESSION, limit), limit);
  }

  /** 当前会话最近的网络请求（诊断工具用；不写入会话历史）。 */
  network(sessionId: string | undefined, limit: number): ReturnType<BrowserObservability["network"]> {
    const own = this.observability.network(sessionId, limit);
    if (!sessionId || this.listTabs(sessionId).length > 0) return own;
    return mergeRecent(own, this.observability.network(USER_TABS_SESSION, limit), limit);
  }

  hasAnyTab(sessionId?: string): boolean {
    return this.group(sessionId).tabs.size > 0;
  }

  /** 修复 ②：应用内浮层打开时隐藏原生视图。 */
  setOverlayOpen(open: boolean): void {
    this.layout.setOverlayOpen(open);
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
    referer?: string,
  ): Promise<NavigateOutcome> {
    // 导航是明确的「我要看这个页面」：把切会话时收起的网页重新展开。
    return this.navigateRecorded(rawUrl, tabId, true, sessionId, origin, referer);
  }

  private async navigateRecorded(
    rawUrl: string,
    tabId?: string,
    record = true,
    sessionId?: string,
    origin: "agent" | "user" = "user",
    referer?: string,
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
    activateTab(group, id);
    const entry = group.tabs.get(id)!;
    // Agent 导航过的标签永久属于 Agent 工作区：用户之后在同一标签点链接/输入地址也不撤销绑定，
    // 否则「Agent 打开的页面」会因为用户碰了一下就从折叠组里掉出去。
    if (origin === "agent") entry.agentBound = true;
    entry.navigating = true;
    // Agent 用 browser_navigate 直接打开从页面里读到的链接时，Chromium 的程序化导航默认不带
    // Referer；不少下载站/防盗链（如 CLisk）会因此返回 403。这里补上「用户点击链接」等价的
    // Referer（同源给完整路径，跨源只给 origin，符合默认 referrer policy）。
    const effectiveReferer = referer ?? downloadCompatibleReferer(normalized.url) ?? (origin === "agent" ? refererForNavigation(entry.url, normalized.url) : undefined);
    try {
      const result = await entry.adapter.navigate(normalized.url, effectiveReferer);
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
      // 导航失败也要入历史（与 Chrome 一致：错误页也是历史里的一条）。
      // 旧实现失败后不动 history，而 onLoadFailure 又把 entry.url 改成失败 URL →
      // canBack 仍为假：错误页上的「返回」消失，用户被困在错误页。
      if (record) {
        const failedUrl = normalized.url;
        const current = entry.index >= 0 ? entry.history[entry.index] : undefined;
        if (current !== failedUrl) {
          entry.history = entry.history.slice(0, entry.index + 1);
          entry.history.push(failedUrl);
          entry.index = entry.history.length - 1;
        }
      }
      this.emitTabs(sid);
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
   * 本地文档预览：新建标签页直接加载 file:// PDF（Chromium 内置 PDF 查看器）。
   *
   * 不走 navigate() 的 http(s) 白名单：这里只允许主进程已经转换/校验过的本地 PDF；
   * 预览页标记 localPreview，不写入浏览器恢复状态，避免重启时 file:// 被策略拒绝。
   */
  async openLocalPreview(
    file: string,
    sessionId?: string,
    title?: string,
    options: { tabId?: string } = {},
  ): Promise<{
    ok: boolean;
    tabId?: string;
    url?: string;
    error?: string;
  }> {
    const sid = (sessionId ?? this.visibleSession).trim() || this.visibleSession;
    const group = this.group(sid);
    let entry: TabEntry;
    let id: string;
    if (options.tabId) {
      const existing = group.tabs.get(options.tabId);
      if (!existing) return { ok: false, error: "预览标签已关闭" };
      entry = existing;
      id = options.tabId;
      if (entry.localPreview) this.deps.onLocalPreview?.(Number(entry.view.webContents.id ?? -1), entry.url, false);
      activateTab(group, id);
    } else {
      entry = this.createTab(sid);
      id = group.activeId!;
    }
    // 文档转换期间先给一个 data: 加载页（同一标签随后替换为 PDF），避免用户以为应用卡死。
    const url = file.startsWith("data:") ? file : pathToFileURL(file).href;
    const previewTitle = officeDocumentTitle(title || file);
    entry.localPreview = true;
    entry.url = url;
    entry.title = previewTitle;
    entry.history = [url];
    entry.index = 0;
    entry.navigating = true;
    this.deps.onLocalPreview?.(Number(entry.view.webContents.id ?? -1), url, true);
    this.emitTabs(sid);
    try {
      await entry.view.webContents.loadURL(url);
      entry.url = entry.view.webContents.getURL() || url;
      entry.title = previewTitle;
      entry.loading = false;
      entry.loadFailure = null;
      this.emitTabs(sid);
      return { ok: true, tabId: id, url: entry.url };
    } catch (err) {
      entry.loading = false;
      entry.loadFailure = {
        code: 0,
        description: err instanceof Error ? err.message : String(err),
        url,
        isMainFrame: true,
      };
      this.emitTabs(sid);
      return { ok: false, tabId: id, error: err instanceof Error ? err.message : String(err) };
    } finally {
      entry.navigating = false;
    }
  }
  handleDownloadSource(webContentsId: number): void {
    closeBlankDownloadTab(this as unknown as DownloadSourceHost, webContentsId);
  }

  /**
   * 请求守卫/导航拦截的统一入口：找到发起 file:// 的浏览器标签，交给壳层打开预览。
   * will-navigate 与 webRequest.onBeforeRequest 都可能命中，用 2 秒窗口去重，避免开两个标签。
   * 返回 true 表示已接管（调用方应取消原始本地导航）。
   */
  handleLocalFileRequest(webContentsId: number, rawUrl: string): boolean {
    const file = officeFileFromUrl(rawUrl);
    return file ? this.handleLocalFilePath(webContentsId, file) : false;
  }
  /** 浏览器页 preload 直接送来的本地路径：校验扩展名/归属后打开预览。 */
  handleLocalFilePath(webContentsId: number, file: string): boolean {
    let normalized: string | null = null;
    try {
      normalized = officeFileFromUrl(pathToFileURL(file).href);
    } catch {
      return false;
    }
    if (!normalized) return false;
    for (const [sessionId, group] of this.groups) {
      for (const entry of group.tabs.values()) {
        if (entry.localPreview) continue;
        if (Number(entry.view.webContents.id ?? -1) !== webContentsId) continue;
        const key = `${webContentsId}|${normalized}`;
        const now = Date.now();
        const last = this.localDropHandled.get(key) ?? 0;
        if (now - last > 2000) {
          this.localDropHandled.set(key, now);
          if (this.localDropHandled.size > 200) {
            const oldest = this.localDropHandled.keys().next().value;
            if (oldest) this.localDropHandled.delete(oldest);
          }
          this.deps.onLocalFileDrop?.(normalized, sessionId);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * 新建标签（可带初始 URL）并切为该会话的活动标签；同 URL 已存在时复用。
   * origin="agent" = Agent 新建：被复用的那个标签同样归属「Agent 工作区」。
   */
  async newTab(
    rawUrl?: string,
    sessionId?: string,
    origin: "agent" | "user" = "user",
    options: { afterTabId?: string; forceNew?: boolean; pinned?: boolean; referer?: string; openerId?: string } = {},
  ): Promise<{ tabId: string; url?: string; ok: boolean; error?: string }> {
    const sid = sessionId ?? this.activeSession;
    const group = this.group(sid);
    if (rawUrl && !options.forceNew) {
      const normalized = normalizeNavigateUrl(rawUrl);
      if (normalized.ok) {
        for (const [id, tab] of group.tabs) {
          if (tab.url === normalized.url) {
            if (origin === "agent") tab.agentBound = true;
            activateTab(group, id);
            this.emitTabs(sid);
            return { tabId: id, ok: true, url: tab.url };
          }
        }
      }
    }
    const openerId = options.openerId;
    const entry = this.createTab(sid);
    const id = group.activeId!;
    if (openerId && openerId !== id) entry.openerId = openerId;
    if (origin === "agent") entry.agentBound = true;
    if (options.pinned) entry.pinned = true;
    if (options.afterTabId && group.tabs.has(options.afterTabId) && !entry.pinned) {
      this.moveTabAfter(sid, id, options.afterTabId);
    } else {
      this.applyTabOrder(group);
    }
    this.emitTabs(sid);
    if (!rawUrl) return { tabId: id, ok: true };
    const outcome = await this.navigate(rawUrl, id, sid, origin, options.referer);
    if (!outcome.ok) return { tabId: id, ok: false, error: outcome.error };
    return { tabId: id, ok: true, url: outcome.url };
  }

  /** 新标签插到指定标签右侧（Chrome「在右侧新建标签页」）；固定标签永远在最左。 */
  private moveTabAfter(sessionId: string, tabId: string, afterTabId: string): void {
    moveTabRelative(this.group(sessionId).tabs, tabId, afterTabId, true);
  }

  /** 固定标签必须排在普通标签之前；Map 保持插入顺序，重排即可持久化视觉顺序。 */
  private applyTabOrder(group: SessionGroup): void {
    const entries = [...group.tabs.entries()];
    entries.sort((a, b) => Number(b[1].pinned === true) - Number(a[1].pinned === true));
    group.tabs.clear();
    for (const [id, entry] of entries) group.tabs.set(id, entry);
  }

  /** 当前标签页是否在出声；没有活动标签返回 false。 */
  isTabAudible(tabId?: string, sessionId?: string): boolean {
    return this.resolveTab(tabId, sessionId)?.[1].audible === true;
  }

  async setTabMuted(tabId: string, muted: boolean, sessionId?: string): Promise<boolean> {
    const entry = this.resolveTab(tabId, sessionId)?.[1];
    if (!entry) return false;
    entry.view.webContents.setAudioMuted?.(muted);
    entry.muted = muted;
    this.emitTabs(sessionId ?? this.activeSession);
    return true;
  }

  async setTabPinned(tabId: string, pinned: boolean, sessionId?: string): Promise<boolean> {
    const sid = sessionId ?? this.activeSession;
    const group = this.group(sid);
    const entry = group.tabs.get(tabId);
    if (!entry) return false;
    entry.pinned = pinned;
    this.applyTabOrder(group);
    this.emitTabs(sid);
    return true;
  }

  /** 复制标签：同 URL 强制开新页（普通 newTab 会复用同 URL 标签）。 */
  async duplicateTab(tabId: string, sessionId?: string): Promise<{ ok: boolean; tabId?: string; error?: string }> {
    const resolved = this.resolveTab(tabId, sessionId);
    if (!resolved) return { ok: false, error: "标签不存在" };
    const [id, entry] = resolved;
    const sid = sessionId ?? this.activeSession;
    const result = await this.newTab(entry.url || undefined, sid, entry.agentBound ? "agent" : "user", {
      afterTabId: id,
      forceNew: true,
    });
    return result.ok ? { ok: true, tabId: result.tabId } : { ok: false, error: result.error };
  }

  /** 批量关闭（关闭其他/右侧）：一次遍历，避免 UI 连续 20 次 IPC。 */
  async closeTabs(tabIds: string[], sessionId?: string): Promise<number> {
    let closed = 0;
    for (const id of tabIds) if (await this.closeTab(id, sessionId)) closed += 1;
    return closed;
  }

  /** 最近关闭（新→旧）：面板数据源；restore 用于启动时从磁盘恢复（退出后仍保留）。 */
  listClosedTabs(): ClosedTabView[] { return this.closedTabs.list(); }
  restoreClosedTabs(raw: unknown): void { this.closedTabs.restore(raw); }

  /** 重开最近关闭的网页（原会话还在就回原标签组）；index 0 = 最新。 */
  async reopenClosedTab(sessionId?: string, index = 0): Promise<{ ok: boolean; tabId?: string; sessionId?: string; agentBound?: boolean }> {
    const last = this.closedTabs.take(index);
    if (!last) return { ok: false };
    const targetSession = this.groups.has(last.sessionId) ? last.sessionId : sessionId ?? this.currentSessionForTabs();
    const result = await this.newTab(last.url, targetSession, last.agentBound ? "agent" : "user", { forceNew: true, pinned: last.pinned });
    return result.ok ? { ok: true, tabId: result.tabId, sessionId: targetSession, agentBound: last.agentBound === true } : { ok: false };
  }

  private currentSessionForTabs(): string {
    return this.visibleSession && this.visibleSession !== USER_TABS_SESSION ? this.visibleSession : this.activeSession;
  }

  /**
   * 网页里的 window.open / target=_blank 进入新标签。
   *
   * 必须落在 **当前可见会话**，而不是 activeSession：用户可能在全局用户标签/搜索页里，
   * activeSession 仍是某个聊天会话；若按 activeSession 建页，新标签会落进不可见分组，
   * 页面看起来就是“点了没反应”。Agent 的工具调用仍用 newTab(activeSession)，不受影响。
   */
  async newTabInVisibleSession(rawUrl?: string): Promise<{ tabId: string; url?: string; ok: boolean; error?: string }> {
    // 从网页里点开的链接/下载：带上当前可见页的 Referer（同 window.open 语义）。
    const active = this.activeEntry(this.visibleSession);
    const referer = rawUrl ? (downloadCompatibleReferer(rawUrl) ?? (active?.url ? refererForNavigation(active.url, rawUrl) : undefined)) : undefined;
    const openerId = active?.url ? this.group(this.visibleSession).activeId ?? undefined : undefined;
    return this.newTab(rawUrl, this.visibleSession, "user", { ...(referer ? { referer } : {}), ...(openerId ? { openerId } : {}) });
  }
  selectTab(tabId: string, sessionId?: string): boolean {
    const group = this.group(sessionId);
    if (!group.tabs.has(tabId)) return false;
    activateTab(group, tabId);
    this.emitTabs(sessionId ?? this.activeSession);
    return true;
  }

  /** 拖拽重排：把 tabId 移到 targetTabId 之前/之后；固定标签仍排最前。 */
  moveTab(tabId: string, targetTabId: string, after: boolean, sessionId?: string): boolean {
    const group = this.group(sessionId);
    if (!moveTabRelative(group.tabs, tabId, targetTabId, after)) return false;
    this.applyTabOrder(group);
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
    const sid = sessionId ?? this.activeSession;
    // 只有真正有地址的网页才进「最近关闭」：空白新标签页重开没有意义。
    if (entry.url) {
      this.closedTabs.pushEntry({ url: entry.url, title: entry.title, sessionId: sid, agentBound: entry.agentBound, pinned: entry.pinned });
    }
    // 关闭前先静音：视图销毁/分离的瞬间，页面仍可能继续播放声音。
    entry.view.webContents.setAudioMuted?.(true);
    if (entry.localPreview) this.deps.onLocalPreview?.(Number(entry.view.webContents.id ?? -1), entry.url, false);
    group.tabs.delete(tabId);
    try {
      await entry.adapter.close();
    } finally {
      this.deps.detachView(entry.view);
    }
    if (group.activeId === tabId) {
      group.activeId = activeAfterClose(group, tabId, entry.openerId);
    }
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
    const wc = entry?.view.webContents as import("./agentInput.js").AgentInputWebContents | undefined;
    const factor = typeof wc?.getZoomFactor === "function" ? wc.getZoomFactor() : 1;
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  }

  /** Agent 点击：真实鼠标事件（见 agentInput.ts：存活检查/可见等待/驱动令牌都在那里）。 */
  async agentClick(
    sessionId: string | undefined,
    tabId: string | undefined,
    point: { x: number; y: number },
  ): Promise<boolean> {
    return this.input.click(sessionId, tabId, point);
  }

  /** Agent 逐字输入（真实键盘事件；CJK 走 insertText）。 */
  async agentType(
    sessionId: string | undefined,
    tabId: string | undefined,
    text: string,
    options: { multiline?: boolean } = {},
  ): Promise<boolean> {
    return this.input.type(sessionId, tabId, text, options);
  }

  /** 真实鼠标移动（悬停）：触发 CSS :hover / pointerover / mouseover。 */
  async agentHover(
    sessionId: string | undefined,
    tabId: string | undefined,
    point: { x: number; y: number },
  ): Promise<boolean> {
    return this.input.hover(sessionId, tabId, point);
  }

  /** 页面视口中心（CSS 像素）：滚动/悬停前把虚拟光标停到页面中间。 */
  async getViewportCenter(
    sessionId: string | undefined,
    tabId: string | undefined,
  ): Promise<{ x: number; y: number } | null> {
    return this.input.viewportCenter(sessionId, tabId);
  }

  /** Agent 拖拽：真实按下 → 分帧移动 → 抬起（滑块/拖拽排序/画布）。 */
  async agentDrag(
    sessionId: string | undefined,
    tabId: string | undefined,
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 10,
  ): Promise<boolean> {
    return this.input.drag(sessionId, tabId, from, to, steps);
  }

  /** 真实滚轮：按 notch 拆帧派发（滚动动画/懒加载/吸顶都与用户操作一致）。 */
  async agentWheel(sessionId: string | undefined, tabId: string | undefined, deltaY: number): Promise<boolean> {
    return this.input.scroll(sessionId, tabId, deltaY);
  }

  /** Agent 按键：真实键盘事件（Enter 的表单提交由 char 驱动）。 */
  async agentKey(sessionId: string | undefined, tabId: string | undefined, key: string): Promise<boolean> {
    return this.input.pressKey(sessionId, tabId, key);
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

  async screenshot(sessionId?: string): Promise<string | null> {
    return (this.activeEntry(sessionId) ?? this.activeEntry(USER_TABS_SESSION))?.adapter.screenshot() ?? null;
  }

  /** 当前/指定会话的标签快照（持久化用）。空白标签不写入。 */
  snapshotSession(sessionId: string = this.activeSession): PersistedBrowserState {
    const group = this.group(sessionId);
    const tabs: PersistedBrowserTab[] = [];
    let activeIndex = 0;
    for (const [id, entry] of group.tabs) {
      if (!entry.url || entry.localPreview) continue;
      if (id === group.activeId) activeIndex = tabs.length;
      tabs.push({
        url: entry.url,
        ...(entry.title ? { title: entry.title } : {}),
        history: entry.history.slice(),
        index: entry.index,
        ...(entry.agentBound ? { agentBound: true } : {}),
        ...(entry.pinned ? { pinned: true } : {}),
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
  async ensureAgentTab(sessionId?: string, opts?: { blank?: boolean }): Promise<string | null> {
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
    if (sourceUrl && opts?.blank !== true) {
      const outcome = await this.navigate(sourceUrl, id, sid, "agent");
      if (!outcome.ok) entry.url = sourceUrl;
    }
    // 只有前台会话才切视图/点亮光标：后台会话的工具调用不能把用户正在看的页面换掉。
    const foreground = sid === this.activeSession;
    if (foreground) {
      this.showTask(sid);
      // 页面此刻才真正可见：把「常驻光标」从现在开始算，而不是等用户看到第一次点击。
      this.deps.onAgentActing?.(sid);
    }
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

  /** 主题外壳色：只同步给四角遮罩窗口，绝不改网页视图背景（页面透明时深色会透成黑底，视图保持创建时的白）。 */
  setCornerColor(color: string): void {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
    this.deps.onCornerColor?.(color);
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
    const pending: { entry: TabEntry; url: string }[] = [];
    for (const tab of safe.tabs) {
      const entry = this.createTab(sessionId);
      const id = group.activeId!;
      ids.push(id);
      entry.title = tab.title ?? this.hostnameOf(tab.url);
      // 折叠标签页的归属必须跟着页面一起恢复：否则重启后 Agent 工作区凭空消失。
      entry.agentBound = tab.agentBound === true;
      entry.pinned = tab.pinned === true;
      entry.history = Array.isArray(tab.history) && tab.history.length > 0 ? tab.history.slice() : [tab.url];
      entry.index = typeof tab.index === "number" ? Math.max(0, Math.min(tab.index, entry.history.length - 1)) : entry.history.length - 1;
      entry.navigating = true;
      pending.push({ entry, url: tab.url });
    }
    // 并行导航：启动恢复不再一页一页串行等待（配合启动面板，恢复期用户看不到闪烁）。
    await Promise.all(pending.map(async ({ entry, url }) => {
      try {
        const result = await entry.adapter.navigate(url);
        entry.url = result.url;
      } catch (err) {
        // 加载失败也要把 URL 留在标签里（视图显示 Chromium 错误页，地址栏/刷新也能重试），不能留空白标签 + 静默。
        entry.url = url;
        console.warn("[browser] 恢复页面失败，保留 URL 供刷新重试", url, err instanceof Error ? err.message : String(err));
      } finally {
        entry.navigating = false;
      }
    }));
    const active = ids[Math.max(0, Math.min(safe.activeIndex, ids.length - 1))];
    if (active) group.activeId = active;
    this.applyTabOrder(group);
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
