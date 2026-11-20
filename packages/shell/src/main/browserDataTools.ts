/**
 * 浏览器「状态面」工具：下载、Cookie、控制台、网络、文件上传。
 *
 * 设计约束：
 *   · 只依赖注入的 hooks，不 import electron；主进程负责把 Electron/DownloadsBridge/
 *     BrowserObservability 接到 hooks；
 *   · Cookie 只返回元数据（名称/域/路径/安全属性），**绝不把 cookie 值交给模型**；
 *   · 下载只读列表；上传文件由主进程先做会话根目录校验，工具层只传路径；
 *   · 所有输出都有上限，错误返回 ok:false，不抛异常。
 */
import { z } from "zod";
import type { ToolDefinition, ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";

export interface BrowserDownloadView {
  id: string;
  filename: string;
  savePath: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  received: number;
  total: number;
  startedAt: number;
}

export interface BrowserCookieView {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite?: string;
}

export interface BrowserConsoleEntry {
  tabId: string;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  source?: string;
  at: number;
}

export interface BrowserNetworkEntry {
  tabId: string;
  method: string;
  url: string;
  status: number;
  resourceType?: string;
  error?: string;
  at: number;
}

export interface BrowserDataHooks {
  downloads?: { list(): BrowserDownloadView[] };
  cookies?: (sessionId: string | undefined, url?: string) => Promise<BrowserCookieView[]>;
  console?: (sessionId: string | undefined, limit: number) => BrowserConsoleEntry[];
  network?: (sessionId: string | undefined, limit: number) => BrowserNetworkEntry[];
  /** files 已由主进程做会话根目录校验；返回可读结果。 */
  upload?: (
    sessionId: string | undefined,
    selector: string,
    files: string[],
  ) => Promise<{ ok: boolean; message: string }>;
}

const MAX_LIMIT = 200;
const MAX_UPLOAD_FILES = 10;
const DOWNLOAD_WAIT_MS_MAX = 120_000;

const DownloadSchema = z.object({
  action: z.enum(["list", "wait"]).default("list"),
  /** 只等某个文件名（包含匹配）；缺省等任意一个下载完成。 */
  filename: z.string().trim().min(1).max(200).optional(),
  /** wait 的最长等待时间；默认 30 秒。 */
  timeoutMs: z.number().int().min(1).max(DOWNLOAD_WAIT_MS_MAX).default(30_000),
});

const CookiesSchema = z.object({
  /** 只读该 URL 的 cookie；缺省用当前活动标签。 */
  url: z.string().trim().max(2_000).optional(),
});

const DiagnosticsSchema = z.object({
  kind: z.enum(["console", "network"]),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(50),
  /** console 过滤；network 忽略。 */
  level: z.enum(["all", "debug", "info", "warning", "error"]).default("all"),
});

const UploadSchema = z.object({
  /** 只接受 CSS 选择器（必须是 input[type=file]）；避免坐标误传。 */
  target: z.string().trim().min(1).max(500),
  files: z.array(z.string().trim().min(1).max(2_000)).min(1).max(MAX_UPLOAD_FILES),
});

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `[${code}] ${message}` };
}

function fmtBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDownloads(list: BrowserDownloadView[]): string {
  if (list.length === 0) return "没有下载记录。";
  const lines = [`下载记录 ${list.length} 项：`];
  for (const item of list.slice(0, 20)) {
    const progress = item.total > 0 ? `${fmtBytes(item.received)}/${fmtBytes(item.total)}` : fmtBytes(item.received);
    lines.push(
      `[${item.id}] ${item.state} ${progress} ${clip(item.filename, 100)}`
      + (item.savePath ? ` → ${item.savePath}` : ""),
    );
  }
  if (list.length > 20) lines.push(`…还有 ${list.length - 20} 项未显示`);
  return lines.join("\n");
}

function waitForDownload(
  list: BrowserDownloadView[],
  filename: string | undefined,
): BrowserDownloadView | undefined {
  const wanted = filename?.toLowerCase();
  return list.find((item) => {
    if (item.state === "progressing") return false;
    if (!wanted) return true;
    return item.filename.toLowerCase().includes(wanted) || item.id.toLowerCase() === wanted;
  });
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}

export function registerBrowserDataTools(registry: ToolRegistry, hooks: BrowserDataHooks): void {
  const downloadsTool: ToolDefinition = {
    name: "browser_downloads",
    description:
      "查看浏览器下载列表，或等待某个下载结束。只读；不会打开文件。点击触发下载后用它确认完成。",
    permissions: { read: true, browser: true },
    schema: DownloadSchema,
    async execute(ctx): Promise<ToolResult> {
      const parsed = DownloadSchema.safeParse(ctx.params ?? {});
      if (!parsed.success) return fail("INVALID_INPUT", "参数不合法：action/filename/timeoutMs");
      const { action, filename, timeoutMs } = parsed.data;
      const list = (): BrowserDownloadView[] => hooks.downloads?.list() ?? [];
      if (action === "list") return { ok: true, content: formatDownloads(list()) };

      const started = Date.now();
      try {
        for (;;) {
          const hit = waitForDownload(list(), filename);
          if (hit) {
            const progress = hit.total > 0 ? `${fmtBytes(hit.received)}/${fmtBytes(hit.total)}` : fmtBytes(hit.received);
            return {
              ok: hit.state === "completed",
              content: `${hit.state === "completed" ? "下载完成" : `下载${hit.state}`}：${hit.filename}（${progress}）`
                + (hit.savePath ? `\n路径：${hit.savePath}` : ""),
            };
          }
          const left = timeoutMs - (Date.now() - started);
          if (left <= 0) return fail("TIMEOUT", `等待下载超时（${timeoutMs}ms）；用 browser_downloads action="list" 查看当前状态`);
          await sleep(Math.min(250, left), ctx.signal);
        }
      } catch {
        return fail("ABORTED", "等待下载被取消");
      }
    },
  };

  const cookiesTool: ToolDefinition = {
    name: "browser_cookies",
    description:
      "读取当前页面（或指定 URL）的 Cookie 元数据：名称、域、路径、Secure/HttpOnly/过期时间。不返回值内容，避免泄露会话密钥。",
    permissions: { read: true, browser: true },
    schema: CookiesSchema,
    async execute(ctx): Promise<ToolResult> {
      const parsed = CookiesSchema.safeParse(ctx.params ?? {});
      if (!parsed.success) return fail("INVALID_INPUT", "参数不合法：url");
      if (!hooks.cookies) return fail("UNSUPPORTED", "当前浏览器后端不支持读取 Cookie");
      try {
        const list = await hooks.cookies(ctx.sessionId, parsed.data.url);
        if (list.length === 0) return { ok: true, content: "没有可读取的 Cookie（或当前页面不是 http/https）。" };
        const lines = [`Cookie ${list.length} 项（仅元数据，值已隐藏）：`];
        for (const item of list.slice(0, 80)) {
          const flags = [item.secure ? "Secure" : "", item.httpOnly ? "HttpOnly" : "", item.sameSite ?? ""]
            .filter(Boolean)
            .join(" ");
          lines.push(`- ${item.name}  domain=${item.domain}  path=${item.path}${flags ? `  ${flags}` : ""}`);
        }
        if (list.length > 80) lines.push(`…还有 ${list.length - 80} 项未显示`);
        return { ok: true, content: lines.join("\n") };
      } catch (error) {
        return fail("COOKIE_READ_FAILED", error instanceof Error ? error.message : String(error));
      }
    },
  };

  const diagnosticsTool: ToolDefinition = {
    name: "browser_diagnostics",
    description:
      "读取浏览器控制台日志或网络请求记录（当前会话的全部标签）。kind=console 用于页面报错；kind=network 用于 4xx/5xx、接口失败和资源加载。",
    permissions: { read: true, browser: true },
    schema: DiagnosticsSchema,
    async execute(ctx): Promise<ToolResult> {
      const parsed = DiagnosticsSchema.safeParse(ctx.params ?? {});
      if (!parsed.success) return fail("INVALID_INPUT", "参数不合法：kind/limit/level");
      const { kind, limit, level } = parsed.data;
      if (kind === "console") {
        const entries = (hooks.console?.(ctx.sessionId, MAX_LIMIT) ?? [])
          .filter((item) => level === "all" || item.level === level)
          .slice(-limit);
        if (entries.length === 0) return { ok: true, content: "没有控制台日志。" };
        const lines = [`控制台 ${entries.length} 条（最新在后）：`];
        for (const item of entries) {
          lines.push(`[${item.level}] ${clip(item.message, 500)}${item.source ? ` (${clip(item.source, 160)})` : ""}`);
        }
        return { ok: true, content: lines.join("\n") };
      }

      const entries = (hooks.network?.(ctx.sessionId, MAX_LIMIT) ?? []).slice(-limit);
      if (entries.length === 0) return { ok: true, content: "没有网络请求记录。" };
      const lines = [`网络请求 ${entries.length} 条（最新在后）：`];
      for (const item of entries) {
        const status = item.error ? `ERR ${clip(item.error, 120)}` : String(item.status);
        lines.push(`[${status}] ${item.method} ${clip(item.url, 500)}${item.resourceType ? ` (${item.resourceType})` : ""}`);
      }
      return { ok: true, content: lines.join("\n") };
    },
  };

  const uploadTool: ToolDefinition = {
    name: "browser_upload",
    description:
      "给页面里的 input[type=file] 选择本地文件（最多 10 个）。target 必须是 CSS 选择器；文件必须位于当前会话工作区内。",
    permissions: { write: true, browser: true },
    schema: UploadSchema,
    async execute(ctx): Promise<ToolResult> {
      const parsed = UploadSchema.safeParse(ctx.params ?? {});
      if (!parsed.success) return fail("INVALID_INPUT", "参数不合法：target 必须是 CSS 选择器，files 为 1–10 个路径");
      if (!hooks.upload) return fail("UNSUPPORTED", "当前浏览器后端不支持文件上传");
      try {
        const result = await hooks.upload(ctx.sessionId, parsed.data.target, parsed.data.files);
        return result.ok ? { ok: true, content: result.message } : fail("UPLOAD_FAILED", result.message);
      } catch (error) {
        return fail("UPLOAD_FAILED", error instanceof Error ? error.message : String(error));
      }
    },
  };

  for (const tool of [downloadsTool, cookiesTool, diagnosticsTool, uploadTool]) {
    registry.register(tool, { force: true });
  }
}
