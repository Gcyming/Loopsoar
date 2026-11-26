/**
 * 浏览器工具栏浮层（独立子窗口）：
 *   ① computePopoverBounds 纯函数矩阵：默认下方右对齐 / 四边越界 / 底翻顶 / 顶部兜底 / 多显示器负坐标 / 尺寸收缩 / gap / 取整；
 *   ② 管理器生命周期：创建参数、ready-to-show、唯一实例、主窗口 resize/move/close、浮层 blur、Esc、hover 轮询、dispose；
 *   ③ 域事件转发：ui:openPopover（仅主窗口 + 参数校验）/ ui:closePopover / ui:popoverAction → chrome:popoverAction。
 *
 * 全程无真实 Electron：管理器注入假 BrowserWindow / 假 screen / 假定时器；域只依赖 trustedIpc。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CHROME_POPOVER_KINDS,
  DEFAULT_POPOVER_GAP,
  DEFAULT_POPOVER_SIZES,
  POPOVER_ANCHOR_PADDING,
  POPOVER_BOUNDS_PADDING,
  POPOVER_HOVER_POLL_MS,
  computePopoverBounds,
  intersectRect,
  createChromePopoverManager,
  isPointWithin,
  type ChromePopoverKind,
  type ChromePopoverManager,
  type ChromePopoverManagerDeps,
  type PopoverMainWindowLike,
  type PopoverRect,
  type PopoverScreenLike,
  type PopoverWindowLike,
  type PopoverWindowOptions,
} from "../../packages/shell/src/main/chromePopover.ts";
import { registerChromePopoverDomain } from "../../packages/shell/src/main/domains/chromePopover.ts";
import {
  __resetHandlerRegistryForTests,
  type TrustedIpcDeps,
} from "../../packages/shell/src/main/trustedIpc.ts";

/* ────────────────────────── 纯几何 ────────────────────────── */

const WORK = { x: 0, y: 0, width: 1920, height: 1080 };

describe("intersectRect：浮层可用区域取窗口 ∩ 显示器", () => {
  it("窗口比显示器小：结果等于窗口区域（浮层不会跑到窗口外）", () => {
    const display = { x: 0, y: 0, width: 1920, height: 1080 };
    const win = { x: 100, y: 50, width: 900, height: 700 };
    expect(intersectRect(display, win)).toEqual(win);
  });

  it("窗口跨屏：只保留显示器内的部分", () => {
    const display = { x: 0, y: 0, width: 1920, height: 1080 };
    const win = { x: 1800, y: 100, width: 600, height: 500 };
    expect(intersectRect(display, win)).toEqual({ x: 1800, y: 100, width: 120, height: 500 });
  });

  it("完全不相交时退化为 1×1（不产生负尺寸）", () => {
    const result = intersectRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 500, y: 500, width: 100, height: 100 });
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
  });
});

describe("computePopoverBounds：默认位置与四边夹取", () => {
  it("默认在锚点下方、与锚点右对齐，间距默认 6px", () => {
    const bounds = computePopoverBounds({ x: 800, y: 100, width: 40, height: 30 }, { width: 300, height: 400 }, WORK);
    expect(bounds).toEqual({ x: 800 + 40 - 300, y: 100 + 30 + DEFAULT_POPOVER_GAP, width: 300, height: 400 });
  });

  it("锚点比浮层宽时仍按右对齐（x 可小于锚点 x）", () => {
    const bounds = computePopoverBounds({ x: 100, y: 100, width: 400, height: 30 }, { width: 300, height: 400 }, WORK);
    expect(bounds.x).toBe(100 + 400 - 300);
  });

  it("右侧越界 → 左移夹取，右边缘不超出工作区", () => {
    const bounds = computePopoverBounds({ x: 1900, y: 100, width: 20, height: 30 }, { width: 300, height: 400 }, WORK);
    expect(bounds.x).toBe(WORK.width - 300);
    expect(bounds.x + bounds.width).toBe(WORK.width);
  });

  it("左侧越界 → 夹到工作区左边缘", () => {
    const bounds = computePopoverBounds({ x: 0, y: 100, width: 20, height: 30 }, { width: 300, height: 400 }, WORK);
    expect(bounds.x).toBe(WORK.x);
  });

  it("下方越界 → 翻转到锚点上方", () => {
    const anchor = { x: 800, y: 900, width: 40, height: 30 };
    const bounds = computePopoverBounds(anchor, { width: 300, height: 400 }, WORK);
    expect(bounds.y).toBe(anchor.y - DEFAULT_POPOVER_GAP - 400);
    expect(bounds.y + bounds.height).toBe(900 - DEFAULT_POPOVER_GAP);
  });

  it("翻转后顶部仍越界 → 夹到工作区上边缘（不截断）", () => {
    const work = { x: 0, y: 0, width: 1920, height: 400 };
    const bounds = computePopoverBounds({ x: 800, y: 10, width: 40, height: 30 }, { width: 300, height: 380 }, work);
    expect(bounds.y).toBe(work.y);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(work.y + work.height);
  });

  it("工作区比浮层小 → 尺寸收缩到工作区且四边不越界", () => {
    const work = { x: 0, y: 0, width: 200, height: 150 };
    const bounds = computePopoverBounds({ x: 0, y: 0, width: 20, height: 20 }, { width: 300, height: 400 }, work);
    expect(bounds).toEqual({ x: 0, y: 0, width: 200, height: 150 });
  });

  it("多显示器负坐标：夹取基于工作区绝对坐标", () => {
    const work = { x: -1920, y: 0, width: 1920, height: 1080 };
    const anchor = { x: -1000, y: 900, width: 40, height: 30 };
    const bounds = computePopoverBounds(anchor, { width: 320, height: 420 }, work);
    expect(bounds.x).toBe(anchor.x + anchor.width - 320);
    expect(bounds.y).toBe(anchor.y - DEFAULT_POPOVER_GAP - 420);
    expect(bounds.x).toBeGreaterThanOrEqual(work.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(work.x + work.width);
  });

  it("自定义 gap（含 0）", () => {
    const anchor = { x: 800, y: 100, width: 40, height: 30 };
    expect(computePopoverBounds(anchor, { width: 300, height: 400 }, WORK, 20).y).toBe(100 + 30 + 20);
    expect(computePopoverBounds(anchor, { width: 300, height: 400 }, WORK, 0).y).toBe(100 + 30);
  });

  it("坐标取整：不产生半像素窗口", () => {
    const bounds = computePopoverBounds(
      { x: 100.4, y: 100.6, width: 40.2, height: 30.4 },
      { width: 300, height: 400 },
      WORK,
    );
    expect(Number.isInteger(bounds.x)).toBe(true);
    expect(Number.isInteger(bounds.y)).toBe(true);
    expect(Number.isInteger(bounds.width)).toBe(true);
    expect(Number.isInteger(bounds.height)).toBe(true);
  });

  it("常量：四种 kind 的默认尺寸齐全，hover 常量符合约定", () => {
    for (const kind of CHROME_POPOVER_KINDS) {
      expect(DEFAULT_POPOVER_SIZES[kind].width).toBeGreaterThan(0);
      expect(DEFAULT_POPOVER_SIZES[kind].height).toBeGreaterThan(0);
    }
    expect(POPOVER_HOVER_POLL_MS).toBe(120);
    expect(POPOVER_BOUNDS_PADDING).toBe(8);
    expect(POPOVER_ANCHOR_PADDING).toBe(24);
  });
});

describe("isPointWithin：光标命中判定", () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  it("内部/边界/外部", () => {
    expect(isPointWithin(rect, { x: 150, y: 150 })).toBe(true);
    expect(isPointWithin(rect, { x: 100, y: 100 })).toBe(true);
    expect(isPointWithin(rect, { x: 300, y: 200 })).toBe(true);
    expect(isPointWithin(rect, { x: 99, y: 150 })).toBe(false);
    expect(isPointWithin(rect, { x: 150, y: 201 })).toBe(false);
  });
  it("padding 外扩（负 padding 视为 0）", () => {
    expect(isPointWithin(rect, { x: 95, y: 150 }, 8)).toBe(true);
    expect(isPointWithin(rect, { x: 91, y: 150 }, 8)).toBe(false);
    expect(isPointWithin(rect, { x: 99, y: 150 }, -10)).toBe(false);
  });
});

/* ────────────────────────── 假 Electron 原语 ────────────────────────── */

class FakeMainWindow implements PopoverMainWindowLike {
  content: PopoverRect = { x: 100, y: 50, width: 1200, height: 800 };
  destroyed = false;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  getContentBounds(): PopoverRect {
    return { ...this.content };
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakePopoverWindow implements PopoverWindowLike {
  options: PopoverWindowOptions;
  bounds: PopoverRect;
  url = "";
  shown = false;
  closed = false;
  focused = false;
  visible = false;
  loadFailure: Error | null = null;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  webContentsListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  webContents = {
    id: 2,
    on: (event: string, listener: (...args: unknown[]) => void): unknown => {
      const set = this.webContentsListeners.get(event) ?? new Set();
      set.add(listener);
      this.webContentsListeners.set(event, set);
      return this.webContents;
    },
  };

  constructor(options: PopoverWindowOptions) {
    this.options = options;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
  }

  loadURL(url: string): Promise<void> {
    this.url = url;
    return this.loadFailure ? Promise.reject(this.loadFailure) : Promise.resolve();
  }
  show(): void {
    this.shown = true;
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.visible = false;
    this.emit("closed");
  }
  isDestroyed(): boolean {
    return this.closed;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isFocused(): boolean {
    return this.focused;
  }
  getBounds(): PopoverRect {
    return { ...this.bounds };
  }
  setBounds(bounds: PopoverRect): void {
    this.bounds = { ...bounds };
  }
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }
  removeAllListeners(): unknown {
    this.listeners.clear();
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
  emitWebContents(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.webContentsListeners.get(event) ?? [])]) listener(...args);
  }
}

class FakeScreen implements PopoverScreenLike {
  cursor = { x: 0, y: 0 };
  workArea: PopoverRect = { ...WORK };
  getCursorScreenPoint(): { x: number; y: number } {
    return { ...this.cursor };
  }
  getDisplayMatching(_rect: PopoverRect): { workArea: PopoverRect } {
    return { workArea: { ...this.workArea } };
  }
}

interface TimerHarness {
  setIntervalFn: (callback: () => void, ms: number) => unknown;
  clearIntervalFn: (handle: unknown) => void;
  tick: () => void;
  interval: number;
  cleared: number;
  active: boolean;
}

function makeTimers(): TimerHarness {
  let callback: (() => void) | null = null;
  let interval = 0;
  let cleared = 0;
  return {
    setIntervalFn: (fn: () => void, ms: number): unknown => {
      callback = fn;
      interval = ms;
      return { timer: true };
    },
    clearIntervalFn: (_handle: unknown): void => {
      callback = null;
      cleared += 1;
    },
    tick: (): void => {
      callback?.();
    },
    get interval(): number {
      return interval;
    },
    get cleared(): number {
      return cleared;
    },
    get active(): boolean {
      return callback !== null;
    },
  };
}

function makeHarness(overrides: Partial<ChromePopoverManagerDeps> = {}) {
  const main = new FakeMainWindow();
  const screen = new FakeScreen();
  const timers = makeTimers();
  const created: FakePopoverWindow[] = [];
  const ctor = function windowCtor(options: PopoverWindowOptions): FakePopoverWindow {
    const win = new FakePopoverWindow(options);
    created.push(win);
    return win;
  };
  const actions: unknown[] = [];
  const manager = createChromePopoverManager({
    getMainWindow: () => main,
    loadUrlFor: (kind, lang) =>
      `loopsoar://app/index.html?popover=${kind}${lang ? `&lang=${encodeURIComponent(lang)}` : ""}`,
    preloadPath: "/tmp/preload.cjs",
    additionalArguments: ["--loopsoar-bindings=[]", "--loopsoar-events=[]"],
    createWindow: ctor,
    screen,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    onAction: (payload) => actions.push(payload),
    ...overrides,
  });
  return { manager, main, screen, timers, created, actions };
}

const ANCHOR = { x: 900, y: 60, width: 32, height: 32 };
/** 锚点换算到屏幕后：{x: 1000, y: 110, width: 32, height: 32}。 */
const ANCHOR_SCREEN = { x: 1000, y: 110, width: 32, height: 32 };

function openReady(harness: ReturnType<typeof makeHarness>): FakePopoverWindow {
  const result = harness.manager.open({ kind: "more", anchor: ANCHOR });
  expect(result.ok).toBe(true);
  const win = harness.created[harness.created.length - 1];
  win.emit("ready-to-show");
  return win;
}

/* ────────────────────────── 管理器生命周期 ────────────────────────── */

describe("createChromePopoverManager：窗口创建与生命周期", () => {
  it("open 创建半透明无边框子窗口：正确 bounds/preload/配置，ready-to-show 后 show 并启动 120ms 轮询", () => {
    const harness = makeHarness();
    const result = harness.manager.open({ kind: "more", anchor: ANCHOR });
    expect(result).toEqual({ ok: true });
    expect(harness.created).toHaveLength(1);
    const win = harness.created[0];

    // 窗口选项：父窗口 + 无边框 + 透明 + 不可缩放/移动 + 不占任务栏 + 先隐藏
    expect(win.options.parent).toBe(harness.main);
    expect(win.options.frame).toBe(false);
    expect(win.options.transparent).toBe(true);
    expect(win.options.resizable).toBe(false);
    expect(win.options.movable).toBe(false);
    expect(win.options.skipTaskbar).toBe(true);
    expect(win.options.show).toBe(false);
    expect(win.options.webPreferences).toEqual({
      preload: "/tmp/preload.cjs",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ["--loopsoar-bindings=[]", "--loopsoar-events=[]"],
      devTools: false,
    });
    // 位置：主窗口内容区 (100,50) + 锚点 (900,60) = 屏幕 (1000,110)；下方 y=110+32+6；右对齐 x=1000+32-300
    expect({ x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height }).toEqual({
      x: 1000 + 32 - DEFAULT_POPOVER_SIZES.more.width,
      y: ANCHOR_SCREEN.y + ANCHOR_SCREEN.height + DEFAULT_POPOVER_GAP,
      width: DEFAULT_POPOVER_SIZES.more.width,
      height: DEFAULT_POPOVER_SIZES.more.height,
    });
    expect(win.url).toBe("loopsoar://app/index.html?popover=more");
    expect(win.shown).toBe(false);

    win.emit("ready-to-show");
    expect(win.shown).toBe(true);
    expect(harness.timers.interval).toBe(POPOVER_HOVER_POLL_MS);
    expect(harness.timers.active).toBe(true);
    expect(harness.manager.isOpen()).toBe(true);
    harness.manager.dispose();
  });

  it("loadUrlFor 收到 lang 并拼到 URL", () => {
    const harness = makeHarness();
    harness.manager.open({ kind: "history", anchor: ANCHOR, lang: "en-US" });
    expect(harness.created[0].url).toBe("loopsoar://app/index.html?popover=history&lang=en-US");
    harness.manager.dispose();
  });

  it("同一时刻只显示一个浮层：换 kind 时旧窗口保留到新窗口 ready 再关", () => {
    const harness = makeHarness();
    const first = openReady(harness);
    const second = harness.manager.open({ kind: "bookmarks", anchor: ANCHOR });
    expect(second.ok).toBe(true);
    expect(first.closed).toBe(false);
    harness.created[1].emit("ready-to-show");
    expect(first.visible).toBe(false);
    expect(first.closed).toBe(true);
    expect(harness.created).toHaveLength(2);
    expect(harness.created[1].closed).toBe(false);
    expect(harness.created[1].options.width).toBe(DEFAULT_POPOVER_SIZES.bookmarks.width);
    harness.manager.dispose();
  });

  it("主窗口 resize / move / close / closed 都会关闭浮层并解绑监听", () => {
    for (const event of ["resize", "move", "close", "closed"]) {
      const harness = makeHarness();
      const win = openReady(harness);
      harness.main.emit(event);
      expect(win.visible, event).toBe(false);
      expect(harness.manager.isOpen(), event).toBe(false);
      expect(harness.main.listenerCount(event), event).toBe(0);
      harness.manager.dispose();
    }
  });

  it("浮层 blur → 关闭", () => {
    const harness = makeHarness();
    const win = openReady(harness);
    win.emit("blur");
    expect(win.visible).toBe(false);
    expect(harness.manager.isOpen()).toBe(false);
    harness.manager.dispose();
  });

  it("Esc（webContents before-input-event）→ 关闭", () => {
    const harness = makeHarness();
    const win = openReady(harness);
    win.emitWebContents("before-input-event", { type: "keyDown" }, { key: "Escape" });
    expect(win.visible).toBe(false);
    harness.manager.dispose();
  });

  it("非 Esc 按键不关闭", () => {
    const harness = makeHarness();
    const win = openReady(harness);
    win.emitWebContents("before-input-event", { type: "keyDown" }, { key: "a" });
    expect(win.closed).toBe(false);
    harness.manager.dispose();
  });

  it("handleAction：回调 onAction 后关闭", () => {
    const harness = makeHarness();
    const win = openReady(harness);
    harness.manager.handleAction({ action: "openSettings", payload: { a: 1 } });
    expect(harness.actions).toEqual([{ action: "openSettings", payload: { a: 1 } }]);
    expect(win.visible).toBe(false);
    harness.manager.dispose();
  });

  it("主窗口未就绪 → open 返回可读错误而非崩溃", () => {
    const harness = makeHarness({ getMainWindow: () => null });
    const result = harness.manager.open({ kind: "more", anchor: ANCHOR });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("主窗口未就绪");
    expect(harness.created).toHaveLength(0);
  });

  it("未知 kind 直接拒绝（防御契约被绕过）", () => {
    const harness = makeHarness();
    const result = harness.manager.open({ kind: "bogus" as ChromePopoverKind, anchor: ANCHOR });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未知浮层类型");
    expect(harness.created).toHaveLength(0);
    harness.manager.dispose();
  });

  it("sizeFor 可覆盖默认尺寸（UI 菜单更宽/更高时）", () => {
    const harness = makeHarness({ sizeFor: () => ({ width: 420, height: 500 }) });
    harness.manager.open({ kind: "more", anchor: ANCHOR });
    expect(harness.created[0].options.width).toBe(420);
    expect(harness.created[0].options.height).toBe(500);
    harness.manager.dispose();
  });

  it("loadURL 失败 → 自动关闭并清理轮询", async () => {
    const main = new FakeMainWindow();
    const timers = makeTimers();
    const created: FakePopoverWindow[] = [];
    const failingCtor = function windowCtor(options: PopoverWindowOptions): FakePopoverWindow {
      const win = new FakePopoverWindow(options);
      win.loadFailure = new Error("load failed");
      created.push(win);
      return win;
    };
    const manager = createChromePopoverManager({
      getMainWindow: () => main,
      loadUrlFor: () => "loopsoar://app/index.html?popover=more",
      preloadPath: "/tmp/preload.cjs",
      createWindow: failingCtor,
      screen: new FakeScreen(),
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    expect(manager.open({ kind: "more", anchor: ANCHOR }).ok).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(created[0].closed).toBe(true);
    manager.dispose();
  });

  it("dispose：关闭窗口、解绑主窗口监听、清理定时器，之后不能再 open", () => {
    const harness = makeHarness();
    const win = openReady(harness);
    const timer = harness.timers;
    harness.manager.dispose();
    expect(win.closed).toBe(true);
    expect(harness.main.listenerCount("resize")).toBe(0);
    expect(harness.main.listenerCount("closed")).toBe(0);
    expect(timer.active).toBe(false);
    expect(timer.cleared).toBeGreaterThan(0);
    const after = harness.manager.open({ kind: "more", anchor: ANCHOR });
    expect(after.ok).toBe(false);
    expect(after.error).toContain("已销毁");
  });
});

/* ────────────────────────── hover 自动关闭 ────────────────────────── */

describe("createChromePopoverManager：hover 自动关闭（120ms 轮询）", () => {
  it("光标同时离开浮层（外扩 8px）与锚点（外扩 24px）→ 关闭", () => {
    const harness = makeHarness();
    const win = openReady(harness);
    harness.screen.cursor = { x: 0, y: 0 };
    harness.timers.tick();
    expect(win.visible).toBe(false);
    expect(harness.timers.active).toBe(false);
    harness.manager.dispose();
  });

  it("光标在浮层外扩 8px 内 → 不关闭", () => {
    const harness = makeHarness();
    const win = openReady(harness);
    harness.screen.cursor = { x: win.bounds.x - 4, y: win.bounds.y + 10 };
    harness.timers.tick();
    expect(win.closed).toBe(false);
    harness.manager.dispose();
  });

  it("光标在锚点外扩 24px 内 → 不关闭（点击后小抖动不应闪关）", () => {
    const harness = makeHarness();
    const win = openReady(harness);
    harness.screen.cursor = { x: ANCHOR_SCREEN.x - 20, y: ANCHOR_SCREEN.y - 20 };
    harness.timers.tick();
    expect(win.closed).toBe(false);
    harness.manager.dispose();
  });

  it("浮层已聚焦（用户正在菜单内操作）→ 即使光标移开也不关闭", () => {
    const harness = makeHarness();
    const win = openReady(harness);
    win.focused = true;
    harness.screen.cursor = { x: 0, y: 0 };
    harness.timers.tick();
    expect(win.closed).toBe(false);
    harness.manager.dispose();
  });

  it("轮询期间窗口被系统销毁 → 关闭清理（无残留定时器）", () => {
    const harness = makeHarness();
    const win = openReady(harness);
    win.closed = true; // 模拟系统/用户直接销毁，不经过 manager.close
    harness.timers.tick();
    expect(harness.manager.isOpen()).toBe(false);
    expect(harness.timers.active).toBe(false);
    harness.manager.dispose();
  });
});

/* ────────────────────────── 域：通道注册与事件转发 ────────────────────────── */

interface DomainCalls {
  opened: unknown[];
  closed: number;
  actions: unknown[];
}

function makeDomain(overrides: Partial<Omit<TrustedIpcDeps, "ipc">> & Record<string, unknown> = {}) {
  __resetHandlerRegistryForTests();
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const ipc: TrustedIpcDeps["ipc"] = {
    handle: (channel, fn) => {
      handlers.set(channel.replace(/^loopsoar:/, ""), fn as (event: unknown, payload: unknown) => Promise<unknown>);
    },
  };
  const calls: DomainCalls = { opened: [], closed: 0, actions: [] };
  const pushes: { event: string; payload: unknown }[] = [];
  const state = { open: false };
  const manager: ChromePopoverManager = {
    open: (input) => {
      calls.opened.push(input);
      state.open = true;
      return { ok: true };
    },
    close: () => {
      calls.closed += 1;
      state.open = false;
    },
    handleAction: (payload) => {
      calls.actions.push(payload);
    },
    isOpen: () => state.open,
    dispose: () => {},
  };
  registerChromePopoverDomain(
    {
      ipc,
      audit: () => {},
      push: (event, payload) => pushes.push({ event, payload }),
      getMainWebContentsId: () => 1,
      ...overrides,
    },
    manager,
  );
  const invoke = (
    channel: string,
    payload: unknown,
    event: unknown = { senderFrame: { url: "loopsoar://app/index.html" }, sender: { id: 1 } },
  ): Promise<unknown> => {
    // 走 ipc.handle 实际注册的 handler（handleTrusted 四要素 + openPopover 的发送者校验都在这一层）
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`channel ${channel} 未注册`);
    return Promise.resolve(handler(event, payload));
  };
  return { calls, pushes, handlers, invoke };
}

describe("registerChromePopoverDomain：IPC 入口", () => {
  beforeEach(() => {
    __resetHandlerRegistryForTests();
  });

  it("ui:openPopover 由主窗口调用 → manager.open 收到 {kind, anchor, lang}", async () => {
    const domain = makeDomain();
    const payload = { kind: "more", anchor: { x: 10, y: 20, width: 30, height: 40 }, lang: "zh-CN" };
    const result = await domain.invoke("ui:openPopover", payload);
    expect(result).toEqual({ ok: true });
    expect(domain.calls.opened).toEqual([{ kind: "more", anchor: { x: 10, y: 20, width: 30, height: 40 }, lang: "zh-CN" }]);
  });

  it("ui:openPopover 来自浮层子窗口（sender.id 非主窗口）→ 拒绝", async () => {
    const domain = makeDomain();
    await expect(
      domain.invoke(
        "ui:openPopover",
        { kind: "more", anchor: { x: 10, y: 20, width: 30, height: 40 } },
        { senderFrame: { url: "loopsoar://app/index.html?popover=more" }, sender: { id: 2 } },
      ),
    ).rejects.toThrow(/仅主窗口/);
    expect(domain.calls.opened).toEqual([]);
  });

  it("ui:openPopover 参数非法（未知 kind / 锚点非数字）→ 契约校验拒绝", async () => {
    const domain = makeDomain();
    await expect(domain.invoke("ui:openPopover", { kind: "bogus", anchor: { x: 1, y: 2, width: 3, height: 4 } })).rejects.toThrow(
      /参数校验失败/,
    );
    await expect(
      domain.invoke("ui:openPopover", { kind: "more", anchor: { x: "a", y: 2, width: 3, height: 4 } }),
    ).rejects.toThrow(/参数校验失败/);
    expect(domain.calls.opened).toEqual([]);
  });

  it("ui:closePopover → manager.close，返回 {ok:true}；不接受参数", async () => {
    const domain = makeDomain();
    expect(await domain.invoke("ui:closePopover", undefined)).toEqual({ ok: true });
    expect(domain.calls.closed).toBe(1);
    await expect(domain.invoke("ui:closePopover", { unexpected: true })).rejects.toThrow(/不接受参数/);
  });

  it("ui:popoverAction → push(chrome:popoverAction, {action,payload}) 并关闭浮层", async () => {
    const domain = makeDomain();
    const action = { action: "openPage", payload: { url: "https://example.com" } };
    expect(await domain.invoke("ui:popoverAction", action)).toEqual({ ok: true });
    expect(domain.pushes).toEqual([{ event: "chrome:popoverAction", payload: action }]);
    expect(domain.calls.closed).toBe(1);
  });

  it("ui:togglePopover：未打开 → 打开；已打开 → 关闭（原子切换，绝不重开连闪）", async () => {
    const domain = makeDomain();
    const payload = { kind: "more", anchor: { x: 1, y: 2, width: 3, height: 4 } };
    expect(await domain.invoke("ui:togglePopover", payload)).toEqual({ ok: true, open: true });
    expect(domain.calls.opened).toHaveLength(1);
    expect(await domain.invoke("ui:togglePopover", payload)).toEqual({ ok: true, open: false });
    expect(domain.calls.closed).toBe(1);
    expect(domain.calls.opened).toHaveLength(1); // 关掉即可，不能再打开（旧实现关→开连闪）
    // 再点一次又能正常打开（状态没有被卡死）
    expect(await domain.invoke("ui:togglePopover", payload)).toEqual({ ok: true, open: true });
    expect(domain.calls.opened).toHaveLength(2);
  });

  it("getMainWebContentsId 返回 null（主窗口不可用）→ fail-closed 拒绝", async () => {
    const domain = makeDomain({ getMainWebContentsId: () => null });
    await expect(
      domain.invoke("ui:openPopover", { kind: "more", anchor: { x: 1, y: 2, width: 3, height: 4 } }),
    ).rejects.toThrow(/仅主窗口/);
  });
});

describe("createChromePopoverManager：onClosed 状态同步（点击收起不闪烁）", () => {
  it("浮层真正关闭（close/失焦/动作）时回调 onClosed；切 kind 不回调（新浮层仍开着）", () => {
    let closedCount = 0;
    const harness = makeHarness({ onClosed: () => { closedCount += 1; } });
    harness.manager.close(); // 没有浮层 → 不回调
    expect(closedCount).toBe(0);
    openReady(harness);
    harness.manager.close();
    expect(closedCount).toBe(1);
    // 切 kind：旧浮层保留到新窗口 ready（这时才 +1）
    openReady(harness);
    const switchResult = harness.manager.open({ kind: "history", anchor: ANCHOR });
    expect(switchResult.ok).toBe(true);
    expect(closedCount).toBe(1);
    const second = harness.created[harness.created.length - 1];
    second.emit("ready-to-show");
    expect(second.closed).toBe(false);
    expect(closedCount).toBe(1); // 切 kind 不回调：新浮层仍打开
    second.emit("blur");
    expect(closedCount).toBe(2);
    harness.manager.dispose();
    expect(closedCount).toBe(2); // dispose 时已无浮层
  });
});
