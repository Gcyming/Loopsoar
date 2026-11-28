/**
 * 新标签页「快捷方式」（壳层）：<dataDir>/shortcuts.json
 *   { version: 1, items: [{ id, url, title, icon?, createdAt }] }
 *
 * 与「历史记录」的区别（用户 m04220）：新标签页那排图标应当是**用户主动添加**的快捷方式，
 * 而不是「最近访问」的镜像；历史是自动积累的、不可编辑的，快捷方式必须能增/改/删。
 *
 * 设计沿用 BookmarksStore 的取舍：
 *  - 原子写（tmp + rename）：半截 JSON 永远不会被读到；
 *  - 损坏隔离：解析失败改名 <file>.corrupt-<ts> 后空库启动（保留现场，不静默覆盖）；
 *  - URL 规范化 + 去重：https://a.com 与 https://a.com/ 视为同一条；
 *  - 上限 24 淘汰最旧：新标签页是有限版面，超过就看不过来了；
 *  - 写失败不抛：快捷方式是旁路功能，磁盘异常不该让 IPC 变成异常。
 */
import fs from "node:fs";
import path from "node:path";

/** 快捷方式条目（IPC 直接序列化给 UI）。 */
export interface ShortcutItem {
  id: string;
  url: string;
  title: string;
  /** 页面图标（data URL）；缺省时 UI 用首字母块。 */
  icon?: string;
  createdAt: number;
}

export interface ShortcutsFile {
  version: 1;
  items: ShortcutItem[];
}

export type ShortcutWriteResult =
  | { ok: true; shortcut: ShortcutItem; duplicate?: boolean }
  | { ok: false; error: string };

/** 上限：新标签页最多 24 个快捷方式，超出淘汰最早添加的。 */
export const MAX_SHORTCUTS = 24;
const MAX_URL_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 40;
/** 图标上限：data URL 可能很大，超过 256KB 一律丢弃（避免把 shortcuts.json 撑爆）。 */
const MAX_ICON_LENGTH = 256 * 1024;

export interface ShortcutsStoreOptions {
  /** 时间源（测试注入递增时钟验证排序/淘汰）。 */
  now?: () => number;
  /** 上限覆盖（默认 MAX_SHORTCUTS）。 */
  maxItems?: number;
}

/** URL 规范化：仅 http/https，统一 URL.toString() 作为去重键。 */
export function normalizeShortcutUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: false, error: "网址为空" };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, error: "网址过长" };
  // 用户往往只输入 example.com：补 https:// 再解析，比报错更有用。
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: `网址不合法：${trimmed.slice(0, 120)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `仅支持 http/https 网址（收到 ${parsed.protocol}）` };
  }
  if (!parsed.hostname) return { ok: false, error: "网址缺少主机名" };
  return { ok: true, url: parsed.toString() };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function validItem(value: unknown): value is ShortcutItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ShortcutItem>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    item.id.length <= 120 &&
    typeof item.url === "string" &&
    /^https?:\/\//i.test(item.url) &&
    item.url.length <= MAX_URL_LENGTH &&
    typeof item.title === "string" &&
    typeof item.createdAt === "number" &&
    Number.isFinite(item.createdAt)
  );
}

export class ShortcutsStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly maxItems: number;
  private items: ShortcutItem[] = [];

  constructor(dataDir: string, opts: ShortcutsStoreOptions = {}) {
    this.file = path.join(dataDir, "shortcuts.json");
    this.now = opts.now ?? Date.now;
    this.maxItems =
      typeof opts.maxItems === "number" && Number.isFinite(opts.maxItems) && opts.maxItems > 0
        ? Math.floor(opts.maxItems)
        : MAX_SHORTCUTS;
    this.load();
  }

  /** 数据文件绝对路径（诊断/测试用）。 */
  get filePath(): string {
    return this.file;
  }

  /** 按添加时间正序：新加的排在最后一个（正好贴着「+」按钮）。 */
  list(): ShortcutItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /** 新增：规范化 → 去重（返回已有项）→ 追加 → 超限淘汰最旧 → 落盘。 */
  add(input: { url: string; title?: string; icon?: string }): ShortcutWriteResult {
    const normalized = normalizeShortcutUrl(input?.url ?? "");
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const existing = this.items.find((item) => item.url === normalized.url);
    if (existing) return { ok: true, shortcut: { ...existing }, duplicate: true };

    const nowMs = this.now();
    const title = (typeof input?.title === "string" ? input.title.trim() : "").slice(0, MAX_TITLE_LENGTH) || hostnameOf(normalized.url);
    const shortcut: ShortcutItem = {
      id: `sc-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      url: normalized.url,
      title,
      createdAt: nowMs,
      ...(typeof input?.icon === "string" && input.icon.length <= MAX_ICON_LENGTH ? { icon: input.icon } : {}),
    };
    this.items = [...this.items, shortcut].slice(-this.maxItems);
    this.save();
    return { ok: true, shortcut: { ...shortcut }, duplicate: false };
  }

  /** 编辑：改标题 / 改网址 / 写回图标；网址仍走规范化与去重。 */
  update(id: string, input: { title?: string; url?: string; icon?: string }): ShortcutWriteResult {
    const targetId = typeof id === "string" ? id.trim() : "";
    if (!targetId) return { ok: false, error: "快捷方式 id 为空" };
    const index = this.items.findIndex((item) => item.id === targetId);
    if (index < 0) return { ok: false, error: "快捷方式不存在" };
    const current = this.items[index];
    let url = current.url;
    if (typeof input?.url === "string" && input.url.trim()) {
      const normalized = normalizeShortcutUrl(input.url);
      if (!normalized.ok) return { ok: false, error: normalized.error };
      const clash = this.items.find((item) => item.url === normalized.url && item.id !== targetId);
      if (clash) return { ok: false, error: `该网址已有快捷方式：${clash.title}` };
      url = normalized.url;
    }
    const next: ShortcutItem = {
      ...current,
      url,
      title:
        typeof input?.title === "string" && input.title.trim()
          ? input.title.trim().slice(0, MAX_TITLE_LENGTH)
          : current.title,
    };
    if (typeof input?.icon === "string") {
      if (input.icon && input.icon.length <= MAX_ICON_LENGTH) next.icon = input.icon;
      else if (!input.icon) delete next.icon;
    }
    this.items = this.items.map((item, i) => (i === index ? next : item));
    this.save();
    return { ok: true, shortcut: { ...next } };
  }

  /** 删除：不存在返回 false（UI 只当「已经没了」处理）。 */
  remove(id: string): boolean {
    const targetId = typeof id === "string" ? id.trim() : "";
    if (!targetId) return false;
    const next = this.items.filter((item) => item.id !== targetId);
    if (next.length === this.items.length) return false;
    this.items = next;
    this.save();
    return true;
  }

  /** 置顶（UI 右键「移到最前」）：只改顺序，不改时间。 */
  moveToFront(id: string): boolean {
    const targetId = typeof id === "string" ? id.trim() : "";
    const target = this.items.find((item) => item.id === targetId);
    if (!target) return false;
    this.items = [target, ...this.items.filter((item) => item.id !== targetId)];
    this.save();
    return true;
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      this.items = [];
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ShortcutsFile>;
      const items = Array.isArray(parsed?.items) ? parsed.items.filter(validItem) : [];
      this.items = items.slice(-this.maxItems);
    } catch {
      this.quarantine();
      this.items = [];
    }
  }

  /** 解析失败：把坏文件改名保留现场，避免下一次写入把它无声覆盖。 */
  private quarantine(): void {
    try {
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
    } catch {
      // 改名失败也不能阻断启动。
    }
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data: ShortcutsFile = { version: 1, items: this.items };
      fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      // 落盘失败不抛出：快捷方式是旁路功能。
    }
  }
}
