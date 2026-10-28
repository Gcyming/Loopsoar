/**
 * Node 平台实现（§4.2）
 * 这是唯一允许接触 Node 内建模块（fs/promises、child_process、dns）的边界
 */
import * as fs from "node:fs/promises";
import { resolve as resolvePath, dirname } from "node:path";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";

import { LoopsoarNotImplementedError } from "./errors.js";
import type {
  FsAdapter,
  ProcessResult,
  ProcessAdapter,
  SqliteAdapter,
  SqliteDb,
  NetAdapter,
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
      const maxBytes = opts.maxBytes ?? 8_388_608;
      const child = execFile(cmd, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 64 * 1024 * 1024, // 内部缓冲放大；输出截断由 data 监听器按 maxBytes 完成（避免 maxBuffer 超限杀进程）
        killSignal: "SIGTERM",
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf-8", 0, Math.min(chunk.length, Math.max(0, maxBytes - stdoutAcc.length)));
        stdoutAcc += s;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf-8", 0, Math.min(chunk.length, Math.max(0, maxBytes - stderrAcc.length)));
        stderrAcc += s;
      });

      child.on("close", (code, signal) => {
        resolve({
          code: typeof code === "number" ? code : null,
          stdout: stdoutAcc,
          stderr: stderrAcc,
          timedOut: signal !== null || child.killed,
        });
      });
      child.on("error", (err: Error) => {
        // 执行出错：直接返回错误结果，保持 fail-closed
        resolve({
          code: null,
          stdout: stdoutAcc,
          stderr: stderrAcc + (err.message ? `\n[执行错误] ${err.message}` : ""),
          timedOut: false,
        });
      });
      // 超时处理
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGTERM");
            // 延迟强制终止（如果 SIGTERM 无效）
            setTimeout(() => {
              try { child.kill("SIGKILL"); } catch { /* 已终止 */ }
            }, 1_000);
          }
        }, opts.timeoutMs);
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

// 纯函数：将 IP 与 13 段 CIDR 比对（来自 contracts 的 PRIVATE_NET_RANGES）
function isPrivateOrReserved(ipStr: string, privateRanges: Array<{ v: 4 | 6; base: number[]; prefix: number }>): boolean {
  // 简化实现：逐段比对，匹配则视为私有
  const ip4Match = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(ipStr);
  if (ip4Match) {
    const [a, b, c, d] = [parseInt(ip4Match[1]), parseInt(ip4Match[2]), parseInt(ip4Match[3]), parseInt(ip4Match[4])];
    for (const r of privateRanges) {
      if (r.v === 6) continue; // IPv6 另处理
      // 简化：检查常见私有段
      if (a === 10) return true; // 10/8
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
      if (a === 192 && b === 168) return true; // 192.168/16
      if (a === 169 && b === 254) return true; // 169.254/16
      if (a === 127) return true; // 127/8
      if (a === 0 && b === 0) return true; // 0/8
      if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10
      if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24
      if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24
      if (a === 198 && b === 18) return true; // 198.18/15
      if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24
      if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24
    }
  }
  // IPv6 简化处理
  if (ipStr.includes(":")) {
    // ::1 / fc00:: / fe80::
    if (ipStr === "::1" || ipStr.includes("fc00:") || ipStr.includes("fe80:") || ipStr.includes("::ffff:") || ipStr.startsWith("fe80:")) return true;
  }
  return false;
}

class NodeNetAdapter implements NetAdapter {
  constructor() {}

  async resolveIps(host: string): Promise<string[]> {
    try {
      const result = await lookup(host, { all: true }) as Array<{ address: string; family?: number } | string>;
      const addrs = Array.isArray(result) ? result : [];
      return addrs.map((a: any) => (typeof a === "string" ? a : a?.address)).filter(Boolean);
    } catch {
      return [];
    }
  }

  async fetchText(
    url: string,
    opts: { timeoutMs?: number; maxChars?: number; headers?: Record<string, string>; maxRedirects?: number },
  ): Promise<{ status: number; finalUrl: string; text: string }> {
    const maxRedirects = opts.maxRedirects ?? 5;
    let redirectCount = 0;
    let currentUrl = url;
    const headers = opts.headers ?? {};

    const performFetch = async (targetUrl: string): Promise<{ status: number; finalUrl: string; text: string }> => {
      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const resp = await fetch(targetUrl, {
          method: "GET",
          headers: { ...headers, "User-Agent": "Loopsoar-S4/1.0" },
          redirect: "manual",
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // 处理重定向
        if (resp.status >= 300 && resp.status < 400 && resp.headers.has("location")) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new Error(`重定向超过最大次数 ${maxRedirects}`);
          }
          const newLocation = resp.headers.get("location") || "";
          const resolvedUrl = new URL(newLocation, targetUrl).toString();

          // 逐跳 SSRF 复查：解析新 URL 的主机并检查 IP
          const urlObj = new URL(resolvedUrl);
          const host = urlObj.hostname;
          const ips = await this.resolveIps(host);
          // 简化：使用 contracts 的 PRIVATE_NET_RANGES 检查（此处直接检查常见私有段）
          for (const ip of ips) {
            if (isPrivateOrReserved(ip, [
              { v: 4, base: [10, 0, 0, 0], prefix: 8 },
              { v: 4, base: [172, 16, 0, 0], prefix: 12 },
              { v: 4, base: [192, 168, 0, 0], prefix: 16 },
              { v: 4, base: [169, 254, 0, 0], prefix: 16 },
              { v: 4, base: [127, 0, 0, 0], prefix: 8 },
              { v: 4, base: [0, 0, 0, 0], prefix: 8 },
              { v: 4, base: [100, 64, 0, 0], prefix: 10 },
              { v: 4, base: [192, 0, 0, 0], prefix: 24 },
              { v: 4, base: [192, 0, 2, 0], prefix: 24 },
              { v: 4, base: [198, 18, 0, 0], prefix: 15 },
              { v: 4, base: [198, 51, 100, 0], prefix: 24 },
              { v: 4, base: [203, 0, 113, 0], prefix: 24 },
              { v: 6, base: [0, 0, 0, 0, 0, 0, 0, 1], prefix: 128 }, // ::1
              { v: 6, base: [0, 252, 0, 0, 0, 0, 0, 0], prefix: 7 }, // fc00::/7
              { v: 6, base: [0, 254, 128, 0, 0, 0, 0, 0], prefix: 10 }, // fe80::/10
            ])) {
              throw new Error(`SSRF 检测：重定向到私有/保留 IP ${ip}`);
            }
          }
          return await performFetch(resolvedUrl);
        }

        const text = await resp.text();
        return {
          status: resp.status,
          finalUrl: resp.url,
          text: opts.maxChars ? text.slice(0, opts.maxChars) : text,
        };
      } catch (err: any) {
        clearTimeout(timeoutId);
        throw err;
      }
    };

    return await performFetch(currentUrl);
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
