/**
 * 原生网页视图的几何单一产地（从 BrowserHost 拆出）。
 *
 * 为什么独立成类：侧栏宽度、底部终端面板高度、顶部 Agent 列表高度、覆盖层开关，
 * 这四件事共同决定「网页应该占哪块矩形」，并且每一步都要立即重排所有视图。
 * 留在 BrowserHost 里时，它和标签生命周期、会话切换混在一个 1500 行类中，
 * 谁改一个 inset 都要读完整台宿主——而这部分逻辑其实**不碰标签内容**，只碰几何与可见性。
 *
 * 现在：`apply(groups, visibleSession, attach)` 是唯一入口，宿主只负责把「当前有哪些组」
 * 和「怎么把视图挂到窗口」递进来；几何规则、脏标记、隐藏/可见策略全部收在这里。
 */
import { LAYOUT, computeBrowserViewBounds, type BrowserViewBounds, type WindowSize } from "loopsoar-contracts/layout";

/** 视图的最小几何面（真实 WebContentsView 满足，测试假件可选实现）。 */
export interface LayoutView {
  setBounds(rect: { x: number; y: number; width: number; height: number }): void;
  setVisible?(visible: boolean): void;
  setBorderRadius?(radius: number): void;
  getBounds?(): { x: number; y: number; width: number; height: number };
}

/** 参与布局的标签项（结构类型，避免宿主把内部 TabEntry 暴露出去）。 */
export interface LayoutTabEntry {
  view: LayoutView;
  url: string;
  /** 主框架加载中：首次加载（url 仍空）时也据此先把原生视图亮出来。 */
  loading: boolean;
  /** 非 null = 加载失败：隐藏原生视图，让 DOM 错误页接管。 */
  loadFailure: unknown;
  attached: boolean;
  lastVisible?: boolean;
  lastBounds?: { x: number; y: number; width: number; height: number };
  layoutDirty?: boolean;
}

export interface LayoutGroup {
  tabs: Map<string, LayoutTabEntry>;
  activeId: string | null;
}

export interface BrowserViewLayoutDeps {
  getWindowSize(): WindowSize;
  /** 覆盖层（Agent 指针/高亮）跟随当前可见网页矩形；null = 不显示。 */
  onViewLayout?(rect: { x: number; y: number; width: number; height: number } | null): void;
}

export class BrowserViewLayout {
  private overlayOpen = false;
  /** 侧栏当前宽度（用户可拖拽；偏好持久化在 UI 层）。 */
  private sidebarWidth: number = LAYOUT.SIDEBAR_WIDTH;
  /** 底部 DOM 面板（全宽终端）占用的高度：原生视图必须让出，否则会被面板盖住。 */
  private bottomInset = 0;
  /** 顶部 DOM 面板（Agent 工作区展开列表）占用的高度：原生视图下移，页面不被隐藏。 */
  private topInset = 0;

  constructor(private readonly deps: BrowserViewLayoutDeps) {}

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
  }

  /** 当前底部让位高度（UI 恢复终端高度时可先读回，避免首帧跳动）。 */
  getBottomInset(): number {
    return this.bottomInset;
  }

  /** 顶部 DOM 面板高度（Agent 工作区展开列表）：页面整体下移，不隐藏原生视图。 */
  setTopInset(height: number): void {
    const next = Number.isFinite(height) ? Math.round(height) : 0;
    this.topInset = Math.max(0, Math.min(2000, next));
  }

  apply(groups: Map<string, LayoutGroup>, visibleSession: string, attach: (view: LayoutView) => boolean): void {
    // 几何单一产地：侧栏宽度与底部 DOM 面板（全宽终端）高度都作为 options 传入，
    // 原生视图让出这两块区域，否则会被 DOM 盖住/盖住 DOM。
    const bounds = computeBrowserViewBounds(this.deps.getWindowSize(), LAYOUT, {
      sidebarWidth: this.sidebarWidth,
      bottomInset: this.bottomInset,
      topInset: this.topInset,
    });
    // 启动恢复先于窗口创建：createTab 时 attachView 拿不到主窗口（旧实现静默 no-op），
    // 窗口就绪后必须在这里补挂，否则恢复的页面永远不会出现在窗口里（刷新也无效）。
    // 补挂与布局解耦：所有组的标签都补挂（幂等），只有可见组的活动标签参与 setBounds。
    for (const group of groups.values()) {
      for (const entry of group.tabs.values()) {
        if (!entry.attached) entry.attached = attach(entry.view);
      }
    }
    const activeGroup = groups.get(visibleSession);
    // 只布局「可见组的活动标签」：隐藏标签/后台会话不参与每帧布局（拖侧栏/终端面板时不再全量 setBounds）。
    // 隐藏期间置 layoutDirty，切回时强制重新布局一次，避免沿用旧几何。
    if (activeGroup) {
      for (const [id, entry] of activeGroup.tabs) {
        if (id !== activeGroup.activeId) {
          entry.layoutDirty = true;
          if (entry.lastVisible !== false) {
            entry.view.setVisible?.(false);
            entry.lastVisible = false;
          }
          continue;
        }
        const last = entry.lastBounds;
        if (
          entry.layoutDirty ||
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
          entry.layoutDirty = false;
        }
        // 只有「没有页面」时才隐藏原生视图（空标签/新建页），否则透明视图会覆盖整个内容区
        // 并吞掉鼠标事件；加载失败时也让 DOM 错误页露出来。
        //
        // 关键：**加载中绝不隐藏**。旧实现在 loading 时隐藏视图、让 DOM 加载页接管，
        // 用户看到的是整块应用底色（黑边/黑圈）或品牌加载页盖住网页。现在导航期间
        // 原生视图保持可见：Chromium 自己会保留旧页面直到新页面可绘制，页面永不消失。
        // 首次加载（新标签输入网址/点链接）时还没有 url，但把原生视图先亮出来：
        // Chromium 的白底比 DOM 深色加载页更接近浏览器行为，也不会出现「整块黑底」。
        const visible =
          !this.overlayOpen &&
          (Boolean(entry.url) || entry.loading) &&
          entry.loadFailure === null;
        if (entry.lastVisible !== visible) {
          entry.view.setVisible?.(visible);
          entry.view.setBorderRadius?.(LAYOUT.BROWSER_VIEW_RADIUS);
          entry.lastVisible = visible;
        }
      }
    }
    // 后台会话：只保证「不可见」，不布局、不 setBounds（切会话时 applyLayout 会重新处理）。
    for (const [sessionId, group] of groups) {
      if (sessionId === visibleSession) continue;
      for (const entry of group.tabs.values()) {
        entry.layoutDirty = true;
        if (entry.lastVisible !== false) {
          entry.view.setVisible?.(false);
          entry.lastVisible = false;
        }
      }
    }
    // 覆盖窗口只跟随「当前会话的当前标签」：后台会话的页面不可见，指针也不该出现在屏幕上
    // （会话隔离要求：只有进入对应会话才看到对应内容）。几何与原生视图同源，避免两套坐标。
    const activeEntry = activeGroup?.activeId ? activeGroup.tabs.get(activeGroup.activeId) : null;
    this.deps.onViewLayout?.(
      activeEntry?.lastVisible
        ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        : null,
    );
  }
  /** 浮层打开时隐藏原生视图（浮层要浮在网页之上，不能被原生视图盖住）。 */
  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open;
  }

  isOverlayOpen(): boolean {
    return this.overlayOpen;
  }

  /** 当前几何（诊断/测试用）。 */
  bounds(): BrowserViewBounds {
    return computeBrowserViewBounds(this.deps.getWindowSize(), LAYOUT, {
      sidebarWidth: this.sidebarWidth,
      bottomInset: this.bottomInset,
      topInset: this.topInset,
    });
  }

  insets(): { sidebarWidth: number; bottomInset: number; topInset: number } {
    return { sidebarWidth: this.sidebarWidth, bottomInset: this.bottomInset, topInset: this.topInset };
  }
}
