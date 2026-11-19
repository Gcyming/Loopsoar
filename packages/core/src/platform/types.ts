/**
 * 平台适配层接口定义（§4.2）
 * 这是 S3 与 S4 的契约边界：纯接口，无实现依赖
 */

export interface FsAdapter {
  readFileUtf8(p: string): Promise<string>;
  writeFileUtf8(p: string, data: string): Promise<void>;
  readDir(p: string): Promise<string[]>;
  stat(p: string): Promise<{ size: number; mtimeMs: number }>;
  exists(p: string): Promise<boolean>;
  resolve(p: string): string;
  isInside(root: string, p: string): boolean;
}

/**
 * 最小路径能力（core 不直接 import node:path）：工作根解析与越界判定都走注入。
 * 为什么单独成端口：Sandbox 是纯逻辑，路径语义（Windows 盘符 / POSIX）由平台适配层决定。
 */
export interface PathPort {
  resolve(...parts: string[]): string;
  isAbsolute(p: string): boolean;
  dirname(p: string): string;
  join(...parts: string[]): string;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessAdapter {
  run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs?: number; maxBytes?: number },
  ): Promise<ProcessResult>;
}

export interface SqliteDb {
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  close(): Promise<void>;
}

export interface SqliteAdapter {
  open(path: string): Promise<SqliteDb>;
}

/**
 * 网络请求选项（platform 层唯一出网入口）。
 * 为什么把 method/body 也放进适配层：DNS 钉扎必须由「真正发起连接的人」完成——
 * 先校验再交给全局 fetch 会重新解析 DNS，等于把钉扎让给了 TOCTOU。
 */
export interface NetRequestOptions {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** 响应体最大字符数（超出截断，防止上下文/主进程被撑爆）。 */
  maxChars?: number;
  /** 手动跟随 3xx 的上限（逐跳重新校验 + 重新解析 + 重新钉扎）。 */
  maxRedirects?: number;
  /** 是否允许回环目标（本地模型服务/E2E 本地页面）；默认 false。 */
  allowLoopback?: boolean;
}

export interface NetResponse {
  status: number;
  finalUrl: string;
  text: string;
  headers: Record<string, string>;
}

export interface NetAdapter {
  request(opts: NetRequestOptions): Promise<NetResponse>;
  fetchText(
    url: string,
    opts: {
      timeoutMs?: number;
      maxChars?: number;
      headers?: Record<string, string>;
      maxRedirects?: number;
    },
  ): Promise<{ status: number; finalUrl: string; text: string }>;
  resolveIps(host: string): Promise<string[]>;
}

export interface EmbedAdapter {
  embed(texts: string[]): Promise<number[][]>;
}

export interface LoopsoarPlatform {
  fs: FsAdapter;
  process: ProcessAdapter;
  sqlite: SqliteAdapter;
  net: NetAdapter;
  embed: EmbedAdapter;
}