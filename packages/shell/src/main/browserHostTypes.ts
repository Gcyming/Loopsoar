/**
 * BrowserHost 的公开类型面（从 browserHost.ts 抽出以控制单文件体积）。
 * browserHost.ts 继续 re-export，既有 import 路径不变。
 */
import type { BrowserViewBounds, WindowSize } from "loopsoar-contracts/layout";
import type { WebContentsViewLike } from "../browserAdapter/backends/webContentsView.js";
import type { BrowserLoadFailure } from "../browserAdapter/types.js";
import type { PersistedBrowserState } from "./browserSessionState.js";

export interface HostView extends WebContentsViewLike {
  setBounds(bounds: BrowserViewBounds): void;
  setVisible?(visible: boolean): void;
  setBackgroundColor?(color: string): void;
  /** 原生视图圆角（Electron 45 View.setBorderRadius；假 View 可不实现）。 */
  setBorderRadius?(radius: number): void;
  /** 真实视图几何（Electron WebContentsView.getBounds；假 View 可不实现）。 */
  getBounds?(): { x: number; y: number; width: number; height: number };
}

export interface BrowserHostDeps {
  /** sessionId 用于给页面的 window.open/target=_blank 找到正确归属（后台会话不能落到用户标签）。 */
  createView: (sessionId?: string) => HostView;
  /**
   * 用户把 Office 文档拖进某个网页视图：宿主在 file:// 导航发生前截获并交给壳层预览。
   * 没有这个回调时保持浏览器默认行为（测试/旧装配不受影响）。
   */
  onLocalFileDrop?: (file: string, sessionId: string) => void;
  /** 请求守卫发现网页 tab 的 file:// 导航：返回 true 表示壳层已接管并应取消原导航。 */
  onLocalFileRequest?: (webContentsId: number, url: string) => boolean;
  /** 本地预览标签登记：请求守卫只放行这些 webContents 的 file:// PDF。 */
  onLocalPreview?: (webContentsId: number, url: string, active: boolean) => void;
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
  /** 「最近关闭」变化（关闭/重开）：index 侧防抖落盘到 closed-tabs.json。 */
  onClosedTabsChanged?: (entries: { url: string; title: string; sessionId: string; closedAt: number; agentBound?: boolean; pinned?: boolean }[]) => void;
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
  /** 首次任务化（Agent 拿到自己的克隆页）：壳层据此把会话标记成「浏览器任务」。 */
  onTaskCreated?: (sessionId: string) => void;
  /** Agent 正在这个会话里动手（克隆页已可见）：壳层据此把虚拟光标切成常驻。 */
  onAgentActing?: (sessionId: string) => void;
  /**
   * 网页视图几何（主窗口内容坐标系）：Agent 覆盖窗口据此严丝合缝地贴住网页区域。
   * 传 null = 当前没有可见网页（无标签 / 加载中 / 浮层打开 / 非活动会话），覆盖层必须隐藏。
   */
  onViewLayout?: (rect: BrowserViewBounds | null) => void;
  /** 主题外壳色变化：四角遮罩/视图切角跟着换色。 */
  onCornerColor?: (color: string) => void;
  /** 底部开发者工具面板：打开指定 WebContents 的调试前端（返回是否成功）。 */
  openDevToolsPanel?: (webContents: unknown) => boolean;
  /** 关闭底部开发者工具面板。 */
  closeDevToolsPanel?: () => void;
  /** 底部开发者工具面板是否已打开。 */
  isDevToolsPanelOpen?: () => boolean;
  /** 网页请求新窗口时由宿主转为新标签。 */
  openInNewTab?: (url: string) => void;
  /**
   * 网页焦点下的浏览器快捷键（Ctrl+T/W/R/M、Ctrl+Shift+T/K）：
   * WebContentsView 有独立焦点，主窗口收不到 keydown；宿主把动作转给壳层再推渲染层执行。
   */
  onShortcut?: (action: string) => void;
  /** 初始会话（默认 default）。 */
  initialSessionId?: string;
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
  /** 由 Agent 打开或导航过：UI 把它折叠进「Agent 工作区」标签组。 */
  agentBound: boolean;
  /** 页面当前是否在出声（Electron isCurrentlyAudible；用于标签栏喇叭按钮）。 */
  audible?: boolean;
  /** 标签是否已被用户静音。 */
  muted?: boolean;
  /** 固定标签（Chrome 语义：固定在最左侧；关闭其他标签时保留）。 */
  pinned?: boolean;
}

/** 一次成功访问（供壳层追加「全局历史」；与标签内部后退/前进栈无关）。 */
export interface BrowserVisit {
  url: string;
  /** 访问当下已知的页面标题（可能缺省：网页内跳转时标题还没回来）。 */
  title?: string;
  sessionId: string;
  tabId: string;
}
