/**
 * Agent 会话栏「独立窗口」（真·窗口化 + 无边框自绘标题栏）：
 *   ① 几何：computeAgentWindowBounds 贴主窗口右缘 / 顶部对齐浏览器视图 / 工作区四边夹取 / 无主窗口回退；
 *   ② 管理器：无边框创建参数、滑入/滑出动画（假定时器逐帧驱动）、单实例聚焦、最小化、webContentsId、
 *      用户关闭 vs 程序性关闭的事件语义、loadURL 同步/异步失败、dispose、异常兜底；
 *   ③ 域：ui:openAgentWindow（仅主窗口 + 参数归一化）/ ui:closeAgentWindow / ui:minimizeAgentWindow
 *      （仅 Agent 窗口自身）/ chrome:agentWindowClosed 推送。
 *
 * 全程无真实 Electron：管理器注入假 BrowserWindow + 假 screen + 假定时器；域只依赖 trustedIpc。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_WINDOW_DEFAULT_HEIGHT,
  AGENT_WINDOW_DEFAULT_WIDTH,
  AGENT_WINDOW_EDGE_GAP,
  AGENT_WINDOW_ICON_ANIM_MS,
  AGENT_WINDOW_ICON_SIZE,
  AGENT_WINDOW_MIN_HEIGHT,
  AGENT_WINDOW_MIN_WIDTH,
  AGENT_WINDOW_SLIDE_IN_MS,
  AGENT_WINDOW_SLIDE_OFFSET,
  AGENT_WINDOW_SLIDE_OUT_MS,
  AGENT_WINDOW_TITLE,
  computeAgentWindowBounds,
  computeAgentWindowIconBounds,
  createAgentWindowManager,
  easeCubicBezier,
  type AgentWindowLike,
  type AgentWindowManager,
  type AgentWindowManagerDeps,
  type AgentWindowOptions,
  type AgentWindowRect,
} from "../../packages/shell/src/main/agentWindow.ts";
import { registerAgentWindowDomain } from "../../packages/shell/src/main/domains/agentWindow.ts";
import { __resetHandlerRegistryForTests, type TrustedIpcDeps } from "../../packages/shell/src/main/trustedIpc.ts";

/* ────────────────────────── 假 Electron 原语 ────────────────────────── */

class FakeAgentWindow implements AgentWindowLike {
  options: AgentWindowOptions;
  url = "";
  shown = false;
  focusCount = 0;
  destroyed = false;
  minimized = false;
  restoreCount = 0;
  minimizeCount = 0;
  destroyCount = 0;
  /** setBounds 实际生效的 bounds（动画断言用）。 */
  bounds: AgentWindowRect;
  opacity = 1;
  setBoundsCalls = 0;
  /** 图标模式测试：窗口装饰状态。 */
  resizable = true;
  alwaysOnTop = false;
  minSize: [number, number];
  /** 同步抛错（模拟 loadURL 同步失败）。 */
  syncLoadError: Error | null = null;
  /** 异步 reject（模拟 loadURL Promise 失败）。 */
  loadFailure: Error | null = null;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  webContents = { id: 700 };

  constructor(options: AgentWindowOptions) {
    this.options = options;
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width,
      height: options.height,
    };
    this.minSize = [options.minWidth, options.minHeight];
  }

  loadURL(url: string): Promise<void> {
    this.url = url;
    if (this.syncLoadError) throw this.syncLoadError;
    return this.loadFailure ? Promise.reject(this.loadFailure) : Promise.resolve();
  }
  hidden = false;
  show(): void {
    this.shown = true;
    this.hidden = false;
  }
  hide(): void {
    this.hidden = true;
  }
  isVisible(): boolean {
    return !this.hidden;
  }
  focus(): void {
    this.focusCount += 1;
  }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
  destroy(): void {
    this.destroyCount += 1;
    this.close();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  restore(): void {
    this.minimized = false;
    this.restoreCount += 1;
  }
  minimize(): void {
    this.minimizeCount += 1;
    this.minimized = true;
  }
  setBounds(bounds: AgentWindowRect): void {
    this.bounds = { ...bounds };
    this.setBoundsCalls += 1;
  }
  setResizable(value: boolean): void {
    this.resizable = value;
  }
  setAlwaysOnTop(value: boolean): void {
    this.alwaysOnTop = value;
  }
  setMinimumSize(width: number, height: number): void {
    this.minSize = [width, height];
  }
  /** setShape 记录（图标态窗口不缩放，用 shape 裁出 56px 可交互区）。 */
  shape: AgentWindowRect[] | null = null;
  setShape(rects: AgentWindowRect[]): void {
    this.shape = rects.map((r) => ({ ...r }));
  }
  getBounds(): AgentWindowRect {
    return { ...this.bounds };
  }
  capturePageCalls = 0;
  async capturePage(): Promise<{ toDataURL(): string }> {
    this.capturePageCalls += 1;
    return { toDataURL: () => "data:image/png;base64,AAAA" };
  }
  setOpacity(opacity: number): void {
    this.opacity = opacity;
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
}

/** 手动定时器：测试逐 tick 驱动动画，不真实等待 200/160ms。 */
function makeScheduler() {
  const tasks = new Map<number, () => void>();
  let seq = 0;
  return {
    setIntervalFn: (callback: () => void): unknown => {
      seq += 1;
      tasks.set(seq, callback);
      return seq;
    },
    clearIntervalFn: (handle: unknown): void => {
      tasks.delete(handle as number);
    },
    /** 触发 n 帧（每帧调用一次当前所有仍在运行的 interval 回调）。 */
    tick(frames = 1): void {
      for (let i = 0; i < frames; i += 1) {
        for (const [id, callback] of [...tasks]) {
          if (tasks.has(id)) callback();
        }
      }
    },
    pending(): number {
      return tasks.size;
    },
  };
}

const WORK_AREA: AgentWindowRect = { x: 0, y: 0, width: 1600, height: 900 };
const MAIN_CONTENT: AgentWindowRect = { x: 100, y: 50, width: 1200, height: 800 };

function makeScreen(workArea: AgentWindowRect = WORK_AREA) {
  return {
    getDisplayMatching: () => ({ workArea }),
    getPrimaryDisplay: () => ({ workArea }),
  };
}

function makeHarness(overrides: Partial<AgentWindowManagerDeps> = {}) {
  const created: FakeAgentWindow[] = [];
  const events: string[] = [];
  const scheduler = makeScheduler();
  const manager = createAgentWindowManager({
    loadUrlFor: (sessionId) =>
      `loopsoar://app/index.html?agentWindow=1${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    preloadPath: "/tmp/preload.cjs",
    additionalArguments: ["--loopsoar-bindings=[]", "--loopsoar-events=[]"],
    getMainWindowContentBounds: () => MAIN_CONTENT,
    screen: makeScreen(),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
    createWindow: (options) => {
      const win = new FakeAgentWindow(options);
      created.push(win);
      return win;
    },
    onClosed: () => events.push("deps:onClosed"),
    onLoadFailed: (message) => events.push(`deps:onLoadFailed:${message}`),
    ...overrides,
  });
  return { manager, created, events, scheduler };
}

/** 打开窗口并把滑入动画跑完（否则 bounds/opacity 停在中间帧）。 */
function openAndFinish(harness: ReturnType<typeof makeHarness>, sessionId?: string) {
  harness.manager.open(sessionId);
  const win = harness.created[harness.created.length - 1];
  win.emit("ready-to-show");
  harness.scheduler.tick(Math.ceil(AGENT_WINDOW_SLIDE_IN_MS / 16));
  return win;
}

/* ────────────────────────── 几何：computeAgentWindowBounds ────────────────────────── */

describe("computeAgentWindowBounds：贴主窗口右缘 + 工作区夹取", () => {
  it("默认贴主窗口右缘、顶部对齐浏览器视图（40+48+8=96）", () => {
    const bounds = computeAgentWindowBounds(MAIN_CONTENT, WORK_AREA);
    expect(bounds).toEqual({ x: 100 + 1200 - 420 - 8, y: 50 + 96, width: 420, height: 720 });
  });

  it("无主窗口内容区 → 贴屏幕工作区右缘（仍对齐浏览器视图顶部）", () => {
    expect(computeAgentWindowBounds(null, WORK_AREA)).toEqual({ x: 1172, y: 96, width: 420, height: 720 });
  });

  it("工作区过小 → 先收缩窗口尺寸，再夹取坐标（不产生负宽高）", () => {
    const bounds = computeAgentWindowBounds({ x: 0, y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: 800, height: 600 });
    expect(bounds.width).toBe(420);
    expect(bounds.height).toBe(600 - AGENT_WINDOW_EDGE_GAP * 2);
    // y 首选 96 超出下边界（600-584-8=8）→ 夹到 8
    expect(bounds).toEqual({ x: 372, y: 8, width: 420, height: 584 });
  });

  it("负坐标多显示器（副屏在主屏左侧）也能正确贴边", () => {
    const bounds = computeAgentWindowBounds(
      { x: -1920, y: 0, width: 1920, height: 1040 },
      { x: -1920, y: 0, width: 1920, height: 1040 },
    );
    expect(bounds).toEqual({ x: -1920 + 1920 - 420 - 8, y: 96, width: 420, height: 720 });
  });

  it("主窗口贴近工作区右缘 → x 被夹取，不越界", () => {
    const bounds = computeAgentWindowBounds({ x: 800, y: 0, width: 800, height: 800 }, WORK_AREA);
    // 首选 800+800-428=1172，正好等于 maxX
    expect(bounds.x).toBe(1172);
  });

  it("easeCubicBezier：端点精确、单调递增", () => {
    expect(easeCubicBezier(0)).toBe(0);
    expect(easeCubicBezier(1)).toBe(1);
    expect(easeCubicBezier(0.5) > easeCubicBezier(0.2)).toBe(true);
    expect(easeCubicBezier(0.8) > easeCubicBezier(0.5)).toBe(true);
  });
});

/* ────────────────────────── 管理器：创建参数 ────────────────────────── */

describe("createAgentWindowManager：无边框窗口创建参数", () => {
  it("创建无系统边框、自绘标题栏、可缩放/最小化的独立窗口（无 parent）", () => {
    const harness = makeHarness();
    expect(harness.manager.open()).toEqual({ ok: true });
    expect(harness.created).toHaveLength(1);
    const win = harness.created[0];

    expect(win.options).toMatchObject({
      width: AGENT_WINDOW_DEFAULT_WIDTH,
      height: AGENT_WINDOW_DEFAULT_HEIGHT,
      minWidth: AGENT_WINDOW_MIN_WIDTH,
      minHeight: AGENT_WINDOW_MIN_HEIGHT,
      // 无系统边框 + 透明窗口：圆角与背景交给渲染层（图标态只画一个圆角图标，无窗框）
      frame: false,
      titleBarStyle: "hidden",
      transparent: true,
      roundedCorners: false,
      hasShadow: false,
      show: false,
      resizable: true,
      maximizable: true,
      skipTaskbar: false,
      title: AGENT_WINDOW_TITLE,
      autoHideMenuBar: true,
      backgroundColor: "rgba(0,0,0,0)",
    });
    // 独立顶层窗口：绝不能有 parent（否则会变成主窗口的子窗口/被主窗口约束）
    expect("parent" in win.options).toBe(false);
    expect(win.options.webPreferences).toEqual({
      preload: "/tmp/preload.cjs",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ["--loopsoar-bindings=[]", "--loopsoar-events=[]"],
      devTools: false,
    });
    expect(win.url).toBe("loopsoar://app/index.html?agentWindow=1");
    expect(win.shown).toBe(false);
    expect(harness.manager.isOpen()).toBe(true);
    harness.manager.dispose();
  });

  it("创建位置 = 滑入起点（目标右移 24px，隐藏创建，显示时从起点滑入不跳位）", () => {
    const harness = makeHarness();
    harness.manager.open();
    expect(harness.created[0].options.x).toBe(872 + AGENT_WINDOW_SLIDE_OFFSET);
    expect(harness.created[0].options.y).toBe(146);
    harness.manager.dispose();
  });

  it("无 getMainWindowContentBounds → 贴屏幕右缘（回退，不抛错）", () => {
    const harness = makeHarness({ getMainWindowContentBounds: undefined });
    expect(harness.manager.open()).toEqual({ ok: true });
    expect(harness.created[0].options.x).toBe(1172 + AGENT_WINDOW_SLIDE_OFFSET);
    expect(harness.created[0].options.y).toBe(96);
    harness.manager.dispose();
  });

  it("sessionId 透传给 loadUrlFor（编码到 URL）", () => {
    const harness = makeHarness();
    harness.manager.open("sess-42");
    expect(harness.created[0].url).toBe("loopsoar://app/index.html?agentWindow=1&sessionId=sess-42");
    harness.manager.dispose();
  });

  it("deps 可覆盖标题/底色/尺寸（默认值不被硬编码）", () => {
    const harness = makeHarness({ title: "自定义标题", backgroundColor: "#123456", width: 500, height: 800 });
    harness.manager.open();
    expect(harness.created[0].options.title).toBe("自定义标题");
    expect(harness.created[0].options.backgroundColor).toBe("#123456");
    expect(harness.created[0].options.width).toBe(500);
    expect(harness.created[0].options.height).toBe(800);
    harness.manager.dispose();
  });
});

/* ────────────────────────── 管理器：滑入动画 ────────────────────────── */

describe("createAgentWindowManager：滑入动画", () => {
  it("ready-to-show 前不显示；ready 后在目标右侧 24px 外、透明显示并逐帧滑入", () => {
    const harness = makeHarness();
    harness.manager.open();
    const win = harness.created[0];
    // 创建坐标是滑入起点；减掉 offset 还原目标位置
    const targetX = (win.options.x as number) - AGENT_WINDOW_SLIDE_OFFSET;
    expect(win.shown).toBe(false);

    win.emit("ready-to-show");
    expect(win.shown).toBe(true);
    // 起点：目标右侧 24px、全透明
    expect(win.bounds.x).toBe(targetX + AGENT_WINDOW_SLIDE_OFFSET);
    expect(win.opacity).toBe(0);
    expect(harness.scheduler.pending()).toBeGreaterThan(0);

    // 中间帧：位置在起点与目标之间、透明度在 0..1 之间
    harness.scheduler.tick(1);
    expect(win.bounds.x < targetX + AGENT_WINDOW_SLIDE_OFFSET).toBe(true);
    expect(win.bounds.x > targetX).toBe(true);
    expect(win.opacity > 0).toBe(true);
    expect(win.opacity < 1).toBe(true);

    // 跑完：精确落在目标、完全不透明、定时器清空
    harness.scheduler.tick(Math.ceil(AGENT_WINDOW_SLIDE_IN_MS / 16));
    expect(win.bounds.x).toBe(targetX);
    expect(win.opacity).toBe(1);
    expect(harness.scheduler.pending()).toBe(0);
    harness.manager.dispose();
  });

  it("滑入期间重复 open → 只聚焦，不重建也不重启动画", () => {
    const harness = makeHarness();
    harness.manager.open();
    const win = harness.created[0];
    win.emit("ready-to-show");
    harness.scheduler.tick(2);
    expect(harness.manager.open()).toEqual({ ok: true });
    expect(harness.created).toHaveLength(1);
    expect(win.focusCount).toBe(1);
    harness.manager.dispose();
  });
});

/* ────────────────────────── 管理器：单实例与聚焦 ────────────────────────── */

describe("createAgentWindowManager：单实例与聚焦", () => {
  it("重复 open 不重建窗口，只聚焦已有实例", () => {
    const harness = makeHarness();
    expect(harness.manager.open("a")).toEqual({ ok: true });
    expect(harness.manager.open("b")).toEqual({ ok: true });
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0].focusCount).toBe(1);
    // 第二次 open 不改变已有窗口的 URL/会话
    expect(harness.created[0].url).toBe("loopsoar://app/index.html?agentWindow=1&sessionId=a");
    harness.manager.dispose();
  });

  it("最小化状态下重复 open → 先 restore 再 focus", () => {
    const harness = makeHarness();
    harness.manager.open();
    const win = harness.created[0];
    win.minimized = true;
    harness.manager.open();
    expect(win.restoreCount).toBe(1);
    expect(win.minimized).toBe(false);
    expect(win.focusCount).toBe(1);
    harness.manager.dispose();
  });

  it("focus：无窗口返回 false，有窗口返回 true", () => {
    const harness = makeHarness();
    expect(harness.manager.focus()).toBe(false);
    harness.manager.open();
    expect(harness.manager.focus()).toBe(true);
    expect(harness.created[0].focusCount).toBe(1);
    harness.manager.dispose();
  });
});

/* ────────────────────────── 管理器：最小化 / webContentsId ────────────────────────── */

describe("createAgentWindowManager：最小化与 webContentsId", () => {
  it("minimize：缩成图标按钮（56px），不缩到任务栏；restore 还原原 bounds", () => {
    const notifications: boolean[] = [];
    const transitions: Array<{
      phase: string;
      from: { width: number; height: number };
      to: { width: number; height: number };
    }> = [];
    const harness = makeHarness({
      onIconModeChange: (icon) => notifications.push(icon),
      onTransition: (payload) =>
        transitions.push({ phase: payload.phase, from: payload.from, to: payload.to }),
    });
    expect(harness.manager.minimize()).toBe(false);
    harness.manager.open();
    const win = harness.created[0];
    const before = { ...win.bounds };
    expect(harness.manager.minimize()).toBe(true);
    // 面板过渡：窗口不动，渲染层拿 from(整窗)→to(图标矩形)；动画结束才落最终 bounds。
    expect(transitions[0]).toMatchObject({
      phase: "minimize",
      from: { width: before.width, height: before.height },
      to: { width: AGENT_WINDOW_ICON_SIZE, height: AGENT_WINDOW_ICON_SIZE },
    });
    harness.scheduler.tick(Math.ceil(AGENT_WINDOW_ICON_ANIM_MS / 16) + 1);
    // Agent 大窗口 bounds 不变、被隐藏；独立 56px 图标窗口出现在图标位置
    expect(win.bounds.width).toBe(before.width);
    expect(win.bounds.height).toBe(before.height);
    expect(win.isVisible()).toBe(false);
    const icon = computeAgentWindowIconBounds(before, WORK_AREA);
    const iconWin = harness.created[1];
    expect(iconWin).toBeTruthy();
    expect(iconWin.bounds).toEqual({ x: icon.x, y: icon.y, width: AGENT_WINDOW_ICON_SIZE, height: AGENT_WINDOW_ICON_SIZE });
    expect(iconWin.isVisible()).toBe(true);
    expect(iconWin.options.skipTaskbar).toBe(true);
    expect(win.minimizeCount).toBe(0); // 不再调用系统最小化（否则会缩到任务栏）
    expect(harness.manager.isIconMode()).toBe(true);
    expect(notifications).toEqual([true]);

    expect(harness.manager.restore()).toBe(true);
    expect(transitions[1]).toMatchObject({
      phase: "restore",
      from: { width: AGENT_WINDOW_ICON_SIZE, height: AGENT_WINDOW_ICON_SIZE },
      to: { width: before.width, height: before.height },
    });
    harness.scheduler.tick(Math.ceil(AGENT_WINDOW_ICON_ANIM_MS / 16) + 1);
    expect(harness.manager.isIconMode()).toBe(false);
    // Agent 大窗口重新显示，原点对齐到图标位置（此处图标由原窗口右上角计算，故等于原 bounds）
    expect(win.isVisible()).toBe(true);
    expect(win.bounds).toEqual(before);
    expect(iconWin.isVisible()).toBe(false);
    expect(win.alwaysOnTop).toBe(false);
    expect(win.resizable).toBe(true);
    expect(notifications).toEqual([true, false]);
    harness.manager.dispose();
  });
  it("webContentsId：无窗口 null；有窗口返回 webContents.id（域层 sender 校验用）", () => {
    const harness = makeHarness();
    expect(harness.manager.webContentsId()).toBeNull();
    harness.manager.open();
    expect(harness.manager.webContentsId()).toBe(700);
    harness.created[0].close();
    expect(harness.manager.webContentsId()).toBeNull();
    harness.manager.dispose();
  });

  it("reposition：主窗口移动/缩放后无动画重新贴回右缘；最小化/无窗口时不抢位置", () => {
    let content: AgentWindowRect = { ...MAIN_CONTENT };
    const harness = makeHarness({ getMainWindowContentBounds: () => content });
    expect(harness.manager.reposition()).toBe(false);
    const win = openAndFinish(harness);
    expect(win.bounds.x).toBe(MAIN_CONTENT.x + MAIN_CONTENT.width - AGENT_WINDOW_DEFAULT_WIDTH - 8);

    content = { x: 200, y: 100, width: 900, height: 700 };
    expect(harness.manager.reposition()).toBe(true);
    expect(win.bounds).toEqual({
      x: 200 + 900 - AGENT_WINDOW_DEFAULT_WIDTH - 8,
      // 首选 100+96=196 超出工作区下边界（900-720-8=172）→ 夹到 172
      y: 172,
      width: AGENT_WINDOW_DEFAULT_WIDTH,
      height: AGENT_WINDOW_DEFAULT_HEIGHT,
    });
    expect(harness.scheduler.pending()).toBe(0);

    // 最小化窗口保持原位，等用户从任务栏还原
    win.minimized = true;
    content = { x: 0, y: 0, width: 1600, height: 900 };
    expect(harness.manager.reposition()).toBe(false);
    harness.manager.dispose();
  });
});


describe("createAgentWindowManager：普通态拖动会话", () => {
  it("begin/drag/end：按累计屏幕增量移动，尺寸固定为拖动起点（不随帧漂移）", () => {
    const harness = makeHarness();
    const win = openAndFinish(harness);
    const start: AgentWindowRect = { ...win.bounds };
    expect(harness.manager.beginAgentWindowDrag()).toBe(true);
    expect(harness.manager.dragBy(20, 15)).toBe(true);
    expect(harness.manager.dragBy(20, 15)).toBe(true);
    expect(win.bounds.x).toBe(start.x + 40);
    expect(win.bounds.y).toBe(start.y + 30);
    expect(win.bounds.width).toBe(start.width);
    expect(win.bounds.height).toBe(start.height);
    expect(harness.manager.endAgentWindowDrag()).toBe(true);

    // 新一次拖动从当前窗口位置重新取起点，不继承上一次的累计位移。
    harness.manager.beginAgentWindowDrag();
    harness.manager.dragBy(-10, -5);
    expect(win.bounds.x).toBe(start.x + 30);
    expect(win.bounds.y).toBe(start.y + 25);
    harness.manager.dispose();
  });

  it("未显式 begin 时，首个 dragBy 自动捕获起点；零增量仍保持尺寸", () => {
    const harness = makeHarness();
    const win = openAndFinish(harness);
    const start: AgentWindowRect = { ...win.bounds };
    expect(harness.manager.dragBy(0, 0)).toBe(true);
    expect(win.bounds).toEqual(start);
    expect(harness.manager.dragBy(12, -8)).toBe(true);
    expect(win.bounds.x).toBe(start.x + 12);
    expect(win.bounds.y).toBe(start.y - 8);
    harness.manager.dispose();
  });

  it("拖动被屏幕工作区夹取：标题栏始终留在可见范围", () => {
    const harness = makeHarness();
    const win = openAndFinish(harness);
    const start: AgentWindowRect = { ...win.bounds };
    harness.manager.beginAgentWindowDrag();
    harness.manager.dragBy(-5000, -5000);
    expect(win.bounds.x).toBeGreaterThanOrEqual(WORK_AREA.x - start.width + 120);
    expect(win.bounds.y).toBeGreaterThanOrEqual(WORK_AREA.y);
    expect(win.bounds.width).toBe(start.width);
    expect(win.bounds.height).toBe(start.height);
    harness.manager.endAgentWindowDrag();
    harness.manager.dispose();
  });

  it("图标态下 begin/drag 返回 false（图标窗口自行拖动）", () => {
    const harness = makeHarness();
    openAndFinish(harness);
    harness.manager.minimize();
    harness.scheduler.tick(Math.ceil(AGENT_WINDOW_ICON_ANIM_MS / 16) + 5);
    expect(harness.manager.isIconMode()).toBe(true);
    expect(harness.manager.beginAgentWindowDrag()).toBe(false);
    expect(harness.manager.dragBy(20, 15)).toBe(false);
    harness.manager.dispose();
  });
});

/* ────────────────────────── 关闭：滑出动画 ────────────────────────── */

describe("createAgentWindowManager：滑出动画与关闭语义", () => {
  it("close()：调用瞬间 isOpen=false；160ms 原地淡出后销毁（不再逐帧移动窗口，避免透明窗拖影）", () => {
    const harness = makeHarness();
    const win = openAndFinish(harness);
    const startX = win.bounds.x;
    harness.manager.close();

    // 程序性关闭：立即摘引用（不再接受聚焦/最小化），但窗口还没销毁
    expect(harness.manager.isOpen()).toBe(false);
    expect(win.destroyed).toBe(false);
    expect(harness.scheduler.pending()).toBeGreaterThan(0);

    harness.scheduler.tick(2);
    // 淡出期间窗口位置不变（逐帧 setBounds 是透明窗拖影/掉帧的来源）
    expect(win.bounds.x).toBe(startX);
    expect(win.opacity < 1).toBe(true);

    harness.scheduler.tick(Math.ceil(AGENT_WINDOW_SLIDE_OUT_MS / 16));
    expect(win.bounds.x).toBe(startX);
    expect(win.opacity).toBe(0);
    expect(win.destroyed).toBe(true);
    expect(win.destroyCount).toBe(1);
    expect(harness.scheduler.pending()).toBe(0);
    // 程序性关闭：窗口真正销毁后仍触发一次关闭通知（主窗口据此恢复右侧侧栏，时机在淡出结束之后）
    expect(harness.events).toEqual(["deps:onClosed"]);
    harness.manager.dispose();
  });

  it("close({animate:false}) → 立即关闭（应用退出/主窗口销毁场景），同样在销毁后通知一次", () => {
    const harness = makeHarness();
    const win = openAndFinish(harness);
    harness.manager.close({ animate: false });
    expect(win.destroyed).toBe(true);
    expect(win.destroyCount).toBe(0);
    expect(harness.manager.isOpen()).toBe(false);
    expect(harness.events).toEqual(["deps:onClosed"]);
    harness.manager.dispose();
    // dispose 不会重复通知
    expect(harness.events).toEqual(["deps:onClosed"]);
  });

  it("关闭动画未播完就重新 open → 先销毁旧窗口，再创建新实例", () => {
    const harness = makeHarness();
    const first = openAndFinish(harness);
    harness.manager.close();
    harness.scheduler.tick(1);
    expect(harness.manager.open()).toEqual({ ok: true });
    expect(first.destroyed).toBe(true);
    expect(harness.created).toHaveLength(2);
    expect(harness.manager.isOpen()).toBe(true);
    harness.manager.dispose();
  });

  it("重复 close 幂等（关闭动画期间不会重复动画/报错）", () => {
    const harness = makeHarness();
    openAndFinish(harness);
    harness.manager.close();
    harness.manager.close();
    expect(harness.scheduler.pending()).toBe(1);
    harness.scheduler.tick(Math.ceil(AGENT_WINDOW_SLIDE_OUT_MS / 16));
    expect(harness.scheduler.pending()).toBe(0);
    harness.manager.dispose();
  });

  it("用户/系统关闭 → 清引用 + onClosed 订阅与 deps.onClosed 各触发一次", () => {
    const harness = makeHarness();
    const closed: string[] = [];
    const unsubscribe = harness.manager.onClosed(() => closed.push("subscriber"));
    openAndFinish(harness);
    harness.created[0].close(); // 模拟用户点 X（外部触发 "closed"）

    expect(closed).toEqual(["subscriber"]);
    expect(harness.events).toEqual(["deps:onClosed"]);
    expect(harness.manager.isOpen()).toBe(false);

    // 重复的 closed 事件不会重复通知（窗口引用已清）
    harness.created[0].emit("closed");
    expect(closed).toEqual(["subscriber"]);
    expect(harness.events).toEqual(["deps:onClosed"]);
    unsubscribe();
    harness.manager.dispose();
  });

  it("用户关闭后可重新 open（新窗口实例）", () => {
    const harness = makeHarness();
    openAndFinish(harness);
    harness.created[0].close();
    expect(harness.manager.open()).toEqual({ ok: true });
    expect(harness.created).toHaveLength(2);
    expect(harness.created[1].destroyed).toBe(false);
    harness.manager.dispose();
  });

  it("dispose：关闭窗口但不触发关闭事件，之后不可再 open", () => {
    const harness = makeHarness();
    const closed: number[] = [];
    harness.manager.onClosed(() => closed.push(1));
    harness.manager.open();
    harness.manager.dispose();
    expect(harness.created[0].destroyed).toBe(true);
    expect(closed).toEqual([]);
    expect(harness.events).toEqual([]);
    const after = harness.manager.open();
    expect(after.ok).toBe(false);
    expect(after.error).toContain("已销毁");
  });

  it("创建窗口抛错 → 返回可读错误而不崩溃", () => {
    const harness = makeHarness({
      createWindow: () => {
        throw new Error("no display");
      },
    });
    const result = harness.manager.open();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no display");
    expect(harness.manager.isOpen()).toBe(false);
    harness.manager.dispose();
  });
});

/* ────────────────────────── 管理器：健壮性 ────────────────────────── */

describe("createAgentWindowManager：健壮性", () => {
  it("窗口被外部销毁（未发 closed）→ 引用自动失效，可重新 open", () => {
    const harness = makeHarness();
    harness.manager.open();
    // 直接标记 destroyed 且不触发 closed（模拟系统层销毁/崩溃边界）
    harness.created[0].destroyed = true;
    expect(harness.manager.isOpen()).toBe(false);
    expect(harness.manager.focus()).toBe(false);
    expect(harness.manager.open()).toEqual({ ok: true });
    expect(harness.created).toHaveLength(2);
    harness.manager.dispose();
  });

  it("单个 onClosed 订阅者抛错不影响其它订阅者与 deps.onClosed", () => {
    const harness = makeHarness();
    let second = 0;
    harness.manager.onClosed(() => {
      throw new Error("subscriber boom");
    });
    harness.manager.onClosed(() => (second += 1));
    harness.manager.open();
    harness.created[0].close();
    expect(second).toBe(1);
    expect(harness.events).toEqual(["deps:onClosed"]);
    harness.manager.dispose();
  });

  it("取消订阅后不再收到关闭通知", () => {
    const harness = makeHarness();
    let called = 0;
    const unsubscribe = harness.manager.onClosed(() => (called += 1));
    unsubscribe();
    harness.manager.open();
    harness.created[0].close();
    expect(called).toBe(0);
    expect(harness.events).toEqual(["deps:onClosed"]);
    harness.manager.dispose();
  });
});

/* ────────────────────────── loadURL 失败 ────────────────────────── */

describe("createAgentWindowManager：loadURL 失败清理", () => {
  it("同步抛错 → 关闭窗口并返回 error（不触发用户关闭事件）", () => {
    const created: FakeAgentWindow[] = [];
    const events: string[] = [];
    const manager = createAgentWindowManager({
      loadUrlFor: () => "loopsoar://app/index.html?agentWindow=1",
      preloadPath: "/tmp/preload.cjs",
      createWindow: (options) => {
        const win = new FakeAgentWindow(options);
        win.syncLoadError = new Error("load sync boom");
        created.push(win);
        return win;
      },
      onClosed: () => events.push("onClosed"),
    });
    const result = manager.open();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("load sync boom");
    expect(created[0].destroyed).toBe(true);
    expect(manager.isOpen()).toBe(false);
    expect(events).toEqual([]);
    manager.dispose();
  });

  it("异步 reject → 关闭窗口并通过 onLoadFailed 通知（不伪造用户关闭事件）", async () => {
    const created: FakeAgentWindow[] = [];
    const events: string[] = [];
    const manager = createAgentWindowManager({
      loadUrlFor: () => "loopsoar://app/index.html?agentWindow=1",
      preloadPath: "/tmp/preload.cjs",
      createWindow: (options) => {
        const win = new FakeAgentWindow(options);
        win.loadFailure = new Error("async boom");
        created.push(win);
        return win;
      },
      onClosed: () => events.push("onClosed"),
      onLoadFailed: (message) => events.push(`onLoadFailed:${message}`),
    });
    expect(manager.open()).toEqual({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(created[0].destroyed).toBe(true);
    expect(manager.isOpen()).toBe(false);
    expect(events).toEqual(["onLoadFailed:async boom"]);
    manager.dispose();
  });
});

/* ────────────────────────── 域：通道与事件 ────────────────────────── */

interface FakeManagerCalls {
  opened: (string | undefined)[];
  closeCount: number;
  isOpen: boolean;
  minimizeCount: number;
  restoreCount: number;
  moves: Array<[number, number]>;
  /** 当前 Agent 窗口 webContents id（null = 窗口未打开）。 */
  webContentsId: number | null;
}

function makeDomain(overrides: Partial<Record<string, unknown>> = {}) {
  __resetHandlerRegistryForTests();
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const ipc: TrustedIpcDeps["ipc"] = {
    handle: (channel, fn) => {
      handlers.set(channel.replace(/^loopsoar:/, ""), fn as (event: unknown, payload: unknown) => Promise<unknown>);
    },
  };
  const calls: FakeManagerCalls = { opened: [], closeCount: 0, isOpen: false, minimizeCount: 0, restoreCount: 0, moves: [], webContentsId: 2 };
  const pushes: { event: string; payload: unknown }[] = [];
  let closedListener: (() => void) | null = null;
  const manager: AgentWindowManager = {
    open: (sessionId) => {
      calls.opened.push(sessionId);
      return { ok: true };
    },
    close: () => {
      calls.closeCount += 1;
      // 真实 manager 在窗口销毁后统一 notifyClosed；假对象在这里模拟同一时序（域不再自己补推事件）
      if (calls.isOpen) {
        calls.isOpen = false;
        closedListener?.();
      }
    },
    isOpen: () => calls.isOpen,
    focus: () => false,
    minimize: () => {
      calls.minimizeCount += 1;
      return true;
    },
    moveBy: (dx, dy) => {
      calls.moves.push([dx, dy]);
      return true;
    },
    reposition: () => false,
    restore: () => {
      calls.restoreCount += 1;
      return true;
    },
    isIconMode: () => false,
    webContentsId: () => calls.webContentsId,
    onClosed: (listener) => {
      closedListener = listener;
      return () => {
        closedListener = null;
      };
    },
    dispose: () => {},
  };
  registerAgentWindowDomain(
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
    // 走 ipc.handle 实际注册的 handler（handleTrusted 四要素 + 域的发送者校验都在这一层）
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`channel ${channel} 未注册`);
    return Promise.resolve(handler(event, payload));
  };
  return {
    calls,
    pushes,
    invoke,
    emitClosed: () => closedListener?.(),
    hasClosedListener: () => closedListener !== null,
  };
}

describe("registerAgentWindowDomain：IPC 入口", () => {
  beforeEach(() => {
    __resetHandlerRegistryForTests();
  });

  it("ui:openAgentWindow 由主窗口调用 → manager.open(sessionId)（trim）", async () => {
    const domain = makeDomain();
    expect(await domain.invoke("ui:openAgentWindow", { sessionId: "  sess-1  " })).toEqual({ ok: true });
    expect(domain.calls.opened).toEqual(["sess-1"]);
  });

  it("缺省/空 sessionId → manager.open(undefined)，由渲染层兜底当前会话", async () => {
    const domain = makeDomain();
    await domain.invoke("ui:openAgentWindow", {});
    await domain.invoke("ui:openAgentWindow", { sessionId: "   " });
    expect(domain.calls.opened).toEqual([undefined, undefined]);
  });

  it("ui:openAgentWindow 来自 Agent 子窗口（sender.id 非主窗口）→ 拒绝", async () => {
    const domain = makeDomain();
    await expect(
      domain.invoke("ui:openAgentWindow", {}, { senderFrame: { url: "loopsoar://app/index.html?agentWindow=1" }, sender: { id: 2 } }),
    ).rejects.toThrow(/仅主窗口/);
    expect(domain.calls.opened).toEqual([]);
  });

  it("getMainWebContentsId 返回 null（主窗口不可用）→ fail-closed", async () => {
    const domain = makeDomain({ getMainWebContentsId: () => null });
    await expect(domain.invoke("ui:openAgentWindow", {})).rejects.toThrow(/仅主窗口/);
  });

  it("sessionId 非字符串 / 超长 → 契约校验拒绝", async () => {
    const domain = makeDomain();
    await expect(domain.invoke("ui:openAgentWindow", { sessionId: 123 })).rejects.toThrow(/参数校验失败/);
    await expect(domain.invoke("ui:openAgentWindow", { sessionId: "x".repeat(129) })).rejects.toThrow(/参数校验失败/);
    expect(domain.calls.opened).toEqual([]);
  });

  it("ui:closeAgentWindow → manager.close；关闭通知由 onClosed 在窗口销毁后统一推送一次", async () => {
    const domain = makeDomain();
    // 模拟窗口确实开着：只有真的关掉窗口才推关闭事件（真实 manager 在滑出结束后 notifyClosed）
    domain.calls.isOpen = true;
    expect(await domain.invoke("ui:closeAgentWindow", undefined)).toEqual({ ok: true });
    expect(domain.calls.closeCount).toBe(1);
    expect(domain.pushes).toEqual([{ event: "chrome:agentWindowClosed", payload: {} }]);
    // 窗口已经关了：再调 close 幂等，不重复推事件
    expect(
      await domain.invoke("ui:closeAgentWindow", undefined, {
        senderFrame: { url: "loopsoar://app/index.html?agentWindow=1" },
        sender: { id: 2 },
      }),
    ).toEqual({ ok: true });
    expect(domain.calls.closeCount).toBe(2);
    expect(domain.pushes).toEqual([{ event: "chrome:agentWindowClosed", payload: {} }]);
    // 该通道不接受参数
    await expect(domain.invoke("ui:closeAgentWindow", { unexpected: true })).rejects.toThrow(/不接受参数/);
  });

  it("ui:minimizeAgentWindow：Agent 窗口自身调用 → manager.minimize()，不再推送 closed（小窗仍以图标存在）", async () => {
    const domain = makeDomain();
    const result = await domain.invoke("ui:minimizeAgentWindow", null, {
      senderFrame: { url: "loopsoar://app/index.html?agentWindow=1" },
      sender: { id: 2 },
    });
    expect(result).toEqual({ ok: true });
    expect(domain.calls.minimizeCount).toBe(1);
    expect(domain.pushes).toEqual([]);
  });

  it("ui:restoreAgentWindow：Agent 窗口自身调用 → manager.restore()", async () => {
    const domain = makeDomain();
    expect(
      await domain.invoke("ui:restoreAgentWindow", null, {
        senderFrame: { url: "loopsoar://app/index.html?agentWindow=1" },
        sender: { id: 2 },
      }),
    ).toEqual({ ok: true });
    expect(domain.calls.restoreCount).toBe(1);
  });

  it("ui:moveAgentWindow：Agent 窗口自身调用 → manager.moveBy(dx,dy)", async () => {
    const domain = makeDomain();
    expect(
      await domain.invoke("ui:moveAgentWindow", { dx: 12, dy: -6 }, {
        senderFrame: { url: "loopsoar://app/index.html?agentWindow=1" },
        sender: { id: 2 },
      }),
    ).toEqual({ ok: true });
    expect(domain.calls.moves).toEqual([[12, -6]]);
  });

  it("ui:minimizeAgentWindow：主窗口调用 → 拒绝（只有 Agent 窗口能最小化自己）", async () => {
    const domain = makeDomain();
    await expect(domain.invoke("ui:minimizeAgentWindow", null)).rejects.toThrow(/仅 Agent/);
    expect(domain.calls.minimizeCount).toBe(0);
  });

  it("ui:minimizeAgentWindow：窗口未打开（webContentsId=null）→ fail-closed", async () => {
    const domain = makeDomain();
    domain.calls.webContentsId = null;
    await expect(
      domain.invoke("ui:minimizeAgentWindow", null, {
        senderFrame: { url: "loopsoar://app/index.html?agentWindow=1" },
        sender: { id: 2 },
      }),
    ).rejects.toThrow(/仅 Agent/);
  });

  it("用户关闭窗口 → push chrome:agentWindowClosed 一次（payload {}）", async () => {
    const domain = makeDomain();
    expect(domain.hasClosedListener()).toBe(true);
    domain.emitClosed();
    expect(domain.pushes).toEqual([{ event: "chrome:agentWindowClosed", payload: {} }]);
  });
});
