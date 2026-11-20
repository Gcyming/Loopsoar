/**
 * 扩展市场（壳层）：静态 JSON registry 的拉取、缓存、下载与安装。
 *
 * registry 契约见 contracts/extensionRegistry.ts。关键门禁：
 *   · 下载地址只允许 http(s)，且包必须带 sha256（安装前重算比对）；
 *   · 体积上限 64MB，超时 30s；
 *   · 目录缓存 5 分钟，refresh=true 强制重取；
 *   · 市场只负责「找到包」，信任/兼容/依赖门禁仍由 installer + host 统一执行。
 */
import type { ExtensionCatalogView, ExtensionRegistryEntry, ExtensionRegistryIndex, ExtensionRegistryVersion } from "loopsoar-contracts/extensionRegistry";
import { ExtensionRegistryIndexSchema } from "loopsoar-contracts/extensionRegistry";
import { compareSemVer, maxSatisfying, parseSemVer, satisfies } from "loopsoar-core/semver";
import { fingerprintPublicKey } from "loopsoar-core/extensionSignature";
import { findRevocation, verifyRegistrySignature } from "loopsoar-core/registrySignature";
import type { ExtensionHost } from "./extensions.js";
import { installExtension, sha256Hex, type InstallOptions, type InstallResult } from "./extensionInstaller.js";

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
/** 信任确认后重试时复用已校验的包，避免二次下载/TOCTOU 换包。 */
const PACKAGE_CACHE_TTL_MS = 10 * 60 * 1000;

function assertHttpUrl(raw: string, label: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} 只允许 http(s)：${raw}`);
  // 云元数据地址是典型的 SSRF 目标；即使桌面端也不允许扩展目录把它当代理。
  if (url.hostname === "169.254.169.254" || url.hostname === "metadata.google.internal") {
    throw new Error(`${label} 不允许指向云元数据地址`);
  }
  return url;
}

async function fetchLimited(url: string, maxBytes: number): Promise<Buffer> {
  let current = url;
  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json, application/zip, application/octet-stream" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`重定向缺少 Location：${current}`);
      // 每一跳都重新做协议/元数据校验，避免 registry 用 302 把请求引到 SSRF 目标。
      current = assertHttpUrl(new URL(location, current).toString(), "重定向地址").toString();
      continue;
    }
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${current}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error(`响应体超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error(`响应体超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    return buffer;
  }
  throw new Error("重定向次数超过上限（5）");
}

function pickLatest(
  entry: ExtensionRegistryEntry,
  revocations: ExtensionRegistryIndex["revocations"] = [],
): { version: string; url: string } | null {
  const available = entry.versions.filter(
    (version) => !version.yanked && !findRevocation({ revocations }, entry.id, version.version),
  );
  if (available.length === 0) return null;
  if (entry.latest) {
    const explicit = available.find((version) => version.version === entry.latest);
    if (explicit) return { version: explicit.version, url: explicit.downloadUrl };
  }
  const best = maxSatisfying(
    available.map((version) => version.version),
    "*",
  );
  const found = available.find((version) => version.version === best);
  return found ? { version: found.version, url: found.downloadUrl } : null;
}

interface CatalogCache {
  registryUrl: string;
  fetchedAt: number;
  view: ExtensionCatalogView;
  entries: Map<string, ExtensionRegistryEntry>;
  revocations: ExtensionRegistryIndex["revocations"];
}

export class ExtensionMarket {
  private cache: CatalogCache | null = null;
  private inflight: Promise<CatalogCache> | null = null;
  private packages = new Map<string, { zip: Buffer; cachedAt: number }>();

  constructor(
    private readonly options: {
      registryUrl: () => string;
      /** 市场目录签名公钥（base64 SPKI）；非空时强制要求 trusted 目录签名。 */
      catalogPublicKey?: () => string;
      host: ExtensionHost;
    },
  ) {}

  private async load(registryUrl: string): Promise<CatalogCache> {
    const url = assertHttpUrl(registryUrl, "registry 地址");
    const buffer = await fetchLimited(url.toString(), MAX_INDEX_BYTES);
    let raw: unknown;
    try {
      raw = JSON.parse(buffer.toString("utf8"));
    } catch (err) {
      throw new Error(`registry 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = ExtensionRegistryIndexSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`registry 不符合 schema：${parsed.error.issues.slice(0, 3).map((issue) => issue.path.join(".")).join("；")}`);
    }
    const index: ExtensionRegistryIndex = parsed.data;
    const catalogPublicKey = this.options.catalogPublicKey?.().trim() ?? "";
    const trusted = new Set(catalogPublicKey ? [fingerprintPublicKey(catalogPublicKey)] : []);
    const signature = verifyRegistrySignature(index, trusted);
    if (signature.status === "invalid") {
      throw new Error(`市场目录签名无效：${signature.message ?? "index.json 已被篡改"}`);
    }
    if (catalogPublicKey && signature.status !== "trusted") {
      throw new Error(
        signature.status === "unsigned"
          ? "市场目录未签名：已配置市场公钥，拒绝无签名目录"
          : `市场目录签名公钥不受信（${signature.fingerprint ?? "unknown"}）`,
      );
    }
    if (index.expiresAt !== undefined && Date.now() > index.expiresAt) {
      throw new Error(`市场目录已过期（expiresAt=${new Date(index.expiresAt).toISOString()}），请刷新或联系市场维护者`);
    }
    // 撤销列表是安装后的止损通道：拉到目录就落盘并重扫，命中的扩展立即 blocked。
    if (index.revocations && index.revocations.length > 0) {
      this.options.host.applyRevocations(index.revocations);
    }
    const entries = new Map(index.plugins.map((entry) => [entry.id, entry]));
    const hostVersion = this.options.host.hostVersionValue();
    const installed = new Map(this.options.host.list().map((entry) => [entry.manifest.id, entry.manifest.version]));

    const plugins = index.plugins.map((entry) => {
      const latest = pickLatest(entry, index.revocations);
      const latestVersion = latest?.version;
      const latestMeta = latestVersion ? entry.versions.find((version) => version.version === latestVersion) : undefined;
      const installedVersion = installed.get(entry.id);
      return {
        ...entry,
        ...(latestVersion ? { latestVersion } : {}),
        ...(installedVersion ? { installedVersion } : {}),
        ...(latestVersion && installedVersion ? { updateAvailable: compareVersions(installedVersion, latestVersion) < 0 } : {}),
        ...(latestMeta?.engines?.loopsoar ? { compatible: satisfies(hostVersion, latestMeta.engines.loopsoar) } : {}),
      };
    });
    const view: ExtensionCatalogView = {
      registryUrl: url.toString(),
      ...(index.name ? { name: index.name } : {}),
      ...(index.updatedAt !== undefined ? { updatedAt: index.updatedAt } : {}),
      ...(index.channel ? { channel: index.channel } : {}),
      ...(index.expiresAt !== undefined ? { expiresAt: index.expiresAt } : {}),
      ...(index.revocations && index.revocations.length > 0 ? { revoked: index.revocations.length } : {}),
      signature: {
        status: signature.status,
        ...(signature.fingerprint ? { fingerprint: signature.fingerprint } : {}),
      },
      fetchedAt: Date.now(),
      plugins,
    };
    return { registryUrl: url.toString(), fetchedAt: Date.now(), view, entries, revocations: index.revocations };
  }

  async catalog(refresh = false): Promise<ExtensionCatalogView> {
    const registryUrl = this.options.registryUrl().trim();
    if (!registryUrl) {
      return { registryUrl: "", fetchedAt: Date.now(), plugins: [] };
    }
    if (!refresh && this.cache && this.cache.registryUrl === registryUrl && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.withInstalled(this.cache.view);
    }
    if (!this.inflight) {
      this.inflight = this.load(registryUrl)
        .then((cache) => {
          this.cache = cache;
          return cache;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    const cache = await this.inflight;
    return this.withInstalled(cache.view);
  }

  /** 每次返回前刷新 installedVersion/updateAvailable（安装后无需强制重新拉 registry）。 */
  private withInstalled(view: ExtensionCatalogView): ExtensionCatalogView {
    const installed = new Map(this.options.host.list().map((entry) => [entry.manifest.id, entry.manifest.version]));
    return {
      ...view,
      plugins: view.plugins.map((plugin) => {
        const installedVersion = installed.get(plugin.id);
        return {
          ...plugin,
          ...(installedVersion ? { installedVersion } : {}),
          ...(plugin.latestVersion && installedVersion
            ? { updateAvailable: compareVersions(installedVersion, plugin.latestVersion) < 0 }
            : {}),
        };
      }),
    };
  }

  async install(id: string, version: string | undefined, options: InstallOptions = {}): Promise<InstallResult> {
    const registryUrl = this.options.registryUrl().trim();
    if (!registryUrl) throw new Error("未配置扩展市场 registry");
    const cache = this.cache?.registryUrl === registryUrl ? this.cache : await this.load(registryUrl);
    const entry = cache.entries.get(id);
    if (!entry) throw new Error(`registry 中没有扩展 ${id}`);
    const latest = pickLatest(entry, cache.revocations);
    const selected: ExtensionRegistryVersion | undefined = version
      ? entry.versions.find((item) => item.version === version && !item.yanked)
      : entry.versions.find((item) => item.version === latest?.version);
    if (!selected) throw new Error(`registry 中没有可用版本 ${version ?? latest?.version ?? "latest"}`);
    if (findRevocation({ revocations: cache.revocations }, id, selected.version)) {
      throw new Error(`版本 ${id}@${selected.version} 已被市场撤销，拒绝安装`);
    }
    const url = new URL(selected.downloadUrl, cache.registryUrl).toString();
    assertHttpUrl(url, "下载地址");
    if (selected.size && selected.size > MAX_PACKAGE_BYTES) throw new Error("registry 声明的包体积超过上限");
    const cacheKey = `${id}@${selected.version}:${selected.sha256.toLowerCase()}`;
    const cached = this.packages.get(cacheKey);
    let zip: Buffer;
    if (cached && Date.now() - cached.cachedAt < PACKAGE_CACHE_TTL_MS) {
      zip = cached.zip;
    } else {
      this.packages.delete(cacheKey);
      zip = await fetchLimited(url, Math.min(selected.size ?? MAX_PACKAGE_BYTES, MAX_PACKAGE_BYTES));
      const digest = sha256Hex(zip);
      if (digest !== selected.sha256.toLowerCase()) {
        throw new Error(`包摘要不匹配（registry ${selected.sha256}，实际 ${digest}）`);
      }
      if (this.packages.size >= 8) this.packages.delete(this.packages.keys().next().value!);
      this.packages.set(cacheKey, { zip, cachedAt: Date.now() });
    }
    const result = installExtension(
      this.options.host,
      { zip, filename: `${id}-${selected.version}.zip` },
      { ...options, sourceLabel: `registry:${cache.registryUrl}` },
    );
    if (result.ok) this.packages.delete(cacheKey);
    if (result.ok && result.version && result.version !== selected.version && !result.warnings.includes("registry 版本与包内版本不一致")) {
      result.warnings.push(`registry 版本 ${selected.version} 与包内版本 ${result.version} 不一致`);
    }
    return result;
  }
}

function compareVersions(a: string, b: string): number {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  if (!left || !right) return a < b ? -1 : a > b ? 1 : 0;
  return compareSemVer(left, right);
}
