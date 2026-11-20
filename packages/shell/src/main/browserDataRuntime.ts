/**
 * 浏览器「状态面」工具接线：把 DownloadsBridge / BrowserHost / Electron session
 * 的差异收敛在一个模块里，index.ts 只留一行调用（它已接近 1500 行守卫）。
 */
import fs from "node:fs";
import path from "node:path";
import type { ToolRegistry } from "loopsoar-core/tools/registry";
import {
  registerBrowserDataTools,
  type BrowserConsoleEntry,
  type BrowserCookieView,
  type BrowserDownloadView,
  type BrowserNetworkEntry,
} from "./browserDataTools.js";

interface HostLike {
  listTabs(sessionId?: string): Array<{ url: string; active: boolean }>;
  /** 会话没有任务页时，只读工具回落到用户全局标签（与 browser_snapshot 同一规则）。 */
  readableUrl?(sessionId?: string): string;
  /** 写操作（上传）必须落在会话自己的任务页上：没有就克隆用户当前页建一个。 */
  ensureAgentTab?(sessionId?: string): Promise<string | null>;
  console(sessionId: string | undefined, limit: number): BrowserConsoleEntry[];
  network(sessionId: string | undefined, limit: number): BrowserNetworkEntry[];
  uploadFiles(sessionId: string | undefined, selector: string, files: string[]): Promise<{ ok: boolean; message: string }>;
}

interface CookieRow {
  name: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: string;
}

export function registerBrowserDataRuntime(
  registry: ToolRegistry,
  getHost: () => HostLike | null,
  downloads: { list(): BrowserDownloadView[] },
  resolveRoot: (sessionId?: string) => string,
  getCookies: (url: string) => Promise<CookieRow[]>,
): void {
  registerBrowserDataTools(registry, {
    downloads: { list: () => downloads.list() },
    cookies: async (sessionId, url) => {
      const tabs = getHost()?.listTabs(sessionId) ?? [];
      // 会话没有自己的任务页时，回落到用户全局标签的当前地址：
      // 只读查询不该因为「Agent 还没克隆页面」而返回空。
      const target = (url ?? tabs.find((tab) => tab.active)?.url ?? getHost()?.readableUrl?.(sessionId) ?? "").trim();
      if (!/^https?:\/\//i.test(target)) return [];
      const rows = await getCookies(target);
      return rows.map((cookie): BrowserCookieView => ({
        name: cookie.name,
        domain: cookie.domain ?? "",
        path: cookie.path ?? "/",
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
        expirationDate: cookie.expirationDate,
        sameSite: cookie.sameSite,
      }));
    },
    console: (sessionId, limit) => getHost()?.console(sessionId, limit) ?? [],
    network: (sessionId, limit) => getHost()?.network(sessionId, limit) ?? [],
    upload: async (sessionId, selector, requested) => {
      const host = getHost();
      if (!host) return { ok: false, message: "浏览器宿主尚未就绪" };
      // 上传是写操作：必须落在会话自己的任务页上。没有任务页就先克隆用户当前页，
      // 否则会出现「文件校验通过、却没有 input 可写」的假失败。
      if (typeof host.ensureAgentTab === "function") {
        const tabId = await host.ensureAgentTab(sessionId);
        if (!tabId) return { ok: false, message: "当前会话没有可用的页面标签，无法上传" };
      }
      const root = resolveRoot(sessionId);
      const files: string[] = [];
      for (const raw of requested) {
        const abs = path.resolve(root, raw);
        const rel = path.relative(root, abs);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new Error(`文件不在当前会话工作区：${raw}`);
        }
        if (!fs.statSync(abs).isFile()) throw new Error(`不是普通文件：${raw}`);
        files.push(abs);
      }
      return host.uploadFiles(sessionId, selector, files);
    },
  });
}
