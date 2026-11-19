/**
 * Node 平台实现（§4.2）
 * 这是唯一允许接触 Node 内建模块（fs/promises、child_process、dns、http/https）的边界
 *
 * 网络安全约定：NetAdapter.request 是 Agent 出网的唯一实现——
 *   1) 先做纯 URL 判据（../net/ssrf：协议/主机名/IP/端口）；
 *   2) 再做 DNS 解析判据，任一私网/保留 IP 即拒；
 *   3) 连接钉扎：TCP 直接连到已校验的 IP（不交给 DNS 再解析一次，堵住 DNS rebinding TOCTOU），
 *      但 Host 头与 TLS servername 保持原主机名，虚拟主机/证书校验语义不变；
 *   4) 3xx 手动逐跳跟随，每一跳重新校验+重新解析+重新钉扎。
 */
import * as fs from "node:fs/promises";
import { resolve as resolvePath, dirname } from "node:path";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";

import { MAX_REDIRECTS } from "loopsoar-contracts/security-policy";
import { LoopsoarNotImplementedError } from "./errors.js";
import { assertPublicUrlWithDns, isIpLiteral } from "../net/ssrf.js";
import type {
  FsAdapter,
  ProcessResult,
  ProcessAdapter,
  SqliteAdapter,
  SqliteDb,
  NetAdapter,
  NetRequestOptions,
  NetResponse,
  EmbedAdapter,
  LoopsoarPlatform,
} from "./types.js";

class NodeFsAdapter implements FsAdapter {
  async readFileUtf8(p: string): Promise<string> {
    return await fs.readFile(p, { encoding: "utf-8" });
  }
  async writeFileUtf8(p: string, data: string): Promise<void> {
    await fs.mkdir(dirname(p), { recursive: true }).catch(() => {});
    await fs.writeFile(p, data, { encoding: "utf-8" });
  }
  async readDir(p: string): Promise<string[]> {
    try {
      return await fs.readdir(p, { withFileTypes: false });
    } catch {
      return [];
    }
  }
  async stat(p: string): Promise<{ size: number; mtimeMs: number }> {
    const s = await fs.stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  }
  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
  resolve(p: string): string {
    return resolvePath(p);
  }
  isInside(root: string, p: string): boolean {
    const r = resolvePath(root);
    const t = resolvePath(p);
    return t === r || t.startsWith(r + (r.endsWith("/") || r.endsWith("\\") ? "" : "/")) || t.startsWith(r + "\\");
  }
}

class NodeProcessAdapter implements ProcessAdapter {
  async run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs?: number; maxBytes?: number },
  ): Promise<ProcessResult> {
    return new Promise((resolve) => {
      let stdoutAcc = "";
      let stderrAcc = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutDecoder = new TextDecoder("utf-8");
      const stderrDecoder = new TextDecoder("utf-8");
      let settled = false;
      const maxBytes = opts.maxBytes ?? 8_388_608;
      const child = execFile(cmd, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 64 * 1024 * 1024, // 内部缓冲放大；输出截断由 data 监听器按 maxBytes 完成（避免 maxBuffer 超限杀进程）
        killSignal: "SIGTERM",
      });

      // 超时定时器必须在结束时清掉：否则进程提前退出后定时器仍挂着，
      // 既阻止进程退出（Electron 退出被拖住），又会误杀复用的 pid/句柄。
      let killTimer: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const clearTimers = (): void => {
        if (killTimer) clearTimeout(killTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        killTimer = undefined;
        forceKillTimer = undefined;
      };
      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(result);
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const room = maxBytes - stdoutBytes;
        if (room <= 0) return;
        const slice = bytes.length <= room ? bytes : bytes.subarray(0, room);
        stdoutBytes += slice.length;
        // TextDecoder(stream) 保留跨 chunk 的多字节尾部；直接 chunk.toString 会把中文切坏。
        stdoutAcc += stdoutDecoder.decode(slice, { stream: true });
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const room = maxBytes - stderrBytes;
        if (room <= 0) return;
        const slice = bytes.length <= room ? bytes : bytes.subarray(0, room);
        stderrBytes += slice.length;
        stderrAcc += stderrDecoder.decode(slice, { stream: true });
      });

      child.on("close", (code, signal) => {
        stdoutAcc += stdoutDecoder.decode();
        stderrAcc += stderrDecoder.decode();
        finish({
          code: typeof code === "number" ? code : null,
          stdout: stdoutAcc,
          stderr: stderrAcc,
          timedOut: signal !== null || child.killed,
        });
      });
      child.on("error", (err: Error) => {
        // 执行出错：直接返回错误结果，保持 fail-closed
        finish({
          code: null,
          stdout: stdoutAcc,
          stderr: stderrAcc + (err.message ? `\n[执行错误] ${err.message}` : ""),
          timedOut: false,
        });
      });
      // 超时处理：SIGTERM 后 1s 仍不退再 SIGKILL（execFile 自带 timeout 兜底）
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        killTimer = setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGTERM");
            forceKillTimer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                /* 已终止 */
              }
            }, 1_000);
          }
        }, opts.timeoutMs);
        killTimer.unref?.();
      }
    });
  }
}

class NodeSqliteAdapter implements SqliteAdapter {
  async open(_path: string): Promise<SqliteDb> {
    // P4 引入 better-sqlite3 后实现；当前阶段拒绝
    throw new LoopsoarNotImplementedError("sqlite 于 P4 引入 better-sqlite3 后实现");
  }
}

/* ────────────────────────────── 网络请求（DNS 钉扎） ────────────────────────────── */

interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function normalizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/** 网络错误 → 可读中文（tool/UI 直接展示；不含请求体等敏感信息）。 */
function normalizeNetError(err: unknown): Error {
  const e = err as NodeJS.ErrnoException | undefined;
  const code = typeof e?.code === "string" ? e.code : "";
  const message = e instanceof Error ? e.message : String(err);
  if (message === "LOOPSOAR_TIMEOUT") return new Error("网络请求超时");
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return new Error("网络请求超时");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new Error("DNS 解析失败（目标主机不存在）");
  if (code === "ECONNREFUSED") return new Error("连接被拒绝（目标端口未监听）");
  if (code === "ECONNRESET") return new Error("连接被重置");
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return new Error("目标网络不可达");
  if (/CERT|TLS|SSL|EPROTO/i.test(code) || /certificate|self.signed|altnames|SSL|TLS/i.test(message)) {
    return new Error(`TLS 证书校验失败（${message}）`);
  }
  return new Error(`网络请求失败：${message}`);
}

class NodeNetAdapter implements NetAdapter {
  async resolveIps(host: string): Promise<string[]> {
    try {
      const result = (await lookup(host, { all: true })) as Array<{ address?: string } | string>;
      const seen = new Set<string>();
      const out: string[] = [];
      for (const entry of result) {
        const address = typeof entry === "string" ? entry : entry?.address;
        if (!address || seen.has(address)) continue;
        seen.add(address);
        out.push(address);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 抓取文本（历史接口）：直接委托 request，保证与 DNS 钉扎抓取走同一条安全路径。 */
  async fetchText(
    url: string,
    opts: { timeoutMs?: number; maxChars?: number; headers?: Record<string, string>; maxRedirects?: number },
  ): Promise<{ status: number; finalUrl: string; text: string }> {
    const response = await this.request({
      url,
      method: "GET",
      headers: opts.headers,
      timeoutMs: opts.timeoutMs,
      maxChars: opts.maxChars,
      maxRedirects: opts.maxRedirects,
    });
    return { status: response.status, finalUrl: response.finalUrl, text: response.text };
  }

  async request(opts: NetRequestOptions): Promise<NetResponse> {
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
    const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
    const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : 1_000_000;
    const deadline = Date.now() + timeoutMs;

    let currentUrl = opts.url;
    let method: "GET" | "POST" = opts.method ?? "GET";
    let body: string | undefined = opts.body;
    let redirects = 0;

    while (true) {
      const { url, ips } = await assertPublicUrlWithDns(currentUrl, (host) => this.resolveIps(host), {
        allowLoopback: opts.allowLoopback === true,
      });
      if (ips.length === 0) throw new Error("SSRF 拦截：目标主机没有可用 IP");

      const response = await this.requestWithFallback(url, ips, method, body, opts.headers, maxChars, deadline);
      const location = response.headers["location"];
      if (isRedirectStatus(response.status) && location) {
        if (redirects >= maxRedirects) {
          throw new Error(`网络请求失败：重定向超过最大次数 ${maxRedirects}`);
        }
        redirects += 1;
        const nextUrl = new URL(location, url);
        // 浏览器语义：301/302/303 把 POST 降级为 GET 并丢弃 body（307/308 保留）
        if (method === "POST" && (response.status === 301 || response.status === 302 || response.status === 303)) {
          method = "GET";
          body = undefined;
        }
        currentUrl = nextUrl.toString();
        continue;
      }
      return {
        status: response.status,
        finalUrl: url.toString(),
        text: response.text,
        headers: response.headers,
      };
    }
  }

  /**
   * 依次尝试 DNS 解析出的多个 IP（仍全部是已校验 IP，不会重新解析）。
   * 为什么需要：localhost 常同时解析出 ::1 与 127.0.0.1，而本地服务往往只监听其中一个；
   * 公网双栈主机在无 IPv6 网络下也会出现首个地址不可达。
   */
  private async requestWithFallback(
    url: URL,
    ips: string[],
    method: "GET" | "POST",
    body: string | undefined,
    extraHeaders: Record<string, string> | undefined,
    maxChars: number,
    deadline: number,
  ): Promise<RawHttpResponse> {
    let lastError: unknown;
    for (const ip of ips) {
      if (Date.now() >= deadline) break;
      try {
        return await this.requestPinned(url, ip, method, body, extraHeaders, maxChars, deadline);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("网络请求失败：目标地址全部不可达");
  }

  /** 单跳请求：TCP 连 pinnedIp，Host/servername 保持原主机名。 */
  private requestPinned(
    url: URL,
    pinnedIp: string,
    method: "GET" | "POST",
    body: string | undefined,
    extraHeaders: Record<string, string> | undefined,
    maxChars: number,
    deadline: number,
  ): Promise<RawHttpResponse> {
    return new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new Error("网络请求超时"));
        return;
      }
      const isHttps = url.protocol === "https:";
      const transport = isHttps ? https : http;
      const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

      const headers: Record<string, string | number> = {
        "user-agent": "Loopsoar-S4/1.0",
        accept: "text/html,application/json,text/plain,*/*",
        ...(extraHeaders ?? {}),
        // 关键：连接打到 IP，但 Host 头保持原主机名（虚拟主机路由 + 证书校验语义不变）
        host: url.host,
      };
      if (body !== undefined) {
        headers["content-length"] = Buffer.byteLength(body, "utf8");
        if (!hasHeader(extraHeaders, "content-type")) headers["content-type"] = "application/json; charset=utf-8";
      }

      const options: https.RequestOptions = {
        host: pinnedIp,
        port,
        method,
        path: `${url.pathname || "/"}${url.search}`,
        headers,
        agent: false,
      };
      // SNI/证书校验用原主机名；目标是 IP 字面量时不设 servername（否则会按域名规则校验 IP 证书）
      if (isHttps && !isIpLiteral(url.hostname)) {
        options.servername = url.hostname;
      }

      let settled = false;
      const finish = (result: RawHttpResponse): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(normalizeNetError(err));
      };

      const req = transport.request(options, (res) => {
        const chunks: string[] = [];
        let collected = 0;
        const decoder = new TextDecoder("utf-8");
        const status = res.statusCode ?? 0;
        const headersOut = normalizeHeaders(res.headers);
        const finishBody = (): void => {
          chunks.push(decoder.decode());
          finish({ status, headers: headersOut, text: chunks.join("") });
        };

        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          const piece = decoder.decode(chunk, { stream: true });
          const room = maxChars - collected;
          if (room <= 0) {
            // 语义是「取前 maxChars 个字符」：够了就收尾，避免把整页下载进内存
            finishBody();
            res.destroy();
            return;
          }
          if (piece.length <= room) {
            chunks.push(piece);
            collected += piece.length;
            return;
          }
          chunks.push(piece.slice(0, room));
          collected = maxChars;
          finishBody();
          res.destroy();
        });
        res.on("end", finishBody);
        res.on("error", (err: Error) => {
          // 主动截断后的 socket 错误不再上报（数据已按 maxChars 收齐）
          if (!settled) fail(err);
        });
      });
      req.on("error", fail);
      req.setTimeout(Math.max(1, remaining), () => {
        req.destroy(new Error("LOOPSOAR_TIMEOUT"));
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

class NodeEmbedAdapter implements EmbedAdapter {
  private baseUrl: string;
  constructor(opts?: { baseUrl?: string }) {
    // 项目隔离：Loopsoar 使用独立嵌入端口（slime 用 8999，避免共享同一 llama-server 实例互相串扰）
    this.baseUrl = opts?.baseUrl ?? "http://127.0.0.1:8991";
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const resp = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ input: texts }),
      });
      if (!resp.ok) {
        throw new LoopsoarNotImplementedError("llama-server 未运行");
      }
      const json = await resp.json();
      const embeddings: number[][] = [];
      if (Array.isArray(json.data)) {
        for (const item of json.data) {
          embeddings.push(Array.isArray(item?.embedding) ? item.embedding : []);
        }
      }
      if (embeddings.length === 0 && texts.length > 0) {
        throw new LoopsoarNotImplementedError("llama-server 未运行");
      }
      return embeddings;
    } catch (err: any) {
      if (err instanceof LoopsoarNotImplementedError) throw err;
      throw new LoopsoarNotImplementedError("llama-server 未运行");
    }
  }
}

export function createNodePlatform(opts?: { embedBaseUrl?: string }): LoopsoarPlatform {
  return {
    fs: new NodeFsAdapter(),
    process: new NodeProcessAdapter(),
    sqlite: new NodeSqliteAdapter(),
    net: new NodeNetAdapter(),
    embed: new NodeEmbedAdapter({ baseUrl: opts?.embedBaseUrl }),
  };
}

export { NodeFsAdapter, NodeProcessAdapter, NodeSqliteAdapter, NodeNetAdapter, NodeEmbedAdapter };
