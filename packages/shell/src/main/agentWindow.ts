/**
 * Agent 会话栏「独立窗口」：真正的系统窗口（带边框、可拖动/缩放/最小化），不是应用内浮动卡片。
 *
 * 背景：用户明确要求「像 slime 的浮窗一样真正独立」——
 *   · 应用内 DOM 浮层/侧栏会被原生 WebContentsView 盖住或需要隐藏网页（上一轮已证明体验不可接受）；
 *   · 独立 BrowserWindow 由窗口管理器参与（拖动/缩放/最小化/贴边/多显示器都天然可用），
 *     主窗口把会话栏隐藏、网页铺满，两窗口共享同一套 IPC 契约与会话数据。
 *
 * 与 chromePopover 的差异（刻意区分，不要合并）：
 *   · 浮层是 parent 子窗口、置顶、hover 消失；本窗口是**无 parent 的顶层窗口**，可常驻、可最小化；
 *   · 本窗口有系统边框（frame:true）与任务栏图标（skipTaskbar:false），用户可像普通应用窗口一样管理；
 *   · 单实例：重复 open 只聚焦已有窗口（不重建、不重载会话），避免多份状态互相打架。
 *
 * 测试友好：不静态 import electron —— Electron 原语走 deps 注入或惰性 require（仅真实运行且未注入时加载），
 * 因此单测可在纯 Node 下跑完整生命周期（创建参数/单实例/closed 回调/失败清理）。
 */
import { createRequire } from "node:module";

/* ────────────────────────── 默认窗口参数 ────────────────────────── */

/** 默认窗口尺寸（窄长条，贴屏幕右侧当会话栏用）。 */
export const AGENT_WINDOW_DEFAULT_WIDTH = 420;
export const AGENT_WINDOW_DEFAULT_HEIGHT = 720;
export const AGENT_WINDOW_MIN_WIDTH = 340;
export const AGENT_WINDOW_MIN_HEIGHT = 480;
/** 窗口标题（品牌 + 用途；多窗口任务栏里可辨识）。 */
export const AGENT_WINDOW_TITLE = "Loopsoar · Agent 对话";
/** 与主窗口一致的深色底，避免加载瞬间白闪。 */
export const AGENT_WINDOW_BACKGROUND = "#0a0c10";

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
  /** true：系统边框（可拖动/缩放/最小化）。 */
  frame: boolean;
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

/** 惰性 require 的 electron 运行时形状。 */
export interface AgentElectronRuntime {
  BrowserWindow: new (options: AgentWindowOptions) => AgentWindowLike;
}

let cachedElectronRuntime: AgentElectronRuntime | null = null;

/**
 * 惰性加载 electron（不静态 import：单测在纯 Node 下 import 本模块不会失败）。
 * 真实运行在 Electron 主进程里，require("electron") 返回 BrowserWindow。
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

export interface AgentWindowManagerDeps {
  /** 会话栏窗口要加载的 URL（通常 `${PROTOCOL}://app/index.html?agentWindow=1&sessionId=...`；由装配层决定）。 */
  loadUrlFor: (sessionId?: string) => string;
  /** preload 路径（与主窗口同一个 CJS preload）。 */
  preloadPath: string;
  /** preload additionalArguments（必须带 --loopsoar-bindings/--loopsoar-events，否则窗口里 loopsoarAPI 为空）。 */
  additionalArguments?: string[];
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
  /** 关闭窗口（程序性关闭：不触发 onClosed/不推 chrome:agentWindowClosed 事件）。 */
  close(): void;
  isOpen(): boolean;
  /** 聚焦已有窗口（若最小化先还原）；无窗口时返回 false。 */
  focus(): boolean;
  /**
   * 订阅「用户/系统关闭窗口」事件（点击 X、任务栏关闭、系统销毁…；程序性 close/dispose 不触发）。
   * 返回取消订阅函数。domain 用它 push chrome:agentWindowClosed 给主窗口渲染层。
   */
  onClosed(listener: () => void): () => void;
  /** 应用退出时调用：关闭窗口（不触发关闭事件）、清空订阅。 */
  dispose(): void;
}

/**
 * 创建 Agent 窗口管理器（单实例）。
 * 生命周期：
 *   · open：无窗口 → 创建（show:false，ready-to-show 后 show）；已有 → focus（最小化先 restore）；
 *   · 用户/系统关闭 → 清引用 → onClosed 订阅者 + deps.onClosed 各触发一次（事件推送由此驱动）；
 *   · close()/dispose()：程序性关闭，不触发关闭事件（避免主窗口 UI 自己关的时候又收到一次"已关闭"）；
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
  let disposed = false;
  const closedListeners = new Set<() => void>();

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

  function close(): void {
    closeProgrammatic();
  }

  function open(sessionId?: string): AgentWindowOpenResult {
    if (disposed) return { ok: false, error: "Agent 窗口管理器已销毁" };
    const existing = currentWindow();
    if (existing) {
      // 单实例：重复 open 只聚焦（保留用户已在窗口里拖过的位置/尺寸）
      focus();
      return { ok: true };
    }

    try {
      const createWindow: AgentWindowFactory =
        deps.createWindow ??
        ((options: AgentWindowOptions) => new (loadElectronRuntime().BrowserWindow)(options));

      const created = createWindow({
        width,
        height,
        minWidth,
        minHeight,
        // 系统边框 + 可缩放/最小化：用户要的是「真正的窗口」，不是无边框卡片
        frame: true,
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
        try {
          created.show();
        } catch {
          closeProgrammatic();
        }
      });

      // 用户/系统关闭（点 X、任务栏关闭、系统销毁）：清引用并通知订阅者/装配层
      created.on("closed", () => {
        const wasProgrammatic = expectedClose === created;
        if (expectedClose === created) expectedClose = null;
        // 只有「当前被跟踪的窗口」的首次 closed 才算数：程序性关闭已先摘引用（wasTracked=false）；
        // 重复的 closed 事件（防御真实 Electron 的边界行为）也不会重复通知。
        const wasTracked = win === created;
        if (wasTracked) win = null;
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

  function isOpen(): boolean {
    return currentWindow() !== null;
  }

  function onClosed(listener: () => void): () => void {
    closedListeners.add(listener);
    return () => {
      closedListeners.delete(listener);
    };
  }

  function dispose(): void {
    disposed = true;
    closeProgrammatic();
    closedListeners.clear();
  }

  return { open, close, isOpen, focus, onClosed, dispose };
}
