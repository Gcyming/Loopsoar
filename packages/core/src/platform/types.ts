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

export interface NetAdapter {
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