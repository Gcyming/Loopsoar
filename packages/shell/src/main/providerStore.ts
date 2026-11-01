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

export interface ProviderModel {
  id: string;
  selected?: boolean;
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  thinking?: boolean;
  thinkingEfforts?: string[];
}

export interface ProviderItem {
  id: string;
  provider: string;
  baseUrl: string;
  /** 默认模型（聊天输入区默认使用）。 */
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

export class ProviderStore {
  private file: string;
  private legacyFile: string;

  constructor(configDir: string) {
    this.file = path.join(configDir, "providers.json");
    this.legacyFile = path.join(configDir, "provider.json");
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
      const { items, alias } = this.dedupe(filtered);
      const wantedActive = raw.activeId ? (alias.get(raw.activeId) ?? raw.activeId) : null;
      const activeId = wantedActive && items.some((i) => i.id === wantedActive) ? wantedActive : (items[0]?.id ?? null);
      // 修复历史重复（旧版每次切模型都会 upsert 新供应商）：写回一次，避免用户重启后选中无请求头/无密钥的副本
      if (items.length !== filtered.length || wantedActive !== raw.activeId) {
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
   * 合并重复供应商（同 provider + 同 baseUrl）。
   * 旧版切模型会 upsert 新记录，导致副本丢 headers/models/密钥关联；这里保留首条 id，
   * 把后续副本的请求头/模型/协议等字段并入，密钥仍挂在首条 id 上。
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
    const id = input.id || this.slug(input.provider, file.items.map((i) => i.id));
    const item: ProviderItem = {
      id,
      provider: input.provider,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      model: input.model,
      apiFormat: input.apiFormat ?? "auto",
      rpm: input.rpm,
      headers: this.sanitizeHeaders(input.headers ?? file.items.find((i) => i.id === id)?.headers),
      models: input.models ?? file.items.find((i) => i.id === id)?.models,
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
