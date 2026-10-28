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

export interface ProviderItem {
  id: string;
  provider: string;
  baseUrl: string;
  model: string;
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

  upsert(input: { id?: string; provider: string; baseUrl: string; model: string }): ProviderItem {
    const file = this.load();
    const id = input.id || this.slug(input.provider, file.items.map((i) => i.id));
    const item: ProviderItem = { id, provider: input.provider, baseUrl: input.baseUrl.replace(/\/+$/, ""), model: input.model };
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
