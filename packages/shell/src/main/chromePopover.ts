/**
 * 浏览器工具栏浮层（more / bookmarks / history / downloads）：**独立子 BrowserWindow** 渲染。
 *
 * 为什么不用「主窗口内 DOM 浮层 + 隐藏 WebContentsView」：
 *   主窗口里的浮层和原生 WebContentsView 不在同一个合成层，菜单会被网页盖住；而「打开菜单时隐藏网页」
 *   又会导致网页闪一下甚至整页消失（用户反馈的两个问题同源）。独立子窗口是 Electron 里唯一稳定的解法：
 *   子窗口天然绘制在父窗口所有内容（含 WebContentsView）之上，且完全不碰网页视图的生命周期。
 *
 * 本文件只负责主进程侧：窗口创建/定位/生命周期/悬浮自动关闭。渲染内容由 UI 的 PopoverApp 提供
 * （index.html?popover=<kind>&lang=<lang>）。几何计算抽成纯函数 computePopoverBounds 便于单测。
 *
 * 测试友好：不静态 import electron —— 所有 Electron 原语（BrowserWindow/screen）都走 deps 注入或
 * 惰性 require（仅真实运行且未注入时才会加载），因此单测可以在纯 Node 下跑完整生命周期。
 */
import { createRequire } from "node:module";

/* ────────────────────────── 几何：边缘翻转 + 夹取 ────────────────────────── */

/** 屏幕/窗口矩形（Electron 的 Rectangle 结构兼容；统一用 DIP）。 */
export interface PopoverRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopoverPoint {
  x: number;
  y: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

/** 浮层种类（与契约 PopoverKindSchema 保持一致）。 */
export type ChromePopoverKind = "more" | "bookmarks" | "history" | "downloads" | "workspaces";

export const CHROME_POPOVER_KINDS: readonly ChromePopoverKind[] = ["more", "bookmarks", "history", "downloads", "workspaces"];

/** 浮层与锚点之间的默认间距。 */
export const DEFAULT_POPOVER_GAP = 6;
/** hover 轮询间隔：菜单打开期间检测鼠标是否已经离开（hover flyout 语义）。 */
export const POPOVER_HOVER_POLL_MS = 120;
/** 光标在浮层 bounds 外扩多少像素内仍算「在浮层上」。 */
export const POPOVER_BOUNDS_PADDING = 8;
/** 光标在锚点矩形外扩多少像素内仍算「在锚点上」（点击后移开一点点不应立刻关）。 */
export const POPOVER_ANCHOR_PADDING = 24;

/** 各浮层的默认窗口尺寸（UI 可经 sizeFor 覆盖；窗口尺寸应与菜单内容一致，避免大片透明可点区）。 */
export const DEFAULT_POPOVER_SIZES: Record<ChromePopoverKind, PopoverSize> = {
  more: { width: 300, height: 400 },
  bookmarks: { width: 340, height: 440 },
  history: { width: 340, height: 460 },
  downloads: { width: 360, height: 440 },
  workspaces: { width: 230, height: 300 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 计算浮层窗口的屏幕坐标（DIP）：
 *   · 默认：锚点**下方**、与锚点**右对齐**（工具栏按钮通常靠右）；
 *   · 下方放不下 → 翻转到锚点**上方**；
 *   · 最后对 x/y 做夹取（clamp），并把尺寸限制在工作区内 —— **四边都不越界、不截断**；
 *   · 若请求尺寸大于工作区，窗口尺寸收缩到工作区（内容由渲染层滚动，绝不把窗口推出屏幕）。
 *
 * @param anchorScreenRect 锚点屏幕矩形（主窗口内容区坐标 + getContentBounds 偏移后的屏幕坐标）
 * @param size 期望窗口尺寸
 * @param workArea 所在显示器的工作区（Electron screen.getDisplayMatching(anchor).workArea）
 * @param gap 锚点与浮层间距，默认 6px
 */
export function computePopoverBounds(
  anchorScreenRect: PopoverRect,
  size: PopoverSize,
  workArea: PopoverRect,
  gap: number = DEFAULT_POPOVER_GAP,
): PopoverRect {
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : DEFAULT_POPOVER_GAP;
  const workWidth = Math.max(1, Math.round(workArea.width));
  const workHeight = Math.max(1, Math.round(workArea.height));
  const width = Math.max(1, Math.min(Math.round(size.width), workWidth));
  const height = Math.max(1, Math.min(Math.round(size.height), workHeight));

  // 默认下方 + 右对齐
  let x = anchorScreenRect.x + anchorScreenRect.width - width;
  let y = anchorScreenRect.y + anchorScreenRect.height + safeGap;

  // 下方放不下 → 翻转到上方（翻转后仍可能越界，交给下面的夹取兜底）
  if (y + height > workArea.y + workHeight) {
    y = anchorScreenRect.y - safeGap - height;
  }

  x = clamp(x, workArea.x, workArea.x + workWidth - width);
  y = clamp(y, workArea.y, workArea.y + workHeight - height);

  return { x: Math.round(x), y: Math.round(y), width, height };
}

/** 点是否落在矩形内（可外扩 padding）；用于 hover 自动关闭判定，导出便于单测。 */
export function isPointWithin(rect: PopoverRect, point: PopoverPoint, padding = 0): boolean {
  const pad = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  return (
    point.x >= rect.x - pad &&
    point.x <= rect.x + rect.width + pad &&
    point.y >= rect.y - pad &&
    point.y <= rect.y + rect.height + pad
  );
}

/* ────────────────────────── Electron 原语的最小结构类型 ────────────────────────── */

/** 主窗口最小接口（真实 BrowserWindow 结构兼容；测试用假对象）。 */
export interface PopoverMainWindowLike {
  getContentBounds(): PopoverRect;
  isDestroyed?(): boolean;
  /** 主窗口是否获得焦点（用于「点回主窗口不立即关浮层」的判定）。 */
  isFocused?(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** 浮层窗口 webContents 最小接口（只用到 Esc 监听与 id）。 */
export interface PopoverWebContentsLike {
  id?: number;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** 浮层窗口最小接口（真实 BrowserWindow 结构兼容）。 */
export interface PopoverWindowLike {
  loadURL(url: string): Promise<void> | void;
  show(): void;
  hide?(): void;
  close(): void;
  destroy?(): void;
  isDestroyed(): boolean;
  isVisible?(): boolean;
  isFocused(): boolean;
  getBounds(): PopoverRect;
  setBounds?(bounds: PopoverRect): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners?(): unknown;
  webContents?: PopoverWebContentsLike;
}

/** 创建浮层窗口的构造参数（只列本模块真正设置的字段）。 */
export interface PopoverWindowOptions {
  parent?: PopoverMainWindowLike;
  x: number;
  y: number;
  width: number;
  height: number;
  frame: boolean;
  transparent: boolean;
  resizable: boolean;
  movable: boolean;
  skipTaskbar: boolean;
  show: boolean;
  hasShadow?: boolean;
  backgroundColor?: string;
  focusable?: boolean;
  minimizable?: boolean;
  maximizable?: boolean;
  fullscreenable?: boolean;
  webPreferences: {
    preload: string;
    sandbox: boolean;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    additionalArguments?: string[];
    devTools?: boolean;
  };
}

export type PopoverBrowserWindowCtor = new (options: PopoverWindowOptions) => PopoverWindowLike;

/** 创建浮层窗口的工厂（装配层用 `(options) => new BrowserWindow(...)`；测试用假窗口）。 */
export type PopoverWindowFactory = (options: PopoverWindowOptions) => PopoverWindowLike;

/** 屏幕最小接口（真实 Electron screen 结构兼容）。 */
export interface PopoverScreenLike {
  getCursorScreenPoint(): PopoverPoint;
  getDisplayMatching(rect: PopoverRect): { workArea: PopoverRect };
}

/** 惰性 require 的 electron 运行时形状。 */
export interface PopoverElectronRuntime {
  BrowserWindow: PopoverBrowserWindowCtor;
  screen: PopoverScreenLike;
}

let cachedElectronRuntime: PopoverElectronRuntime | null = null;

/**
 * 惰性加载 electron（不静态 import：单测在纯 Node 下 import 本模块不会失败）。
 * 真实运行在 Electron 主进程里，require("electron") 返回 BrowserWindow/screen。
 */
function loadElectronRuntime(): PopoverElectronRuntime {
  if (cachedElectronRuntime) return cachedElectronRuntime;
  const requireFromHere = createRequire(import.meta.url);
  cachedElectronRuntime = requireFromHere("electron") as PopoverElectronRuntime;
  return cachedElectronRuntime;
}

/* ────────────────────────── 管理器 ────────────────────────── */

/** open() 入参（锚点为主窗口内容区 CSS px，主进程换算屏幕坐标）。 */
export interface ChromePopoverOpenInput {
  kind: ChromePopoverKind;
  anchor: PopoverRect;
  lang?: string;
}

/** 浮层内动作（由主进程转发给主窗口渲染层执行）。 */
export interface ChromePopoverActionInput {
  action: string;
  payload?: unknown;
}

export interface ChromePopoverOpenResult {
  ok: boolean;
  error?: string;
}

export interface ChromePopoverManagerDeps {
  /** 主窗口（parent）；返回 null 时 open 失败而不是崩。 */
  getMainWindow: () => PopoverMainWindowLike | null;
  /** 浮层要加载的 URL（含 ?popover=<kind>&lang=；开发/生产 URL 差异由装配层决定）。 */
  loadUrlFor: (kind: ChromePopoverKind, lang?: string) => string;
  /** preload 路径（与主窗口同一个 CJS preload）。 */
  preloadPath: string;
  /** preload additionalArguments（必须带上 --loopsoar-bindings/--loopsoar-events，否则浮层拿不到 api）。 */
  additionalArguments?: string[];
  /** 浮层动作回调（缺省由 domain 层转发；两条路径不重复触发）。 */
  onAction?: (payload: ChromePopoverActionInput) => void;
  /**
   * 浮层被关闭（任何路径：Esc / 失焦 / hover 离开 / 切 kind / 动作后）时回调。
   * 渲染层据此同步「当前打开的浮层」状态，实现「已展开时点击一次即收起」而不闪烁。
   */
  onClosed?: () => void;
  /** 窗口背景（transparent 下的兜底色，默认全透明）。 */
  backgroundColor?: string;
  /** 尺寸策略（默认 DEFAULT_POPOVER_SIZES）。 */
  sizeFor?: (kind: ChromePopoverKind) => PopoverSize;
  /** 测试注入：窗口工厂（缺省惰性 require electron.BrowserWindow）。 */
  createWindow?: PopoverWindowFactory;
  /** 测试注入：屏幕信息（缺省惰性 require electron.screen）。 */
  screen?: PopoverScreenLike;
  /** hover 轮询间隔（默认 120ms；测试可调小）。 */
  hoverPollMs?: number;
  /** 测试注入：定时器。 */
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface ChromePopoverManager {
  /** 打开（或切换）浮层；同一时刻只保留一个。 */
  open(input: ChromePopoverOpenInput): ChromePopoverOpenResult;
  /** 关闭当前浮层（幂等）。 */
  close(): void;
  /** 浮层内动作：交给 onAction 并关闭浮层。 */
  handleAction(payload: ChromePopoverActionInput): void;
  isOpen(): boolean;
  /** 应用退出时调用：关闭浮层并解绑主窗口监听。 */
  dispose(): void;
}

/**
 * 创建浮层管理器。
 * 生命周期要点：主窗口 resize/move/close、浮层 blur、Esc（webContents before-input-event）都会关闭浮层；
 * open 期间 120ms 轮询光标，鼠标同时离开「浮层外扩 8px」与「锚点外扩 24px」且浮层未聚焦时自动关闭。
 */
export function createChromePopoverManager(deps: ChromePopoverManagerDeps): ChromePopoverManager {
  const hoverPollMs = deps.hoverPollMs ?? POPOVER_HOVER_POLL_MS;
  const sizeFor = deps.sizeFor ?? ((kind: ChromePopoverKind): PopoverSize => DEFAULT_POPOVER_SIZES[kind]);
  const setIntervalFn = deps.setIntervalFn ?? ((callback: () => void, ms: number): unknown => setInterval(callback, ms));
  const clearIntervalFn =
    deps.clearIntervalFn ?? ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));

  let popover: PopoverWindowLike | null = null;
  /** 当前浮层对应的锚点屏幕矩形（hover 判定用）。 */
  let anchorScreen: PopoverRect | null = null;
  let pollHandle: unknown = null;
  let mainWindow: PopoverMainWindowLike | null = null;
  let mainListeners: { event: string; listener: (...args: unknown[]) => void }[] = [];
  let disposed = false;

  function stopPolling(): void {
    if (pollHandle !== null) {
      clearIntervalFn(pollHandle);
      pollHandle = null;
    }
  }

  function detachMainListeners(): void {
    const win = mainWindow;
    mainWindow = null;
    if (!win) {
      mainListeners = [];
      return;
    }
    for (const { event, listener } of mainListeners) {
      try {
        win.removeListener?.(event, listener);
      } catch {
        // 主窗口已销毁时 removeListener 可能抛：忽略
      }
    }
    mainListeners = [];
  }

  function attachMainListeners(win: PopoverMainWindowLike): void {
    detachMainListeners();
    mainWindow = win;
    // 主窗口一动（缩放/移动）或要关闭 → 浮层立即关闭，避免子窗口悬空或跟随错位
    const listener = (): void => close();
    for (const event of ["resize", "move", "close", "closed"]) {
      win.on(event, listener);
      mainListeners.push({ event, listener });
    }
  }

  function close(): void {
    stopPolling();
    const win = popover;
    popover = null;
    anchorScreen = null;
    if (win) {
      try {
        win.removeAllListeners?.();
      } catch {
        // 忽略解绑失败
      }
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        // 窗口可能已被系统销毁：忽略
      }
      // 通知渲染层「浮层已关闭」，用于「再次点击即收起」的状态同步（避免切 kind 时误判）
      try {
        deps.onClosed?.();
      } catch {
        // 回调异常不影响关闭（渲染层正在销毁等）
      }
    }
    detachMainListeners();
  }

  function startPolling(screenApi: PopoverScreenLike): void {
    stopPolling();
    pollHandle = setIntervalFn(() => {
      const win = popover;
      if (!win) {
        stopPolling();
        return;
      }
      try {
        if (win.isDestroyed()) {
          close();
          return;
        }
        // 浮层获得焦点（用户正在菜单里操作/键盘导航）时不做 hover 关闭
        if (win.isFocused()) return;
        const cursor = screenApi.getCursorScreenPoint();
        if (isPointWithin(win.getBounds(), cursor, POPOVER_BOUNDS_PADDING)) return;
        if (anchorScreen && isPointWithin(anchorScreen, cursor, POPOVER_ANCHOR_PADDING)) return;
        close();
      } catch {
        close();
      }
    }, hoverPollMs);
  }

  function open(input: ChromePopoverOpenInput): ChromePopoverOpenResult {
    if (disposed) return { ok: false, error: "浮层管理器已销毁" };
    if (!CHROME_POPOVER_KINDS.includes(input.kind)) {
      return { ok: false, error: `未知浮层类型：${String(input.kind)}` };
    }
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed?.()) {
      return { ok: false, error: "主窗口未就绪，无法打开工具栏浮层" };
    }

    // 同一时刻只保留一个浮层（切换 kind 时先关旧的）
    close();

    try {
      const runtime = deps.createWindow && deps.screen ? null : loadElectronRuntime();
      const BrowserWindowCtor = (runtime as PopoverElectronRuntime | null)?.BrowserWindow;
      const createWindow: PopoverWindowFactory =
        deps.createWindow ??
        ((options: PopoverWindowOptions) => {
          if (!BrowserWindowCtor) throw new Error("缺少 BrowserWindow（Electron 未就绪）");
          return new BrowserWindowCtor(options);
        });
      const screenApi = deps.screen ?? runtime?.screen;
      if (!screenApi) throw new Error("缺少 screen（Electron 未就绪）");

      // 渲染层给的是「主窗口内容区 CSS px」：换算成屏幕坐标（Electron 全程 DIP；窗口缩放需为 1）
      const content = main.getContentBounds();
      const anchorRect: PopoverRect = {
        x: Math.round(content.x + input.anchor.x),
        y: Math.round(content.y + input.anchor.y),
        width: Math.max(1, Math.round(input.anchor.width)),
        height: Math.max(1, Math.round(input.anchor.height)),
      };
      const workArea = screenApi.getDisplayMatching(anchorRect).workArea;
      const bounds = computePopoverBounds(anchorRect, sizeFor(input.kind), workArea, DEFAULT_POPOVER_GAP);

      const win = createWindow({
        parent: main,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        show: false,
        hasShadow: false,
        backgroundColor: deps.backgroundColor ?? "#00000000",
        focusable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
          preload: deps.preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          ...(deps.additionalArguments ? { additionalArguments: deps.additionalArguments } : {}),
          devTools: false,
        },
      });

      popover = win;
      anchorScreen = anchorRect;

      win.on("ready-to-show", () => {
        if (popover !== win) return;
        try {
          win.show();
        } catch {
          close();
          return;
        }
        startPolling(screenApi);
      });
      // 浮层失焦 → 关闭；但用户点回主窗口时先不关（让 click 的 toggle 正确收起，
      // 也避免 pointerdown 先关、click 再开导致「再次点击重复展开」）；离开菜单/锚点的点击由 hover 轮询兜底关闭。
      win.on("blur", () => {
        if (popover !== win) return;
        const main = deps.getMainWindow();
        if (main && !main.isDestroyed?.() && main.isFocused?.()) return;
        close();
      });
      win.on("closed", () => {
        if (popover === win) close();
      });
      // Esc：渲染层通常自己调 closePopover，这里再加一道主进程兜底（不依赖渲染层是否处理）
      win.webContents?.on?.("before-input-event", (...args: unknown[]) => {
        const inputEvent = args[1] as { key?: string; type?: string } | undefined;
        if (popover === win && (inputEvent?.key === "Escape" || inputEvent?.key === "Esc")) close();
      });

      attachMainListeners(main);

      try {
        const loading = win.loadURL(deps.loadUrlFor(input.kind, input.lang));
        if (loading && typeof (loading as Promise<void>).catch === "function") {
          void (loading as Promise<void>).catch(() => {
            if (popover === win) close();
          });
        }
      } catch {
        if (popover === win) close();
        return { ok: false, error: "浮层页面加载失败" };
      }

      return { ok: true };
    } catch (err) {
      close();
      return { ok: false, error: `打开浮层失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  function handleAction(payload: ChromePopoverActionInput): void {
    try {
      deps.onAction?.(payload);
    } finally {
      close();
    }
  }

  function dispose(): void {
    disposed = true;
    close();
  }

  return {
    open,
    close,
    handleAction,
    isOpen: () => popover !== null,
    dispose,
  };
}
