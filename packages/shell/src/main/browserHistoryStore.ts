/**
 * 全局浏览器历史（跨标签、跨会话共享，持久化）。
 *
 * 为什么是全局：历史面板的语义是「我最近访问过什么」，而不是「这个会话在这个标签里点过什么」；
 * 会话级的历史栈（BrowserHost 内存里的 entry.history）只服务于**后退/前进**，两者互不替代：
 *   · 后退/前进 → 仍按标签栈（本文件不参与，避免把 A 标签的历史塞进 B 标签的返回栈）；
 *   · 历史面板 → 本文件的 list()，所有标签/所有会话共用一份；
 *   · 上限 500 条、同 URL 去重合并（移到最前、时间刷新、次数累加），避免长会话把列表撑爆。
 *
 * 持久化：`<dataDir>/browser-history.json`
 *   - 原子写：先写 `<file>.tmp` 再 rename（rename 失败时退回直接覆盖，保证尽力落盘）；
 *   - 损坏容错：JSON 解析/结构校验失败 → 原名改存 `<file>.corrupt-<ts>`，以空历史继续运行；
 *   - 写入失败不抛错（历史是辅助功能，不能因为磁盘只读拖垮浏览器）。
 *
 * 安全：只接受 http(s)（与导航白名单一致）；文件可能被手工改过，读取时逐条净化、去重、重新排序。
 */
import fs from "node:fs";
import path from "node:path";

/** 一条全局历史。字段与 UI 的 HistoryEntry 保持「url 必有」的兼容底线，其余为增益字段。 */
export interface GlobalHistoryEntry {
  url: string;
  /** 页面标题（导航/标题事件已知时才写；未知则缺省）。 */
  title?: string;
  /** 最近一次访问时间（ms）。 */
  visitedAt: number;
  /** 同 URL 累计访问次数（去重合并时累加）。 */
  visitCount: number;
  /** 站点图标（data: URL，≤96KB；来自 page-favicon-updated）。 */
  favicon?: string;
}

/** 全局历史上限：超过后丢弃最旧（列表末尾）。 */
export const MAX_GLOBAL_HISTORY = 500;

/** 落盘文件版本号（未来结构升级用；未知版本按「结构不可信」处理，容错为旧版读取）。 */
const HISTORY_FILE_VERSION = 1;

/** 标题上限（与标签标题渲染保持一致，避免被超长 <title> 撑坏 UI）。 */
const MAX_TITLE_CHARS = 120;

/** favicon 上限：data URL 只接受图片、限制体积（避免把历史文件吹大）。 */
const MAX_FAVICON_CHARS = 96 * 1024;

function normalizeFavicon(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("data:image/") || trimmed.length > MAX_FAVICON_CHARS) return undefined;
  return trimmed;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 补记输入：会话恢复出来的旧标签（只关心 URL 与已知标题）。 */
export interface BackfillVisit {
  url?: unknown;
  title?: unknown;
}

/** 补记结果（日志/诊断用）。 */
export interface BackfillStats {
  /** 新补进历史面板的条目数。 */
  added: number;
  /** 已存在、只按需补了标题的条目数（不动 visitCount/排序）。 */
  merged: number;
  /** 非法 URL / 同批次重复地址（未写入）。 */
  skipped: number;
}

export class BrowserHistoryStore {
  private entries: GlobalHistoryEntry[] = [];

  constructor(private readonly filePath: string) {
    this.load();
  }

  /** 历史文件路径（诊断/测试用）。 */
  get path(): string {
    return this.filePath;
  }

  /** 当前条数。 */
  get size(): number {
    return this.entries.length;
  }

  /** 最新在前；返回副本，调用方改不坏内部状态。 */
  list(): GlobalHistoryEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /**
   * 记录一次成功访问：同 URL 合并（移到最前、刷新时间、次数 +1），否则插到最前；超上限截断。
   * 非 http(s) / 空 URL 返回 null（不记录），调用方无须再判协议。
   */
  record(visit: { url?: unknown; title?: unknown; visitedAt?: unknown; favicon?: unknown }): GlobalHistoryEntry | null {
    const url = typeof visit?.url === "string" ? visit.url.trim() : "";
    if (!url || !isHttpUrl(url)) return null;
    const visitedAt =
      typeof visit?.visitedAt === "number" && Number.isFinite(visit.visitedAt) && visit.visitedAt > 0
        ? Math.floor(visit.visitedAt)
        : Date.now();
    const title = normalizeTitle(visit?.title);
    const favicon = normalizeFavicon(visit?.favicon);
    const existing = this.entries.find((entry) => entry.url === url);
    const merged: GlobalHistoryEntry = existing
      ? {
          url,
          ...(title ?? existing.title ? { title: title ?? existing.title } : {}),
          ...(favicon ?? existing.favicon ? { favicon: favicon ?? existing.favicon } : {}),
          visitedAt,
          visitCount: existing.visitCount + 1,
        }
      : { url, ...(title ? { title } : {}), ...(favicon ? { favicon } : {}), visitedAt, visitCount: 1 };
    // 去重：同 URL 只保留合并后的一条，并回到最前（"最近访问"语义）
    this.entries = [merged, ...this.entries.filter((entry) => entry.url !== url)].slice(0, MAX_GLOBAL_HISTORY);
    this.save();
    return { ...merged };
  }

  /** 页面图标迟到/变化时，更新同 URL 条目的图标（不改变排序、不增加访问次数）。 */
  updateFavicon(url: string, favicon: unknown): boolean {
    const normalizedUrl = typeof url === "string" ? url.trim() : "";
    const normalizedFavicon = normalizeFavicon(favicon);
    if (!normalizedUrl || !normalizedFavicon) return false;
    const entry = this.entries.find((item) => item.url === normalizedUrl);
    if (!entry || entry.favicon === normalizedFavicon) return false;
    entry.favicon = normalizedFavicon;
    this.save();
    return true;
  }

  /** 页面标题迟到/变化时，更新同 URL 条目的标题（不改变排序、不增加访问次数）。 */
  updateTitle(url: string, title: unknown): boolean {
    const normalizedUrl = typeof url === "string" ? url.trim() : "";
    const normalizedTitle = normalizeTitle(title);
    if (!normalizedUrl || !normalizedTitle) return false;
    const entry = this.entries.find((item) => item.url === normalizedUrl);
    if (!entry || entry.title === normalizedTitle) return false;
    entry.title = normalizedTitle;
    this.save();
    return true;
  }

  /**
   * 补记（会话恢复专用）：把「开机恢复出来的旧标签」补进全局历史，但**不伪造一次新访问**：
   *   · URL 不存在 → 新增一条（visitedAt = 补记时刻、visitCount = 1，按传入顺序排在列表最前）；
   *   · URL 已存在 → 只按需补标题（原条目无标题、本次有），**不改 visitedAt、不增 visitCount、
   *     不改变排序**——恢复不是"用户刚看过"，用它抬高最近排序或访问次数会污染历史信号；
   *   · 同批次重复 URL / 非 http(s) / 空地址 → 跳过。
   *
   * 为什么需要它：会话恢复被有意设计为「不记录访问」（否则每次重启都把旧页面当成新访问）。
   * 但老用户升级到「全局历史」后，历史面板唯一数据来源是这张表，恢复的标签又不会写进来 →
   * 面板看起来是空的（用户反馈）。补记正好填上这个缺口，同时保留"恢复不计访问"的语义。
   */
  backfill(visits: readonly BackfillVisit[]): BackfillStats {
    const stats: BackfillStats = { added: 0, merged: 0, skipped: 0 };
    if (!Array.isArray(visits) || visits.length === 0) return stats;
    const now = Date.now();
    const seen = new Set<string>();
    const pending: GlobalHistoryEntry[] = [];
    let titleChanged = false;

    for (const visit of visits) {
      const url = typeof visit?.url === "string" ? visit.url.trim() : "";
      if (!url || !isHttpUrl(url) || seen.has(url)) {
        stats.skipped += 1;
        continue;
      }
      seen.add(url);
      const title = normalizeTitle(visit?.title);
      const existing = this.entries.find((entry) => entry.url === url);
      if (existing) {
        stats.merged += 1;
        // 只补空标题：已有标题更可信（用户实际看到过的页面标题），不被恢复态覆盖
        if (!existing.title && title) {
          existing.title = title;
          titleChanged = true;
        }
        continue;
      }
      pending.push({ url, ...(title ? { title } : {}), visitedAt: now, visitCount: 1 });
    }

    if (pending.length > 0) {
      // 传入顺序 = 恢复时的标签顺序：整体保持顺序放在最前（首个标签排第一），旧的已存在条目顺延在后
      this.entries = pending.concat(this.entries).slice(0, MAX_GLOBAL_HISTORY);
      stats.added = pending.length;
    }
    if (stats.added > 0 || titleChanged) this.save();
    return stats;
  }

  /** 清空历史（设置/隐私操作用）。 */
  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.save();
  }

  /** 批量删除指定 URL 的历史（历史页勾选删除用；返回实际删除条数，幂等）。 */
  remove(urls: readonly string[]): number {
    const targets = new Set(
      urls
        .filter((url): url is string => typeof url === "string")
        .map((url) => url.trim())
        .filter((url) => url.length > 0 && isHttpUrl(url)),
    );
    if (targets.size === 0 || this.entries.length === 0) return 0;
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => !targets.has(entry.url));
    const removed = before - this.entries.length;
    if (removed > 0) this.save();
    return removed;
  }

  /* ─────────────────────────────── 持久化 ─────────────────────────────── */

  /** 读取并净化：坏文件改名留证后以空历史启动；结构不合法（含手改）逐条丢弃而不是整体拒绝。 */
  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      // 兼容两种形状：{ version, entries } 与裸数组（手工/未来降级写出的文件）
      const rows = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { entries?: unknown } | null)?.entries)
          ? ((parsed as { entries: unknown[] }).entries as unknown[])
          : null;
      if (!rows) throw new Error("结构不合法：缺少 entries 数组");
      this.entries = this.sanitize(rows);
    } catch {
      this.entries = [];
      // 保留现场便于排查（不覆盖原文件，改名后重新开始）
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        // 改名失败（只读/占用）：放弃留证，仍以空历史继续
      }
    }
  }

  /** 逐条净化：只保留 http(s)、时间/次数补默认值、按 URL 去重、按时间倒序、截断上限。 */
  private sanitize(rows: unknown[]): GlobalHistoryEntry[] {
    const seen = new Set<string>();
    const out: GlobalHistoryEntry[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const item = row as { url?: unknown; title?: unknown; visitedAt?: unknown; visitCount?: unknown; favicon?: unknown };
      const url = typeof item.url === "string" ? item.url.trim() : "";
      if (!url || !isHttpUrl(url) || seen.has(url)) continue;
      seen.add(url);
      const visitedAt =
        typeof item.visitedAt === "number" && Number.isFinite(item.visitedAt) && item.visitedAt > 0
          ? Math.floor(item.visitedAt)
          : 0;
      const count = typeof item.visitCount === "number" && Number.isFinite(item.visitCount) && item.visitCount >= 1
        ? Math.floor(item.visitCount)
        : 1;
      const title = normalizeTitle(item.title);
      const favicon = normalizeFavicon(item.favicon);
      out.push({ url, ...(title ? { title } : {}), ...(favicon ? { favicon } : {}), visitedAt, visitCount: count });
    }
    out.sort((a, b) => b.visitedAt - a.visitedAt);
    return out.slice(0, MAX_GLOBAL_HISTORY);
  }

  /** 原子写：`.tmp` 写完再 rename；失败退回直接覆盖（Windows 目标被占用时 rename 会抛）。 */
  private save(): void {
    const payload = JSON.stringify({ version: HISTORY_FILE_VERSION, entries: this.entries }, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      try {
        fs.renameSync(tmp, this.filePath);
        return;
      } catch {
        fs.writeFileSync(this.filePath, payload, "utf8");
        try {
          fs.unlinkSync(tmp);
        } catch {
          // 残留 tmp 无害：下次写入会覆盖
        }
        return;
      }
    } catch {
      // 只读磁盘 / 目录不可写：历史退化为内存态，不影响浏览
    }
  }
}
