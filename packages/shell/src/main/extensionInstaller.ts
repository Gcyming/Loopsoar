/**
 * 扩展安装器（壳层）：目录 / zip → 校验 → 兼容/信任门禁 → 备份 → 原子替换 → 记录版本。
 *
 * 安全顺序（每一步失败都不触碰现有安装）：
 *   1. 解析清单 + 路径守卫（main/views 必须在包内）；
 *   2. 解压到 .staging（ZIP 读取器自带路径穿越/symlink/CRC/体积防护）；
 *   3. 计算树摘要 + 校验签名；未信任时返回 requiresTrust 让 UI 明确确认；
 *   4. 兼容性 + 版本门禁（同版本需 force，降级需 force）；
 *   5. 备份当前版本到 .backups，再 rename 替换；rename 失败回滚。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  EXTENSION_MANIFEST_FILE,
  ExtensionRegistry,
  type ExtensionManifest,
} from "loopsoar-core/extension";
import { checkExtensionCompatibility, type ExtensionCompatibility } from "loopsoar-core/extensionCompat";
import type { ExtensionCertification, ExtensionTrustState } from "loopsoar-core/extensionSignature";
import { compareSemVer, parseSemVer } from "loopsoar-core/semver";
import type { ExtensionHost } from "./extensions.js";
import { verifyExtensionPackage, type PackageVerification } from "./extensionTrust.js";
import { extractZipToDir, type ZipLimits } from "./zip.js";

export interface InstallOptions {
  allowUntrusted?: boolean;
  activate?: boolean;
  force?: boolean;
  /** 仅内部回滚使用：允许降级。 */
  allowDowngrade?: boolean;
  sourceLabel?: string;
}

export interface InstallResult {
  ok: boolean;
  error?: string;
  /** 用户取消了文件选择（UI 不当成错误提示）。 */
  canceled?: boolean;
  id?: string;
  version?: string;
  certification?: ExtensionCertification;
  compatibility?: ExtensionCompatibility;
  trust?: ExtensionTrustState;
  warnings: string[];
  /** 需要用户确认信任时返回（UI 展示指纹 + 再次调用 allowUntrusted）。 */
  requiresTrust?: { fingerprint: string; publicKey: string; publisher?: string; message: string };
  /** 受信任确认前已选定的本地来源；UI 重试时复用，避免二次弹选择框。 */
  sourcePath?: string;
}

export interface InstallSource {
  /** 目录或 zip 文件路径。 */
  path?: string;
  /** 已在内存中的 zip（市场下载）。 */
  zip?: Buffer;
  filename?: string;
}

function manifestPathIn(dir: string): string | null {
  const direct = path.join(dir, EXTENSION_MANIFEST_FILE);
  if (fs.existsSync(direct)) return direct;
  return null;
}

/** 允许 zip 包有一个顶层包裹目录（GitHub 下载常见）。 */
function resolvePackageRoot(dir: string): string {
  if (manifestPathIn(dir)) return dir;
  const children = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  const withManifest = children.filter((entry) => manifestPathIn(path.join(dir, entry.name)));
  if (withManifest.length === 1) return path.join(dir, withManifest[0].name);
  throw new Error(`包内找不到 ${EXTENSION_MANIFEST_FILE}（或存在多个顶层目录）`);
}

function assertInside(root: string, relative: string, label: string): void {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (path.isAbsolute(relative) || (target !== base && !target.startsWith(base + path.sep))) {
    throw new Error(`${label} 必须是包内相对路径：${relative}`);
  }
}

function validateManifestPaths(manifest: ExtensionManifest, root: string): void {
  if (manifest.main) assertInside(root, manifest.main, "main");
  for (const view of manifest.contributes?.views ?? []) assertInside(root, view.entry, `view ${view.id}`);
}

function backupRoot(extensionsDir: string, id: string): string {
  return path.join(extensionsDir, ".backups", id);
}

function pruneBackups(extensionsDir: string, id: string, keep = 3): void {
  const root = backupRoot(extensionsDir, id);
  try {
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of entries.slice(keep)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  } catch {
    // 备份清理失败不影响安装
  }
}

export function listBackups(extensionsDir: string, id: string): Array<{ version: string; dir: string; createdAt: number }> {
  const root = backupRoot(extensionsDir, id);
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const match = /^(\d+)-(.+)$/.exec(entry.name);
        if (!match) return null;
        return { version: match[2], dir: path.join(root, entry.name), createdAt: Number(match[1]) };
      })
      .filter((item): item is { version: string; dir: string; createdAt: number } => item !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function copyDir(source: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, dest, { recursive: true, errorOnExist: false, force: true });
}

function sameVersion(a: string, b: string): boolean {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  if (!left || !right) return a === b;
  return compareSemVer(left, right) === 0;
}

/**
 * 安装目录或 zip。同步实现（调用方在 IPC handler 里 await 也只是包一层 Promise），
 * 便于把「校验 → 替换」保持在同一段临界区，减少并发安装互相踩踏。
 */
export function installExtension(
  host: ExtensionHost,
  source: InstallSource,
  options: InstallOptions = {},
): InstallResult {
  const extensionsDir = host.dirPath();
  const trustStore = host.trust();
  const stagingRoot = path.join(extensionsDir, ".staging");
  const stamp = `${Date.now()}-${process.pid}`;
  const staging = path.join(stagingRoot, `install-${stamp}`);
  fs.mkdirSync(staging, { recursive: true });

  let packageRoot: string;
  try {
    if (source.zip) {
      extractZipToDir(source.zip, staging);
      packageRoot = resolvePackageRoot(staging);
    } else if (source.path) {
      const stat = fs.statSync(source.path);
      if (stat.isDirectory()) {
        const sourceRoot = resolvePackageRoot(source.path);
        copyDir(sourceRoot, path.join(staging, "package"));
        packageRoot = path.join(staging, "package");
      } else if (stat.isFile() && source.path.toLowerCase().endsWith(".zip")) {
        extractZipToDir(fs.readFileSync(source.path), staging);
        packageRoot = resolvePackageRoot(staging);
      } else {
        throw new Error("只支持扩展目录或 .zip 包");
      }
    } else {
      throw new Error("缺少安装来源");
    }

    const manifestPath = path.join(packageRoot, EXTENSION_MANIFEST_FILE);
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
    const manifest = ExtensionRegistry.parseManifest(raw);
    validateManifestPaths(manifest, packageRoot);

    // 清单 id 直接决定安装目录名：schema 已限制字符集，这里再守一次。
    if (/[\\/]/.test(manifest.id) || manifest.id === "." || manifest.id === "..") {
      throw new Error(`非法扩展 id：${manifest.id}`);
    }

    const compatibility = checkExtensionCompatibility(manifest, { hostVersion: host.hostVersionValue() });
    if (compatibility.status === "blocked") {
      const reasons = compatibility.issues.filter((issue) => issue.level === "error").map((issue) => issue.message);
      throw new Error(`扩展与当前宿主不兼容：${reasons.join("；")}`);
    }

    const verification: PackageVerification = verifyExtensionPackage(packageRoot, manifest, trustStore);
    if (verification.trust.status === "invalid") {
      throw new Error(`扩展包校验失败：${verification.trust.message ?? "签名/摘要无效"}`);
    }
    if (verification.trust.status !== "trusted") {
      const signature = manifest.signature;
      if (trustStore.policy() === "strict") {
        throw new Error("严格信任策略：扩展未使用已信任的签名，拒绝安装");
      }
      if (!options.allowUntrusted) {
        return {
          ok: false,
          error: "扩展未受信任，需要确认后安装",
          warnings: compatibility.issues.filter((issue) => issue.level === "warning").map((issue) => issue.message),
          ...(source.path ? { sourcePath: source.path } : {}),
          requiresTrust: signature
            ? {
                fingerprint: verification.trust.fingerprint ?? "",
                publicKey: signature.publicKey,
                ...(manifest.publisher ? { publisher: manifest.publisher } : {}),
                message: verification.trust.message ?? "签名有效，但发布者公钥尚未信任",
              }
            : {
                fingerprint: "",
                publicKey: "",
                message: "扩展未签名；安装后无法验证发布者与包完整性",
              },
        };
      }
    }

    const existing = fs.existsSync(path.join(extensionsDir, manifest.id))
      ? host.list().find((entry) => entry.manifest.id === manifest.id)
      : undefined;
    const currentVersion = existing?.manifest.version ?? host.versionInfo(manifest.id)?.active;
    if (currentVersion && !options.force) {
      if (sameVersion(currentVersion, manifest.version)) {
        throw new Error(`已安装相同版本 ${manifest.version}；如需重装请使用 force`);
      }
      const current = parseSemVer(currentVersion);
      const next = parseSemVer(manifest.version);
      if (current && next && compareSemVer(next, current) < 0 && !options.allowDowngrade) {
        throw new Error(`拒绝降级：已安装 ${currentVersion}，待安装 ${manifest.version}`);
      }
    }

    const destination = path.join(extensionsDir, manifest.id);
    const previousVersion = currentVersion;
    if (fs.existsSync(destination)) {
      const backup = path.join(backupRoot(extensionsDir, manifest.id), `${Date.now()}-${previousVersion ?? "unknown"}`);
      copyDir(destination, backup);
      pruneBackups(extensionsDir, manifest.id);
    }

    // 原子替换：先把旧目录 rename 走，再把 staging rename 进来；失败则还原。
    const parked = path.join(stagingRoot, `old-${stamp}`);
    let parkedExisting = false;
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, parked);
      parkedExisting = true;
    }
    try {
      fs.renameSync(packageRoot, destination);
    } catch (err) {
      if (parkedExisting) {
        try {
          fs.renameSync(parked, destination);
        } catch {
          // 还原失败时旧数据仍在 parked，下一次安装可手工恢复；错误信息需带路径。
        }
      }
      throw new Error(`安装替换失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (parkedExisting) fs.rmSync(parked, { recursive: true, force: true });

    host.recordInstall(manifest.id, manifest.version, {
      previous: previousVersion,
      source: options.sourceLabel ?? source.path ?? source.filename ?? "local",
      ...(options.activate !== undefined ? { activate: options.activate } : {}),
    });
    host.scan();
    const installed = host.list().find((entry) => entry.manifest.id === manifest.id);

    const warnings = compatibility.issues.filter((issue) => issue.level === "warning").map((issue) => issue.message);
    if (installed?.info) {
      warnings.push(
        ...installed.info.dependencies.issues,
        ...(installed.info.trust.status !== "trusted" && installed.info.trust.message ? [installed.info.trust.message] : []),
      );
    }
    return {
      ok: true,
      id: manifest.id,
      version: manifest.version,
      warnings,
      ...(installed?.info
        ? {
            certification: installed.info.certification,
            compatibility: installed.info.compatibility,
            trust: installed.info.trust,
          }
        : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      warnings: [],
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * 回滚到最近一个备份（或指定版本）。回滚同样走完整校验：备份也可能被篡改。
 */
export function rollbackExtension(host: ExtensionHost, id: string, targetVersion?: string, options: InstallOptions = {}): InstallResult {
  const backups = listBackups(host.dirPath(), id);
  const current = host.list().find((entry) => entry.manifest.id === id);
  if (!current) return { ok: false, error: `扩展不存在：${id}`, warnings: [] };
  const candidate = targetVersion
    ? backups.find((backup) => backup.version === targetVersion)
    : backups.find((backup) => backup.version !== current.manifest.version);
  if (!candidate) {
    return { ok: false, error: "没有可回滚的备份（只在更新/覆盖安装时生成）", warnings: [] };
  }
  return installExtension(host, { path: candidate.dir }, { ...options, force: true, allowDowngrade: true, sourceLabel: "rollback" });
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export type { ZipLimits };
