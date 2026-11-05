/**
 * Agent 会话栏「独立窗口」：真正的系统窗口（无系统边框、自绘标题栏，可拖动/缩放/最小化）。
 *
 * 背景：用户要求「像 slime 的浮窗一样真正独立」，并且：
 *   · 去掉系统边框、由渲染层自绘标题栏（frame:false + titleBarStyle:hidden）；
 *   · 出现/收起方向正确：从主窗口右缘外滑入 / 滑回右缘外收起（200ms/160ms 动画）；
 *   · 主窗口侧栏收起/展开时，原生网页视图必须用相同的曲线/时长同步过渡（见 browserHost）。
 *
 * 与 chromePopover 的差异（刻意区分，不要合并）：
 *   · 浮层是 parent 子窗口、置顶、hover 消失；本窗口是**无 parent 的顶层窗口**，可常驻、可最小化；
 *   · 本窗口无系统边框（frame:false），标题栏由渲染层绘制；点击最小化走 ui:minimizeAgentWindow；
 *   · 单实例：重复 open 只聚焦已有窗口（不重建、不重载会话），避免多份状态互相打架。
 *
 * 测试友好：不静态 import electron —— Electron 原语走 deps 注入或惰性 require（仅真实运行且未注入时加载），
 * 定时器也可注入（测试用手动 scheduler 驱动动画），因此单测可在纯 Node 下跑完整生命周期。
 */
import { createRequire } from "node:module";
import { LAYOUT } from "loopsoar-contracts/layout";

/* ────────────────────────── 默认窗口参数 ────────────────────────── */

/** 默认窗口尺寸（窄长条，贴主窗口右缘当会话栏用）。 */
export const AGENT_WINDOW_DEFAULT_WIDTH = 420;
export const AGENT_WINDOW_DEFAULT_HEIGHT = 720;
export const AGENT_WINDOW_MIN_WIDTH = 340;
export const AGENT_WINDOW_MIN_HEIGHT = 480;
/** 窗口标题（品牌 + 用途；多窗口任务栏里可辨识）。 */
export const AGENT_WINDOW_TITLE = "Loopsoar · Agent 对话";
/** 与主窗口一致的深色底，避免加载瞬间白闪。 */
export const AGENT_WINDOW_BACKGROUND = "#0a0c10";

/* ────────────────────────── 动画与贴边常量 ────────────────────────── */

/** 打开滑入时长（与 UI 侧栏展开动画同一条曲线，避免「侧栏先动、网页后动」的错拍感）。 */
export const AGENT_WINDOW_SLIDE_IN_MS = 200;
/** 关闭滑出时长（比打开略快，收起不拖沓）。 */
export const AGENT_WINDOW_SLIDE_OUT_MS = 160;
/** 动画帧间隔（约 60fps）。 */
export const AGENT_WINDOW_ANIMATION_TICK_MS = 16;
/** 滑入起点：目标位置右侧多出的距离（看起来像从主窗口右缘「推出来」）。 */
export const AGENT_WINDOW_SLIDE_OFFSET = 24;
/** 距离屏幕工作区右/下边缘的留白。 */
export const AGENT_WINDOW_EDGE_GAP = 8;

/** 无主窗口 / 无 screen 信息时的兜底工作区（仅测试与极端环境使用）。 */
const DEFAULT_WORK_AREA: AgentWindowRect = { x: 0, y: 0, width: 1920, height: 1080 };

/* ────────────────────────── 几何 ────────────────────────── */

/** 屏幕坐标矩形（Electron getContentBounds / Display.workArea 同形）。 */
export interface AgentWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 三次贝塞尔缓动 cubic-bezier(0.2, 0, 0.2, 1)：与 UI CSS（theme.ts MOTION.ease / index.html --ls-ease）同一条曲线。
 * x(u) = 0.6u(1-u) + u³，y(u) = 3u² - 2u³；用牛顿迭代从 x 反解 u，再求 y。
 * 为什么不用近似/不各写一条：侧栏 DOM 与原生网页视图必须同拍，曲线差一点在 320ms 内就能看出覆盖/缝隙。
 */
export function easeCubicBezier(x: number): number {
  const t = clamp(x, 0, 1);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let u = t;
  for (let i = 0; i < 6; i += 1) {
    const ux = 0.6 * u * (1 - u) + u * u * u;
    const dx = 0.6 * (1 - 2 * u) + 3 * u * u;
    if (Math.abs(dx) < 1e-6) break;
    u = clamp(u - (ux - t) / dx, 0, 1);
  }
  return clamp(3 * u * u - 2 * u * u * u, 0, 1);
}

/**
 * 计算会话栏窗口的目标 bounds（屏幕逻辑像素）：
 *  · 默认贴主窗口右缘：x = 主窗口内容区右缘 - 窗口宽度 - 8；
 *  · 顶部对齐浏览器原生视图（标题栏 36 + 顶部栏 48 + 标签栏 34 = 118，来自 contracts/layout）；
 *  · 用屏幕工作区四边夹取，右/下留 8px（多显示器/任务栏/小屏都不会把窗口推出去）；
 *  · 尺寸超出工作区时先收缩尺寸（不会产生负宽高）。
 */
export function computeAgentWindowBounds(
  contentBounds: AgentWindowRect | null,
  workArea: AgentWindowRect,
  size: { width?: number; height?: number } = {},
  gap: number = AGENT_WINDOW_EDGE_GAP,
): AgentWindowRect {
  const preferredWidth = size.width ?? AGENT_WINDOW_DEFAULT_WIDTH;
  const preferredHeight = size.height ?? AGENT_WINDOW_DEFAULT_HEIGHT;
  const width = Math.max(1, Math.min(preferredWidth, Math.max(1, workArea.width - gap * 2)));
  const height = Math.max(1, Math.min(preferredHeight, Math.max(1, workArea.height - gap * 2)));

  // 浏览器视图顶部 = 自绘标题栏（含标签页）+ 顶部栏 + 网页面板留白（顺序与 contracts/layout 一致）
  const topInset = LAYOUT.TITLE_BAR_HEIGHT + LAYOUT.TOP_BAR_HEIGHT + LAYOUT.BROWSER_VIEW_INSET;

  const preferredX =
    contentBounds && Number.isFinite(contentBounds.x) && Number.isFinite(contentBounds.width)
      ? contentBounds.x + contentBounds.width - width - gap
      : workArea.x + workArea.width - width - gap;
  const preferredY =
    contentBounds && Number.isFinite(contentBounds.y) ? contentBounds.y + topInset : workArea.y + topInset;

  // 四边夹取：右/下永远留 gap；左侧/顶部可贴工作区边缘（小屏时不至于被裁掉）
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - width - gap);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - height - gap);
  return {
    x: Math.round(clamp(preferredX, workArea.x, maxX)),
    y: Math.round(clamp(preferredY, workArea.y, maxY)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/* ────────────────────────── Electron 原语的最小结构类型 ────────────────────────── */

/** Agent 窗口 webContents 最小接口（只用于可选事件接线与 id）。 */
export interface AgentWindowWebContentsLike {
  id?: number;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Agent 窗口最小接口（真实 BrowserWindow 结构兼容；测试用假对象）。 */
export interface AgentWindowLike {
  loadURL(url: string): Promise<void> | void;
  show(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  isMinimized?(): boolean;
  restore?(): void;
  /** 动画需要：改窗口位置/尺寸（缺省时退化为只显示/关闭）。 */
  setBounds?(bounds: AgentWindowRect): void;
  getBounds?(): AgentWindowRect;
  /** 滑入/滑出透明度（Windows/macOS 支持；异常时忽略）。 */
  setOpacity?(opacity: number): void;
  /** 最小化（标题栏自绘按钮 → ui:minimizeAgentWindow）。 */
  minimize?(): void;
  /** 动画结束后销毁（不触发用户关闭事件）。 */
  destroy?(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners?(): unknown;
  webContents?: AgentWindowWebContentsLike;
}

/** 创建 Agent 窗口的构造参数（只列本模块真正设置的字段；不设 parent = 独立顶层窗口）。 */
export interface AgentWindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** 初始位置（隐藏创建时先落在目标位置，避免显示时跳一下）。 */
  x?: number;
  y?: number;
  /** false：去掉系统边框，标题栏由渲染层自绘。 */
  frame: boolean;
  /** 无边框窗口的标题栏样式（macOS 生效；Windows/Linux 忽略）。 */
  titleBarStyle?: "hidden";
  /** Windows 11 圆角（无边框窗口也保留圆角，视觉上不割裂）。 */
  roundedCorners?: boolean;
  show: boolean;
  resizable: boolean;
  maximizable: boolean;
  skipTaskbar: boolean;
  title: string;
  autoHideMenuBar: boolean;
  backgroundColor: string;
  webPreferences: {
    preload: string;
    sandbox: boolean;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    additionalArguments?: string[];
    devTools?: boolean;
  };
}

/** 创建 Agent 窗口的工厂（装配层用 `(options) => new BrowserWindow(...)`；测试用假窗口）。 */
export type AgentWindowFactory = (options: AgentWindowOptions) => AgentWindowLike;

/** 屏幕信息最小接口（真实 Electron screen；测试注入假对象）。 */
export interface AgentWindowScreenLike {
  getDisplayMatching(rect: AgentWindowRect): { workArea: AgentWindowRect };
  getPrimaryDisplay(): { workArea: AgentWindowRect };
}

/** 惰性 require 的 electron 运行时形状。 */
export interface AgentElectronRuntime {
  BrowserWindow: new (options: AgentWindowOptions) => AgentWindowLike;
  screen?: AgentWindowScreenLike;
}

let cachedElectronRuntime: AgentElectronRuntime | null = null;

/**
 * 惰性加载 electron（不静态 import：单测在纯 Node 下 import 本模块不会失败）。
 * 真实运行在 Electron 主进程里，require("electron") 返回 BrowserWindow/screen。
 */
function loadElectronRuntime(): AgentElectronRuntime {
  if (cachedElectronRuntime) return cachedElectronRuntime;
  const requireFromHere = createRequire(import.meta.url);
  cachedElectronRuntime = requireFromHere("electron") as AgentElectronRuntime;
  return cachedElectronRuntime;
}

/* ────────────────────────── 管理器 ────────────────────────── */

export interface AgentWindowOpenResult {
  ok: boolean;
  error?: string;
}

/** 关闭选项：默认播滑出动画；主窗口关闭/退出等场景可显式跳过。 */
export interface AgentWindowCloseOptions {
  animate?: boolean;
}

export interface AgentWindowManagerDeps {
  /** 会话栏窗口要加载的 URL（通常 `${PROTOCOL}://app/index.html?mini=1&sessionId=...`；由装配层决定）。 */
  loadUrlFor: (sessionId?: string) => string;
  /** preload 路径（与主窗口同一个 CJS preload）。 */
  preloadPath: string;
  /** preload additionalArguments（必须带 --loopsoar-bindings/--loopsoar-events，否则窗口里 loopsoarAPI 为空）。 */
  additionalArguments?: string[];
  /**
   * 主窗口内容区屏幕坐标（index 注入 `mainWindow.getContentBounds()`）。
   * 用于把会话栏贴到主窗口右缘、顶部对齐浏览器视图；缺省/返回 null 时贴屏幕右缘。
   */
  getMainWindowContentBounds?: () => AgentWindowRect | null;
  /** 测试注入：屏幕信息（缺省惰性 require electron.screen）。 */
  screen?: AgentWindowScreenLike;
  /** 测试注入：定时器（缺省全局 setInterval/clearInterval；测试用手动 scheduler 驱动动画）。 */
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** 用户/系统关闭窗口时的直接回调（可选；也可用 manager.onClosed 订阅，二者都会触发）。 */
  onClosed?: () => void;
  /** 异步加载失败（loadURL 的 Promise reject）时的通知（可选；失败会自动关闭窗口）。 */
  onLoadFailed?: (message: string) => void;
  /** 测试注入：窗口工厂（缺省惰性 require electron.BrowserWindow）。 */
  createWindow?: AgentWindowFactory;
  /** 覆盖默认标题/底色/尺寸（一般不用传）。 */
  title?: string;
  backgroundColor?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}

export interface AgentWindowManager {
  /**
   * 打开（或聚焦）会话栏独立窗口。单实例：已有窗口时只 focus（不重建、不换会话）。
   * 同步错误（创建/loadURL 同步抛错）通过返回值报告；异步加载失败会关闭窗口并走 onLoadFailed。
   */
  open(sessionId?: string): AgentWindowOpenResult;
  /**
   * 关闭窗口（程序性关闭：播放滑出动画，窗口真正销毁后才触发 onClosed/推 chrome:agentWindowClosed）。
   * 默认播 160ms 滑出动画后销毁；animate:false 立即关闭（应用退出/主窗口销毁场景，同样在销毁后触发关闭通知）。
   * 调用瞬间 isOpen() 即变为 false（不再接受最小化等操作）。
   */
  close(options?: AgentWindowCloseOptions): void;
  isOpen(): boolean;
  /** 聚焦已有窗口（若最小化先还原）；无窗口时返回 false。 */
  focus(): boolean;
  /** 最小化（自绘标题栏的最小化按钮）。无窗口/最小化失败返回 false。 */
  minimize(): boolean;
  /**
   * 主窗口移动/缩放后重新贴回其右缘（无动画，跟随应与主窗口拖拽同帧）。
   * 无窗口/正在关闭/已最小化时返回 false（最小化窗口不抢位置，用户从任务栏还原时保持原处）。
   */
  reposition(): boolean;
  /** 当前窗口 webContents id（域层做「仅 Agent 窗口可最小化自己」的发送者校验）；无窗口返回 null。 */
  webContentsId(): number | null;
  /**
   * 订阅「窗口真正销毁」事件（点击 X、任务栏关闭、系统销毁、程序性 close 滑出动画结束……）。
   * 返回取消订阅函数。domain 用它 push chrome:agentWindowClosed 给主窗口渲染层：
   * 通知时机必须晚于滑出动画，否则主窗口侧栏会在窗口还盖在右侧时提前展开（动画反逻辑）。
   * 注意 dispose() 不触发。
   */
  onClosed(listener: () => void): () => void;
  /** 应用退出时调用：立即关闭窗口（不播动画、不触发关闭事件）、清空订阅。 */
  dispose(): void;
}

/**
 * 创建 Agent 窗口管理器（单实例）。
 * 生命周期：
 *   · open：无窗口 → 在目标位置右侧 24px 外隐藏创建 → ready-to-show 后 show 并 200ms 滑入；
 *           已有 → focus（最小化先 restore）；
 *   · 用户/系统关闭 → 清引用 → onClosed 订阅者 + deps.onClosed 各触发一次（事件推送由此驱动）；
 *   · close()/dispose()：程序性关闭；close 在窗口真正销毁后（滑出动画结束/立即关闭）触发一次关闭通知，
 *     dispose 不触发（应用正在退出，没有渲染层可通知）；
 *   · reposition：主窗口移动/缩放后把窗口重新贴回右缘（不播动画）；
 *   · loadURL 同步失败 → 关闭并返回 {ok:false,error}；异步失败 → 关闭并通过 onLoadFailed 通知。
 */
export function createAgentWindowManager(deps: AgentWindowManagerDeps): AgentWindowManager {
  const width = deps.width ?? AGENT_WINDOW_DEFAULT_WIDTH;
  const height = deps.height ?? AGENT_WINDOW_DEFAULT_HEIGHT;
  const minWidth = deps.minWidth ?? AGENT_WINDOW_MIN_WIDTH;
  const minHeight = deps.minHeight ?? AGENT_WINDOW_MIN_HEIGHT;
  const title = deps.title ?? AGENT_WINDOW_TITLE;
  const backgroundColor = deps.backgroundColor ?? AGENT_WINDOW_BACKGROUND;

  let win: AgentWindowLike | null = null;
  /** 程序性关闭的窗口引用：其 "closed" 事件不视为用户关闭。 */
  let expectedClose: AgentWindowLike | null = null;
  /** 正在播滑出动画、等待 destroy 的窗口（close 后已从 win 摘除）。 */
  let closingWindow: AgentWindowLike | null = null;
  let disposed = false;
  const closedListeners = new Set<() => void>();

  /** 当前动画的 interval 句柄（同一时刻至多一个）。 */
  let animationHandle: unknown = null;
  /** 最近一次目标 bounds 与工作区（关闭动画从当前位置滑出时用）。 */
  let targetBounds: AgentWindowRect = { x: 0, y: 0, width, height };
  let workArea: AgentWindowRect = DEFAULT_WORK_AREA;
  let lastBounds: AgentWindowRect = { x: 0, y: 0, width, height };
  let lastOpacity = 1;

  const setIntervalImpl =
    deps.setIntervalFn ?? ((callback: () => void, ms: number): unknown => setInterval(callback, ms));
  const clearIntervalImpl =
    deps.clearIntervalFn ??
    ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));

  /**
   * 窗口「真正销毁」通知：用户关闭与程序性 close 共用（且只触发一次）。
   * 不在这里处理 dispose —— 应用退出时主窗口正在销毁，推送没有意义。
   */
  const notifyClosed = (): void => {
    for (const listener of [...closedListeners]) {
      try {
        listener();
      } catch {
        // 单个订阅者异常不影响其它订阅者/不阻断窗口关闭流程
      }
    }
    try {
      deps.onClosed?.();
    } catch {
      // 同上
    }
  };

  function currentWindow(): AgentWindowLike | null {
    const current = win;
    if (!current) return null;
    try {
      if (current.isDestroyed()) {
        win = null;
        return null;
      }
    } catch {
      win = null;
      return null;
    }
    return current;
  }

  /* ── 几何：主窗口内容区 + 屏幕工作区 ── */

  function contentBounds(): AgentWindowRect | null {
    try {
      const bounds = deps.getMainWindowContentBounds?.() ?? null;
      if (
        bounds &&
        Number.isFinite(bounds.x) &&
        Number.isFinite(bounds.y) &&
        Number.isFinite(bounds.width) &&
        Number.isFinite(bounds.height)
      ) {
        return bounds;
      }
      return null;
    } catch {
      return null;
    }
  }

  function resolveScreen(): AgentWindowScreenLike | null {
    if (deps.screen) return deps.screen;
    // 注入 createWindow = 测试环境：不触达真实 electron（否则单测会加载到 electron 的二进制路径模块）
    if (deps.createWindow) return null;
    try {
      return loadElectronRuntime().screen ?? null;
    } catch {
      return null;
    }
  }

  function resolveWorkArea(): AgentWindowRect {
    const content = contentBounds();
    try {
      const screen = resolveScreen();
      if (screen) {
        const display = content ? screen.getDisplayMatching(content) : screen.getPrimaryDisplay();
        if (display?.workArea && Number.isFinite(display.workArea.width)) return display.workArea;
      }
    } catch {
      // 屏幕信息不可用（无显示环境/多显示器切换中）：退回兜底工作区
    }
    return DEFAULT_WORK_AREA;
  }

  /* ── 动画 ── */

  function stopAnimation(): void {
    if (animationHandle !== null) {
      try {
        clearIntervalImpl(animationHandle);
      } catch {
        // 句柄已失效：忽略
      }
      animationHandle = null;
    }
  }

  /** 动画帧驱动：帧数 = ceil(duration/tick)，最后一帧精确落在 1。 */
  function runAnimation(durationMs: number, onFrame: (progress: number) => void, onDone: () => void): void {
    stopAnimation();
    const totalFrames = Math.max(1, Math.ceil(durationMs / AGENT_WINDOW_ANIMATION_TICK_MS));
    let frame = 0;
    animationHandle = setIntervalImpl(() => {
      frame += 1;
      const linear = Math.min(1, frame / totalFrames);
      onFrame(easeCubicBezier(linear));
      if (linear >= 1) {
        stopAnimation();
        onDone();
      }
    }, AGENT_WINDOW_ANIMATION_TICK_MS);
  }

  function applyBounds(target: AgentWindowLike, bounds: AgentWindowRect): void {
    try {
      target.setBounds?.({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    } catch {
      // 窗口已销毁/平台不支持：动画降级为直接切换
    }
  }

  function applyOpacity(target: AgentWindowLike, opacity: number): void {
    try {
      target.setOpacity?.(Math.max(0, Math.min(1, opacity)));
    } catch {
      // 透明度不可用（部分 Linux 窗口管理器/已销毁）：忽略
    }
  }

  function safeBounds(target: AgentWindowLike): AgentWindowRect | null {
    try {
      const bounds = target.getBounds?.() ?? null;
      if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.width)) return bounds;
    } catch {
      // 窗口已销毁
    }
    return null;
  }

  /** 立即销毁滑出动画中的窗口（被新的 open/close/dispose 打断时调用，避免泄漏）。 */
  function finalizeClosing(): void {
    const current = closingWindow;
    closingWindow = null;
    if (!current) return;
    try {
      if (current.isDestroyed()) return;
      if (current.destroy) current.destroy();
      else current.close();
    } catch {
      // 系统已销毁：忽略
    }
  }

  /** 程序性关闭：先摘引用，避免 "closed" 回调把它当用户关闭；不触发事件。 */
  function closeProgrammatic(): void {
    const current = win;
    win = null;
    if (!current) return;
    expectedClose = current;
    try {
      if (!current.isDestroyed()) current.close();
    } catch {
      // 窗口可能已被系统销毁：忽略
    }
  }

  function focus(): boolean {
    const current = currentWindow();
    if (!current) return false;
    try {
      // 最小化状态下 focus 不会还原窗口 → 先 restore（Electron/Windows 行为）
      if (current.isMinimized?.()) current.restore?.();
      current.focus();
      return true;
    } catch {
      return false;
    }
  }

  function minimize(): boolean {
    const current = currentWindow();
    if (!current) return false;
    try {
      current.minimize?.();
      return true;
    } catch {
      return false;
    }
  }

  function open(sessionId?: string): AgentWindowOpenResult {
    if (disposed) return { ok: false, error: "Agent 窗口管理器已销毁" };
    const existing = currentWindow();
    if (existing) {
      // 单实例：重复 open 只聚焦（保留用户已在窗口里拖过的位置/尺寸）
      focus();
      return { ok: true };
    }
    // 上一次关闭动画还没播完就重新打开：先销毁旧窗口，避免两个实例/定时器互抢
    stopAnimation();
    finalizeClosing();

    try {
      const createWindow: AgentWindowFactory =
        deps.createWindow ??
        ((options: AgentWindowOptions) => new (loadElectronRuntime().BrowserWindow)(options));

      const content = contentBounds();
      workArea = resolveWorkArea();
      targetBounds = computeAgentWindowBounds(content, workArea, { width, height });
      lastBounds = { ...targetBounds };
      lastOpacity = 1;

      const created = createWindow({
        // 首帧就落在滑入起点（目标右移 24px）+ 全透明，避免窗口先在目标位闪一下再跳回起点。
        x: targetBounds.x + AGENT_WINDOW_SLIDE_OFFSET,
        y: targetBounds.y,
        width: targetBounds.width,
        height: targetBounds.height,
        minWidth,
        minHeight,
        // 无系统边框、自绘标题栏（用户要求）；保留缩放/最小化/圆角
        frame: false,
        titleBarStyle: "hidden",
        roundedCorners: true,
        show: false,
        resizable: true,
        maximizable: true,
        skipTaskbar: false,
        title,
        autoHideMenuBar: true,
        backgroundColor,
        webPreferences: {
          preload: deps.preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          ...(deps.additionalArguments ? { additionalArguments: deps.additionalArguments } : {}),
          devTools: false,
        },
      });

      win = created;
      expectedClose = null;

      created.on("ready-to-show", () => {
        if (win !== created) return;
        // 先落在目标右侧 24px 外、全透明，再 show 并滑入（看起来像从主窗口右缘推出来）
        const startX = targetBounds.x + AGENT_WINDOW_SLIDE_OFFSET;
        const startBounds: AgentWindowRect = { ...targetBounds, x: startX };
        applyBounds(created, startBounds);
        applyOpacity(created, 0);
        try {
          created.show();
        } catch {
          closeProgrammatic();
          return;
        }
        lastBounds = startBounds;
        lastOpacity = 0;
        runAnimation(
          AGENT_WINDOW_SLIDE_IN_MS,
          (progress) => {
            if (win !== created) return;
            const x = Math.round(startX + (targetBounds.x - startX) * progress);
            lastBounds = { ...targetBounds, x };
            lastOpacity = progress;
            applyBounds(created, lastBounds);
            applyOpacity(created, progress);
          },
          () => {
            if (win !== created) return;
            lastBounds = { ...targetBounds };
            lastOpacity = 1;
            applyBounds(created, targetBounds);
            applyOpacity(created, 1);
          },
        );
      });

      // 用户/系统关闭（点 X、任务栏关闭、系统销毁）：清引用并通知订阅者/装配层
      created.on("closed", () => {
        const wasProgrammatic = expectedClose === created;
        if (expectedClose === created) expectedClose = null;
        // 只有「当前被跟踪的窗口」的首次 closed 才算数：程序性关闭已先摘引用（wasTracked=false）；
        // 重复的 closed 事件（防御真实 Electron 的边界行为）也不会重复通知。
        const wasTracked = win === created;
        if (wasTracked) {
          win = null;
          stopAnimation();
        }
        if (wasTracked && !wasProgrammatic) notifyClosed();
      });

      let loading: Promise<void> | void;
      try {
        loading = created.loadURL(deps.loadUrlFor(sessionId));
      } catch (err) {
        closeProgrammatic();
        return { ok: false, error: `Agent 窗口加载失败：${err instanceof Error ? err.message : String(err)}` };
      }
      if (loading && typeof (loading as Promise<void>).catch === "function") {
        void (loading as Promise<void>).catch((err: unknown) => {
          // 异步加载失败：窗口没有可用内容 → 关闭（不伪造"用户关闭"事件）
          if (win === created) closeProgrammatic();
          try {
            deps.onLoadFailed?.(err instanceof Error ? err.message : String(err));
          } catch {
            // 通知失败不影响清理
          }
        });
      }

      return { ok: true };
    } catch (err) {
      // 创建窗口本身失败（如无显示环境/参数非法）：清理并返回可读错误
      win = null;
      return { ok: false, error: `打开 Agent 窗口失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  function close(options?: AgentWindowCloseOptions): void {
    const current = currentWindow();
    if (!current) return;
    const animate = options?.animate !== false;
    stopAnimation();
    finalizeClosing();
    // 立即摘引用：关闭动画期间 isOpen=false（不再接受最小化/聚焦），重复 close 也幂等
    win = null;
    expectedClose = current;

    if (!animate) {
      try {
        if (!current.isDestroyed()) current.close();
      } catch {
        // 窗口可能已被系统销毁：忽略
      }
      // 立即关闭也要在窗口销毁后通知一次：主窗口侧栏不能因为「应用正在关窗」而永远隐藏
      notifyClosed();
      return;
    }

    const bounds = safeBounds(current) ?? lastBounds;
    const endX = workArea.x + workArea.width;
    const startX = bounds.x;
    const fromOpacity = lastOpacity;
    closingWindow = current;
    runAnimation(
      AGENT_WINDOW_SLIDE_OUT_MS,
      (progress) => {
        const x = Math.round(startX + (endX - startX) * progress);
        applyBounds(current, { ...bounds, x });
        applyOpacity(current, fromOpacity * (1 - progress));
      },
      () => {
        finalizeClosing();
        // 滑出动画结束后才通知：主窗口侧栏此刻才展开，不会与仍在右侧的窗口打架
        notifyClosed();
      },
    );
  }

  function isOpen(): boolean {
    return currentWindow() !== null;
  }

  function reposition(): boolean {
    const current = currentWindow();
    if (!current || closingWindow) return false;
    try {
      // 最小化窗口不抢位置：用户从任务栏还原时保持它原来的位置（Windows 习惯）
      if (current.isMinimized?.()) return false;
    } catch {
      return false;
    }
    workArea = resolveWorkArea();
    const next = computeAgentWindowBounds(contentBounds(), workArea, { width, height });
    // 主窗口正在拖动/缩放：位置跟随必须同帧完成，不能与滑入/滑出动画抢坐标
    stopAnimation();
    targetBounds = { ...next };
    lastBounds = { ...next };
    lastOpacity = 1;
    applyBounds(current, next);
    applyOpacity(current, 1);
    return true;
  }

  function webContentsId(): number | null {
    const current = currentWindow();
    const id = current?.webContents?.id;
    return typeof id === "number" ? id : null;
  }

  function onClosed(listener: () => void): () => void {
    closedListeners.add(listener);
    return () => {
      closedListeners.delete(listener);
    };
  }

  function dispose(): void {
    disposed = true;
    stopAnimation();
    finalizeClosing();
    closeProgrammatic();
    closedListeners.clear();
  }

  return { open, close, isOpen, focus, minimize, reposition, webContentsId, onClosed, dispose };
}
