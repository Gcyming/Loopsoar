/**
 * 浏览器扩展宿主（Chrome/Edge 系扩展适配，Electron 子集）。
 *
 * 为什么需要它：
 *   · Electron 官方只支持「未打包扩展」且只实现了 Chrome 扩展 API 的一个子集
 *     （https://www.electronjs.org/docs/latest/api/extensions），Chrome 应用商店的 .crx
 *     不能直接 loadExtension；
 *   · 用户要求 Loopsoar 尽可能兼容现有插件市场 → 这里补上「.crx 下载 + 解包 + 安装」与
 *     「本地文件夹安装 + 持久化 + 开机自动加载」，并在设置页明确展示兼容性说明。
 *
 * 安全：
 *   · 只允许 http(s)/Chrome 商店链接；下载体积上限；CRX 头解析失败即拒绝；
 *   · ZIP 解包拒绝绝对路径 / `..` 穿越（扩展目录内落盘）；
 *   · 安装目录固定为 <dataDir>/browser-extensions/<id>，卸载只删除该目录内的子目录；
 *   · manifest 必须是 JSON 对象且 manifest_version 为 2/3。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface BrowserExtensionInfo {
  id: string;
  name: string;
  version: string;
  manifestVersion: number;
  description?: string;
  /** 安装来源："store" | "folder" | "bundled"。 */
  source: "store" | "folder" | "bundled";
  dir: string;
  enabled: boolean;
  /** 加载失败原因（loaded=false 时）。 */
  error?: string;
}

/** Electron 扩展 API 的最小形状（便于单测注入假实现；真实对象来自 session.extensions）。 */
export interface ExtensionApiLike {
  loadExtension(extensionPath: string, options?: { allowFileAccess?: boolean }): Promise<{
    id: string;
    name: string;
    version: string;
    manifest?: Record<string, unknown>;
  }>;
  removeExtension(extensionId: string): Promise<void>;
  getAllExtensions(): Array<{ id: string; name: string; version: string; manifest?: Record<string, unknown> }>;
}

interface InstalledRecord {
  id: string;
  dir: string;
  source: "store" | "folder" | "bundled";
  installedAt: number;
  /** Chrome 商店扩展 ID（从 URL 解析得到时记录，便于展示来源）。 */
  storeId?: string;
}

interface StateFile {
  version: 1;
  items: InstalledRecord[];
}

const MAX_CRX_BYTES = 32 * 1024 * 1024;
const STATE_VERSION = 1;

/** 从 Chrome 应用商店 URL / 32 位 ID 提取扩展 ID。 */
export function extractChromeStoreId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-p]{32}$/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "chromewebstore.google.com" && parsed.hostname !== "chrome.google.com") return null;
    const match = parsed.pathname.match(/\/(?:detail\/[^/]+\/)?([a-p]{32})(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 从 Edge Add-ons 详情页 URL 提取扩展 ID。 */
export function extractEdgeStoreId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-p]{32}$/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname.toLowerCase().endsWith("microsoftedge.microsoft.com")) return null;
    const match = parsed.pathname.match(/\/addons\/detail\/[^/]+\/([a-p]{32})(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Edge Add-ons CRX 下载地址（与 Chrome 相同 CRX 格式，走 Edge 的 crx 端点）。 */
export function edgeStoreCrxUrl(extensionId: string): string {
  const x = encodeURIComponent(`id=${extensionId}&uc`);
  return `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=${x}`;
}

/** Chrome 应用商店 CRX 下载地址（官方 update2 端点；跟随重定向拿 .crx）。 */
export function chromeStoreCrxUrl(extensionId: string): string {
  const x = encodeURIComponent(`id=${extensionId}&uc`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&os=win&arch=x86_64&os_arch=x86_64&nacl_arch=x86-64&prod=chromecrx&prodchannel=stable&prodversion=120.0.0.0&acceptformat=crx2,crx3&x=${x}`;
}

/** 解析 CRX3/CRX2 文件头，返回内部 ZIP 起点；无法识别返回 null。 */
export function crxZipOffset(buffer: Buffer): number | null {
  if (buffer.length < 16) return null;
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0x34327243) return null; // "Cr24"
  const version = buffer.readUInt32LE(4);
  if (version === 3) {
    const headerLen = buffer.readUInt32LE(8);
    const offset = 12 + headerLen;
    return offset < buffer.length ? offset : null;
  }
  if (version === 2) {
    const pubKeyLen = buffer.readUInt32LE(8);
    const sigLen = buffer.readUInt32LE(12);
    const offset = 16 + pubKeyLen + sigLen;
    return offset < buffer.length ? offset : null;
  }
  return null;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** 极简 ZIP 中央目录读取（只依赖 node:zlib；够用于扩展包，不引入第三方依赖）。 */
function readZipEntries(buffer: Buffer): ZipEntry[] {
  // EOCD：签名 0x06054b50，从尾部扫描（最多 64KB 注释）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP 包（缺少 EOCD）");
  const total = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const rawName = buffer.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (rawName.includes("\u0000") || /^[a-zA-Z]:/.test(rawName)) throw new Error(`ZIP 条目名非法：${rawName}`);
    const normalized = rawName.replace(/\\/g, "/");
    if (normalized.split("/").includes("..")) throw new Error(`ZIP 条目路径穿越：${rawName}`);
    entries.push({ name: normalized, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解包 ZIP 到目录（stored / deflate 两种压缩方式；扩展包足够）。 */
export function extractZip(buffer: Buffer, targetDir: string): void {
  const entries = readZipEntries(buffer);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith("/")) continue;
    const outPath = path.resolve(targetDir, entry.name);
    const root = path.resolve(targetDir);
    if (outPath !== root && !outPath.startsWith(root + path.sep)) throw new Error(`ZIP 条目越界：${entry.name}`);
    const p = entry.localOffset;
    if (buffer.readUInt32LE(p) !== 0x04034b50) throw new Error("ZIP 本地文件头损坏");
    const nameLen = buffer.readUInt16LE(p + 26);
    const extraLen = buffer.readUInt16LE(p + 28);
    const dataStart = p + 30 + nameLen + extraLen;
    const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    const data = entry.method === 0 ? raw : entry.method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`不支持的 ZIP 压缩算法：${entry.method}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
  }
}

interface ManifestShape {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  manifest_version?: unknown;
}

function readManifest(dir: string): { name: string; version: string; manifestVersion: number; description?: string } {
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) throw new Error("扩展缺少 manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("manifest.json 不是合法 JSON");
  }
  const manifest = raw as ManifestShape;
  const manifestVersion = Number(manifest.manifest_version);
  if (manifestVersion !== 2 && manifestVersion !== 3) throw new Error("仅支持 manifest_version 2 / 3");
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  if (!name || !version) throw new Error("manifest.json 缺少 name/version");
  return {
    name: name.slice(0, 120),
    version: version.slice(0, 40),
    manifestVersion,
    description: typeof manifest.description === "string" ? manifest.description.slice(0, 240) : undefined,
  };
}

function sanitizeDirName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "extension";
}

function copyDir(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) continue; // 不跟随符号链接，避免把外部目录带进扩展
    if (stat.isDirectory()) copyDir(from, to);
    else if (stat.isFile()) fs.copyFileSync(from, to);
  }
}

export interface BrowserExtensionHostOptions {
  /** 安装根目录（<dataDir>/browser-extensions）。 */
  rootDir: string;
  /** 浏览器分区 session 的扩展 API（Electron: session.fromPartition(...).extensions）。 */
  api: ExtensionApiLike;
  /** 下载实现（缺省全局 fetch；测试可注入）。 */
  fetchImpl?: typeof fetch;
}

export class BrowserExtensionHost {
  private readonly rootDir: string;
  private readonly api: ExtensionApiLike;
  private readonly fetchImpl: typeof fetch;
  /** 本次启动加载失败的扩展（id → 原因），列表页展示。 */
  private loadErrors = new Map<string, string>();

  constructor(opts: BrowserExtensionHostOptions) {
    this.rootDir = opts.rootDir;
    this.api = opts.api;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get statePath(): string {
    return path.join(this.rootDir, "state.json");
  }

  private readState(): StateFile {
    try {
      if (!fs.existsSync(this.statePath)) return { version: STATE_VERSION, items: [] };
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<StateFile>;
      const items = Array.isArray(raw.items) ? raw.items.filter((item) => item && typeof item.id === "string" && typeof item.dir === "string") : [];
      return { version: STATE_VERSION, items };
    } catch {
      return { version: STATE_VERSION, items: [] };
    }
  }

  private writeState(state: StateFile): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  private safeDirPath(dir: string): string | null {
    const root = path.resolve(this.rootDir);
    const target = path.resolve(dir);
    return target !== root && target.startsWith(root + path.sep) ? target : null;
  }

  /** 开机加载：逐个 loadExtension；失败记录原因但不阻断应用。 */
  async loadAll(): Promise<void> {
    const state = this.readState();
    const alive: InstalledRecord[] = [];
    for (const item of state.items) {
      const dir = this.safeDirPath(item.dir);
      if (!dir || !fs.existsSync(dir)) {
        this.loadErrors.set(item.id, "扩展目录不存在");
        continue;
      }
      try {
        await this.api.loadExtension(dir, { allowFileAccess: false });
        alive.push(item);
        this.loadErrors.delete(item.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.loadErrors.set(item.id, reason);
        alive.push(item);
      }
    }
    if (alive.length !== state.items.length) this.writeState({ version: STATE_VERSION, items: alive });
  }

  /** 已安装扩展列表（合并运行时信息 + 失败原因）。 */
  list(): BrowserExtensionInfo[] {
    const state = this.readState();
    const runtime = new Map(this.api.getAllExtensions().map((ext) => [ext.id, ext]));
    const items: BrowserExtensionInfo[] = [];
    const seen = new Set<string>();
    for (const record of state.items) {
      const live = runtime.get(record.id);
      let manifest: { name: string; version: string; manifestVersion: number; description?: string } | null = null;
      let manifestError: string | undefined;
      if (live) {
        seen.add(live.id);
        manifest = {
          name: live.name,
          version: live.version,
          manifestVersion: Number((live.manifest as { manifest_version?: unknown } | undefined)?.manifest_version ?? 3),
        };
      } else if (record.dir && fs.existsSync(record.dir)) {
        try {
          manifest = readManifest(record.dir);
        } catch (err) {
          manifestError = err instanceof Error ? err.message : String(err);
        }
      }
      const error = this.loadErrors.get(record.id) ?? manifestError;
      items.push({
        id: record.id,
        name: manifest?.name ?? path.basename(record.dir) ?? record.id,
        version: manifest?.version ?? "?",
        manifestVersion: manifest?.manifestVersion ?? 3,
        description: manifest?.description,
        source: record.source,
        dir: record.dir,
        enabled: Boolean(live) && !error,
        error,
      });
    }
    // 运行时存在但状态文件缺失（例如用户手工放入、或旧版本安装）也列出，避免「装了看不到」。
    for (const ext of runtime.values()) {
      if (seen.has(ext.id)) continue;
      items.push({
        id: ext.id,
        name: ext.name,
        version: ext.version,
        manifestVersion: Number((ext.manifest as { manifest_version?: unknown } | undefined)?.manifest_version ?? 3),
        source: "bundled",
        dir: "",
        enabled: true,
      });
    }
    return items;
  }

  /** 本地未打包扩展安装：校验 manifest → 复制到管理目录 → loadExtension。 */
  async installFromFolder(sourceDir: string): Promise<BrowserExtensionInfo> {
    const source = path.resolve(sourceDir);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error("目录不存在");
    const manifest = readManifest(source);
    const id = `local-${sanitizeDirName(manifest.name)}-${Date.now().toString(36)}`;
    const targetDir = path.join(this.rootDir, id);
    copyDir(source, targetDir);
    const loaded = await this.api.loadExtension(targetDir, { allowFileAccess: false });
    const state = this.readState();
    state.items = state.items.filter((item) => item.id !== loaded.id);
    state.items.push({ id: loaded.id, dir: targetDir, source: "folder", installedAt: Date.now() });
    this.writeState(state);
    this.loadErrors.delete(loaded.id);
    const info = this.list().find((item) => item.id === loaded.id);
    if (!info) throw new Error("扩展加载成功但未能读取信息");
    return info;
  }

  /** Chrome 应用商店安装：解析 ID → 下载 CRX → 解包 → loadExtension。 */
  async installFromStore(input: string): Promise<BrowserExtensionInfo> {
    const chromeId = extractChromeStoreId(input);
    const edgeId = chromeId ? null : extractEdgeStoreId(input);
    const storeId = chromeId ?? edgeId;
    if (!storeId) throw new Error("请输入 Chrome/Edge 应用商店链接或 32 位扩展 ID");
    const response = await this.fetchImpl(chromeId ? chromeStoreCrxUrl(storeId) : edgeStoreCrxUrl(storeId), {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) throw new Error(`扩展下载失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) throw new Error("商店返回空扩展包（该扩展可能已下架/地区不可用，或需要登录）");
    if (buffer.byteLength > MAX_CRX_BYTES) throw new Error("扩展包体积异常（超过 32MB）");
    const zipOffset = crxZipOffset(buffer);
    if (zipOffset === null) throw new Error("不是有效的 CRX 扩展包（应用商店可能已拒绝该版本）");
    const id = `store-${storeId}-${Date.now().toString(36)}`;
    const targetDir = path.join(this.rootDir, id);
    extractZip(buffer.subarray(zipOffset), targetDir);
    const manifest = readManifest(targetDir);
    const loaded = await this.api.loadExtension(targetDir, { allowFileAccess: false });
    const state = this.readState();
    state.items = state.items.filter((item) => item.id !== loaded.id);
    state.items.push({ id: loaded.id, dir: targetDir, source: "store", installedAt: Date.now(), storeId });
    this.writeState(state);
    this.loadErrors.delete(loaded.id);
    const info = this.list().find((item) => item.id === loaded.id);
    if (!info) throw new Error("扩展加载成功但未能读取信息");
    return { ...info, name: manifest.name, version: manifest.version };
  }

  /** 卸载：先 unload（幂等），再删除管理目录与状态。 */
  async remove(extensionId: string): Promise<{ ok: boolean; error?: string }> {
    const state = this.readState();
    const record = state.items.find((item) => item.id === extensionId);
    if (!record) return { ok: false, error: "扩展未安装" };
    try {
      await this.api.removeExtension(extensionId);
    } catch {
      // 运行时未加载时 removeExtension 会抛：继续删目录
    }
    try {
      const dir = this.safeDirPath(record.dir);
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    state.items = state.items.filter((item) => item.id !== extensionId);
    this.writeState(state);
    this.loadErrors.delete(extensionId);
    return { ok: true };
  }
}
