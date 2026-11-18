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
  /** 每个会话独立的标签组与激活项；远端 CDP 没有原生视图，但仍保持工具面的会话隔离。 */
  private sessions = new Map<string, { tabIds: string[]; active: string | null }>();
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

  private group(sessionId?: string): { tabIds: string[]; active: string | null } {
    const key = sessionId || "default";
    let group = this.sessions.get(key);
    if (!group) {
      group = { tabIds: [], active: null };
      this.sessions.set(key, group);
    }
    return group;
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

  private async addTab(targetId: string, sessionId?: string): Promise<CdpTab> {
    const sessionIdForTab = await this.attach(targetId);
    const refs = createTabRegistry();
    const tab: CdpTab = {
      tabId: `cdp-tab-${++this.nextTab}`,
      targetId,
      sessionId: sessionIdForTab,
      url: "about:blank",
      title: "",
      loading: false,
      agentBound: true,
      token: refs.token,
      registry: refs.registry,
    };
    this.tabs.set(tab.tabId, tab);
    const group = this.group(sessionId);
    group.tabIds.push(tab.tabId);
    group.active = tab.tabId;
    await this.refreshTab(tab).catch(() => undefined);
    return tab;
  }

  private async createTarget(url = "about:blank", sessionId?: string): Promise<CdpTab> {
    const result = await this.send("Target.createTarget", { url });
    const targetId = typeof result.targetId === "string" ? result.targetId : "";
    if (!targetId) throw new Error("CDP 创建标签失败");
    return this.addTab(targetId, sessionId);
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

  private async tabOrCreate(tabId?: string, sessionId?: string): Promise<CdpTab> {
    if (tabId) {
      const existing = this.tabs.get(tabId);
      if (existing) return existing;
    }
    const group = this.group(sessionId);
    const active = group.active ? this.tabs.get(group.active) : undefined;
    if (active) return active;
    const first = group.tabIds.map((id) => this.tabs.get(id)).find((tab): tab is CdpTab => Boolean(tab));
    if (first) {
      group.active = first.tabId;
      return first;
    }
    return this.createTarget("about:blank", sessionId);
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

  listTabs(sessionId?: string): TabState[] {
    const group = this.group(sessionId);
    return group.tabIds
      .map((id) => this.tabs.get(id))
      .filter((tab): tab is CdpTab => Boolean(tab))
      .map((tab) => tabState(tab, tab.tabId === group.active));
  }

  activeTabId(sessionId?: string): string | null {
    return this.group(sessionId).active;
  }

  async navigate(rawUrl: string, tabId?: string, sessionId?: string): Promise<NavigateOutcome> {
    try {
      const tab = await this.tabOrCreate(tabId, sessionId);
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

  async newTab(rawUrl = "about:blank", sessionId?: string): Promise<{ tabId: string; url?: string; ok: boolean; error?: string }> {
    try {
      const tab = await this.createTarget(rawUrl, sessionId);
      await this.waitReady(tab);
      await this.refreshTab(tab);
      return { tabId: tab.tabId, url: tab.url, ok: true };
    } catch (err) {
      return { tabId: "", ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  selectTab(tabId: string, sessionId?: string): boolean {
    if (!this.tabs.has(tabId)) return false;
    const group = this.group(sessionId);
    if (!group.tabIds.includes(tabId)) group.tabIds.push(tabId);
    group.active = tabId;
    return true;
  }

  async closeTab(tabId: string, sessionId?: string): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    this.tabs.delete(tabId);
    const group = this.group(sessionId);
    group.tabIds = group.tabIds.filter((id) => id !== tabId);
    try {
      await this.send("Target.closeTarget", { targetId: tab.targetId });
    } catch {
      // 已关闭
    }
    if (group.active === tabId) group.active = group.tabIds[0] ?? null;
    return true;
  }

  private async history(tabId: string | undefined, delta: number, sessionId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    try {
      const tab = await this.tabOrCreate(tabId, sessionId);
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

  goBack(tabId?: string, sessionId?: string) {
    return this.history(tabId, -1, sessionId);
  }

  goForward(tabId?: string, sessionId?: string) {
    return this.history(tabId, 1, sessionId);
  }

  async reload(tabId?: string, sessionId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    try {
      const tab = await this.tabOrCreate(tabId, sessionId);
      await this.send("Page.reload", {}, tab.sessionId);
      await this.waitReady(tab);
      await this.refreshTab(tab);
      return { ok: true, url: tab.url };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async screenshot(sessionId?: string): Promise<string | null> {
    try {
      const tab = await this.tabOrCreate(undefined, sessionId);
      const raw = (await this.send("Page.captureScreenshot", { format: "png" }, tab.sessionId)) as { data?: string };
      return typeof raw.data === "string" ? raw.data : null;
    } catch {
      return null;
    }
  }

  async snapshot(sessionId?: string, tabId?: string): Promise<BrowserSnapshot | null> {
    try {
      const tab = await this.tabOrCreate(tabId, sessionId);
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

  private async mouse(tabId: string | undefined, type: string, x: number, y: number, extra: Record<string, unknown> = {}, sessionId?: string) {
    const tab = await this.tabOrCreate(tabId, sessionId);
    await this.send("Input.dispatchMouseEvent", { type, x, y, ...extra }, tab.sessionId);
  }

  async agentClick(sessionId: string | undefined, tabId: string | undefined, point: { x: number; y: number }): Promise<boolean> {
    try {
      await this.mouse(tabId, "mouseMoved", point.x, point.y, {}, sessionId);
      await this.mouse(tabId, "mousePressed", point.x, point.y, { button: "left", clickCount: 1 }, sessionId);
      await this.mouse(tabId, "mouseReleased", point.x, point.y, { button: "left", clickCount: 1 }, sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async agentType(sessionId: string | undefined, tabId: string | undefined, text: string): Promise<boolean> {
    try {
      const tab = await this.tabOrCreate(tabId, sessionId);
      await this.send("Input.insertText", { text }, tab.sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async agentHover(sessionId: string | undefined, tabId: string | undefined, point: { x: number; y: number }): Promise<boolean> {
    try {
      await this.mouse(tabId, "mouseMoved", point.x, point.y, {}, sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async getViewportCenter(sessionId?: string, tabId?: string): Promise<{ x: number; y: number } | null> {
    try {
      const tab = await this.tabOrCreate(tabId, sessionId);
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
    sessionId: string | undefined,
    tabId: string | undefined,
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 8,
  ): Promise<boolean> {
    try {
      await this.mouse(tabId, "mouseMoved", from.x, from.y, {}, sessionId);
      await this.mouse(tabId, "mousePressed", from.x, from.y, { button: "left", clickCount: 1 }, sessionId);
      const count = Math.max(2, Math.min(32, Math.floor(steps)));
      for (let i = 1; i <= count; i += 1) {
        const x = from.x + ((to.x - from.x) * i) / count;
        const y = from.y + ((to.y - from.y) * i) / count;
        await this.mouse(tabId, "mouseMoved", x, y, { button: "left", buttons: 1 }, sessionId);
      }
      await this.mouse(tabId, "mouseReleased", to.x, to.y, { button: "left", clickCount: 1 }, sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async agentWheel(sessionId: string | undefined, tabId: string | undefined, deltaY: number): Promise<boolean> {
    try {
      await this.mouse(tabId, "mouseWheel", 0, 0, { deltaY, deltaX: 0 }, sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async agentKey(sessionId: string | undefined, tabId: string | undefined, key: string): Promise<boolean> {
    try {
      const tab = await this.tabOrCreate(tabId, sessionId);
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

  async executeScript(script: string, sessionId?: string, tabId?: string): Promise<unknown> {
    const tab = await this.tabOrCreate(tabId, sessionId);
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

  isSessionVisible(sessionId?: string): boolean {
    return this.sessions.has(sessionId || "default");
  }

  async ensureAgentTab(sessionId?: string): Promise<string | null> {
    const group = this.group(sessionId);
    if (group.active && this.tabs.has(group.active)) return group.active;
    const tab = await this.tabOrCreate(undefined, sessionId);
    group.active = tab.tabId;
    return tab.tabId;
  }

  async close(): Promise<void> {
    this.transport?.close();
    this.transport = null;
    this.connected = null;
    this.tabs.clear();
    this.sessions.clear();
  }
}

/**
 * 环境选择器：只有显式设置 `LOOPSOAR_BROWSER_CDP_ENDPOINT` 才启用远端 CDP 后端。
 * 默认返回 null，Electron 主窗口继续用 BrowserHost，行为不变。
 * 远端模式是自动化/无头场景：原生 BrowserHost 的标签 UI 不接管远端页面。
 */
export function createCdpBrowserBackendFromEnv(env: NodeJS.ProcessEnv = process.env): CdpBrowserBackend | null {
  const endpoint = env.LOOPSOAR_BROWSER_CDP_ENDPOINT?.trim();
  if (!endpoint) return null;
  return new CdpBrowserBackend(endpoint);
}
