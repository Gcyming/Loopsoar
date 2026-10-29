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
  /** 已探测/手工维护的模型清单（含上下文、输出、视觉、思考与推理等级）。 */
  models?: ProviderModel[];
}

export interface ProvidersFile {
  activeId: string | null;
  items: ProviderItem[];
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
      const items = raw.items
        .filter((x): x is ProviderItem => !!x && typeof x.id === "string" && typeof x.baseUrl === "string")
        .slice(0, 50);
      const activeId = raw.activeId && items.some((i) => i.id === raw.activeId) ? raw.activeId : (items[0]?.id ?? null);
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
