/**
 * 浏览器书签（壳层）：<dataDir>/bookmarks.json
 *   { version: 1, items: [{ id, url, title, createdAt }] }
 *
 * 设计要点（为什么这样写）：
 *  - 原子写（tmp + rename）：书签是高频小文件，直接覆盖写一旦进程/磁盘中断就留下半截 JSON；
 *    先写 `<file>.tmp` 再 rename，读到的永远是完整文件。
 *  - 损坏恢复：解析失败把原文件改名为 `<file>.corrupt-<ts>` 并空库启动——既不阻断启动，
 *    又保留现场（用户可人工抢救），不会静默丢掉全部书签后又被后续写入覆盖。
 *  - 上限 500 淘汰最旧：书签是无界增长的用户数据，UI 侧也是全量渲染；超限按 createdAt 淘汰最旧。
 *  - URL 规范化 + 同 URL 去重：`https://a.com` 与 `https://a.com/` 视为同一条，避免重复书签。
 *  - 写失败不抛：书签是旁路功能，磁盘/权限异常不能把 IPC 调用变成异常、更不能崩主进程。
 */
import fs from "node:fs";
import path from "node:path";

/** 书签条目（IPC 直接序列化给 UI）。 */
export interface BookmarkItem {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

/** 持久化文件结构（version 预留：未来加字段时可做迁移而不是猜）。 */
export interface BookmarksFile {
  version: 1;
  items: BookmarkItem[];
}

export type BookmarkAddResult =
  | { ok: true; bookmark: BookmarkItem; duplicate: boolean }
  | { ok: false; error: string };

export type BookmarkUpdateResult =
  | { ok: true; bookmark: BookmarkItem }
  | { ok: false; error: string };

/** 书签上限：超过后淘汰 createdAt 最旧的条目。 */
export const MAX_BOOKMARKS = 500;
/** 与 contracts 的 BookmarkAddSchema 对齐。 */
const MAX_URL_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 300;

export interface BookmarksStoreOptions {
  /** 时间源（测试注入递增时钟以验证排序/淘汰；生产用 Date.now）。 */
  now?: () => number;
  /** 条目上限覆盖（默认 500；测试用小值验证淘汰逻辑）。 */
  maxItems?: number;
}

/**
 * URL 规范化：trim → 解析 → 仅 http/https → 统一为 URL.toString()。
 * 为什么用 URL.toString 作为去重键：它会补全默认端口/路径并小写化主机名，
 * 让 `HTTPS://Example.COM:443` 与 `https://example.com/` 归一，避免同页多条书签。
 */
export function normalizeBookmarkUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: false, error: "URL 为空" };
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, error: `URL 过长（${trimmed.length} 字符，上限 ${MAX_URL_LENGTH}）` };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `URL 不合法：${trimmed.slice(0, 120)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `仅支持 http/https 书签（收到 ${parsed.protocol}）` };
  }
  if (!parsed.hostname) return { ok: false, error: "URL 缺少主机名" };
  const url = parsed.toString();
  if (url.length > MAX_URL_LENGTH) {
    return { ok: false, error: `URL 过长（${url.length} 字符，上限 ${MAX_URL_LENGTH}）` };
  }
  return { ok: true, url };
}

function isValidItem(value: unknown): value is BookmarkItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BookmarkItem>;
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

export class BookmarksStore {
  private file: string;
  private items: BookmarkItem[] = [];
  private readonly now: () => number;
  private readonly maxItems: number;

  constructor(dataDir: string, opts: BookmarksStoreOptions = {}) {
    this.file = path.join(dataDir, "bookmarks.json");
    this.now = opts.now ?? Date.now;
    this.maxItems =
      typeof opts.maxItems === "number" && Number.isFinite(opts.maxItems) && opts.maxItems > 0
        ? Math.floor(opts.maxItems)
        : MAX_BOOKMARKS;
    this.load();
  }

  /** 数据文件绝对路径（诊断/测试用）。 */
  get filePath(): string {
    return this.file;
  }

  /** 按 createdAt 倒序（最新在前；UI 左侧书签列表直接渲染）。返回副本，防止外部改内部状态。 */
  list(): BookmarkItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /**
   * 新增书签：URL 规范化 → 同 URL 去重（返回已有项）→ 插入队首 → 超限淘汰最旧 → 原子落盘。
   * 失败返回可读错误（不抛异常）。
   */
  add(input: { url: string; title?: string }): BookmarkAddResult {
    const normalized = normalizeBookmarkUrl(input?.url ?? "");
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const url = normalized.url;

    const existing = this.items.find((item) => item.url === url);
    if (existing) return { ok: true, bookmark: { ...existing }, duplicate: true };

    const rawTitle = typeof input?.title === "string" ? input.title.trim() : "";
    const title = (rawTitle || this.hostnameOf(url)).slice(0, MAX_TITLE_LENGTH);
    const nowMs = this.now();
    const bookmark: BookmarkItem = {
      id: `bm-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title,
      createdAt: nowMs,
    };
    this.items = [bookmark, ...this.items]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, this.maxItems);
    this.save();
    return { ok: true, bookmark: { ...bookmark }, duplicate: false };
  }

  /** 编辑书签：改标题/网址；网址仍走规范化与去重，失败返回可读错误。 */
  update(id: string, input: { title?: string; url?: string }): BookmarkUpdateResult {
    const targetId = typeof id === "string" ? id.trim() : "";
    if (!targetId) return { ok: false, error: "书签 id 为空" };
    const target = this.items.find((item) => item.id === targetId);
    if (!target) return { ok: false, error: "书签不存在" };
    let url = target.url;
    if (typeof input?.url === "string") {
      const normalized = normalizeBookmarkUrl(input.url);
      if (!normalized.ok) return { ok: false, error: normalized.error };
      url = normalized.url;
    }
    if (this.items.some((item) => item.id !== targetId && item.url === url)) {
      return { ok: false, error: "该网址已在书签中" };
    }
    const rawTitle = typeof input?.title === "string" ? input.title.trim() : target.title;
    target.url = url;
    target.title = (rawTitle || this.hostnameOf(url)).slice(0, MAX_TITLE_LENGTH);
    this.save();
    return { ok: true, bookmark: { ...target } };
  }

  /** 删除书签；不存在返回 false（UI 按「已不存在」处理，不报错）。 */
  remove(id: string): boolean {
    const target = typeof id === "string" ? id.trim() : "";
    if (!target) return false;
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== target);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  private hostnameOf(url: string): string {
    try {
      return new URL(url).hostname || url;
    } catch {
      return url;
    }
  }

  /** 启动加载：缺失 → 空库；损坏 → 隔离改名后空库；字段不合法条目丢弃（不影响其余数据）。 */
  private load(): void {
    let raw: string;
    try {
      if (!fs.existsSync(this.file)) return;
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      // 读不了（权限/被占用/目标是目录）→ 视为不可用文件：尝试隔离后空库启动（隔离失败也不影响启动）
      this.quarantineCorrupt();
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<BookmarksFile> | null;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
        this.quarantineCorrupt();
        return;
      }
      const sorted = parsed.items
        .filter(isValidItem)
        .sort((a, b) => b.createdAt - a.createdAt);
      // 手工编辑/旧版本可能产生重复 URL：加载时按 URL 去重（保留最新），保证 list 唯一
      const seen = new Set<string>();
      this.items = sorted
        .filter((item) => {
          if (seen.has(item.url)) return false;
          seen.add(item.url);
          return true;
        })
        .slice(0, this.maxItems);
    } catch {
      // JSON 解析失败 = 文件损坏（截断/手工编辑错误）：保留现场，空库启动
      this.quarantineCorrupt();
    }
  }

  /** 把损坏文件改名隔离（绝不删除：书签是用户数据，留现场便于人工恢复）；改名失败则忽略。 */
  private quarantineCorrupt(): void {
    this.items = [];
    try {
      if (!fs.existsSync(this.file)) return;
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, backup);
    } catch {
      // 隔离失败不影响启动（下次启动会再尝试；保存时会原子覆盖）
    }
  }

  /** 原子写：tmp 写入 + rename 覆盖；任何失败都吞掉（书签写入失败不阻断调用方）。 */
  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const payload: BookmarksFile = { version: 1, items: this.items };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      // 写失败：本次内存状态仍有效，下次 add/remove 会再次尝试落盘
    }
  }
}
