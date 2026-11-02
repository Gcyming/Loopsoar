/**
 * 审计落盘（追加式 JSONL）：
 *   <dir>/audit-YYYYMMDD.jsonl      当日审计文件
 *   <dir>/audit-YYYYMMDD.N.jsonl    轮转归档（N 越大越旧）
 *
 * 设计约束（审计是"旁路"，绝不能拖垮主流程）：
 *   - append() 只入内存队列并异步 appendFile，绝不抛异常（磁盘满/权限错都吞掉）；
 *   - 5MB 轮转，保留 keepFiles 份归档，防止审计文件无限增长吃满磁盘；
 *   - 字段截断（channel≤120 / reason≤500 / sender≤512），避免超长入参把单行撑成 MB 级；
 *   - 目录不存在自动创建；flush() 用于退出前把队列写完（配合 shutdown.ts 超时兜底）。
 */
import fs from "node:fs";
import path from "node:path";
import type { AuditEntry } from "./trustedIpc.js";

export interface AuditFileLoggerOptions {
  /** 审计目录（通常 <dataDir>/logs）。 */
  dir: string;
  /** 单文件轮转阈值（字节），默认 5MB。 */
  maxBytes?: number;
  /** 保留的轮转归档份数（不含当前文件），默认 5。 */
  keepFiles?: number;
  /** 时间源（测试注入固定时钟；生产用 Date.now）。 */
  now?: () => number;
}

/** 默认单文件上限 5MB。 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** 默认保留 5 份归档。 */
const DEFAULT_KEEP_FILES = 5;
const MAX_CHANNEL_CHARS = 120;
const MAX_REASON_CHARS = 500;
const MAX_SENDER_CHARS = 512;

/** 写入磁盘的审计行（在 AuditEntry 基础上补时间戳，便于跨文件排序/取证）。 */
interface AuditLine {
  ts: string;
  channel: string;
  sender: string;
  status: "ok" | "rejected";
  reason?: string;
}

function truncate(value: unknown, maxChars: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地日期戳 YYYYMMDD（与文件名一致；跨天自动换新文件）。 */
function dateStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

export class AuditFileLogger {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly keepFiles: number;
  private readonly now: () => number;

  /** 待写队列（行文本）。用串行 Promise 链保证顺序，且不阻塞调用方。 */
  private queue: string[] = [];
  private pending: Promise<void> = Promise.resolve();
  /** 当前写入的文件与已写入字节数（轮转判定依据）。 */
  private currentFile: string | null = null;
  private currentBytes = 0;

  constructor(opts: AuditFileLoggerOptions) {
    this.dir = opts.dir;
    this.maxBytes = Number.isFinite(opts.maxBytes) && (opts.maxBytes ?? 0) > 0 ? (opts.maxBytes as number) : DEFAULT_MAX_BYTES;
    this.keepFiles = Number.isFinite(opts.keepFiles) && (opts.keepFiles ?? 0) >= 0 ? Math.floor(opts.keepFiles as number) : DEFAULT_KEEP_FILES;
    this.now = opts.now ?? Date.now;
    // 目录自动创建；失败也不抛（append 时还会再试一次）
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      // 无法创建目录时审计降级为「只排队不落盘」，但主流程不受影响
    }
  }

  /** 入队一条审计记录（同步返回；写入在后台队列完成）。 */
  append(entry: AuditEntry): void {
    try {
      const line = `${JSON.stringify(this.toLine(entry))}\n`;
      this.queue.push(line);
      // 串到队列尾部：前一批写完后接着写这一批；单批写失败在 drain 内吞掉，队列继续
      this.pending = this.pending.then(() => this.drain(), () => this.drain());
    } catch {
      // 序列化异常（如循环引用）也不能影响主流程
    }
  }

  /** 等待当前队列全部落盘（退出前调用；失败也 resolve，不阻断退出）。 */
  flush(): Promise<void> {
    return this.pending.catch(() => undefined);
  }

  /** 诊断信息：当前应写入的文件、已写字节数、待写条数。 */
  stats(): { file: string; bytes: number; queued: number } {
    const file = this.currentFile ?? path.join(this.dir, `${this.stem(this.now())}.jsonl`);
    return { file, bytes: this.currentBytes, queued: this.queue.length };
  }

  /** 组装单行：字段截断 + 补时间戳。为什么截断：审计入参来自 IPC，可能有超长 URL/错误堆栈。 */
  private toLine(entry: AuditEntry): AuditLine {
    const raw = (entry ?? {}) as Partial<AuditEntry>;
    const reason = typeof raw.reason === "string" ? truncate(raw.reason, MAX_REASON_CHARS) : undefined;
    return {
      ts: new Date(this.now()).toISOString(),
      channel: truncate(raw.channel, MAX_CHANNEL_CHARS, "-"),
      sender: truncate(raw.sender, MAX_SENDER_CHARS, "-"),
      status: raw.status === "ok" ? "ok" : "rejected",
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  /** 文件名主干：audit-YYYYMMDD（当前文件加 .jsonl，归档加 .N.jsonl）。 */
  private stem(ts: number): string {
    return `audit-${dateStamp(ts)}`;
  }

  /** 取当前文件路径（跨天自动切换到新文件）。 */
  private async currentTarget(): Promise<string> {
    const stem = this.stem(this.now());
    const file = path.join(this.dir, `${stem}.jsonl`);
    if (this.currentFile !== file) {
      this.currentFile = file;
      this.currentBytes = await this.sizeOf(file);
    }
    return file;
  }

  /** 读文件大小；不存在/不可读按 0（新文件）。 */
  private async sizeOf(file: string): Promise<number> {
    try {
      const stat = await fs.promises.stat(file);
      return stat.size;
    } catch {
      return 0;
    }
  }

  /** 写入一批（只处理队列当前快照；写失败吞掉，绝不抛出）。 */
  private async drain(): Promise<void> {
    if (this.queue.length === 0) return;
    const lines = this.queue.splice(0);
    const text = lines.join("");
    const bytes = Buffer.byteLength(text, "utf8");
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      const file = await this.currentTarget();
      // 轮转：当前文件非空且再写会超阈值 → 先归档再写新文件（单行本身超限时照写，避免死循环）
      if (this.currentBytes > 0 && this.currentBytes + bytes > this.maxBytes) {
        await this.rotate();
        this.currentBytes = 0;
      }
      await fs.promises.appendFile(file, text, "utf8");
      this.currentBytes += bytes;
    } catch {
      // 磁盘满/权限/被占用：丢弃本批（审计失败不阻断业务，也不无限重试占内存）
    }
  }

  /** 轮转：audit-YYYYMMDD.jsonl → .1，旧 .1→.2 … 超出 keepFiles 的删除。 */
  private async rotate(): Promise<void> {
    const stemPath = path.join(this.dir, this.stem(this.now()));
    const current = `${stemPath}.jsonl`;
    try {
      // 先删最旧的，再整体后移，保证 N 越大越旧且不覆盖未归档文件
      if (this.keepFiles <= 0) {
        await fs.promises.rm(current, { force: true });
        return;
      }
      await fs.promises.rm(`${stemPath}.${this.keepFiles}.jsonl`, { force: true });
      for (let i = this.keepFiles - 1; i >= 1; i -= 1) {
        try {
          await fs.promises.rename(`${stemPath}.${i}.jsonl`, `${stemPath}.${i + 1}.jsonl`);
        } catch {
          // 该归档不存在属正常（还没转满）
        }
      }
      await fs.promises.rename(current, `${stemPath}.1.jsonl`);
    } catch {
      // 归档失败时保留当前文件继续追加（宁可超阈值，也不丢审计）
    }
  }
}
