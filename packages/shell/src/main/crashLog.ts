/**
 * 崩溃取证写盘（纯模块，不 import electron；Electron 事件由 index.ts 注册）。
 *
 * 为什么单独拆：主进程入口已经超过体量预算，而「轮转 + 版本元信息 + 脱敏」是可单测的
 * 纯逻辑，留在入口只会让组合根继续膨胀。
 *
 * 口径：
 *   · 每条都带版本 / Electron / Node / 平台：用户只发一行也能对上构建；
 *   · 超过 2MB 轮转一次（保留 crash.log.1），避免内测长期运行写满磁盘；
 *   · 写盘失败吞掉：崩溃取证是旁路，不能反过来阻断启动。
 */
import fs from "node:fs";
import path from "node:path";
import { crashLogReplacer } from "./logRedaction.js";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export interface CrashLogContext {
  dataDir: string;
  /** 应用版本（APP_VERSION）。 */
  version: string;
  /** process.versions（只取 electron/node）。 */
  versions: { electron?: string; node: string };
  platform: string;
  arch: string;
  maxBytes?: number;
}

export interface CrashLog {
  /** crash.log 的绝对路径（诊断页/反馈指引用）。 */
  path: string;
  write(kind: string, detail: unknown): void;
}

export function createCrashLog(context: CrashLogContext): CrashLog {
  const file = path.join(context.dataDir, "crash.log");
  const maxBytes = context.maxBytes ?? DEFAULT_MAX_BYTES;
  const meta = `v${context.version} electron=${context.versions.electron ?? "-"} node=${context.versions.node} ${context.platform}-${context.arch}`;

  /** 轮转（只保留 1 份历史）；文件不存在/改名失败都不阻断。 */
  function rotate(): void {
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
    } catch {
      // 首次写入 / 并发改名：继续写当前文件
    }
  }

  return {
    path: file,
    write(kind: string, detail: unknown): void {
      try {
        rotate();
        fs.appendFileSync(
          file,
          `${new Date().toISOString()} [${meta}] ${kind} ${JSON.stringify(detail, crashLogReplacer)}\n`,
        );
      } catch {
        // 日志写不进去不阻断启动
      }
    },
  };
}
