/**
 * Agent 会话栏「独立窗口」（真·窗口化）：
 *   ① 管理器：创建参数（系统边框/可缩放/最小尺寸/无 parent/标题/preload 参数）、单实例聚焦、
 *      ready-to-show、用户关闭 vs 程序性关闭的事件语义、loadURL 同步/异步失败、dispose、异常兜底；
 *   ② 域：ui:openAgentWindow（仅主窗口 + 参数归一化）/ ui:closeAgentWindow / chrome:agentWindowClosed 推送。
 *
 * 全程无真实 Electron：管理器注入假 BrowserWindow；域只依赖 trustedIpc。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_WINDOW_BACKGROUND,
  AGENT_WINDOW_DEFAULT_HEIGHT,
  AGENT_WINDOW_DEFAULT_WIDTH,
  AGENT_WINDOW_MIN_HEIGHT,
  AGENT_WINDOW_MIN_WIDTH,
  AGENT_WINDOW_TITLE,
  createAgentWindowManager,
  type AgentWindowLike,
  type AgentWindowManager,
  type AgentWindowManagerDeps,
  type AgentWindowOptions,
} from "../../packages/shell/src/main/agentWindow.ts";
import { registerAgentWindowDomain } from "../../packages/shell/src/main/domains/agentWindow.ts";
import { __resetHandlerRegistryForTests, type TrustedIpcDeps } from "../../packages/shell/src/main/trustedIpc.ts";

/* ────────────────────────── 假 Electron 原语 ────────────────────────── */

class FakeAgentWindow implements AgentWindowLike {
  options: AgentWindowOptions;
  url = "";
  shown = false;
  focusCount = 0;
  closed = false;
  minimized = false;
  restoreCount = 0;
  /** 同步抛错（模拟 loadURL 同步失败）。 */
  syncLoadError: Error | null = null;
  /** 异步 reject（模拟 loadURL Promise 失败）。 */
  loadFailure: Error | null = null;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(options: AgentWindowOptions) {
    this.options = options;
  }

  loadURL(url: string): Promise<void> {
    this.url = url;
    if (this.syncLoadError) throw this.syncLoadError;
    return this.loadFailure ? Promise.reject(this.loadFailure) : Promise.resolve();
  }
  show(): void {
    this.shown = true;
  }
  focus(): void {
    this.focusCount += 1;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("closed");
  }
  isDestroyed(): boolean {
    return this.closed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  restore(): void {
    this.minimized = false;
    this.restoreCount += 1;
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

function makeHarness(overrides: Partial<AgentWindowManagerDeps> = {}) {
  const created: FakeAgentWindow[] = [];
  const events: string[] = [];
  const manager = createAgentWindowManager({
    loadUrlFor: (sessionId) =>
      `loopsoar://app/index.html?agentWindow=1${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    preloadPath: "/tmp/preload.cjs",
    additionalArguments: ["--loopsoar-bindings=[]", "--loopsoar-events=[]"],
    createWindow: (options) => {
      const win = new FakeAgentWindow(options);
      created.push(win);
      return win;
    },
    onClosed: () => events.push("deps:onClosed"),
    onLoadFailed: (message) => events.push(`deps:onLoadFailed:${message}`),
    ...overrides,
  });
  return { manager, created, events };
}

/* ────────────────────────── 管理器：创建与单实例 ────────────────────────── */

describe("createAgentWindowManager：窗口创建参数", () => {
  it("创建带系统边框、可缩放/最小化的独立窗口（无 parent）", () => {
    const harness = makeHarness();
    expect(harness.manager.open()).toEqual({ ok: true });
    expect(harness.created).toHaveLength(1);
    const win = harness.created[0];

    expect(win.options).toMatchObject({
      width: AGENT_WINDOW_DEFAULT_WIDTH,
      height: AGENT_WINDOW_DEFAULT_HEIGHT,
      minWidth: AGENT_WINDOW_MIN_WIDTH,
      minHeight: AGENT_WINDOW_MIN_HEIGHT,
      frame: true,
      show: false,
      resizable: true,
      maximizable: true,
      skipTaskbar: false,
      title: AGENT_WINDOW_TITLE,
      autoHideMenuBar: true,
      backgroundColor: AGENT_WINDOW_BACKGROUND,
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

  it("sessionId 透传给 loadUrlFor（编码到 URL）", () => {
    const harness = makeHarness();
    harness.manager.open("sess-42");
    expect(harness.created[0].url).toBe("loopsoar://app/index.html?agentWindow=1&sessionId=sess-42");
    harness.manager.dispose();
  });

  it("ready-to-show 后才显示（避免白屏闪一下）", () => {
    const harness = makeHarness();
    harness.manager.open();
    const win = harness.created[0];
    expect(win.shown).toBe(false);
    win.emit("ready-to-show");
    expect(win.shown).toBe(true);
    harness.manager.dispose();
  });

  it("debs 可覆盖标题/底色/尺寸（默认值不被硬编码）", () => {
    const harness = makeHarness({ title: "自定义标题", backgroundColor: "#123456", width: 500, height: 800 });
    harness.manager.open();
    expect(harness.created[0].options.title).toBe("自定义标题");
    expect(harness.created[0].options.backgroundColor).toBe("#123456");
    expect(harness.created[0].options.width).toBe(500);
    expect(harness.created[0].options.height).toBe(800);
    harness.manager.dispose();
  });
});

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

/* ────────────────────────── 关闭事件语义 ────────────────────────── */

describe("createAgentWindowManager：用户关闭 vs 程序性关闭", () => {
  it("用户/系统关闭 → 清引用 + onClosed 订阅与 deps.onClosed 各触发一次", () => {
    const harness = makeHarness();
    const closed: string[] = [];
    const unsubscribe = harness.manager.onClosed(() => closed.push("subscriber"));
    harness.manager.open();
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

  it("程序性 close() 不触发关闭事件（避免 UI 自己关闭时收到二次通知）", () => {
    const harness = makeHarness();
    let pushed = 0;
    harness.manager.onClosed(() => (pushed += 1));
    harness.manager.open();
    harness.manager.close();
    expect(harness.created[0].closed).toBe(true);
    expect(pushed).toBe(0);
    expect(harness.events).toEqual([]);
    expect(harness.manager.isOpen()).toBe(false);
    // 幂等
    harness.manager.close();
    expect(pushed).toBe(0);
    harness.manager.dispose();
  });

  it("用户关闭后可重新 open（新窗口实例）", () => {
    const harness = makeHarness();
    harness.manager.open();
    harness.created[0].close();
    expect(harness.manager.open()).toEqual({ ok: true });
    expect(harness.created).toHaveLength(2);
    expect(harness.created[1].closed).toBe(false);
    harness.manager.dispose();
  });

  it("dispose：关闭窗口但不触发关闭事件，之后不可再 open", () => {
    const harness = makeHarness();
    const closed: number[] = [];
    harness.manager.onClosed(() => closed.push(1));
    harness.manager.open();
    harness.manager.dispose();
    expect(harness.created[0].closed).toBe(true);
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
    harness.created[0].closed = true;
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
    expect(created[0].closed).toBe(true);
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
    expect(created[0].closed).toBe(true);
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
}

function makeDomain(overrides: Partial<Record<string, unknown>> = {}) {
  __resetHandlerRegistryForTests();
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const ipc: TrustedIpcDeps["ipc"] = {
    handle: (channel, fn) => {
      handlers.set(channel.replace(/^loopsoar:/, ""), fn as (event: unknown, payload: unknown) => Promise<unknown>);
    },
  };
  const calls: FakeManagerCalls = { opened: [], closeCount: 0, isOpen: false };
  const pushes: { event: string; payload: unknown }[] = [];
  let closedListener: (() => void) | null = null;
  const manager: AgentWindowManager = {
    open: (sessionId) => {
      calls.opened.push(sessionId);
      return { ok: true };
    },
    close: () => {
      calls.closeCount += 1;
    },
    isOpen: () => calls.isOpen,
    focus: () => false,
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
    // 走 ipc.handle 实际注册的 handler（handleTrusted 四要素 + openAgentWindow 的发送者校验都在这一层）
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

  it("ui:closeAgentWindow → manager.close；主窗口与 Agent 窗口自身都可调用", async () => {
    const domain = makeDomain();
    // 模拟窗口确实开着：只有真的关掉窗口才补推关闭事件
    domain.calls.isOpen = true;
    expect(await domain.invoke("ui:closeAgentWindow", undefined)).toEqual({ ok: true });
    expect(
      await domain.invoke("ui:closeAgentWindow", undefined, {
        senderFrame: { url: "loopsoar://app/index.html?agentWindow=1" },
        sender: { id: 2 },
      }),
    ).toEqual({ ok: true });
    expect(domain.calls.closeCount).toBe(2);
    // 主动关闭也要通知主窗口恢复侧栏（程序性 close 不走 onClosed，由域补推）
    expect(domain.pushes).toEqual([
      { event: "chrome:agentWindowClosed", payload: {} },
      { event: "chrome:agentWindowClosed", payload: {} },
    ]);
    // 该通道不接受参数
    await expect(domain.invoke("ui:closeAgentWindow", { unexpected: true })).rejects.toThrow(/不接受参数/);
  });

  it("用户关闭窗口 → push chrome:agentWindowClosed 一次（payload {}）", async () => {
    const domain = makeDomain();
    expect(domain.hasClosedListener()).toBe(true);
    domain.emitClosed();
    expect(domain.pushes).toEqual([{ event: "chrome:agentWindowClosed", payload: {} }]);
  });
});
