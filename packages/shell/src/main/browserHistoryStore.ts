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
}

/** 全局历史上限：超过后丢弃最旧（列表末尾）。 */
export const MAX_GLOBAL_HISTORY = 500;

/** 落盘文件版本号（未来结构升级用；未知版本按「结构不可信」处理，容错为旧版读取）。 */
const HISTORY_FILE_VERSION = 1;

/** 标题上限（与标签标题渲染保持一致，避免被超长 <title> 撑坏 UI）。 */
const MAX_TITLE_CHARS = 120;

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
  record(visit: { url?: unknown; title?: unknown; visitedAt?: unknown }): GlobalHistoryEntry | null {
    const url = typeof visit?.url === "string" ? visit.url.trim() : "";
    if (!url || !isHttpUrl(url)) return null;
    const visitedAt =
      typeof visit?.visitedAt === "number" && Number.isFinite(visit.visitedAt) && visit.visitedAt > 0
        ? Math.floor(visit.visitedAt)
        : Date.now();
    const title = normalizeTitle(visit?.title);
    const existing = this.entries.find((entry) => entry.url === url);
    const merged: GlobalHistoryEntry = existing
      ? {
          url,
          ...(title ?? existing.title ? { title: title ?? existing.title } : {}),
          visitedAt,
          visitCount: existing.visitCount + 1,
        }
      : { url, ...(title ? { title } : {}), visitedAt, visitCount: 1 };
    // 去重：同 URL 只保留合并后的一条，并回到最前（"最近访问"语义）
    this.entries = [merged, ...this.entries.filter((entry) => entry.url !== url)].slice(0, MAX_GLOBAL_HISTORY);
    this.save();
    return { ...merged };
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

  /** 清空历史（设置/隐私操作用）。 */
  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.save();
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
      const item = row as { url?: unknown; title?: unknown; visitedAt?: unknown; visitCount?: unknown };
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
      out.push({ url, ...(title ? { title } : {}), visitedAt, visitCount: count });
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
