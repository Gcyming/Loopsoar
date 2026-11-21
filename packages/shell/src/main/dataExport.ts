/**
 * 用户可操作的数据导出（发布阶段 §4.4/§4.5）：
 *   · exportDataBackup：把「用户数据」复制到用户选的目录（不含浏览器缓存/日志/旧备份）；
 *   · exportDiagnostics：把排查问题需要的最小集合（日志/崩溃/审计/版本/诊断 JSON）复制成诊断包。
 *
 * 为什么是「复制目录」而不是 zip：运行时不引入压缩依赖；用户可以自己打包，
 * 目录也便于在资源管理器里先看一眼有没有敏感内容。
 *
 * 约束：任何失败都以可读错误返回，不抛给 IPC 层；单文件/总量有上限，避免把磁盘写满。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { SKIP_NAMES } from "./dataBackup.js";

const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
/** 诊断包最多附带 10 个崩溃文件，避免 Crashpad 目录异常时无限遍历/复制。 */
const MAX_CRASH_DUMP_FILES = 10;

/**
 * Crashpad 的转储不在目录根部：Electron 的 crashDumps 指向 `<dataDir>\\Crashpad`，
 * 真正的 `.dmp` 通常在 `reports/`（附件在 `attachments/`）。只读顶层会永远拿不到 minidump，
 * 所以这里递归扫描若干层，并限制文件数与遍历目录数（崩溃目录可能被外部服务写入）。
 */
async function collectCrashDumpFiles(
  root: string,
  limit = MAX_CRASH_DUMP_FILES,
): Promise<Array<{ file: string; relative: string }>> {
  const found: Array<{ file: string; relative: string }> = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visitedDirs = 0;
  while (stack.length > 0 && found.length < limit && visitedDirs < 200) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    visitedDirs += 1;
    for (const entry of entries) {
      if (found.length >= limit) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !/\.(dmp|meta)$/i.test(entry.name)) continue;
      const relative = path.relative(root, full);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      found.push({ file: full, relative });
    }
  }
  return found;
}

export interface ExportResult {
  /** 导出目录绝对路径。 */
  path: string;
  files: number;
  bytes: number;
  /** 跳过的顶层条目（缓存/日志/旧备份等）。 */
  skipped: string[];
  error?: string;
}

interface CopyStats {
  files: number;
  bytes: number;
  skipped: string[];
}

/** 目录名时间戳：20261121-190500。 */
function stamp(date: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`;
}

async function copyTree(
  source: string,
  target: string,
  stats: CopyStats,
  options: { skipTopLevel?: ReadonlySet<string>; maxBytes?: number },
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_TOTAL_BYTES;
  const entries = await fsp.readdir(source, { withFileTypes: true });
  await fsp.mkdir(target, { recursive: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (options.skipTopLevel?.has(entry.name)) {
        stats.skipped.push(entry.name);
        continue;
      }
      await copyTree(from, to, stats, options);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fsp.stat(from);
    if (stats.bytes + stat.size > maxBytes) {
      throw new Error(`导出超过上限（${(maxBytes / 1024 / 1024 / 1024).toFixed(1)} GB），已中止`);
    }
    await fsp.copyFile(from, to);
    stats.files += 1;
    stats.bytes += stat.size;
  }
}

/**
 * 用户数据备份：目标目录下新建 loopsoar-backup-<version>-<时间>。
 * 排除项复用 dataBackup 的 SKIP_NAMES（浏览器缓存、日志、traces、旧备份、崩溃日志）。
 */
export async function exportDataBackup(options: {
  dataDir: string;
  targetDir: string;
  version: string;
  now?: () => number;
}): Promise<ExportResult> {
  const now = options.now ?? (() => Date.now());
  const target = path.join(options.targetDir, `loopsoar-backup-${options.version}-${stamp(new Date(now()))}`);
  const stats: CopyStats = { files: 0, bytes: 0, skipped: [] };
  // 目标目录若落在数据目录内（用户把备份放进数据目录），必须跳过它，否则会把正在写的备份再拷进备份。
  const relative = path.relative(path.resolve(options.dataDir), path.resolve(target));
  const inside = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  const skip = inside
    ? new Set([...SKIP_NAMES, relative.split(path.sep)[0]])
    : SKIP_NAMES;
  try {
    await fsp.mkdir(target, { recursive: true });
    await copyTree(options.dataDir, target, stats, { skipTopLevel: skip });
    return { path: target, files: stats.files, bytes: stats.bytes, skipped: stats.skipped };
  } catch (err) {
    return {
      path: target,
      files: stats.files,
      bytes: stats.bytes,
      skipped: stats.skipped,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 诊断包：目标目录下新建 loopsoar-diagnostics-<version>-<时间>。
 * 内容：diagnostics.json、main.log（含 .1）、crash.log（含 .1）、最近 2 份审计日志、
 *       version.json、可选 Crashpad minidump 目录，以及 README.txt（反馈说明）。
 */
export async function exportDiagnostics(options: {
  dataDir: string;
  targetDir: string;
  version: string;
  /** settings:diagnostics 的结果（路径/版本/存储模式等，不含密钥）。 */
  diagnostics: unknown;
  /** Electron crashDumps 目录（可选）。 */
  crashDumpsDir?: string;
  now?: () => number;
}): Promise<ExportResult & { included: string[] }> {
  const now = options.now ?? (() => Date.now());
  const target = path.join(options.targetDir, `loopsoar-diagnostics-${options.version}-${stamp(new Date(now()))}`);
  const stats: CopyStats = { files: 0, bytes: 0, skipped: [] };
  const included: string[] = [];
  try {
    await fsp.mkdir(target, { recursive: true });
    const copyIfExists = async (from: string, name = path.basename(from)): Promise<void> => {
      try {
        const stat = await fsp.stat(from);
        if (!stat.isFile()) return;
        const to = path.join(target, name);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(from, to);
        stats.files += 1;
        stats.bytes += stat.size;
        included.push(name);
      } catch {
        // 不存在：跳过
      }
    };
    await copyIfExists(path.join(options.dataDir, "version.json"));
    for (const name of ["main.log", "main.log.1", "crash.log", "crash.log.1"]) {
      await copyIfExists(path.join(options.dataDir, "logs", name));
    }
    const auditDir = path.join(options.dataDir, "logs");
    try {
      const audits = (await fsp.readdir(auditDir))
        .filter((name) => /^audit-\d{8}(\.\d+)?\.jsonl$/.test(name))
        .sort()
        .slice(-2);
      for (const name of audits) await copyIfExists(path.join(auditDir, name));
    } catch {
      // 没有审计目录：跳过
    }
    const diagJson = `${JSON.stringify(options.diagnostics, null, 2)}\n`;
    await fsp.writeFile(path.join(target, "diagnostics.json"), diagJson, "utf8");
    stats.files += 1;
    stats.bytes += Buffer.byteLength(diagJson);
    included.push("diagnostics.json");
    if (options.crashDumpsDir) {
      try {
        const dumps = await collectCrashDumpFiles(options.crashDumpsDir);
        for (const dump of dumps) {
          await copyIfExists(dump.file, path.join("crashdumps", dump.relative));
        }
      } catch {
        stats.skipped.push("crashDumps");
      }
    }
    const readme = [
      `Loopsoar ${options.version} 诊断包`,
      "",
      "包含：诊断 JSON、主进程日志、崩溃日志、最近审计日志、版本记录。",
      "不包含：API Key、会话正文、网页内容、记忆正文。",
      "提交问题前请自行检查内容；确认无敏感信息后再上传到 Issue。",
    ].join("\n");
    await fsp.writeFile(path.join(target, "README.txt"), readme, "utf8");
    stats.files += 1;
    stats.bytes += Buffer.byteLength(readme);
    included.push("README.txt");
    return { path: target, files: stats.files, bytes: stats.bytes, skipped: stats.skipped, included };
  } catch (err) {
    return {
      path: target,
      files: stats.files,
      bytes: stats.bytes,
      skipped: stats.skipped,
      included,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
