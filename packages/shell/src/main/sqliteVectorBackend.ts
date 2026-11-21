/**
 * 可选 sqlite-vec 向量后端（ADR-0007 F8 收口）：better-sqlite3 + sqlite-vec 索引实现。
 *
 * 设计约束（为什么这样写）：
 *   · **可选且 fail-open**：原生模块未安装 / Electron ABI 不匹配 / 加载抛错时 `createSqliteVecBackend`
 *     必须返回 null、绝不抛——记忆检索不允许因为原生依赖变砖，调用方（MemoryService）自动降级 flat TS；
 *   · **默认 flat**：10 万条实测（docs/research/memory-bench-ADR-0007.md §8）sqlite-vec 与 flat 暴力余弦
 *     同量级甚至更慢（HNSW/ANN 未启用时），而原生依赖带来 Electron ABI 重建与打包复杂度，
 *     所以 v1 默认 flat，sqlite-vec 仅在 `MemoryService.vectorBackend === "sqlite-vec"` 显式选择时启用；
 *   · **接口同构**：与 core 的 FlatVectorIndex 语义一致（upsert 归一化、get 返回副本、remove 幂等、
 *     search 返回余弦分），MemoryService 只依赖 VectorBackend 接口，换后端不改检索逻辑；
 *   · **不做类型级依赖**：better-sqlite3/sqlite-vec 无 @types，用 createRequire + 结构化最小类型，
 *     保证 tsconfig/typecheck 不需要原生包安装也能过（CI/打包机都能编译）。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { toUnpackedPath } from "./packagedPaths.js";
import { FlatVectorIndex } from "loopsoar-core/memory";

/** 向量后端种类（写入 vectorStats，供诊断/基准报告）。 */
export type VectorBackendKind = "flat" | "sqlite-vec";

export interface VectorBackendStats {
  backend: VectorBackendKind;
  size: number;
  dimension: number;
  /** 估算占用（sqlite-vec 为 DB 数据页 + 元数据的近似值）。 */
  memoryBytes: number;
}

export interface BackendSearchHit {
  id: string;
  /** 余弦相似度（降序）。 */
  score: number;
}

/**
 * 向量索引后端接口：MemoryService 的唯一依赖面。
 * 方法均为同步（better-sqlite3 同步 API；flat 更快），调用方在异步方法内使用。
 */
export interface VectorBackend {
  readonly kind: VectorBackendKind;
  readonly dimension: number;
  size(): number;
  /** 写入/覆盖：向量会先做 L2 归一化再存（检索按余弦）。维度不符抛错（fail-closed）。 */
  upsert(id: string, vector: Float32Array): void;
  remove(id: string): boolean;
  /** 返回归一化向量副本（不存在 null）；外部修改不影响索引。 */
  get(id: string): Float32Array | null;
  search(query: Float32Array, topK: number): BackendSearchHit[];
  clear(): void;
  memoryBytes(): number;
  stats(): VectorBackendStats;
  /** 释放底层资源（sqlite 连接；flat 无操作）。 */
  close(): void;
}

/** 纯 TS flat 后端（默认）：把 core FlatVectorIndex 适配成 VectorBackend。 */
export class FlatVectorBackend implements VectorBackend {
  readonly kind = "flat" as const;
  readonly dimension: number;
  private readonly index: FlatVectorIndex;

  constructor(dimension: number, initialCapacity = 64) {
    this.dimension = dimension;
    this.index = new FlatVectorIndex(dimension, initialCapacity);
  }

  size(): number {
    return this.index.size;
  }

  upsert(id: string, vector: Float32Array): void {
    this.index.upsert(id, vector);
  }

  remove(id: string): boolean {
    return this.index.remove(id);
  }

  get(id: string): Float32Array | null {
    return this.index.get(id);
  }

  search(query: Float32Array, topK: number): BackendSearchHit[] {
    return this.index.search(query, topK).map((hit) => ({ id: hit.id, score: hit.score }));
  }

  clear(): void {
    this.index.clear();
  }

  memoryBytes(): number {
    return this.index.memoryBytes();
  }

  stats(): VectorBackendStats {
    const stats = this.index.stats();
    return {
      backend: this.kind,
      size: stats.size,
      dimension: stats.dimension,
      memoryBytes: stats.memoryBytes,
    };
  }

  close(): void {
    // 纯 JS 索引无底层资源
  }
}

/* ───────────────────────── sqlite-vec：最小结构化类型（无 @types 依赖） ───────────────────────── */

interface SqliteStatementLike {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteRunResult {
  lastInsertRowid?: number | bigint;
}

interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec(sql: string): void;
  close(): void;
  /** better-sqlite3 的扩展加载（sqlite-vec 的 vec0.dll 走这里）。 */
  loadExtension?(path: string): void;
}

type SqliteDatabaseCtor = new (path: string, options?: Record<string, unknown>) => SqliteDatabaseLike;

interface SqliteVecModuleLike {
  load(db: unknown): void;
  /** 返回平台扩展文件路径（打包态在 asar 内，需要换成 unpacked）。 */
  getLoadablePath?(): string;
}

/** 依赖加载器：默认 createRequire("better-sqlite3"/"sqlite-vec")；测试可注入假模块。 */
export type NativeModuleLoader = (name: string) => unknown;

function defaultModuleLoader(): NativeModuleLoader {
  return (name: string) => {
    // 延迟到创建后端时才 require：这样「未选择 sqlite-vec / 未安装原生包」时应用启动零开销。
    // 打包态原生模块放在 resources/native/node_modules（extraResources），不在 asar 内；
    // 从该目录的 package.json 建立 require 基准，sqlite-vec 的平台包也能按名字解析。
    const nativeRoot = process.resourcesPath ? path.join(process.resourcesPath, "native", "node_modules") : "";
    const requireFn = createRequire(import.meta.url);
    // 打包态优先按绝对目录加载：resources/native/node_modules/<name>。
    // （从 node_modules 目录里的 package.json 建立基准时 Node 不会把该目录当作模块根，
    //   所以这里直接 require 包目录；sqlite-vec 内部再按名字找平台包，同目录即可解析。）
    if (nativeRoot) {
      const target = path.join(nativeRoot, name);
      if (fs.existsSync(path.join(target, "package.json"))) {
        return requireFn(target) as unknown;
      }
    }
    return requireFn(name) as unknown;
  };
}

function pickDatabaseCtor(module: unknown): SqliteDatabaseCtor | null {
  if (typeof module === "function") return module as SqliteDatabaseCtor;
  if (module && typeof module === "object") {
    const record = module as Record<string, unknown>;
    const candidate = record.default ?? record.Database;
    if (typeof candidate === "function") return candidate as SqliteDatabaseCtor;
  }
  return null;
}

function toBlob(vector: Float32Array): Buffer {
  // sqlite-vec 的 float[N] 绑定接受 float32 原始字节（Buffer 是 Uint8Array 子类）
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function blobToFloat32(value: unknown, expectedDim: number): Float32Array | null {
  if (!(value instanceof Uint8Array)) return null;
  if (value.byteLength !== expectedDim * 4) return null;
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return new Float32Array(copy.buffer, 0, expectedDim);
}

function normalizeCopy(vector: Float32Array): Float32Array {
  const copy = new Float32Array(vector.length);
  copy.set(vector);
  let normSq = 0;
  for (let i = 0; i < copy.length; i++) normSq += copy[i] * copy[i];
  if (normSq === 0) return copy;
  const inv = 1 / Math.sqrt(normSq);
  for (let i = 0; i < copy.length; i++) copy[i] *= inv;
  return copy;
}

/** 归一化向量的 L2 距离 → 余弦：||a-b||² = 2 - 2·cos(a,b)。 */
function distanceToCosine(distance: number): number {
  return 1 - (distance * distance) / 2;
}

class SqliteVecBackend implements VectorBackend {
  readonly kind = "sqlite-vec" as const;
  readonly dimension: number;
  private readonly db: SqliteDatabaseLike;
  private readonly insertVec: SqliteStatementLike;
  private readonly deleteVec: SqliteStatementLike;
  private readonly insertPayload: SqliteStatementLike;
  private readonly deletePayload: SqliteStatementLike;
  private readonly selectPayload: SqliteStatementLike;
  private readonly knn: SqliteStatementLike;
  private readonly rowIdByExternalId = new Map<string, number>();
  private readonly externalIdByRowId = new Map<number, string>();
  private liveCount = 0;

  constructor(dimension: number, db: SqliteDatabaseLike) {
    this.dimension = dimension;
    this.db = db;
    this.insertVec = db.prepare("INSERT INTO vec_items(embedding) VALUES (?)");
    this.deleteVec = db.prepare("DELETE FROM vec_items WHERE rowid = ?");
    this.insertPayload = db.prepare("INSERT INTO vec_payload(rowid, id, embedding) VALUES (?, ?, ?)");
    this.deletePayload = db.prepare("DELETE FROM vec_payload WHERE rowid = ?");
    this.selectPayload = db.prepare("SELECT embedding FROM vec_payload WHERE rowid = ?");
    this.knn = db.prepare("SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? ORDER BY distance LIMIT ?");
  }

  size(): number {
    return this.liveCount;
  }

  upsert(id: string, vector: Float32Array): void {
    if (!(vector instanceof Float32Array) || vector.length !== this.dimension) {
      throw new Error(`向量维度不匹配：期望 ${this.dimension}，实际 ${vector instanceof Float32Array ? vector.length : "非 Float32Array"}`);
    }
    const stored = normalizeCopy(vector);
    const blob = toBlob(stored);
    const existing = this.rowIdByExternalId.get(id);
    if (existing !== undefined) {
      this.deleteVec.run(existing);
      this.deletePayload.run(existing);
      this.rowIdByExternalId.delete(id);
      this.externalIdByRowId.delete(existing);
      this.liveCount -= 1;
    }
    // 注意：sqlite-vec 的 vec0 对显式 rowid 绑定不接受 better-sqlite3 的普通 number（报 "Only integers
    // are allows for primary key values"），改用自增 rowid 再读 lastInsertRowid，避免 cast hack。
    const inserted = this.insertVec.run(blob) as SqliteRunResult;
    const rowId = Number(inserted.lastInsertRowid);
    if (!Number.isFinite(rowId) || rowId <= 0) {
      throw new Error("sqlite-vec 插入失败：未返回有效 rowid");
    }
    this.insertPayload.run(rowId, id, blob);
    this.rowIdByExternalId.set(id, rowId);
    this.externalIdByRowId.set(rowId, id);
    this.liveCount += 1;
  }

  remove(id: string): boolean {
    const rowId = this.rowIdByExternalId.get(id);
    if (rowId === undefined) return false;
    this.deleteVec.run(rowId);
    this.deletePayload.run(rowId);
    this.rowIdByExternalId.delete(id);
    this.externalIdByRowId.delete(rowId);
    this.liveCount -= 1;
    return true;
  }

  get(id: string): Float32Array | null {
    const rowId = this.rowIdByExternalId.get(id);
    if (rowId === undefined) return null;
    const row = this.selectPayload.get(rowId) as { embedding?: unknown } | undefined;
    if (!row || row.embedding === undefined) return null;
    return blobToFloat32(row.embedding, this.dimension);
  }

  search(query: Float32Array, topK: number): BackendSearchHit[] {
    if (!(query instanceof Float32Array) || query.length !== this.dimension) {
      throw new Error(`查询向量维度不匹配：期望 ${this.dimension}`);
    }
    const k = Math.max(1, Math.floor(topK));
    if (this.liveCount === 0) return [];
    const normalized = normalizeCopy(query);
    const rows = this.knn.all(toBlob(normalized), k) as Array<{ rowid?: unknown; distance?: unknown }>;
    const hits: BackendSearchHit[] = [];
    for (const row of rows) {
      const rowId = Number(row.rowid);
      const id = this.externalIdByRowId.get(rowId);
      if (!id) continue;
      const distance = Number(row.distance);
      if (!Number.isFinite(distance)) continue;
      hits.push({ id, score: distanceToCosine(distance) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  clear(): void {
    this.db.exec("DELETE FROM vec_items; DELETE FROM vec_payload;");
    this.rowIdByExternalId.clear();
    this.externalIdByRowId.clear();
    this.liveCount = 0;
  }

  memoryBytes(): number {
    // vec0 索引页 + payload BLOB + 元数据：用「每向量两份 float32 + 约 64B 行开销」估算
    return this.liveCount * (this.dimension * 4 * 2 + 64);
  }

  stats(): VectorBackendStats {
    return {
      backend: this.kind,
      size: this.liveCount,
      dimension: this.dimension,
      memoryBytes: this.memoryBytes(),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // 重复 close / 连接已释放：忽略
    }
  }
}

export interface SqliteVecBackendOptions {
  dimension: number;
  /** 数据库位置：默认 ":memory:"（记忆持久化仍走 JSON，索引每次 load 重建）。 */
  databasePath?: string;
  /** 依赖加载器覆盖（测试注入假模块；默认 createRequire）。 */
  loadModule?: NativeModuleLoader;
}

/**
 * 尝试创建 sqlite-vec 后端。
 * 返回 null 的语义 = 「本机不可用，请降级 flat」：模块缺失、ABI 不匹配、扩展加载失败、表创建失败
 * 全部在此吞掉（不抛）——调用方据此自动降级，绝不让记忆检索不可用。
 */
export function createSqliteVecBackend(options: SqliteVecBackendOptions): VectorBackend | null {
  const dimension = Math.floor(options.dimension);
  if (!Number.isFinite(dimension) || dimension <= 0) return null;
  try {
    const loadModule = options.loadModule ?? defaultModuleLoader();
    const databaseCtor = pickDatabaseCtor(loadModule("better-sqlite3"));
    if (!databaseCtor) return null;
    const sqliteVec = loadModule("sqlite-vec") as SqliteVecModuleLike | null;
    if (!sqliteVec || typeof sqliteVec.load !== "function") return null;
    const db = new databaseCtor(options.databasePath ?? ":memory:");
    try {
      const loadable = typeof sqliteVec.getLoadablePath === "function" ? sqliteVec.getLoadablePath() : null;
      if (loadable && typeof db.loadExtension === "function") {
        // 安装包里 vec0.dll 位于 app.asar 内：SQLite 不认识 asar 虚拟路径，
        // 必须换成 app.asar.unpacked 下的真实文件（打包脚本已 asarUnpack）。
        db.loadExtension(toUnpackedPath(loadable));
      } else {
        sqliteVec.load(db);
      }
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(embedding float[${dimension}])`);
      db.exec(
        "CREATE TABLE IF NOT EXISTS vec_payload (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, embedding BLOB NOT NULL)",
      );
    } catch {
      try {
        db.close();
      } catch {
        // 关闭失败不影响「不可用」结论
      }
      return null;
    }
    return new SqliteVecBackend(dimension, db);
  } catch (err) {
    lastNativeError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/** 最近一次原生后端创建失败原因：仅用于 vectorStats 的降级说明。 */
let lastNativeError: string | null = null;

/** 后端创建结果（MemoryService 内部使用；note 用于 vectorStats 暴露降级原因）。 */
export interface VectorBackendResolution {
  backend: VectorBackend;
  requested: VectorBackendKind;
  note?: string;
}

/**
 * 按配置解析后端：requested="sqlite-vec" 时尝试原生后端，失败/工厂返回 null → flat 降级并记录原因。
 * 默认 flat 时完全不触碰原生模块（启动零开销、CI/打包机无需安装原生依赖也能跑）。
 */
export function resolveVectorBackend(opts: {
  requested?: VectorBackendKind;
  dimension: number;
  capacity?: number;
  factory?: (dimension: number) => VectorBackend | null;
}): VectorBackendResolution {
  const requested: VectorBackendKind = opts.requested ?? "flat";
  if (requested === "sqlite-vec") {
    try {
      const backend = opts.factory
        ? opts.factory(opts.dimension)
        : createSqliteVecBackend({ dimension: opts.dimension });
      if (backend && backend.dimension === opts.dimension) {
        return { backend, requested };
      }
      return {
        backend: new FlatVectorBackend(opts.dimension, opts.capacity ?? 64),
        requested,
        note: backend
          ? `sqlite-vec 后端维度不符（${backend.dimension} ≠ ${opts.dimension}），已降级 flat`
          : `sqlite-vec 不可用（${lastNativeError ?? "原生模块缺失或 Electron ABI 不匹配"}），已降级 flat`,
      };
    } catch (err) {
      return {
        backend: new FlatVectorBackend(opts.dimension, opts.capacity ?? 64),
        requested,
        note: `sqlite-vec 初始化失败（${err instanceof Error ? err.message : String(err)}），已降级 flat`,
      };
    }
  }
  return { backend: new FlatVectorBackend(opts.dimension, opts.capacity ?? 64), requested };
}
