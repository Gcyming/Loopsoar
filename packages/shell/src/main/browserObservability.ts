/**
 * 浏览器控制台/网络记录（会话级、标签级标签）。
 *
 * 为什么单独一个模块：BrowserHost 已经接近 1500 行守卫；观测是「旁路」能力，
 * 不应该把事件监听、环形缓冲和格式化塞回标签生命周期里。BrowserHost 只在 createTab
 * 时回调一次 attach，其余全部由这里负责。
 *
 * 记录只保留最近 N 条，避免长会话把主进程内存吃满；不持久化，不写会话历史。
 */
import type { BrowserConsoleEntry, BrowserNetworkEntry } from "./browserDataTools.js";

const MAX_ENTRIES = 300;

interface ObservableWebContents {
  id: number;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once?(event: string, listener: (...args: unknown[]) => void): void;
  session?: ObservableSession;
}

interface WebRequestDetails {
  url?: string;
  method?: string;
  statusCode?: number;
  resourceType?: string;
  webContentsId?: number;
  error?: string;
}

interface ObservableSession {
  webRequest?: {
    onCompleted?: (listener: (details: WebRequestDetails) => void) => void;
    onErrorOccurred?: (listener: (details: WebRequestDetails) => void) => void;
  };
}

export class BrowserObservability {
  private consoleBySession = new Map<string, BrowserConsoleEntry[]>();
  private networkBySession = new Map<string, BrowserNetworkEntry[]>();
  /** webContentsId → { sessionId, tabId }：webRequest 是 session 级事件，需要反查标签。 */
  private tabs = new Map<number, { sessionId: string; tabId: string }>();
  private wiredSessions = new WeakSet<object>();

  attach(sessionId: string, tabId: string, webContents: unknown): void {
    const wc = webContents as ObservableWebContents | undefined;
    if (!wc || typeof wc.id !== "number" || typeof wc.on !== "function") return;
    this.tabs.set(wc.id, { sessionId, tabId });
    this.ensureSession(sessionId, wc.session);
    wc.on("console-message", (...args: unknown[]) => {
      const entry = this.parseConsole(tabId, args);
      if (entry) this.push(this.consoleBySession, sessionId, entry);
    });
    wc.once?.("destroyed", () => {
      this.tabs.delete(wc.id);
    });
  }

  console(sessionId: string | undefined, limit: number): BrowserConsoleEntry[] {
    const list = this.consoleBySession.get(sessionId ?? "") ?? [];
    return list.slice(-limit);
  }

  network(sessionId: string | undefined, limit: number): BrowserNetworkEntry[] {
    const list = this.networkBySession.get(sessionId ?? "") ?? [];
    return list.slice(-limit);
  }

  /** 测试/会话关闭清理；不清空其他会话。 */
  clear(sessionId: string): void {
    this.consoleBySession.delete(sessionId);
    this.networkBySession.delete(sessionId);
    for (const [id, info] of this.tabs) {
      if (info.sessionId === sessionId) this.tabs.delete(id);
    }
  }

  private ensureSession(sessionId: string, session: ObservableSession | undefined): void {
    if (!session || typeof session !== "object" || this.wiredSessions.has(session)) return;
    this.wiredSessions.add(session);
    session.webRequest?.onCompleted?.((details) => {
      const info = this.tabOf(details);
      if (!info) return;
      this.push(this.networkBySession, info.sessionId, {
        tabId: info.tabId,
        method: (details.method ?? "GET").toUpperCase(),
        url: details.url ?? "",
        status: details.statusCode ?? 0,
        resourceType: details.resourceType,
        at: Date.now(),
      });
    });
    session.webRequest?.onErrorOccurred?.((details) => {
      const info = this.tabOf(details);
      if (!info) return;
      this.push(this.networkBySession, info.sessionId, {
        tabId: info.tabId,
        method: (details.method ?? "GET").toUpperCase(),
        url: details.url ?? "",
        status: 0,
        resourceType: details.resourceType,
        error: details.error ?? "NETWORK_ERROR",
        at: Date.now(),
      });
    });
  }

  private tabOf(details: WebRequestDetails): { sessionId: string; tabId: string } | undefined {
    if (typeof details.webContentsId !== "number") return undefined;
    return this.tabs.get(details.webContentsId);
  }

  private parseConsole(tabId: string, args: unknown[]): BrowserConsoleEntry | null {
    // Electron 45: (eventDetails, level, message, line, sourceId)。旧参数已弃用，
    // 但 eventDetails 上已有 level/message/sourceId；两者都兼容，避免未来参数移除后静默丢日志。
    const eventDetails = args[0];
    if (eventDetails && typeof eventDetails === "object") {
      const row = eventDetails as { level?: unknown; message?: unknown; sourceId?: unknown };
      if (typeof row.message === "string" && row.message) {
        return {
          tabId,
          level: this.levelOf(row.level),
          message: row.message,
          source: typeof row.sourceId === "string" ? row.sourceId : undefined,
          at: Date.now(),
        };
      }
    }
    const detail = args[1];
    if (detail && typeof detail === "object") {
      const row = detail as { level?: unknown; message?: unknown };
      const message = typeof row.message === "string" ? row.message : "";
      if (!message) return null;
      return {
        tabId,
        level: this.levelOf(row.level),
        message,
        at: Date.now(),
      };
    }
    const rawLevel = typeof args[1] === "number" || typeof args[1] === "string" ? args[1] : 1;
    const message = typeof args[2] === "string" ? args[2] : "";
    if (!message) return null;
    return {
      tabId,
      level: this.levelOf(rawLevel),
      message,
      source: typeof args[4] === "string" ? args[4] : undefined,
      at: Date.now(),
    };
  }

  private levelOf(value: unknown): BrowserConsoleEntry["level"] {
    if (typeof value === "number") {
      if (value >= 3) return "error";
      if (value === 2) return "warning";
      if (value === 1) return "info";
      return "debug";
    }
    const text = String(value ?? "").toLowerCase();
    if (text.includes("error")) return "error";
    if (text.includes("warn")) return "warning";
    if (text.includes("info")) return "info";
    return "debug";
  }

  private push<T>(store: Map<string, T[]>, sessionId: string, entry: T): void {
    const list = store.get(sessionId) ?? [];
    list.push(entry);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    store.set(sessionId, list);
  }
}
