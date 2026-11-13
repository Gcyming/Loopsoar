/**
 * 多供应商配置（壳层）：<configDir>/providers.json
 * { activeId: "deepseek-1", items: [{ id, provider, baseUrl, model }] }
 *
 * - 单活跃 + 多配置：输入区模型弹层可切换「活跃供应商的模型」；设置页管理多条。
 * - 兼容旧版 provider.json：首次加载自动迁移为一条记录。
 * - apiKey 永不落盘（只读环境变量）。
 */
import fs from "node:fs";
import path from "node:path";
import { inferModelCapabilities, type ModelCapabilities } from "loopsoar-core/modelCapabilities";

export interface ProviderModel extends ModelCapabilities {
  id: string;
  selected?: boolean;
}

export interface ProviderItem {
  id: string;
  provider: string;
  baseUrl: string;
  /** 当前选用模型（聊天输入区正在使用的模型；没有「默认模型」概念，随时可在模型菜单切换）。 */
  model: string;
  /** 端点协议：auto=按 baseUrl 推断，openai=/chat/completions，anthropic=/messages。 */
  apiFormat?: "auto" | "openai" | "anthropic";
  /** 上游 RPM 兜底（留空 = 不主动限制）。 */
  rpm?: number;
  /** 自定义请求头（代理鉴权 / UA 等；键值字符串，最多 30 条）。 */
  headers?: Record<string, string>;
  /** 已探测/手工维护的模型清单（含上下文、输出、视觉、思考与推理等级）。 */
  models?: ProviderModel[];
}

export interface ProvidersFile {
  activeId: string | null;
  items: ProviderItem[];
}

/** 判断"切模型的目标"是否就是当前活跃供应商（同 provider + 规范化 baseUrl）。 */
export function isSameProviderTarget(
  active: ProviderItem | null,
  target: { provider: string; baseUrl: string },
): boolean {
  if (!active) return false;
  return (
    active.provider === target.provider &&
    active.baseUrl.replace(/\/+$/, "") === target.baseUrl.replace(/\/+$/, "")
  );
}

/**
 * OpenCode Console 推理网关（2026-11 官方文档 /docs/console/harnesses#base-urls）：
 *   · 按量付费（Zen）：https://opencode.ai/inference/openai/v1
 *   · Go 订阅：      https://opencode.ai/inference/go/openai/v1（Go 模型必须走 /go 段）
 * 两类计划的 API Key 不通用：Go 的 Key 打按量付费端点会被拒（403 Model access is disabled）。
 */
export const OPENCODE_INFERENCE_BASE = "https://opencode.ai/inference/openai/v1";
export const OPENCODE_GO_BASE = "https://opencode.ai/inference/go/openai/v1";

/** baseUrl 是否 OpenCode 官方域名（含 zen/go 历史路径）。 */
export function isOpenCodeBaseUrl(baseUrl: string): boolean {
  try {
    return /(^|\.)opencode\.ai$/i.test(new URL(baseUrl).hostname);
  } catch {
    return /opencode\.ai/i.test(baseUrl);
  }
}

/** 是否 Go 订阅端点（/inference/go/...）。 */
export function isOpenCodeGoBaseUrl(baseUrl: string): boolean {
  return isOpenCodeBaseUrl(baseUrl) && /\/inference\/go(\/|$)/i.test(baseUrl);
}

/**
 * 历史 OpenCode Zen 路径（https://opencode.ai/zen/v1）→ 当前按量付费端点。
 * 注意：/inference/go/openai/v1 是 Go 订阅的正确端点，**不能**改写成 /inference/openai/v1：
 * 2026-11 实测 Go 订阅的 Key 打按量付费端点会 403「Model access is disabled」。
 */
export function canonicalOpenCodeBaseUrl(baseUrl: string): string {
  if (!isOpenCodeBaseUrl(baseUrl)) return baseUrl;
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/zen\/v1$/i.test(trimmed)) return OPENCODE_INFERENCE_BASE;
  return trimmed;
}

/**
 * OpenCode 供应商迁移：仅把历史 /zen/v1 迁到当前按量付费端点（Go 端点原样保留，
 * 避免把订阅 Key 打到错误网关）。**不动模型/清单**：没有「默认模型」概念，用户选哪个就是哪个。
 */
function migrateOpenCodeItem(item: ProviderItem): ProviderItem {
  if (!isOpenCodeBaseUrl(item.baseUrl)) return item;
  const baseUrl = canonicalOpenCodeBaseUrl(item.baseUrl);
  if (baseUrl === item.baseUrl.replace(/\/+$/, "")) return item;
  return { ...item, baseUrl };
}

export class ProviderStore {
  private file: string;
  private legacyFile: string;
  /**
   * 去重合并回调：重复供应商被合并时，把「被合并 id → 保留 id」的映射交给装配层，
   * 由装配层把密钥从被合并 id 迁移/取胜到保留 id。
   *
   * 背景（2026-11-10 用户报障「密钥问题」）：旧版切模型会 upsert 出重复供应商（如 opencode-go-2）；
   * 用户把新 Key 保存在副本上，之后 dedupe 合并副本却只保留首条 id、**密钥仍挂在孤立的副本 id 上**，
   * 聊天按保留 id 取到旧 Key → 上游 403「无订阅」，用户看到「我给的 Key 明明有订阅」。
   * 只做去重不迁密钥 = 用户切换 Key 永远不生效。
   */
  private onAliases?: (aliases: Map<string, string>) => void;

  constructor(configDir: string, options: { onAliases?: (aliases: Map<string, string>) => void } = {}) {
    this.file = path.join(configDir, "providers.json");
    this.legacyFile = path.join(configDir, "provider.json");
    this.onAliases = options.onAliases;
  }

  private readJson<T>(file: string): T | null {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private writeJson(value: unknown): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(value, null, 2), "utf8");
  }

  private load(): ProvidersFile {
    const raw = this.readJson<Partial<ProvidersFile>>(this.file);
    if (raw && Array.isArray(raw.items)) {
      const filtered = raw.items
        .filter((x): x is ProviderItem => !!x && typeof x.id === "string" && typeof x.baseUrl === "string")
        .slice(0, 50);
      const { items: rawItems, alias } = this.dedupe(filtered);
      // 重复合并会丢弃副本 id：先把 alias 交给装配层迁移密钥。
      // 不迁移的后果：用户新保存的 Key 留在孤立副本 id 上，聊天按保留 id 取旧 Key → 上游 403。
      if (alias.size > 0) {
        try {
          this.onAliases?.(alias);
        } catch {
          // 回调异常不能阻断读取（幂等，下次加载会重试）
        }
      }
      // 端点迁移（OpenCode：仅历史 zen → 按量付费端点；Go 端点原样保留；不动模型选择）。
      const migratedItems = rawItems.map((item) => migrateOpenCodeItem(item));
      const needsMigrationWrite = migratedItems.some((item, index) => item !== rawItems[index]);
      // 读取时也补全能力：老 users 的 providers.json 里只有 id/model，没有上下文/视觉等字段，
      // 打开设置面板应该能看到完整信息（写回发生在下一次保存时，不增加读路径 IO）。
      const items = migratedItems.map((item) => ({ ...item, models: this.enrichModels(item) }));
      const wantedActive = raw.activeId ? (alias.get(raw.activeId) ?? raw.activeId) : null;
      const activeId = wantedActive && items.some((i) => i.id === wantedActive) ? wantedActive : (items[0]?.id ?? null);
      // 修复历史重复（旧版每次切模型都会 upsert 新供应商）：写回一次，避免用户重启后选中无请求头/无密钥的副本
      if (items.length !== filtered.length || wantedActive !== raw.activeId || needsMigrationWrite) {
        try {
          this.writeJson({ activeId, items });
        } catch {
          // 写回失败不影响本次读取
        }
      }
      return { activeId, items };
    }
    // 旧版单配置迁移
    const legacy = this.readJson<{ provider?: string; baseUrl?: string; model?: string }>(this.legacyFile);
    if (legacy && legacy.baseUrl && legacy.model) {
      const item: ProviderItem = {
        id: this.slug(legacy.provider || "provider", []),
        provider: legacy.provider || "provider",
        baseUrl: legacy.baseUrl,
        model: legacy.model,
      };
      const file: ProvidersFile = { activeId: item.id, items: [item] };
      this.writeJson(file);
      return file;
    }
    return { activeId: null, items: [] };
  }

  /** 只接受字符串键值、限量：避免配置文件被注入任意字段或无限膨胀。 */
  private sanitizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (!headers || typeof headers !== "object") return undefined;
    const entries = Object.entries(headers)
      .filter(([key, value]) => typeof key === "string" && key.trim() && typeof value === "string")
      .map(([key, value]) => [key.trim(), value] as const)
      .slice(0, 30);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  /**
   * 用内置能力表补全单个模型缺失的元数据（上下文/输出/视觉/思考/模态/工具调用…）。
   * 规则：**显式值优先**（用户手填或上游 /models 返回的字段绝不被覆盖），只补 undefined。
   * 数据源：core/modelCapabilities（slime 能力表 + 用户提供的 NVIDIA NIM 官方模型卡）。
   */
  private enrichModel(model: ProviderModel, provider: string, baseUrl: string): ProviderModel {
    const inferred = inferModelCapabilities(model.id, { provider, baseUrl });
    const { source: _source, vendor: _vendor, nonChat: _nonChat, ...caps } = inferred;
    void _source;
    void _vendor;
    void _nonChat;
    const explicit = Object.fromEntries(
      Object.entries(model).filter(([, value]) => value !== undefined),
    ) as Partial<ProviderModel>;
    const merged = { ...caps, ...explicit } as ProviderModel;
    // vision 与模态互相对齐：只要一个说有图片，另一个补全（UI 两列都有值）
    if (merged.vision === undefined && merged.inputModalities?.includes("image")) merged.vision = true;
    if (merged.vision === true && !merged.inputModalities) merged.inputModalities = ["text", "image"];
    return merged;
  }

  /**
   * 补全供应商的模型清单：
   *   · 已有清单 → 逐条补字段；
   *   · 没有清单但有当前模型 → 用当前模型生成一条（带内置能力），用户打开面板就能看到上下文/输出/视觉。
   */
  private enrichModels(item: {
    provider: string;
    baseUrl: string;
    model: string;
    models?: ProviderModel[];
  }): ProviderModel[] | undefined {
    const list =
      item.models && item.models.length > 0
        ? item.models
        : item.model
          ? [{ id: item.model }]
          : [];
    if (list.length === 0) return item.models;
    return list
      .slice(0, 500)
      .map((model) => this.enrichModel(model, item.provider, item.baseUrl));
  }

  /**
   * 合并重复供应商（同 provider + 同 baseUrl）。
   * 旧版切模型会 upsert 新记录，导致副本丢 headers/models；这里保留首条 id，
   * 把后续副本的请求头/模型/协议等字段并入。
   * **密钥不在本类**：合并产生的 alias 通过 onAliases 交给装配层迁移，
   * 否则副本上的新 Key 会成孤儿，聊天继续用旧 Key（2026-11-10 用户报障根因）。
   */
  private dedupe(items: ProviderItem[]): { items: ProviderItem[]; alias: Map<string, string> } {
    const kept: ProviderItem[] = [];
    const byKey = new Map<string, ProviderItem>();
    const alias = new Map<string, string>();
    for (const item of items) {
      const key = `${item.provider}@@${item.baseUrl.replace(/\/+$/, "")}`;
      const existing = byKey.get(key);
      const sanitized = { ...item, headers: this.sanitizeHeaders(item.headers) };
      if (!existing) {
        byKey.set(key, sanitized);
        kept.push(sanitized);
        alias.set(item.id, item.id);
        continue;
      }
      alias.set(item.id, existing.id);
      existing.headers = { ...(existing.headers ?? {}), ...(sanitized.headers ?? {}) };
      if (!existing.apiFormat && sanitized.apiFormat) existing.apiFormat = sanitized.apiFormat;
      if (existing.rpm === undefined && sanitized.rpm !== undefined) existing.rpm = sanitized.rpm;
      const models = new Map<string, ProviderModel>();
      for (const model of [...(existing.models ?? []), ...(sanitized.models ?? [])]) {
        if (!models.has(model.id) || model.selected !== undefined) models.set(model.id, model);
      }
      existing.models = models.size > 0 ? [...models.values()] : existing.models;
    }
    return { items: kept, alias };
  }

  private slug(base: string, existingIds: string[]): string {
    const clean = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
    const existing = new Set(existingIds);
    if (!existing.has(clean)) return clean;
    let n = 2;
    while (existing.has(`${clean}-${n}`)) n += 1;
    return `${clean}-${n}`;
  }

  list(): ProviderItem[] {
    return this.load().items;
  }

  active(): ProviderItem | null {
    const file = this.load();
    return file.items.find((i) => i.id === file.activeId) ?? file.items[0] ?? null;
  }

  upsert(input: {
    id?: string;
    provider: string;
    baseUrl: string;
    model: string;
    apiFormat?: "auto" | "openai" | "anthropic";
    rpm?: number;
    headers?: Record<string, string>;
    models?: ProviderModel[];
  }): ProviderItem {
    const file = this.load();
    const baseUrl = canonicalOpenCodeBaseUrl(input.baseUrl.replace(/\/+$/, ""));
    const sameEndpoint = (item: ProviderItem): boolean =>
      item.provider === input.provider && item.baseUrl.replace(/\/+$/, "") === baseUrl;
    /*
     * id 解析（2026-11-10 密钥问题修复）：
     *   · 显式 id 不存在（例如历史副本已被去重合并掉）→ 复用「同 provider + 同端点」的现存记录，
     *     绝不复活副本 id；否则新 Key 又挂到孤儿副本上，聊天继续用旧 Key。
     *   · 新增且已有同端点记录（旧版重复 upsert 留下的场景）→ 也复用，避免再产生副本。
     */
    let id = input.id ?? "";
    if (id && !file.items.some((i) => i.id === id)) {
      id = file.items.find(sameEndpoint)?.id ?? id;
    }
    if (!id) {
      id = file.items.find(sameEndpoint)?.id ?? this.slug(input.provider, file.items.map((i) => i.id));
    }
    const item: ProviderItem = {
      id,
      provider: input.provider,
      baseUrl,
      model: input.model,
      apiFormat: input.apiFormat ?? "auto",
      rpm: input.rpm,
      headers: this.sanitizeHeaders(input.headers ?? file.items.find((i) => i.id === id)?.headers),
      // 保存时补全能力字段：内置表能识别的模型（如 deepseek/kimi/glm/llama…）自动带上
      // 上下文/最大输出/视觉/思考/模态/工具调用，用户不必手动查资料。
      models: this.enrichModels({
        provider: input.provider,
        baseUrl,
        model: input.model,
        models: input.models ?? file.items.find((i) => i.id === id)?.models,
      }),
    };
    const idx = file.items.findIndex((i) => i.id === id);
    if (idx >= 0) file.items[idx] = item;
    else file.items.push(item);
    if (!file.activeId || (idx < 0 && file.items.length === 1)) file.activeId = id;
    this.writeJson(file);
    return item;
  }

  remove(id: string): boolean {
    const file = this.load();
    const next = file.items.filter((i) => i.id !== id);
    if (next.length === file.items.length) return false;
    this.writeJson({ activeId: file.activeId === id ? (next[0]?.id ?? null) : file.activeId, items: next });
    return true;
  }

  setActive(id: string): boolean {
    const file = this.load();
    if (!file.items.some((i) => i.id === id)) return false;
    this.writeJson({ activeId: id, items: file.items });
    return true;
  }
}
