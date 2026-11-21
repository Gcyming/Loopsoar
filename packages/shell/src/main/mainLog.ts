/**
 * 主进程日志落盘（安装包排查用）。
 *
 * 为什么需要：Windows GUI 安装包没有控制台，console.error 里的 preload 加载失败、
 * 渲染进程报错、扩展/子进程异常全部丢失，只剩 crash.log（只记未捕获异常）。
 * 这里把 console.error / console.warn 复制一份到 <dataDir>/logs/main.log，并保留终端输出。
 *
 * 约束：
 *   · 只包装 error/warn（log/info 太吵，且多为开发期输）；
 *   · 单文件 5MB 轮转一次（main.log.1），避免长期运行写满磁盘；
 *   · 写盘失败一律吞掉：日志是旁路，不能反过来拖垮主流程；
 *   · 输出前走 logRedaction，避免异常对象里夹带密钥。
 */
import fs from "node:fs";
import path from "node:path";
import { redactDeep, redactText } from "./logRedaction.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function formatArg(value: unknown): string {
  let text: string;
  if (value instanceof Error) text = `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  else if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(redactDeep(value)) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  // 异常堆栈与普通字符串同样可能夹带密钥：统一走字符串级脱敏。
  return redactText(text);
}

export interface MainLogHandle {
  file: string;
  /** 恢复原始 console 方法（测试用；生产进程退出自然结束）。 */
  restore(): void;
}

/** 安装包专用入口：只在打包态启用，开发态保留终端输出不被文件写拖慢。 */
export function installMainLogIfPackaged(dataDir: string, packaged: boolean): void {
  if (!packaged) return;
  const handle = installMainLog(dataDir);
  console.log("[Loopsoar] 主进程日志：", handle.file);
}

export function installMainLog(dataDir: string, options: { maxBytes?: number } = {}): MainLogHandle {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const dir = path.join(dataDir, "logs");
  const file = path.join(dir, "main.log");
  mkdir();
  let bytes = size();

  function mkdir(): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // 目录不可写：后续 append 会失败并被吞掉
    }
  }
  function size(): number {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }
  function rotate(): void {
    if (bytes <= maxBytes) return;
    try {
      fs.renameSync(file, `${file}.1`);
    } catch {
      // 改名失败：继续追加（宁可超限也不丢日志）
    }
    bytes = 0;
  }
  function write(level: string, args: unknown[]): void {
    try {
      const line = `${new Date().toISOString()} ${level} ${args.map(formatArg).join(" ")}\n`;
      rotate();
      fs.appendFileSync(file, line, "utf8");
      bytes += Buffer.byteLength(line);
    } catch {
      // 旁路失败不影响主流程
    }
  }

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args: unknown[]): void => {
    write("ERROR", args);
    originalError(...args);
  };
  console.warn = (...args: unknown[]): void => {
    write("WARN", args);
    originalWarn(...args);
  };
  return {
    file,
    restore: () => {
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}
