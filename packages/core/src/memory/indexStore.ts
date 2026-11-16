/**
 * vault 索引（内容哈希，不依赖 mtime）。
 *
 * 为什么需要：纯文件是真相，但每次启动把上万条 md 全部 YAML 解析一遍太贵。
 * 索引保存「路径 + 内容 sha1 + 已解析的 fact」，启动时只做两件事：
 *   1) 读索引（分片，快）；
 *   2) 重新哈希每个文件，哈希一致就复用解析结果，不一致才重新解析。
 *
 * 为什么用内容哈希而不是 mtime：同步盘/备份工具会保留旧 mtime，FAT 只有 2 秒粒度，
 * 用户也能手改时间；哈希是唯一可靠的「内容是否变过」判据。
 *
 * 索引是**可丢弃的缓存**：删掉/损坏都能从 md 全量重建，绝不作为唯一真相。
 */
import type { MemoryFact } from "./fact.js";

export const INDEX_VERSION = 1;
/** 分片数：写入一条记忆只重写一个分片，避免上万条时每次保存都写整库。 */
export const INDEX_SHARDS = 32;

export interface IndexEntry {
  /** 相对 vault 根目录的路径（facts/... 或 archive/...）。 */
  path: string;
  /** 文件内容的 sha1（十六进制）。 */
  hash: string;
  fact: MemoryFact;
}

export interface IndexShardData {
  version: number;
  entries: Record<string, IndexEntry>;
}

/** djb2：稳定、跨进程一致的分片函数（不依赖 node:crypto）。 */
export function shardOf(id: string): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i += 1) {
    hash = ((hash * 33) ^ id.charCodeAt(i)) >>> 0;
  }
  return hash % INDEX_SHARDS;
}

export function shardFileName(index: number): string {
  return `index-${String(index).padStart(2, "0")}.json`;
}

export function emptyShard(): IndexShardData {
  return { version: INDEX_VERSION, entries: {} };
}

/** 解析一个分片；版本不符或结构损坏返回 null（调用方忽略该分片，走全量解析）。 */
export function parseShard(text: string): IndexShardData | null {
  try {
    const parsed = JSON.parse(text) as Partial<IndexShardData>;
    if (parsed.version !== INDEX_VERSION || typeof parsed.entries !== "object" || parsed.entries === null) return null;
    const entries: Record<string, IndexEntry> = {};
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as IndexEntry).path === "string" &&
        typeof (entry as IndexEntry).hash === "string" &&
        (entry as IndexEntry).fact &&
        typeof (entry as IndexEntry).fact === "object"
      ) {
        entries[id] = entry as IndexEntry;
      }
    }
    return { version: INDEX_VERSION, entries };
  } catch {
    return null;
  }
}

/** 序列化分片（键排序，保证同一内容两次写入逐字节一致）。 */
export function serializeShard(entries: Record<string, IndexEntry>): string {
  const sorted: Record<string, IndexEntry> = {};
  for (const id of Object.keys(entries).sort()) sorted[id] = entries[id] as IndexEntry;
  return JSON.stringify({ version: INDEX_VERSION, entries: sorted } satisfies IndexShardData, null, 2);
}
