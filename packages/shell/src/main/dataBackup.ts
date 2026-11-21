/**
 * 升级前数据备份（发布门：升级不可逆时用户要能退回去）。
 *
 * 口径：
 *   · 只在本机记录的版本号与当前版本不同时备份（首次启动没有旧数据，不备份）；
 *   · 备份到 <dataDir>/backups/pre-<旧版本>-<时间戳>/，整目录拷贝但排除可再生缓存
 *     （Chromium 缓存、日志、traces、上一次备份本身），这些占空间且没有恢复价值；
 *   · 单文件超过 64MB 跳过并记录（多为导出的媒体文件），避免备份把磁盘写满；
 *   · 版本记录写 <dataDir>/version.json：{ version, firstRunAt, lastRunAt }。
 *   · 任何失败都只记录，不阻断启动（备份是尽力而为，不是启动前置条件）。
 */
import fs from "node:fs";
import path from "node:path";

/** 版本记录文件名（与 Electron 的 version 无关，只用于判断「升级了没有」）。 */
export const VERSION_FILE = "version.json";
/** 备份根目录名（位于 dataDir 下）。 */
export const BACKUP_DIR = "backups";
/** 单文件上限：超过则跳过，记录在 skipped。 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** 可再生/无恢复价值的目录与文件：不进入升级备份。 */
export const SKIP_NAMES = new Set([
  BACKUP_DIR,
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "GrShaderCache",
  "Crashpad",
  "logs",
  "traces",
  "Partitions",
  "blob_storage",
  "Local Storage",
  "Session Storage",
  "Network Persistent State",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "crash.log",
  "crash.log.1",
  VERSION_FILE,
]);

export interface VersionRecord {
  version: string;
  firstRunAt: string;
  lastRunAt: string;
}

export interface UpgradeBackupOptions {
  dataDir: string;
  version: string;
  /** 时间源（测试注入固定时钟）。 */
  now?: () => number;
  log?: (message: string) => void;
}

export interface UpgradeBackupResult {
  /** 是否真的创建了备份。 */
  created: boolean;
  previousVersion: string | null;
  versionFile: string;
  backupDir?: string;
  copiedFiles: number;
  copiedBytes: number;
  skipped: string[];
  error?: string;
}

function readVersionRecord(file: string): VersionRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<VersionRecord>;
    if (typeof raw.version !== "string" || !raw.version.trim()) return null;
    return {
      version: raw.version.trim(),
      firstRunAt: typeof raw.firstRunAt === "string" ? raw.firstRunAt : new Date().toISOString(),
      lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : new Date().toISOString(),
    };
  } catch {
    // 缺失/损坏：当作首次启动（不备份），下次写入正确记录
    return null;
  }
}

function writeVersionRecord(file: string, record: VersionRecord): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** 时间戳用于目录名：20261121-163900（本地时区，便于用户对照）。 */
function stamp(date: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`;
}

/**
 * 按「升级前」语义备份数据目录；返回结果供启动日志/诊断读取。
 * 幂等：同一版本重复启动只会更新 lastRunAt。
 */
export function backupBeforeUpgrade(options: UpgradeBackupOptions): UpgradeBackupResult {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => undefined);
  const versionFile = path.join(options.dataDir, VERSION_FILE);
  const record = readVersionRecord(versionFile);
  const timestamp = new Date(now()).toISOString();
  const result: UpgradeBackupResult = {
    created: false,
    previousVersion: record?.version ?? null,
    versionFile,
    copiedFiles: 0,
    copiedBytes: 0,
    skipped: [],
  };

  if (!record) {
    try {
      writeVersionRecord(versionFile, { version: options.version, firstRunAt: timestamp, lastRunAt: timestamp });
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    return result;
  }

  if (record.version === options.version) {
    try {
      writeVersionRecord(versionFile, { ...record, lastRunAt: timestamp });
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    return result;
  }

  const backupDir = path.join(options.dataDir, BACKUP_DIR, `pre-${record.version}-${stamp(new Date(now()))}`);
  result.backupDir = backupDir;
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const entries = fs.readdirSync(options.dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) {
        result.skipped.push(entry.name);
        continue;
      }
      const source = path.join(options.dataDir, entry.name);
      const target = path.join(backupDir, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(source, target, {
          recursive: true,
          dereference: false,
          filter: (src) => {
            const name = path.basename(src);
            if (SKIP_NAMES.has(name)) return false;
            try {
              const stat = fs.statSync(src);
              if (stat.isFile() && stat.size > MAX_FILE_BYTES) {
                result.skipped.push(path.relative(options.dataDir, src));
                return false;
              }
            } catch {
              return false;
            }
            return true;
          },
        });
      } else if (entry.isFile()) {
        const stat = fs.statSync(source);
        if (stat.size > MAX_FILE_BYTES) {
          result.skipped.push(entry.name);
          continue;
        }
        fs.copyFileSync(source, target);
      }
    }
    // 统计体积（只读元数据，失败不影响备份可用性）
    try {
      for (const file of walkFiles(backupDir)) {
        result.copiedFiles += 1;
        result.copiedBytes += fs.statSync(file).size;
      }
    } catch {
      // 统计失败忽略
    }
    result.created = true;
    log(
      `[Loopsoar] 升级备份完成：${record.version} → ${options.version}，${result.copiedFiles} 个文件（${(
        result.copiedBytes / 1024 / 1024
      ).toFixed(1)} MB）→ ${backupDir}`,
    );
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log(`[Loopsoar] 升级备份失败（已忽略，继续启动）：${result.error}`);
    return result;
  }

  try {
    writeVersionRecord(versionFile, { ...record, version: options.version, lastRunAt: timestamp });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/**
 * 启动路径用的安全包装：任何异常都只记录，绝不阻断启动。
 * 返回结果供入口打印（created=true 时提示备份目录）。
 */
export function runUpgradeBackupSafe(dataDir: string, version: string): UpgradeBackupResult {
  try {
    const result = backupBeforeUpgrade({ dataDir, version, log: (message) => console.log(message) });
    if (result.created) console.log("[Loopsoar] 升级备份就绪：", result.backupDir);
    return result;
  } catch (err) {
    console.warn("[Loopsoar] 升级备份异常（已忽略）：", err instanceof Error ? err.message : err);
    return {
      created: false,
      previousVersion: null,
      versionFile: path.join(dataDir, VERSION_FILE),
      copiedFiles: 0,
      copiedBytes: 0,
      skipped: [],
    };
  }
}

function* walkFiles(root: string): Generator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) yield full;
    }
  }
}
