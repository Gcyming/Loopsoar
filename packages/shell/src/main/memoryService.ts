/**
 * 记忆服务（壳层）：持久化 JSON + 五个门的写入治理 + 召回注入 + 混合检索（ADR-0007 W5）。
 * 存储位置可配置（设置 · 存储 · 记忆库路径），默认 <dataDir>/memory/memory.json。
 *
 * 向量能力（ADR-0007 裁决后的默认方案）：
 *   · 默认 = 纯 TS：FlatVectorIndex + 确定性 hash embedding（零原生依赖，离线可用）；
 *   · 可选 = sqlite-vec（better-sqlite3+sqlite-vec 原生索引，vectorBackend: "sqlite-vec"）：
 *     原生模块缺失 / Electron ABI 不匹配 / 加载失败 → 自动降级 flat，绝不抛；
 *   · 若注入了 embed（或平台 platform.embed = llama-server BGE-M3 127.0.0.1:8991 可用），
 *     load/写入后维护外部向量索引，searchAsync() 走真实语义检索；任何失败自动降级 hash，
 *     绝不让记忆检索因为本地模型没起来而不可用（fail-open 到可用的词法检索）。
 *   · 默认 flat 的裁决依据：docs/research/memory-bench-ADR-0007.md §8（10 万条实测 sqlite-vec 无优势，
 *     且原生依赖带来 Electron ABI 重建/打包复杂度；小容量（≤2000）flat 更快更稳）。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_EMBED_DIM,
  MemoryStore,
  extractMemoryCandidates,
  factToMarkdown,
  hashEmbedding,
  INDEX_SHARDS,
  markdownToFact,
  memoryFileName,
  parseShard,
  renderMemoryMarkdown,
  renderVaultIndex,
  retrieveMemory,
  serializeShard,
  shardFileName,
  shardOf,
  shouldRecall,
  type IndexEntry,
  type MemoryCandidate,
  type MemoryFact,
  type UsageEvent,
  type VectorLookup,
} from "loopsoar-core/memory";
import type { LoopsoarPlatform } from "loopsoar-core/platform";
import { resolveVectorBackend, type VectorBackend, type VectorBackendKind } from "./sqliteVectorBackend.js";

/** 外部 embedding 注入签名（与 llama-server /v1/embeddings 同构；失败必须 throw，由服务降级）。 */
export type MemoryEmbedder = (texts: string[]) => Promise<number[][]>;

/** 当前向量空间：hash=纯 TS 词法向量；external=外部模型（BGE-M3 等）真实语义向量。 */
export type MemoryEmbeddingMode = "hash" | "external";

export interface MemoryServiceOptions {
  platform: LoopsoarPlatform;
  filePath: string;
  capacity?: number;
  /**
   * 召回门控开关（默认 true = 开启）。
   * 开启时：recallPrompt 只在 core recallGate 的廉价信号命中（上次/这个/引号/路径/专有名词…）才检索，
   * 未命中返回 ""（不把无关记忆注入上下文，省 token 也防误导）；显式工具 memory_search 不受此门控。
   * 设为 false 时总是检索，用于兼容旧行为或做「有/无门控」对照测试。
   */
  recallGate?: boolean;
  /** 外部 embedding（缺省自动尝试 platform.embed；都不可用/失败 → hash embedding 降级）。 */
  embed?: MemoryEmbedder;
  /** hash embedding 维度（默认 256，与 core vector 默认一致）。 */
  vectorDim?: number;
  /** 外部 embedding 刷新超时（默认 3000ms；超时降级 hash，避免启动被本地模型拖死）。 */
  embedTimeoutMs?: number;
  /** 默认 agent 归属（多 Agent 第 5 闸跨 agent 指针；默认 "loopsoar"）。 */
  agentId?: string;
  /**
   * 向量索引后端（ADR-0007 F8 收口）：
   *   · "flat"（默认）= 纯 TS FlatVectorIndex，零原生依赖、启动零开销；
   *   · "sqlite-vec" = better-sqlite3 + sqlite-vec 原生索引；模块缺失 / Electron ABI 不匹配 /
   *     加载失败时自动降级 flat（绝不抛，vectorStats().backendNote 记录原因）。
   * 默认 flat 的原因见 docs/research/memory-bench-ADR-0007.md §8（10 万条实测 sqlite-vec 无优势）。
   */
  vectorBackend?: VectorBackendKind;
  /** 后端工厂覆盖（测试/高级用法）：返回 null 表示不可用 → 自动降级 flat。 */
  vectorBackendFactory?: (dimension: number) => VectorBackend | null;
}

/** 向量诊断信息（设置·诊断/基准报告/测试用）。 */
export interface MemoryVectorStats {
  mode: MemoryEmbeddingMode;
  /** 配置请求的后端（flat / sqlite-vec）。 */
  requestedBackend: VectorBackendKind;
  /** 实际生效的后端（请求 sqlite-vec 但不可用时会降级为 flat）。 */
  backend: VectorBackendKind;
  /** 降级/初始化说明（正常为 undefined）。 */
  backendNote?: string;
  hashDimension: number;
  hashIndexSize: number;
  hashIndexBytes: number;
  externalDimension: number;
  externalIndexSize: number;
}

const DEFAULT_EMBED_TIMEOUT_MS = 3_000;

/** sidecar（usage.json）版本：只放易变字段与使用事件，随时可删可重建。 */
const SIDECAR_VERSION = 1;

interface RuntimeEntry {
  accessCount: number;
  lastAccessed: number;
  confidence: number;
}

interface Sidecar {
  version: number;
  runtime: Record<string, RuntimeEntry>;
  usage: Record<string, UsageEvent[]>;
}

/** 内容指纹：用于增量写，避免每次召回/捕获都重写全部 md。 */
function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** 索引里存的 fact：剥掉易变字段，避免每次召回/记录使用都重写分片。 */
function stableFact(fact: MemoryFact): MemoryFact {
  return { ...fact, accessCount: 0, lastAccessed: fact.timestamp, confidence: 0.6 };
}

/** 从平台适配层解析 embed 能力；缺失/未实现时返回 null（不抛，交由 hash 降级）。 */
function resolvePlatformEmbedder(platform: LoopsoarPlatform | undefined): MemoryEmbedder | null {
  const adapter = platform?.embed as { embed?: unknown } | undefined;
  if (!adapter || typeof adapter.embed !== "function") return null;
  return (texts: string[]) => (adapter.embed as (input: string[]) => Promise<number[][]>).call(adapter, texts);
}

/** 超时包装：本地模型不可用时必须在有限时间内失败并降级，不能挂住记忆加载。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 把外部 embedding 返回值规整为 Float32Array（校验数量/维度/有限值；不合法返回 null → 降级）。 */
function normalizeExternalVectors(raw: unknown, expectedCount: number): { dim: number; vectors: Float32Array[] } | null {
  if (!Array.isArray(raw) || raw.length !== expectedCount) return null;
  const vectors: Float32Array[] = [];
  let dim = 0;
  for (const item of raw) {
    if (!Array.isArray(item) || item.length === 0) return null;
    if (dim === 0) dim = item.length;
    else if (item.length !== dim) return null;
    const vector = new Float32Array(item.length);
    for (let i = 0; i < item.length; i++) {
      const value = Number(item[i]);
      if (!Number.isFinite(value)) return null;
      vector[i] = value;
    }
    vectors.push(vector);
  }
  return { dim, vectors };
}

export class MemoryService {
  private store: MemoryStore;
  private loaded = false;
  private readonly hashDim: number;
  private hashIndex: VectorBackend;
  private readonly backendRequested: VectorBackendKind;
  private readonly backendNote?: string;
  private externalVectors: Map<string, Float32Array> | null = null;
  private externalDim = 0;
  /** 外部 embedding 已确认不可用（连接失败/维度非法）→ 本进程内不再重试，避免每次写入都付探测成本。 */
  private externalDisabled = false;
  private readonly embedFn: MemoryEmbedder | null;
  private readonly embedTimeoutMs: number;
  /** 使用事件写入很频繁：合并成一次落盘，避免每次工具调用都写文件。 */
  private saveTimer: NodeJS.Timeout | null = null;
  /** vault 内容指纹（id → 路径 + hash）：save 只写变化的那几个文件。 */
  private lastWritten = new Map<string, string>();
  private lastIndexHash = "";
  /** vault 内容索引（id → 路径 + 内容哈希 + 解析结果）：可丢弃缓存，md 才是真相。 */
  private indexEntries = new Map<string, IndexEntry>();
  /** 本次改动过的分片：只重写这些文件。 */
  private touchedShards = new Set<number>();
  /** 后台核对（索引快路径）：启动后与磁盘逐文件对哈希。 */
  private reconcilePromise: Promise<void> | null = null;
  /** vault 监听：外部编辑（Obsidian 等）实时同步，不必重启。 */
  private watcher: fs.FSWatcher | null = null;
  private watcherTimer: NodeJS.Timeout | null = null;
  private pendingPaths = new Set<string>();

  constructor(private opts: MemoryServiceOptions) {
    this.store = new MemoryStore({ capacity: opts.capacity, agentId: opts.agentId });
    this.hashDim = Number.isInteger(opts.vectorDim) && (opts.vectorDim as number) > 0 ? (opts.vectorDim as number) : DEFAULT_EMBED_DIM;
    const resolved = resolveVectorBackend({
      requested: opts.vectorBackend,
      dimension: this.hashDim,
      capacity: 64,
      factory: opts.vectorBackendFactory,
    });
    this.hashIndex = resolved.backend;
    this.backendRequested = resolved.requested;
    this.backendNote = resolved.note;
    this.embedFn = opts.embed ?? resolvePlatformEmbedder(opts.platform);
    this.embedTimeoutMs = opts.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  }

  get filePath(): string {
    return this.opts.filePath;
  }

  /** 切换存储路径（设置里改了记忆库位置后调用）：先保存旧库，再指向新库并加载。 */
  async relocate(filePath: string): Promise<void> {
    this.stopWatcher();
    if (this.reconcilePromise) await this.reconcilePromise;
    await this.save();
    this.opts = { ...this.opts, filePath };
    this.lastWritten = new Map();
    this.lastIndexHash = "";
    this.indexEntries = new Map();
    this.touchedShards = new Set();
    this.store = new MemoryStore({ capacity: this.opts.capacity, agentId: this.opts.agentId });
    this.loaded = false;
    // 换库时重新给本地模型一次机会（可能刚启动）
    this.externalDisabled = false;
    this.externalVectors = null;
    this.externalDim = 0;
    await this.load();
  }

  /** vault 根目录：<记忆目录>/vault，一条记忆一个 md（Obsidian 可直接打开）。 */
  get vaultPath(): string {
    return path.join(path.dirname(this.opts.filePath), "vault");
  }

  private get sidecarPath(): string {
    return path.join(path.dirname(this.opts.filePath), "usage.json");
  }

  /** 索引目录：vault/.loopsoar/index（点目录，Obsidian 默认不展示）。 */
  private get indexDir(): string {
    return path.join(this.vaultPath, ".loopsoar", "index");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const factsDir = path.join(this.vaultPath, "facts");
    const archiveDir = path.join(this.vaultPath, "archive");
    const legacyPath = this.opts.filePath;
    const legacyExists =
      (await this.opts.platform.fs.exists(legacyPath)) || (await this.opts.platform.fs.exists(`${legacyPath}.bak`));

    await this.loadIndex();
    let fromIndex = false;
    if (this.hasVaultNotes(factsDir, archiveDir)) {
      // 有索引 → 先用索引秒开，再后台逐文件核对；无索引（首次/损坏）→ 全量解析。
      const loaded =
        this.indexEntries.size > 0 ? this.loadFromIndex() : await this.readVaultIndexed(factsDir, archiveDir);
      const sidecar = await this.readSidecar();
      this.applyRuntime(loaded.facts, loaded.archived, sidecar.runtime);
      this.store.restore({ facts: loaded.facts, archived: loaded.archived, usage: sidecar.usage });
      // 索引快路径已知每个文件的内容哈希：直接复用，避免把 10k 条记忆重新序列化+哈希一遍
      this.lastWritten = loaded.fromIndex
        ? loaded.lastWritten
        : this.fingerprint(loaded.facts, loaded.archived, loaded.paths);
      if (!loaded.fromIndex) await this.persistIndex(loaded.facts, loaded.archived, loaded.written);
      console.warn(`[Loopsoar] 记忆仓库：${this.vaultPath}（${loaded.facts.length} 活跃 / ${loaded.archived.length} 归档）`);
      fromIndex = loaded.fromIndex;
    } else if (legacyExists) {
      // 一次性迁移：旧 JSON（含 .bak 兜底）→ Markdown 仓库；原文件改名 .migrated 以便回滚。
      const parsed = await this.readLegacyJson(legacyPath);
      this.store.restore(parsed);
      console.warn(`[Loopsoar] 记忆已迁移到 Markdown 仓库：${this.vaultPath}`);
      await this.save();
      try {
        if (await this.opts.platform.fs.exists(legacyPath)) fs.renameSync(legacyPath, `${legacyPath}.migrated`);
      } catch {
        // 改名失败不影响使用：vault 已存在，下次加载优先 vault
      }
    } else {
      this.store.restore({});
    }
    // E-M1：长期未用的 episode 降级为 ghost（失真层），随启动做一次维护。
    if (this.store.demoteGhosts().length > 0) await this.save();
    // 索引在 load 后立即维护：hash 索引同步重建（毫秒级）；外部向量尽力而为（超时/失败降级 hash）
    await this.rebuildVectorIndex();
    this.loaded = true;
    this.startWatcher();
    // 先把索引状态服务起来，再后台逐文件核对（外部编辑/删除会在核对后生效）
    if (fromIndex) this.reconcilePromise = this.reconcileAll();
  }

  /** 后台核对是否仍在进行（设置页展示「核对中」，让最终一致窗口可见）。 */
  get reconciling(): boolean {
    return this.reconcilePromise !== null;
  }

  /** 测试/退出用：等待后台核对完成。 */
  async whenSettled(): Promise<void> {
    if (this.reconcilePromise) await this.reconcilePromise;
  }

  /** 有索引时直接构造内存状态（不读文件）；正确性交给后台 reconcileAll 用哈希核对。 */
  private loadFromIndex(): {
    facts: MemoryFact[];
    archived: MemoryFact[];
    paths: Map<string, string>;
    written: Map<string, { file: string; hash: string }>;
    lastWritten: Map<string, string>;
    fromIndex: boolean;
  } {
    const facts: MemoryFact[] = [];
    const archived: MemoryFact[] = [];
    const paths = new Map<string, string>();
    const written = new Map<string, { file: string; hash: string }>();
    const lastWritten = new Map<string, string>();
    for (const [id, entry] of this.indexEntries) {
      const fact = { ...entry.fact };
      const file = path.join(this.vaultPath, entry.path);
      const archivedFlag = Boolean(fact.archivedAt) || fact.status !== "active" || entry.path.startsWith("archive/");
      (archivedFlag ? archived : facts).push(fact);
      paths.set(id, file);
      written.set(id, { file, hash: entry.hash });
      lastWritten.set(id, `${file}\u0000${entry.hash}`);
    }
    return { facts, archived, paths, written, lastWritten, fromIndex: true };
  }

  /**
   * 后台核对：逐文件算哈希，与索引比对；变化的重新解析并 upsert，删除的移除。
   * 索引只是缓存，任何不一致都以磁盘为准。
   */
  private async reconcileAll(): Promise<void> {
    const factsDir = path.join(this.vaultPath, "facts");
    const archiveDir = path.join(this.vaultPath, "archive");
    const byPath = new Map<string, { id: string; entry: IndexEntry }>();
    for (const [id, entry] of this.indexEntries) byPath.set(entry.path, { id, entry });
    const presentPaths = new Set<string>();
    const changedFacts: MemoryFact[] = [];
    const removedIds: string[] = [];
    let changed = false;

    for (const [dir, relDir, isArchive] of [
      [factsDir, "facts", false],
      [archiveDir, "archive", true],
    ] as const) {
      const names = this.listMarkdown(dir);
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < names.length) {
          const name = names[cursor++] as string;
          const file = path.join(dir, name);
          const rel = `${relDir}/${name}`;
          presentPaths.add(rel);
          try {
            const text = await fs.promises.readFile(file, "utf8");
            const hash = hashText(text);
            const cached = byPath.get(rel);
            if (cached && cached.entry.hash === hash) continue;
            const parsed = markdownToFact(text, name);
            if (!parsed) continue;
            const fact = parsed.fact;
            if (isArchive) {
              fact.archivedAt ??= Date.now();
              if (fact.status === "active") fact.status = "archived";
            }
            this.store.upsert(fact);
            this.indexEntries.set(fact.id, { path: rel, hash, fact: stableFact(fact) });
            this.touchedShards.add(shardOf(fact.id));
            this.lastWritten.set(fact.id, `${file}\u0000${hash}`);
            changedFacts.push(fact);
            changed = true;
          } catch (err) {
            console.warn(`[Loopsoar] 后台核对读取失败：${rel}`, err);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, Math.max(1, names.length)) }, worker));
    }

    for (const [id, entry] of [...this.indexEntries]) {
      if (presentPaths.has(entry.path)) continue;
      this.store.removeAnywhere(id);
      this.indexEntries.delete(id);
      this.touchedShards.add(shardOf(id));
      this.lastWritten.delete(id);
      removedIds.push(id);
      changed = true;
    }
    if (changed) {
      // 只更新变化的向量，避免外部改一条就重建全量索引（10k 时差别很大）
      if (changedFacts.length > 0) await this.indexFacts(changedFacts);
      for (const id of removedIds) {
        this.hashIndex.remove(id);
        this.externalVectors?.delete(id);
      }
    }
    await this.flushIndex();
    this.reconcilePromise = null;
  }

  /** vault 监听：外部编辑实时同步（Windows/macOS 支持递归；失败则退化为重启生效）。 */
  private startWatcher(): void {
    if (this.watcher) return;
    try {
      fs.mkdirSync(this.vaultPath, { recursive: true });
      this.watcher = fs.watch(this.vaultPath, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString().replace(/\\/g, "/");
        if (!rel.endsWith(".md") || rel === "index.md") return;
        this.pendingPaths.add(rel);
        if (this.watcherTimer) clearTimeout(this.watcherTimer);
        this.watcherTimer = setTimeout(() => void this.flushWatcher(), 400);
        this.watcherTimer.unref?.();
      });
    } catch (err) {
      console.warn("[Loopsoar] 记忆目录监听不可用（外部编辑需重启生效）", err);
    }
  }

  private async flushWatcher(): Promise<void> {
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    if (paths.length === 0) return;
    const changedFacts: MemoryFact[] = [];
    const removedIds: string[] = [];
    for (const rel of paths) {
      const result = await this.reconcilePath(rel);
      if (result.fact) changedFacts.push(result.fact);
      if (result.removedId) removedIds.push(result.removedId);
    }
    if (changedFacts.length > 0) await this.indexFacts(changedFacts);
    for (const id of removedIds) {
      this.hashIndex.remove(id);
      this.externalVectors?.delete(id);
    }
    if (changedFacts.length > 0 || removedIds.length > 0) await this.flushIndex();
  }

  /** 单个文件的外部变更：改/新建 → 解析并 upsert；删除 → 移除。 */
  private async reconcilePath(rel: string): Promise<{ fact?: MemoryFact; removedId?: string }> {
    const file = path.join(this.vaultPath, rel);
    try {
      const text = await fs.promises.readFile(file, "utf8");
      const hash = hashText(text);
      const entry = [...this.indexEntries.entries()].find(([, item]) => item.path === rel);
      if (entry && entry[1].hash === hash) return {};
      const parsed = markdownToFact(text, path.basename(file));
      if (!parsed) return {};
      const fact = parsed.fact;
      if (rel.startsWith("archive/")) {
        fact.archivedAt ??= Date.now();
        if (fact.status === "active") fact.status = "archived";
      }
      this.store.upsert(fact);
      this.indexEntries.set(fact.id, { path: rel, hash, fact: stableFact(fact) });
      this.touchedShards.add(shardOf(fact.id));
      this.lastWritten.set(fact.id, `${file}\u0000${hash}`);
      return { fact };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[Loopsoar] 同步外部编辑失败：${rel}`, err);
        return {};
      }
      const entry = [...this.indexEntries.entries()].find(([, item]) => item.path === rel);
      if (!entry) return {};
      this.store.removeAnywhere(entry[0]);
      this.indexEntries.delete(entry[0]);
      this.touchedShards.add(shardOf(entry[0]));
      this.lastWritten.delete(entry[0]);
      return { removedId: entry[0] };
    }
  }

  /** 停止监听（换库时先调用，避免旧库事件串到新库）。 */
  private stopWatcher(): void {
    if (this.watcherTimer) clearTimeout(this.watcherTimer);
    this.watcherTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private hasVaultNotes(factsDir: string, archiveDir: string): boolean {
    return this.listMarkdown(factsDir).length > 0 || this.listMarkdown(archiveDir).length > 0;
  }

  private listMarkdown(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith(".md"))
        .sort();
    } catch {
      return [];
    }
  }

  /** 读取 vault：facts/ 为活跃条目，archive/ 为归档（缺 archivedAt 用文件 mtime 兜底）。 */
  /**
   * 读 vault 的索引快路径：先读索引，再按内容哈希校验每个文件。
   * 哈希一致 → 复用索引里的解析结果（跳过 YAML 解析）；不一致 → 重新解析。
   * 异步并发读，避免上万条时阻塞主线程。
   */
  private async readVaultIndexed(
    factsDir: string,
    archiveDir: string,
  ): Promise<{
    facts: MemoryFact[];
    archived: MemoryFact[];
    /** 实际磁盘路径（文件名可能被手改/重命名），用于增量写时不制造「改名抖动」。 */
    paths: Map<string, string>;
    /** 本次读到的 id → 文件 + 内容哈希，供索引持久化。 */
    written: Map<string, { file: string; hash: string }>;
    /** 与 fingerprint 等价的「路径 + 哈希」基线，供增量写复用。 */
    lastWritten: Map<string, string>;
    fromIndex: boolean;
  }> {
    const facts: MemoryFact[] = [];
    const archived: MemoryFact[] = [];
    const paths = new Map<string, string>();
    const written = new Map<string, { file: string; hash: string }>();
    const seen = new Set<string>();
    const byPath = new Map<string, IndexEntry>();
    for (const entry of this.indexEntries.values()) byPath.set(entry.path, entry);

    for (const [dir, relDir, isArchive] of [
      [factsDir, "facts", false],
      [archiveDir, "archive", true],
    ] as const) {
      const names = this.listMarkdown(dir);
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < names.length) {
          const name = names[cursor++] as string;
          const file = path.join(dir, name);
          const rel = `${relDir}/${name}`;
          try {
            const text = await fs.promises.readFile(file, "utf8");
            const hash = hashText(text);
            const cached = byPath.get(rel);
            let fact: MemoryFact;
            if (cached && cached.hash === hash) {
              fact = { ...cached.fact };
            } else {
              const parsed = markdownToFact(text, name);
              if (!parsed) {
                console.warn(`[Loopsoar] 跳过无法解析的记忆文件：${name}`);
                continue;
              }
              if (parsed.warnings.length > 0) console.warn(`[Loopsoar] 记忆 ${name}：${parsed.warnings.join("；")}`);
              fact = parsed.fact;
            }
            if (isArchive && fact.archivedAt === undefined) fact.archivedAt = (await fs.promises.stat(file)).mtimeMs;
            if (isArchive && fact.status === "active") fact.status = "archived";
            const previous = this.indexEntries.get(fact.id);
            if (!previous || previous.hash !== hash || previous.path !== rel) this.touchedShards.add(shardOf(fact.id));
            this.indexEntries.set(fact.id, { path: rel, hash, fact: stableFact(fact) });
            paths.set(fact.id, file);
            written.set(fact.id, { file, hash });
            seen.add(fact.id);
            (isArchive ? archived : facts).push(fact);
          } catch (err) {
            console.warn(`[Loopsoar] 读取记忆文件失败：${name}`, err);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, Math.max(1, names.length)) }, worker));
    }

    for (const id of [...this.indexEntries.keys()]) {
      if (seen.has(id)) continue;
      this.indexEntries.delete(id);
      this.touchedShards.add(shardOf(id));
    }
    const lastWritten = new Map<string, string>();
    for (const [id, info] of written) lastWritten.set(id, `${info.file}\u0000${info.hash}`);
    return { facts, archived, paths, written, lastWritten, fromIndex: false };
  }

  /** 读索引分片；缺失/损坏都只是「没有缓存」，绝不影响正库加载。 */
  private async loadIndex(): Promise<void> {
    this.indexEntries.clear();
    this.touchedShards.clear();
    // 分片互相独立：并发读，避免 32 次串行 IO 把启动拖慢
    const shards = await Promise.all(
      Array.from({ length: INDEX_SHARDS }, async (_, i) => {
        const file = path.join(this.indexDir, shardFileName(i));
        try {
          if (!(await this.opts.platform.fs.exists(file))) return null;
          return { file, parsed: parseShard(await this.opts.platform.fs.readFileUtf8(file)) };
        } catch {
          return null;
        }
      }),
    );
    for (const shard of shards) {
      if (!shard) continue;
      if (!shard.parsed) {
        console.warn(`[Loopsoar] 记忆索引分片损坏，已忽略：${path.basename(shard.file)}`);
        continue;
      }
      for (const [id, entry] of Object.entries(shard.parsed.entries)) this.indexEntries.set(id, entry);
    }
  }

  /** 只写改动过的分片；索引是缓存，写失败不影响记忆本身。 */
  private async persistIndex(
    facts: readonly MemoryFact[],
    archived: readonly MemoryFact[],
    written: Map<string, { file: string; hash: string }>,
  ): Promise<void> {
    const live = new Set<string>();
    for (const fact of [...facts, ...archived]) {
      const info = written.get(fact.id);
      if (!info) continue;
      live.add(fact.id);
      const rel = path.relative(this.vaultPath, info.file).split(path.sep).join("/");
      const entry: IndexEntry = { path: rel, hash: info.hash, fact: stableFact(fact) };
      const previous = this.indexEntries.get(fact.id);
      if (previous && previous.path === entry.path && previous.hash === entry.hash) continue;
      this.indexEntries.set(fact.id, entry);
      this.touchedShards.add(shardOf(fact.id));
    }
    for (const id of [...this.indexEntries.keys()]) {
      if (live.has(id)) continue;
      this.indexEntries.delete(id);
      this.touchedShards.add(shardOf(id));
    }
    await this.flushIndex();
  }

  /** 把改动过的分片落盘；分片互相独立，单条记忆只重写一个文件。 */
  private async flushIndex(): Promise<void> {
    if (this.touchedShards.size === 0) return;
    const shards = new Map<number, Record<string, IndexEntry>>();
    for (const index of this.touchedShards) shards.set(index, {});
    for (const [id, entry] of this.indexEntries) {
      const bucket = shards.get(shardOf(id));
      if (bucket) bucket[id] = entry;
    }
    for (const [index, entries] of shards) {
      try {
        await this.writeAtomic(path.join(this.indexDir, shardFileName(index)), serializeShard(entries));
      } catch (err) {
        console.warn(`[Loopsoar] 记忆索引写入失败（可重建）：${path.basename(shardFileName(index))}`, err);
      }
    }
    this.touchedShards.clear();
  }

  private async readLegacyJson(legacyPath: string): Promise<{ facts?: MemoryFact[]; archived?: MemoryFact[] }> {
    for (const candidate of [legacyPath, `${legacyPath}.bak`]) {
      try {
        if (!(await this.opts.platform.fs.exists(candidate))) continue;
        return JSON.parse(await this.opts.platform.fs.readFileUtf8(candidate)) as {
          facts?: MemoryFact[];
          archived?: MemoryFact[];
        };
      } catch {
        console.warn(`[Loopsoar] 记忆文件损坏，尝试下一个：${candidate}`);
      }
    }
    return {};
  }

  private async readSidecar(): Promise<{ runtime: Record<string, RuntimeEntry>; usage: Record<string, UsageEvent[]> }> {
    try {
      if (!(await this.opts.platform.fs.exists(this.sidecarPath))) return { runtime: {}, usage: {} };
      const parsed = JSON.parse(await this.opts.platform.fs.readFileUtf8(this.sidecarPath)) as Partial<Sidecar>;
      return { runtime: parsed.runtime ?? {}, usage: parsed.usage ?? {} };
    } catch {
      console.warn("[Loopsoar] usage.json 损坏，已忽略（遥测可重建）");
      return { runtime: {}, usage: {} };
    }
  }

  /** 易变字段（访问次数/最后访问/置信度）从 sidecar 覆盖回来，md 里不写它们。 */
  private applyRuntime(facts: MemoryFact[], archived: MemoryFact[], runtime: Record<string, RuntimeEntry>): void {
    for (const fact of [...facts, ...archived]) {
      const entry = runtime[fact.id];
      if (!entry) continue;
      if (Number.isFinite(entry.accessCount)) fact.accessCount = entry.accessCount;
      if (Number.isFinite(entry.lastAccessed)) fact.lastAccessed = entry.lastAccessed;
      if (Number.isFinite(entry.confidence)) fact.confidence = entry.confidence;
    }
  }

  /** 载入后建立「id → 路径 + 内容指纹」基线，后续 save 只写变化的那几个文件。 */
  private fingerprint(
    facts: readonly MemoryFact[],
    archived: readonly MemoryFact[],
    paths: Map<string, string>,
  ): Map<string, string> {
    const map = new Map<string, string>();
    for (const fact of [...facts, ...archived]) {
      const file = paths.get(fact.id);
      if (!file) continue;
      map.set(fact.id, `${file}\u0000${hashText(factToMarkdown(fact))}`);
    }
    return map;
  }

  /**
   * 增量落盘：内容没变的文件不重写（读取/召回只改 sidecar 里的遥测）；
   * 写入仍是 tmp → fsync → rename，单文件原子。
   */
  async save(): Promise<void> {
    const snapshot = this.store.snapshot();
    const written = await this.writeVault(snapshot.facts, snapshot.archived);
    await this.writeSidecar(snapshot);
    await this.persistIndex(snapshot.facts, snapshot.archived, written);
  }

  private async writeVault(
    facts: readonly MemoryFact[],
    archived: readonly MemoryFact[],
  ): Promise<Map<string, { file: string; hash: string }>> {
    const seen = new Map<string, string>();
    const written = new Map<string, { file: string; hash: string }>();
    for (const [list, dir] of [
      [facts, "facts"],
      [archived, "archive"],
    ] as const) {
      for (const fact of list) {
        // 首次落盘用人类可读名；之后沿用已有文件名（改名会让外部 md 链接失效）。
        const previous = this.lastWritten.get(fact.id)?.split("\u0000")[0];
        const name = previous ? path.basename(previous) : memoryFileName(fact);
        let file = path.join(this.vaultPath, dir, name);
        // 同名不同条目（同一天、同标题）时用 id 后缀去重，保证不覆盖
        if ([...seen.values()].some((token) => token.split("\u0000")[0] === file)) {
          const suffix = fact.id.replace(/[^\w-]/g, "").slice(0, 8) || "dup";
          file = path.join(this.vaultPath, dir, name.replace(/\.md$/i, `-${suffix}.md`));
        }
        const text = factToMarkdown(fact);
        const hash = hashText(text);
        const token = `${file}\u0000${hash}`;
        seen.set(fact.id, token);
        written.set(fact.id, { file, hash });
        if (this.lastWritten.get(fact.id) === token) continue;
        await this.writeAtomic(file, text);
      }
    }
    // 库里已不存在的条目（删除 / 归档移动后的旧位置）要清理，否则会「复活」
    for (const [id, previous] of this.lastWritten) {
      if (seen.has(id)) continue;
      try {
        fs.unlinkSync(previous.split("\u0000")[0]);
      } catch {
        // 文件已不存在
      }
    }
    this.lastWritten = seen;

    const idsHash = hashText([...seen.keys()].sort().join(","));
    if (idsHash !== this.lastIndexHash) {
      await this.writeAtomic(path.join(this.vaultPath, "index.md"), renderVaultIndex(facts, archived));
      this.lastIndexHash = idsHash;
    }
    return written;
  }


  private async writeSidecar(snapshot: {
    facts: readonly MemoryFact[];
    archived: readonly MemoryFact[];
    usage?: Record<string, UsageEvent[]>;
  }): Promise<void> {
    const runtime: Record<string, RuntimeEntry> = {};
    for (const fact of [...snapshot.facts, ...snapshot.archived]) {
      runtime[fact.id] = {
        accessCount: fact.accessCount,
        lastAccessed: fact.lastAccessed,
        confidence: fact.confidence,
      };
    }
    const sidecar: Sidecar = { version: SIDECAR_VERSION, runtime, usage: snapshot.usage ?? {} };
    await this.writeAtomic(this.sidecarPath, JSON.stringify(sidecar, null, 2));
  }

  private async writeAtomic(file: string, text: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await this.opts.platform.fs.writeFileUtf8(tmp, text);
    try {
      const fd = fs.openSync(tmp, "r+");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // 某些文件系统不支持 fsync：继续 rename，不让写记忆失败
    }
    fs.renameSync(tmp, file);
  }

  /**
   * 导出 Markdown 快照（只读投影）：默认写到记忆目录下的 memory.md。
   * 不写 .bak：它是派生文件，随时可重导；写入仍以 vault 里的 md 为准。
   */
  async exportMarkdown(targetPath?: string): Promise<{ path: string; bytes: number; count: number }> {
    const target = targetPath ?? path.join(path.dirname(this.opts.filePath), "memory.md");
    const facts = this.store.list({ includeArchived: true, includeInvalidated: true });
    const text = renderMemoryMarkdown(facts, { generatedAt: Date.now() });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await this.opts.platform.fs.writeFileUtf8(tmp, text);
    fs.renameSync(tmp, target);
    return { path: target, bytes: Buffer.byteLength(text), count: facts.length };
  }

  /** 回顾候选：重要度高、近期用过的活跃条目（默认最多 24 条，够模型一次看完）。 */
  reviewCandidates(limit = 24): MemoryFact[] {
    return this.store
      .list()
      .filter((fact) => !fact.invalidatedAt && fact.status === "active")
      .sort((a, b) => b.importance - a.importance || b.lastAccessed - a.lastAccessed)
      .slice(0, limit);
  }

  /** 应用回顾标题：只改 frontmatter 的 title，不动正文、不改文件名（外部链接不失效）。 */
  async applyTitles(updates: readonly { id: string; title: string }[]): Promise<number> {
    const byId = new Map(updates.map((update) => [update.id, update.title.trim().slice(0, 60)]));
    const changed: MemoryFact[] = [];
    for (const fact of this.store.list()) {
      const title = byId.get(fact.id);
      if (!title || title === fact.title) continue;
      fact.title = title;
      changed.push(fact);
    }
    if (changed.length === 0) return 0;
    await this.save();
    await this.indexFacts(changed);
    return changed.length;
  }

  /** 应用回顾合并：返回实际合并掉的条目数（保留者可追溯）。 */
  async applyMerges(
    groups: readonly { ids: readonly string[]; reason?: string }[],
  ): Promise<{ merged: number; kept: string[] }> {
    const changed = new Map<string, MemoryFact>();
    const kept: string[] = [];
    let merged = 0;
    for (const group of groups) {
      const result = this.store.mergeGroup(group.ids, group.reason?.trim() || "回顾合并");
      if (!result) continue;
      merged += result.merged.length;
      kept.push(result.kept);
      for (const id of [result.kept, ...result.merged]) {
        const fact = this.store
          .list({ includeArchived: true, includeInvalidated: true })
          .find((item) => item.id === id);
        if (fact) changed.set(id, fact);
      }
    }
    if (changed.size > 0) {
      await this.save();
      await this.indexFacts([...changed.values()]);
    }
    return { merged, kept };
  }

  /** 后台巩固（D3 后半）：合并近似重复 + 归档长期未用条目；返回报告。 */
  async consolidate(workspaceId?: string): Promise<{ merged: number; archived: string[]; scanned: number }> {
    const report = this.store.consolidate(Date.now(), workspaceId ? { workspaceId } : {});
    if (report.merged > 0 || report.archived.length > 0) {
      await this.save();
      await this.rebuildVectorIndex();
    }
    return report;
  }

  /** 使用事件快照（图谱激活值用）。 */
  usageSnapshot(): ReturnType<MemoryStore["usageSnapshot"]> {
    return this.store.usageSnapshot();
  }

  /** 工具调用（E-M1）：记 tool 与 session 两条事件，合并落盘。 */
  recordToolUsage(toolName: string, sessionId?: string): void {
    this.store.recordUsage(`tool:${toolName}`, "tool");
    if (sessionId) this.store.recordUsage(`session:${sessionId}`, "tool");
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 500);
  }

  list(opts?: {
    includeArchived?: boolean;
    sortBy?: "updated" | "value" | "importance";
    workspaceId?: string;
    includeInvalidated?: boolean;
  }): MemoryFact[] {
    return this.store.list(opts);
  }

  stats(workspaceId?: string): ReturnType<MemoryStore["stats"]> {
    return this.store.stats(workspaceId);
  }

  get(id: string): MemoryFact | null {
    return this.store.get(id);
  }

  async add(candidate: MemoryCandidate): Promise<MemoryFact> {
    const fact = this.store.add(candidate);
    await this.save();
    await this.indexFacts([fact]);
    return fact;
  }

  async update(
    id: string,
    patch: Partial<Pick<MemoryFact, "content" | "category" | "tags" | "importance">>,
  ): Promise<MemoryFact | null> {
    const fact = this.store.update(id, patch);
    if (fact) {
      await this.save();
      await this.indexFacts([fact]);
    }
    return fact;
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.store.remove(id);
    if (removed) {
      this.hashIndex.remove(id);
      this.externalVectors?.delete(id);
      await this.save();
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.hashIndex.clear();
    this.externalVectors = null;
    this.externalDim = 0;
    await this.save();
  }

  /** 释放向量后端资源（sqlite-vec 的连接；flat 无操作）。应用退出/测试清理时调用。 */
  dispose(): void {
    this.stopWatcher();
    this.hashIndex.close();
  }

  /**
   * 召回提示词片段（供 ChatService 注入 volatile 段）。
   * 门控开启时（默认）：core recallGate 无信号命中 → 返回 ""，即不检索、不注入。
   * 说明：召回注入保持 v1 的关键词路径（store.recall），混合检索用于显式 search / searchAsync，
   * 避免自动注入的行为随向量权重变化而漂移（行为可回归、可对照）。
   */
  recallPrompt(text: string, workspaceId?: string): string {
    if (this.recallGateEnabled() && !shouldRecall(text).hit) return "";
    return this.store.recallPrompt(text, 6, workspaceId ? { workspaceId } : {});
  }

  /** 召回门控是否生效（默认开启；显式 recallGate:false 才关闭，便于测试/兼容对照）。 */
  private recallGateEnabled(): boolean {
    return this.opts.recallGate !== false;
  }

  /**
   * 显式检索（memory_search 工具用）：不走召回门控——模型/用户明确要求搜索时应当拿到结果。
   * 四阶段检索：门控（显式搜索跳过）→ BM25 候选 → hash 向量重排 → 阈值 + limit。
   * 保持同步签名（工具执行链路不变）；需要真实语义向量时用 searchAsync()。
   */
  search(query: string, limit = 6, workspaceId?: string): { fact: MemoryFact; score: number }[] {
    const safeLimit = this.clampLimit(limit);
    const facts = this.store.list(workspaceId ? { workspaceId } : {});
    if (facts.length === 0) return [];
    const lookup: VectorLookup = (id) => this.hashIndex.get(id);
    const hits = retrieveMemory({
      query,
      docs: facts,
      vectors: lookup,
      vectorDim: this.hashDim,
      limit: safeLimit,
    });
    const mapped = this.mapHits(hits, facts);
    // D3：显式检索命中才算一次使用（自动注入不算，避免富者愈富）。
    if (mapped.length > 0) {
      this.store.touch(mapped.map((hit) => hit.fact.id));
      this.scheduleSave();
    }
    return mapped;
  }

  /**
   * 混合检索（异步，真实 embedding 优先）：外部向量可用时用 BGE-M3 语义向量重排；
   * 外部向量/embed 不可用或失败 → 自动回退 search() 的 hash 混合检索（不抛错）。
   */
  async searchAsync(query: string, limit = 6, workspaceId?: string): Promise<{ fact: MemoryFact; score: number }[]> {
    const safeLimit = this.clampLimit(limit);
    if (!this.externalVectors || !this.embedFn) return this.search(query, safeLimit, workspaceId);
    const facts = this.store.list(workspaceId ? { workspaceId } : {});
    if (facts.length === 0) return [];
    try {
      const queryVectors = await this.embedTexts([query]);
      if (!queryVectors || queryVectors.length !== 1) return this.search(query, safeLimit);
      const hits = retrieveMemory({
        query,
        docs: facts,
        vectors: (id) => this.externalVectors?.get(id) ?? null,
        queryVector: queryVectors[0],
        limit: safeLimit,
      });
      return this.mapHits(hits, facts);
    } catch {
      return this.search(query, safeLimit);
    }
  }

  /**
   * 召回门控诊断：返回 shouldRecall 命中的信号列表（空数组 = 无信号、不会自动召回）。
   * 为什么暴露：日志/测试需要判断「这次没召回是没信号还是库里没有」，否则难排查。
   */
  recallSignals(query: string, lastTaskType?: string): string[] {
    return shouldRecall(query, lastTaskType).signals;
  }

  /** 当前向量空间模式（hash=词法兜底；external=真实 embedding 已就绪）。 */
  embeddingMode(): MemoryEmbeddingMode {
    return this.externalVectors ? "external" : "hash";
  }

  /** 向量索引诊断（内存/条数/维度/后端）。 */
  vectorStats(): MemoryVectorStats {
    const stats = this.hashIndex.stats();
    return {
      mode: this.embeddingMode(),
      requestedBackend: this.backendRequested,
      backend: this.hashIndex.kind,
      backendNote: this.backendNote,
      hashDimension: this.hashDim,
      hashIndexSize: stats.size,
      hashIndexBytes: stats.memoryBytes,
      externalDimension: this.externalDim,
      externalIndexSize: this.externalVectors?.size ?? 0,
    };
  }

  /**
   * 会话结束自动汇总：抽候选 → 五门治理写入 → 返回动作明细。
   * 为什么在 done 时做：一轮对话的最终文本只有一个稳定版本，避免流式中间态污染记忆。
   */
  async captureFromTurn(input: {
    userMessage: string;
    assistantReply: string;
    sessionId?: string;
    messageId?: string;
    workspaceId?: string;
  }): Promise<{ added: number; merged: number; deduped: number }> {
    const candidates = extractMemoryCandidates(input).map((candidate) => ({
      ...candidate,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      provenance: {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        trust: candidate.source === "assistant" ? ("agent" as const) : ("user" as const),
        capturedBy: "auto" as const,
      },
    }));
    if (candidates.length === 0) return { added: 0, merged: 0, deduped: 0 };
    const result = this.store.write(candidates);
    if (result.added.length || result.merged.length || result.deduped.length) {
      await this.save();
      // 新增条目建索引；合并会改写目标条目正文 → 需要重算其向量
      const touched = [...result.added, ...result.merged.map((item) => this.store.get(item.into)).filter((fact): fact is MemoryFact => fact !== null)];
      await this.indexFacts(touched);
    }
    return {
      added: result.added.length,
      merged: result.merged.length,
      deduped: result.deduped.length,
    };
  }

  /* ───────────────────────── 向量索引维护（内部） ───────────────────────── */

  /** 重建 hash 索引（同步、毫秒级）+ 尝试重建外部向量索引（超时/失败降级）。 */
  private async rebuildVectorIndex(): Promise<void> {
    const facts = this.store.list();
    // 复用同一后端实例（sqlite 后端复用连接）；先清空，避免 relocate 换库后残留旧条目
    this.hashIndex.clear();
    for (const fact of facts) this.hashIndex.upsert(fact.id, hashEmbedding(fact.content, this.hashDim));
    this.externalVectors = await this.buildExternalIndex(facts);
    this.externalDim = this.externalVectors ? this.externalDim : 0;
  }

  /** 外部向量全量构建：embedFn 缺失/失败/超时/维度不合法 → null（调用方保持 hash 模式）。 */
  private async buildExternalIndex(facts: MemoryFact[]): Promise<Map<string, Float32Array> | null> {
    if (!this.embedFn || this.externalDisabled || facts.length === 0) return null;
    try {
      const raw = await withTimeout(
        this.embedFn(facts.map((fact) => fact.content)),
        this.embedTimeoutMs,
        "记忆 embedding 构建",
      );
      const normalized = normalizeExternalVectors(raw, facts.length);
      if (!normalized) {
        this.externalDisabled = true;
        return null;
      }
      const map = new Map<string, Float32Array>();
      for (let i = 0; i < facts.length; i++) map.set(facts[i].id, normalized.vectors[i]);
      this.externalDim = normalized.dim;
      return map;
    } catch {
      // 本地模型未启动/超时：本进程内降级 hash，不再反复探测（fail-open 到可用检索）
      this.externalDisabled = true;
      return null;
    }
  }

  /** 增量维护：hash 索引必更新；外部索引未就绪时尝试激活一次，已就绪则增量更新。 */
  private async indexFacts(facts: MemoryFact[]): Promise<void> {
    for (const fact of facts) {
      if (!fact) continue;
      this.hashIndex.upsert(fact.id, hashEmbedding(fact.content, this.hashDim));
    }
    if (!this.embedFn || facts.length === 0) return;
    if (!this.externalVectors) {
      // 「load 时服务还没起来、后面才起来」的补救：首次写入时整体试建一次
      this.externalVectors = await this.buildExternalIndex(this.store.list());
      return;
    }
    const vectors = await this.embedTexts(facts.map((fact) => fact.content));
    if (!vectors || vectors.length !== facts.length) {
      this.externalVectors = null;
      this.externalDim = 0;
      return;
    }
    if (this.externalDim !== vectors[0].length) {
      // 向量空间变了（换了模型/维度）：整体降级 hash，等待下次 load 重建
      this.externalVectors = null;
      this.externalDim = 0;
      return;
    }
    for (let i = 0; i < facts.length; i++) this.externalVectors.set(facts[i].id, vectors[i]);
  }

  /** 调外部 embed（带超时）；失败返回 null（调用方决定降级）。 */
  private async embedTexts(texts: string[]): Promise<Float32Array[] | null> {
    if (!this.embedFn || texts.length === 0) return null;
    try {
      const raw = await withTimeout(this.embedFn(texts), this.embedTimeoutMs, "记忆 embedding");
      const normalized = normalizeExternalVectors(raw, texts.length);
      return normalized ? normalized.vectors : null;
    } catch {
      return null;
    }
  }

  private clampLimit(limit: number): number {
    const raw = Number.isFinite(limit) ? Math.floor(limit) : 6;
    return Math.max(1, Math.min(20, raw));
  }

  private mapHits(
    hits: { id: string; score: number }[],
    facts: MemoryFact[],
  ): { fact: MemoryFact; score: number }[] {
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    const result: { fact: MemoryFact; score: number }[] = [];
    for (const hit of hits) {
      const fact = byId.get(hit.id);
      if (fact) result.push({ fact, score: hit.score });
    }
    return result;
  }
}
