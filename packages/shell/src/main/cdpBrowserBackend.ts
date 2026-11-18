/**
 * 第二个 BrowserBackend 实现：通过 Chrome DevTools Protocol 操作远端/无头 Chromium。
 *
 * 为什么用 CDP 而不是 Playwright：主进程不需要新增运行时依赖（Node 24 自带 WebSocket），
 * 打包体积不变；Playwright 的浏览器下载/版本管理也不适合桌面应用。这个后端面向
 * `LOOPSOAR_BROWSER_CDP_ENDPOINT`（如 ws://127.0.0.1:9222/devtools/browser/...）的服务器场景，
 * Electron 主窗口仍用 BrowserHost（WebContentsView）。
 *
 * 端口契约与 BrowserHost 相同；工具层（browserTools）无需改动。快照脚本复用
 * browserAdapter/refs.ts 的 SNAPSHOT_SCRIPT 与 RefRegistry，保证 #eN 语义一致。
 */
import { SNAPSHOT_SCRIPT, createTabRegistry, type RawBrowserElement, type RefRegistry } from "../browserAdapter/refs.js";
import type { BrowserSnapshot } from "../browserAdapter/types.js";
import type { BrowserBackend } from "./browserBackend.js";
import type { NavigateOutcome, TabState } from "./browserHost.js";

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (...args: unknown[]) => void): void;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}

export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  close(): void;
}

export interface CdpBrowserBackendOptions {
  /** 测试注入 transport；生产不传，内部走 WebSocket。 */
  transport?: CdpTransport;
  /** 导航后等待 readyState 的上限（默认 8s）。 */
  loadTimeoutMs?: number;
}

interface CdpTab {
  tabId: string;
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  agentBound: boolean;
  token: string;
  registry: RefRegistry;
}

const DEFAULT_LOAD_TIMEOUT_MS = 8_000;

/** 真实 WebSocket transport：CDP 的 request/response id 复用，事件忽略。 */
export function createWebSocketTransport(endpoint: string): CdpTransport {
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => WsLike }).WebSocket;
  if (!WebSocketCtor) throw new Error("当前 Node 运行时不支持 WebSocket，无法连接 CDP");
  let ws: WsLike | null = null;
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  const open = new Promise<WsLike>((resolve, reject) => {
    const socket = new WebSocketCtor(endpoint);
    ws = socket;
    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("error", () => reject(new Error(`CDP 连接失败：${endpoint}`)));
    socket.addEventListener("message", (...args) => {
      const event = args[0] as { data?: unknown };
      let message: CdpMessage;
      try {
        message = JSON.parse(String(event?.data ?? "")) as CdpMessage;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "CDP 命令失败"));
      else waiter.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      for (const waiter of pending.values()) waiter.reject(new Error("CDP 连接已关闭"));
      pending.clear();
    });
  });
  return {
    async send(method, params = {}, sessionId) {
      const socket = await open;
      const id = ++nextId;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 命令超时：${method}`));
        }, 20_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() {
      try {
        ws?.close();
      } catch {
        // 已关闭
      }
    },
  };
}

function targetIdOf(target: Record<string, unknown>): string {
  return typeof target.targetId === "string" ? target.targetId : "";
}

/** 把 BrowserHost 的 URL 规范化留交给调用方（browserTools 已做 normalize）。 */
function tabState(tab: CdpTab, active: boolean): TabState {
  return {
    id: tab.tabId,
    url: tab.url,
    title: tab.title,
    active,
    canBack: false,
    canForward: false,
    loading: tab.loading,
    loadFailure: null,
    agentBound: tab.agentBound,
  };
}

export class CdpBrowserBackend implements BrowserBackend {
  private transport: CdpTransport | null;
  private tabs = new Map<string, CdpTab>();
  private active: string | null = null;
  private nextTab = 0;
  private connected: Promise<void> | null = null;
  private readonly loadTimeoutMs: number;

  constructor(
    private readonly endpoint: string,
    opts: CdpBrowserBackendOptions = {},
  ) {
    this.transport = opts.transport ?? null;
    this.loadTimeoutMs = opts.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  }

  private async connect(): Promise<CdpTransport> {
    if (!this.connected) {
      this.connected = (async () => {
        this.transport = this.transport ?? createWebSocketTransport(await this.resolveEndpoint());
        await this.transport.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
      })();
    }
    await this.connected;
    if (!this.transport) throw new Error("CDP 未连接");
    return this.transport;
  }

  /** 支持直接 ws://，也支持 http://host:port（自动读 /json/version）。 */
  private async resolveEndpoint(): Promise<string> {
    if (!/^https?:\/\//i.test(this.endpoint)) return this.endpoint;
    const base = this.endpoint.replace(/\/+$/, "");
    const response = await fetch(`${base}/json/version`);
    if (!response.ok) throw new Error(`CDP /json/version 失败：HTTP ${response.status}`);
    const data = (await response.json()) as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) throw new Error("CDP /json/version 未返回 webSocketDebuggerUrl");
    return data.webSocketDebuggerUrl;
  }

  private async send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    return (await this.connect()).send(method, params, sessionId);
  }

  private async attach(targetId: string): Promise<string> {
    const result = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = typeof result.sessionId === "string" ? result.sessionId : "";
    if (!sessionId) throw new Error(`CDP attach 失败：${targetId}`);
    await this.send("Page.enable", {}, sessionId).catch(() => undefined);
    await this.send("Runtime.enable", {}, sessionId).catch(() => undefined);
    return sessionId;
  }

  private async addTab(targetId: string): Promise<CdpTab> {
    const sessionId = await this.attach(targetId);
    const refs = createTabRegistry();
    const tab: CdpTab = {
      tabId: `cdp-tab-${++this.nextTab}`,
      targetId,
      sessionId,
      url: "about:blank",
      title: "",
      loading: false,
      agentBound: true,
      token: refs.token,
      registry: refs.registry,
    };
    this.tabs.set(tab.tabId, tab);
    this.active = tab.tabId;
    await this.refreshTab(tab).catch(() => undefined);
    return tab;
  }

  private async createTarget(url = "about:blank"): Promise<CdpTab> {
    const result = await this.send("Target.createTarget", { url });
    const targetId = typeof result.targetId === "string" ? result.targetId : "";
    if (!targetId) throw new Error("CDP 创建标签失败");
    return this.addTab(targetId);
  }

  /** 把 emulation/Page 的当前状态同步到标签缓存；失败不抛（页面可能正在导航）。 */
  private async refreshTab(tab: CdpTab): Promise<void> {
    try {
      const raw = (await this.send(
        "Runtime.evaluate",
        { expression: "({url: location.href, title: document.title, ready: document.readyState})", returnByValue: true },
        tab.sessionId,
      )) as { result?: { value?: { url?: string; title?: string; ready?: string } } };
      const value = raw.result?.value;
      if (value?.url) tab.url = value.url;
      if (value?.title) tab.title = value.title;
      tab.loading = value?.ready === "loading";
    } catch {
      // 页面切换/销毁窗口：保留旧缓存
    }
  }

  private async tabOrCreate(tabId?: string): Promise<CdpTab> {
    const existing = tabId ? this.tabs.get(tabId) : this.tabs.get(this.active ?? "");
    if (existing) return existing;
    if (this.tabs.size > 0) {
      const first = this.tabs.values().next().value as CdpTab;
      this.active = first.tabId;
      return first;
    }
    return this.createTarget();
  }

  private async waitReady(tab: CdpTab): Promise<void> {
    const deadline = Date.now() + this.loadTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = (await this.send(
          "Runtime.evaluate",
          { expression: "document.readyState", returnByValue: true },
          tab.sessionId,
        )) as { result?: { value?: string } };
        if (raw.result?.value === "interactive" || raw.result?.value === "complete") return;
      } catch {
        // 导航中执行上下文销毁：下一轮重试
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }

  listTabs(): TabState[] {
    return [...this.tabs.values()].map((tab) => tabState(tab, tab.tabId === this.active));
  }

  activeTabId(): string | null {
    return this.active;
  }

  async navigate(rawUrl: string, tabId?: string): Promise<NavigateOutcome> {
    try {
      const tab = await this.tabOrCreate(tabId);
      tab.registry.clear();
      const result = await this.send("Page.navigate", { url: rawUrl }, tab.sessionId);
      if (typeof result.errorText === "string" && result.errorText) {
        tab.loading = false;
        return { ok: false, error: result.errorText };
      }
      tab.agentBound = true;
      await this.waitReady(tab);
      await this.refreshTab(tab);
      return { ok: true, url: tab.url || rawUrl, tabId: tab.tabId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async newTab(rawUrl = "about:blank"): Promise<{ tabId: string; url?: string; ok: boolean; error?: string }> {
    try {
      const tab = await this.createTarget(rawUrl);
      await this.waitReady(tab);
      await this.refreshTab(tab);
      return { tabId: tab.tabId, url: tab.url, ok: true };
    } catch (err) {
      return { tabId: "", ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  selectTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) return false;
    this.active = tabId;
    return true;
  }

  async closeTab(tabId: string): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    this.tabs.delete(tabId);
    try {
      await this.send("Target.closeTarget", { targetId: tab.targetId });
    } catch {
      // 已关闭
    }
    if (this.active === tabId) this.active = this.tabs.keys().next().value ?? null;
    return true;
  }

  private async history(tabId: string | undefined, delta: number): Promise<{ ok: boolean; url?: string; error?: string }> {
    try {
      const tab = await this.tabOrCreate(tabId);
      const raw = (await this.send("Page.getNavigationHistory", {}, tab.sessionId)) as {
        currentIndex?: number;
        entries?: Array<{ id?: number }>;
      };
      const index = Number(raw.currentIndex ?? -1) + delta;
      const entry = raw.entries?.[index];
      if (!entry?.id) return { ok: false, error: "没有可用的历史记录" };
      await this.send("Page.navigateToHistoryEntry", { entryId: entry.id }, tab.sessionId);
      await this.waitReady(tab);
      await this.refreshTab(tab);
      return { ok: true, url: tab.url };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  goBack(tabId?: string) {
    return this.history(tabId, -1);
  }

  goForward(tabId?: string) {
    return this.history(tabId, 1);
  }

  async reload(tabId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    try {
      const tab = await this.tabOrCreate(tabId);
      await this.send("Page.reload", {}, tab.sessionId);
      await this.waitReady(tab);
      await this.refreshTab(tab);
      return { ok: true, url: tab.url };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async screenshot(): Promise<string | null> {
    try {
      const tab = await this.tabOrCreate();
      const raw = (await this.send("Page.captureScreenshot", { format: "png" }, tab.sessionId)) as { data?: string };
      return typeof raw.data === "string" ? raw.data : null;
    } catch {
      return null;
    }
  }

  async snapshot(_sessionId?: string, tabId?: string): Promise<BrowserSnapshot | null> {
    try {
      const tab = await this.tabOrCreate(tabId);
      const raw = (await this.send(
        "Runtime.evaluate",
        { expression: SNAPSHOT_SCRIPT, returnByValue: true, awaitPromise: true },
        tab.sessionId,
      )) as {
        result?: {
          value?: { url?: string; title?: string; text?: string; elements?: RawBrowserElement[]; elementTotal?: number };
        };
      };
      const value = raw.result?.value;
      if (!value) return null;
      const elements = tab.registry.reset(Array.isArray(value.elements) ? value.elements : []);
      if (value.url) tab.url = value.url;
      if (value.title) tab.title = value.title;
      return {
        url: value.url ?? tab.url,
        title: value.title ?? tab.title,
        text: value.text ?? "",
        elements,
        snapshotGen: tab.registry.gen,
        elementTotal: typeof value.elementTotal === "number" ? value.elementTotal : elements.length,
        tabToken: tab.token,
        tabId: tab.tabId,
      };
    } catch {
      return null;
    }
  }

  private async mouse(tabId: string | undefined, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
    const tab = await this.tabOrCreate(tabId);
    await this.send("Input.dispatchMouseEvent", { type, x, y, ...extra }, tab.sessionId);
  }

  async agentClick(_sessionId: string | undefined, tabId: string | undefined, point: { x: number; y: number }): Promise<boolean> {
    try {
      await this.mouse(tabId, "mouseMoved", point.x, point.y);
      await this.mouse(tabId, "mousePressed", point.x, point.y, { button: "left", clickCount: 1 });
      await this.mouse(tabId, "mouseReleased", point.x, point.y, { button: "left", clickCount: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async agentType(_sessionId: string | undefined, tabId: string | undefined, text: string): Promise<boolean> {
    try {
      const tab = await this.tabOrCreate(tabId);
      await this.send("Input.insertText", { text }, tab.sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async agentHover(_sessionId: string | undefined, tabId: string | undefined, point: { x: number; y: number }): Promise<boolean> {
    try {
      await this.mouse(tabId, "mouseMoved", point.x, point.y);
      return true;
    } catch {
      return false;
    }
  }

  async getViewportCenter(): Promise<{ x: number; y: number } | null> {
    try {
      const tab = await this.tabOrCreate();
      const raw = (await this.send(
        "Runtime.evaluate",
        { expression: "({x: window.innerWidth / 2, y: window.innerHeight / 2})", returnByValue: true },
        tab.sessionId,
      )) as { result?: { value?: { x?: number; y?: number } } };
      const value = raw.result?.value;
      if (typeof value?.x !== "number" || typeof value?.y !== "number") return null;
      return { x: value.x, y: value.y };
    } catch {
      return null;
    }
  }

  async agentDrag(
    _sessionId: string | undefined,
    tabId: string | undefined,
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 8,
  ): Promise<boolean> {
    try {
      await this.mouse(tabId, "mouseMoved", from.x, from.y);
      await this.mouse(tabId, "mousePressed", from.x, from.y, { button: "left", clickCount: 1 });
      const count = Math.max(2, Math.min(32, Math.floor(steps)));
      for (let i = 1; i <= count; i += 1) {
        const x = from.x + ((to.x - from.x) * i) / count;
        const y = from.y + ((to.y - from.y) * i) / count;
        await this.mouse(tabId, "mouseMoved", x, y, { button: "left", buttons: 1 });
      }
      await this.mouse(tabId, "mouseReleased", to.x, to.y, { button: "left", clickCount: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async agentWheel(_sessionId: string | undefined, tabId: string | undefined, deltaY: number): Promise<boolean> {
    try {
      await this.mouse(tabId, "mouseWheel", 0, 0, { deltaY, deltaX: 0 });
      return true;
    } catch {
      return false;
    }
  }

  async agentKey(_sessionId: string | undefined, tabId: string | undefined, key: string): Promise<boolean> {
    try {
      const tab = await this.tabOrCreate(tabId);
      const named: Record<string, { key: string; code: string; keyCode: number }> = {
        Enter: { key: "Enter", code: "Enter", keyCode: 13 },
        Tab: { key: "Tab", code: "Tab", keyCode: 9 },
        Escape: { key: "Escape", code: "Escape", keyCode: 27 },
        Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
        Delete: { key: "Delete", code: "Delete", keyCode: 46 },
        ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
        ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
        ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
        ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      };
      const info = named[key] ?? { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...info }, tab.sessionId);
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...info }, tab.sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async executeScript(script: string, _sessionId?: string, tabId?: string): Promise<unknown> {
    const tab = await this.tabOrCreate(tabId);
    const raw = (await this.send(
      "Runtime.evaluate",
      { expression: script, returnByValue: true, awaitPromise: true },
      tab.sessionId,
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (raw.exceptionDetails) throw new Error(raw.exceptionDetails.text ?? "页面脚本执行失败");
    return raw.result?.value ?? null;
  }

  getPageZoom(): number {
    return 1;
  }

  isSessionVisible(): boolean {
    return true;
  }

  async ensureAgentTab(): Promise<string | null> {
    if (this.active && this.tabs.has(this.active)) return this.active;
    const tab = this.tabs.size > 0 ? (this.tabs.values().next().value as CdpTab) : await this.createTarget();
    this.active = tab.tabId;
    return tab.tabId;
  }

  async close(): Promise<void> {
    this.transport?.close();
    this.transport = null;
    this.connected = null;
    this.tabs.clear();
    this.active = null;
  }
}
