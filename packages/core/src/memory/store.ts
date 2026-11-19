/**
 * 记忆库（纯逻辑）：在五闸之上做增删改查与检索。
 *
 * 设计依据（各家权威做法的交集）：
 *  - MemGPT（Packer et al. 2023）：分层记忆（工作/情景/语义）+ 显式读写与容量管理；
 *  - Mem0：写入前先「抽取候选 → 与已有记忆比对 → 更新/合并/新增」（不是无脑追加）；
 *  - Anthropic 记忆工具文档：记忆是外部持久化存储，检索按需注入，不塞满上下文；
 *  - 记忆类型（semantic / episodic / procedural）：本库用 category + layer 表达语义与情景两类，
 *    procedural（技能/流程）暂以 category 区分（导入技能库后单独分层）。
 *
 * 本模块零 node 依赖：文件读写由壳层负责，这里只处理状态与规则。
 */
import { createFact, DEFAULT_WORKSPACE_ID, type MemoryFact, type MemoryProvenance } from "./fact.js";
import {
  gateDedupe,
  gateMerge,
  gateLink,
  gateCapacity,
  gateCrossAgent,
  effectiveValue,
  jaccardCJK,
  sharedBigrams,
  THRESHOLD_CAPACITY_MAX,
  DEFAULT_AGENT_ID,
} from "./fiveGate.js";
import { detectSupersede } from "./supersede.js";

export interface MemoryCandidate {
  content: string;
  category: string;
  tags?: string[];
  importance?: number;
  source?: string;
  layer?: MemoryFact["layer"];
  /** 归属工作区（缺省 = store 的默认工作区）。写入治理只在同工作区内去重/合并/建链。 */
  workspaceId?: string;
  /** 溯源（会话/消息/工具/URL + 信任级别）。 */
  provenance?: MemoryProvenance;
  /** 归属 agent（缺省 = store 的默认 agent "loopsoar"；多 Agent 场景用于第 5 闸跨 agent 指针）。 */
  agentId?: string;
}

export interface MemoryStats {
  total: number;
  active: number;
  archived: number;
  links: number;
  totalAccess: number;
  byCategory: Record<string, number>;
  /** 跨 agent 指针总数（第 5 闸；旧数据/单 agent 场景为 0）。 */
  crossAgentLinks?: number;
  /** 按工作区统计（D1：面板与隔离诊断用）。 */
  byWorkspace?: Record<string, number>;
  /** D2：已失效（被取代）的条目数。 */
  invalidated?: number;
}

/** 使用事件类型（E-M1）：提及 / 工具调用 / 显式搜索 / 点开查看。 */
export type UsageKind = "mention" | "tool" | "search" | "view";

export interface UsageEvent {
  at: number;
  /** 权重：mention 1.0 / tool 0.8 / search 0.6 / view 0.3。 */
  w: number;
  kind: UsageKind;
}

export const USAGE_EVENT_CAP = 50;
export const GHOST_IDLE_DAYS = 90;
export const GHOST_MAX_CHARS = 120;
/** 归档区上限（只裁最旧；活跃记忆仍由 capacity 治理）。 */
export const MAX_ARCHIVED = 2_000;

export interface MemoryStoreState {
  facts: MemoryFact[];
  /** 已归档条目单独存放（软归档：可恢复，不物理删除）。 */
  archived: MemoryFact[];
  /** 使用事件（E-M1）：key = fact:<id> / session:<id> / tool:<name>，每键最多 50 条。 */
  usage?: Record<string, UsageEvent[]>;
}

export class MemoryStore {
  private facts: MemoryFact[] = [];
  private archived: MemoryFact[] = [];
  private usage: Record<string, UsageEvent[]> = {};
  private seq = 0;

  constructor(
    private opts: { capacity?: number; now?: () => number; agentId?: string; workspaceId?: string } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  snapshot(): MemoryStoreState {
    const usage: Record<string, UsageEvent[]> = {};
    for (const [key, events] of Object.entries(this.usage)) usage[key] = [...events];
    return { facts: [...this.facts], archived: [...this.archived], usage };
  }

  /** 外部编辑同步：按 id 覆盖或插入（归档态由 fact 自身决定）。 */
  upsert(fact: MemoryFact): void {
    this.facts = this.facts.filter((item) => item.id !== fact.id);
    this.archived = this.archived.filter((item) => item.id !== fact.id);
    const archived = Boolean(fact.archivedAt) || fact.status !== "active";
    (archived ? this.archived : this.facts).push(fact);
    this.seq = Math.max(this.seq, this.facts.length + this.archived.length);
  }

  /** 从持久化状态恢复（文件损坏时由壳层保证传入空状态）。 */
  restore(state: Partially<MemoryStoreState>): void {
    this.facts = Array.isArray(state?.facts) ? state.facts : [];
    this.archived = Array.isArray(state?.archived) ? state.archived : [];
    this.usage = {};
    for (const [key, events] of Object.entries(state?.usage ?? {})) {
      if (Array.isArray(events)) this.usage[key] = events.slice(-USAGE_EVENT_CAP);
    }
    // 旧数据归一（D1）：补齐 workspaceId 与 provenance.trust，读取端无需到处判空。
    for (const fact of [...this.facts, ...this.archived]) {
      if (!fact.workspaceId) fact.workspaceId = DEFAULT_WORKSPACE_ID;
      if (!fact.provenance) {
        fact.provenance = { trust: "user", capturedBy: "user", workspaceId: fact.workspaceId };
      } else if (!fact.provenance.trust) {
        fact.provenance.trust = "user";
      }
    }
    this.seq = this.facts.length + this.archived.length;
  }

  size(): number {
    return this.facts.length;
  }

  /** 归档区上限：防止长期运行后无界增长（只裁剪最旧归档，不影响活跃记忆）。 */
  private trimArchived(): void {
    const overflow = this.archived.length - MAX_ARCHIVED;
    if (overflow > 0) this.archived.splice(0, overflow);
  }

  /**
   * 写入候选（Mem0 式「抽取后写入」）：
   * ⓪ 第 5 闸（跨 agent）：同内容但归属不同 agent → 不去重/不合并，新增条目 + 双向 crossAgentLinks 指针；
   * ① 去重命中 → 命中项 repeated+1、lastAccessed 刷新（不新增）；
   * ② 合并命中（无 tags 且高相似）→ 合并内容与标签、记录 mergeTrail；
   * ③ 否则新增；④ 建链；⑤ 容量超限软归档。
   * 返回本次动作明细（供 UI/审计展示）。
   */
  write(candidates: MemoryCandidate[]): {
    added: MemoryFact[];
    merged: { into: string; content: string }[];
    deduped: { id: string; content: string }[];
    archived: string[];
    linked: number;
    /** 第 5 闸：本次建立的跨 agent 指针数。 */
    crossAgent: number;
    /** D2：本次被取代（失效）的旧条目 id。 */
    superseded: string[];
  } {
    const nowMs = this.now();
    const defaultAgent = this.opts.agentId ?? DEFAULT_AGENT_ID;
    const defaultWorkspace = this.opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const added: MemoryFact[] = [];
    const merged: { into: string; content: string }[] = [];
    const deduped: { id: string; content: string }[] = [];
    let linked = 0;
    let crossAgent = 0;
    const superseded: string[] = [];

    for (const candidate of candidates) {
      const content = candidate.content.trim();
      if (!content) continue;
      // 工作区隔离（D1）：五闸与建链只在同工作区内进行，否则 A 项目的事实会被 B 项目去重/合并。
      const workspaceId = candidate.workspaceId ?? defaultWorkspace;
      const scoped = this.facts.filter((f) => (f.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId);
      const incoming = createFact({
        id: `mem-${++this.seq}-${nowMs.toString(36)}`,
        content,
        category: candidate.category,
        tags: candidate.tags ?? [],
        importance: candidate.importance ?? 5,
        lastAccessed: nowMs,
        source: candidate.source ?? "chat",
        layer: candidate.layer ?? "semantic",
        agentId: candidate.agentId ?? defaultAgent,
        crossAgentLinks: [],
        workspaceId,
        provenance: candidate.provenance ?? { trust: "user", workspaceId },
      });

      // ⓪ 第 5 闸：同内容但不同 agent → 保留双方条目，只建双向指针（不合并/不去重）
      const cross = gateCrossAgent(scoped, incoming, incoming.agentId ?? defaultAgent);
      if (cross.crossAgent) {
        for (const pointer of cross.pointers) {
          pointer.crossAgentLinks = pointer.crossAgentLinks ?? [];
          if (!pointer.crossAgentLinks.includes(incoming.id)) pointer.crossAgentLinks.push(incoming.id);
          if (!incoming.crossAgentLinks!.includes(pointer.id)) incoming.crossAgentLinks!.push(pointer.id);
        }
        crossAgent += cross.pointers.length;
        this.facts.push(incoming);
        added.push(incoming);
        continue;
      }

      // ① 取代（D2）：必须先于去重/合并——「改为 X」往往与旧条目高度相似，
      // 若先走去重会被当成重复（repeated++），更新就永远不生效。
      const replaceable = detectSupersede(
        incoming,
        scoped.filter((f) => f.id !== incoming.id && f.status === "active" && !f.invalidatedAt),
      );
      for (const hit of replaceable) {
        const old = hit.fact;
        old.invalidatedAt = nowMs;
        old.supersededBy = incoming.id;
        old.status = `invalidated:${old.category}`;
        incoming.supersedes = [...(incoming.supersedes ?? []), old.id];
        superseded.push(old.id);
      }

      // 被取代的旧条目退出后续闸门：否则新内容会被并进一条已失效的旧记忆。
      const activeScoped = scoped.filter((f) => f.status === "active" && !f.invalidatedAt);

      // ② 去重
      const dedupe = gateDedupe(activeScoped, incoming);
      if (dedupe.duplicate && dedupe.hit) {
        dedupe.hit.repeated += 1;
        dedupe.hit.lastAccessed = nowMs;
        dedupe.hit.confidence = Math.min(1, dedupe.hit.confidence + 0.05);
        deduped.push({ id: dedupe.hit.id, content: dedupe.hit.content });
        continue;
      }

      // ③ 合并
      const merge = gateMerge(activeScoped, incoming);
      if (merge.mergeInto) {
        const target = merge.mergeInto;
        target.content = `${target.content}；${incoming.content}`;
        // tags 是分类并集，不是合并的否决票；去重后保留双方分类。
        target.tags = [...new Set([...target.tags, ...incoming.tags])];
        target.lastAccessed = nowMs;
        target.repeated += 1;
        target.mergeTrail.push({ mergedAt: nowMs, reason: `相似度合并（${incoming.source}）` });
        merged.push({ into: target.id, content: incoming.content });
        continue;
      }

      // ③ 新增
      this.facts.push(incoming);
      added.push(incoming);

      // ⑤ 建链（与仍然有效的同区条目）
      const link = gateLink(activeScoped.filter((f) => f.id !== incoming.id), incoming);
      linked += link.linked.length;
    }

    // ⑤ 容量治理（软归档，不物理删除）
    // archivedIds 只收「本次真正归档」的 id：旧实现用 slice(-(added.length+1)) 近似，
    // 返回的 id 与真实归档无关（可能 0 条或多条历史归档），审计与 UI 都会读到错数据。
    const archivedIds: string[] = [];
    const cap = this.opts.capacity ?? THRESHOLD_CAPACITY_MAX;
    // 容量也按工作区独立：否则 B 项目的写入会把 A 项目的记忆挤进归档（跨区泄漏的另一种形式）。
    const workspaces = new Set(this.facts.map((f) => f.workspaceId ?? DEFAULT_WORKSPACE_ID));
    for (const ws of workspaces) {
      const group = this.facts.filter((f) => (f.workspaceId ?? DEFAULT_WORKSPACE_ID) === ws);
      if (group.length <= cap) continue;
      const result = gateCapacity(group, cap);
      const keepIds = new Set(result.keep.map((f) => f.id));
      this.facts = this.facts.filter(
        (f) => (f.workspaceId ?? DEFAULT_WORKSPACE_ID) !== ws || keepIds.has(f.id),
      );
      for (const fact of result.archived) {
        this.archived.push(fact);
        archivedIds.push(fact.id);
      }
    }
    this.trimArchived();

    return {
      added,
      merged,
      deduped,
      archived: archivedIds,
      linked,
      crossAgent,
      superseded,
    };
  }

  /** 记录一次使用事件（E-M1）：mention 1.0 / tool 0.8 / search 0.6 / view 0.3。 */
  recordUsage(key: string, kind: UsageKind, at = this.now()): void {
    const weight = kind === "mention" ? 1 : kind === "tool" ? 0.8 : kind === "search" ? 0.6 : 0.3;
    const events = this.usage[key] ?? [];
    events.push({ at, w: weight, kind });
    if (events.length > USAGE_EVENT_CAP) events.splice(0, events.length - USAGE_EVENT_CAP);
    this.usage[key] = events;
  }

  /**
   * 后台巩固（D3 后半）：
   *  ① 合并近似重复（同工作区同 category、无 tags、相似度 ≥0.9）——历史数据里常见；
   *  ② 把「长期未用 + 低价值 + 从未被检索」的条目软归档（不物理删除）；
   * 返回报告供 UI/日志展示。
   */
  consolidate(
    nowMs = this.now(),
    opts: { workspaceId?: string; maxAgeDays?: number; minValue?: number } = {},
  ): { merged: number; archived: string[]; scanned: number } {
    const maxAgeDays = opts.maxAgeDays ?? 180;
    const minValue = opts.minValue ?? 0.02;
    const inScope = (fact: MemoryFact): boolean =>
      !opts.workspaceId || (fact.workspaceId ?? DEFAULT_WORKSPACE_ID) === opts.workspaceId;
    const scanned = this.facts.filter(inScope).length;

    // ① 合并近似重复（跳过带 tags 的条目：tags 是显式「同族」信号，合并会丢信息）
    let merged = 0;
    const pool = this.facts.filter(inScope);
    for (let i = 0; i < pool.length; i += 1) {
      const keep = pool[i];
      if (!this.facts.includes(keep)) continue;
      if (keep.tags.length > 0) continue;
      for (let j = i + 1; j < pool.length; j += 1) {
        const drop = pool[j];
        if (drop.tags.length > 0) continue;
        if (!this.facts.includes(drop)) continue;
        if (keep.category !== drop.category) continue;
        if ((keep.workspaceId ?? DEFAULT_WORKSPACE_ID) !== (drop.workspaceId ?? DEFAULT_WORKSPACE_ID)) continue;
        if (jaccardCJK(keep.content, drop.content) < 0.9) continue;
        keep.mergeTrail.push({ mergedAt: nowMs, reason: "巩固：近似重复合并" });
        if (drop.content.length > keep.content.length) keep.content = drop.content;
        keep.repeated += drop.repeated + 1;
        keep.lastAccessed = Math.max(keep.lastAccessed, drop.lastAccessed);
        keep.confidence = Math.max(keep.confidence, drop.confidence);
        this.facts = this.facts.filter((f) => f.id !== drop.id);
        merged += 1;
      }
    }

    // ② 归档长期未用的低价值条目
    const archived: string[] = [];
    const staleCutoff = nowMs - maxAgeDays * 86_400_000;
    const survivors: MemoryFact[] = [];
    for (const fact of this.facts) {
      const scoped = inScope(fact);
      const stale =
        scoped &&
        fact.lastAccessed < staleCutoff &&
        fact.accessCount === 0 &&
        fact.repeated === 0 &&
        effectiveValue(fact, nowMs) < minValue;
      if (!stale) {
        survivors.push(fact);
        continue;
      }
      fact.status = `archived:stale`;
      fact.archivedAt = nowMs;
      fact.archivedReason = `长期未用（>${maxAgeDays} 天）且价值低于 ${minValue}`;
      this.archived.push(fact);
      archived.push(fact.id);
    }
    this.facts = survivors;
    this.trimArchived();
    return { merged, archived, scanned };
  }

  /** 使用事件快照（图谱/诊断用）。 */
  usageSnapshot(): Record<string, UsageEvent[]> {
    const out: Record<string, UsageEvent[]> = {};
    for (const [key, events] of Object.entries(this.usage)) out[key] = [...events];
    return out;
  }

  /**
   * 失真层降级（E-M1）：长期未被使用的 episode 压成 ghost——
   * 只留一句话 + 关键词，不物理删除；提及后可重新升回游离层。
   */
  demoteGhosts(nowMs = this.now(), idleDays = GHOST_IDLE_DAYS): string[] {
    const cutoff = nowMs - idleDays * 86_400_000;
    const demoted: string[] = [];
    for (const fact of this.facts) {
      if (fact.category !== "episode") continue;
      if (fact.status !== "active" || fact.invalidatedAt) continue;
      if (fact.lastAccessed >= cutoff) continue;
      fact.category = "ghost";
      fact.content = fact.content.slice(0, GHOST_MAX_CHARS);
      fact.importance = Math.min(5, fact.importance);
      fact.tags = [...new Set([...fact.tags, "ghost"])];
      fact.layer = "working";
      demoted.push(fact.id);
    }
    return demoted;
  }

  /**
   * 访问信号（D3）：只有「真正的检索命中」才计数。
   * 为什么不由 recallPrompt/注入路径调用：注入是渲染，不是使用；若按注入计数，
   * 排名外的沉睡记忆永远追不上（slime 的「富者愈富」bug，见 slime-memory-review.md §3.2）。
   */
  touch(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const nowMs = this.now();
    const wanted = new Set(ids);
    let touched = 0;
    for (const fact of this.facts) {
      if (!wanted.has(fact.id)) continue;
      if (fact.status !== "active" || fact.invalidatedAt) continue;
      fact.accessCount += 1;
      fact.lastAccessed = nowMs;
      fact.confidence = Math.min(1, fact.confidence + 0.02);
      this.recordUsage(`fact:${fact.id}`, "search", nowMs);
      touched += 1;
    }
    return touched;
  }

  /** 手动新增（UI「新增记忆」入口）。 */
  add(input: MemoryCandidate): MemoryFact {
    const result = this.write([{ ...input, source: input.source ?? "manual" }]);
    // 去重/合并命中时 added 为空；旧实现回退到「最后一条」会返回完全无关的记忆，
    // UI 随后拿错 id 做更新/删除。这里按本次动作的真实目标解析。
    if (result.added[0]) return result.added[0];
    if (result.merged[0]) {
      const kept = this.get(result.merged[0].into);
      if (kept) return kept;
    }
    if (result.deduped[0]) {
      const hit = this.get(result.deduped[0].id);
      if (hit) return hit;
    }
    throw new Error("记忆写入未产生任何条目（内容为空或被治理规则丢弃）");
  }

  update(id: string, patch: Partial<Pick<MemoryFact, "content" | "category" | "tags" | "importance">>): MemoryFact | null {
    const fact = this.facts.find((f) => f.id === id);
    if (!fact) return null;
    if (patch.content !== undefined) fact.content = patch.content.trim().slice(0, 5000);
    if (patch.category !== undefined) fact.category = patch.category;
    if (patch.tags !== undefined) fact.tags = patch.tags;
    if (patch.importance !== undefined) fact.importance = Math.max(1, Math.min(10, patch.importance));
    fact.lastAccessed = this.now();
    return fact;
  }

  /**
   * 回顾合并：把同一事实的多个条目合并到一条。
   * 选「保留者」：重要度 → 访问次数 → 时间新；其余条目标记失效并指向保留者（不物理删除，可追溯/可恢复）。
   * 只做信息并集（tags/links/重要度/合并历史），不改正文——正文改写属于人工或后续切片。
   */
  mergeGroup(ids: readonly string[], reason: string, nowMs = this.now()): { kept: string; merged: string[] } | null {
    const unique = [...new Set(ids)];
    if (unique.length < 2) return null;
    const all = [...this.facts, ...this.archived];
    const members = unique.map((id) => all.find((fact) => fact.id === id)).filter((fact): fact is MemoryFact => Boolean(fact));
    if (members.length < 2) return null;
    const keep = members
      .slice()
      .sort((a, b) => b.importance - a.importance || b.accessCount - a.accessCount || b.timestamp - a.timestamp)[0] as MemoryFact;
    const merged: string[] = [];
    for (const fact of members) {
      if (fact.id === keep.id) continue;
      keep.tags = [...new Set([...keep.tags, ...fact.tags])];
      keep.links = [...new Set([...keep.links, ...fact.links])].filter((id) => id !== keep.id);
      keep.importance = Math.max(keep.importance, fact.importance);
      keep.repeated += fact.repeated;
      keep.confidence = Math.max(keep.confidence, fact.confidence);
      keep.mergeTrail = [...keep.mergeTrail, ...fact.mergeTrail, { mergedAt: nowMs, reason }];
      fact.invalidatedAt = nowMs;
      fact.supersededBy = keep.id;
      fact.status = `merged:${fact.category}`;
      merged.push(fact.id);
    }
    return { kept: keep.id, merged };
  }

  /** 外部删除同步（活跃或归档都移除）；不清理 links，悬空链接交由建链规则处理。 */
  removeAnywhere(id: string): boolean {
    const before = this.facts.length + this.archived.length;
    this.facts = this.facts.filter((f) => f.id !== id);
    this.archived = this.archived.filter((f) => f.id !== id);
    return this.facts.length + this.archived.length < before;
  }

  remove(id: string): boolean {
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.id !== id);
    for (const fact of this.facts) {
      fact.links = fact.links.filter((l) => l !== id);
      fact.backlinks = fact.backlinks.filter((l) => l !== id);
    }
    return this.facts.length !== before;
  }

  clear(): void {
    this.facts = [];
    this.archived = [];
    this.usage = {};
    this.seq = 0;
  }

  get(id: string): MemoryFact | null {
    return this.facts.find((f) => f.id === id) ?? this.archived.find((f) => f.id === id) ?? null;
  }

  list(
    opts: {
      includeArchived?: boolean;
      sortBy?: "updated" | "value" | "importance";
      /** 只看某个工作区（缺省 = 全部；UI/召回必须显式传，避免跨区泄漏）。 */
      workspaceId?: string;
      /** D2：是否包含已失效条目（默认不含，供「查看历史」用）。 */
      includeInvalidated?: boolean;
    } = {},
  ): MemoryFact[] {
    const nowMs = this.now();
    const raw = opts.includeArchived ? [...this.facts, ...this.archived] : [...this.facts];
    // 只按「失效」过滤：归档条目属于历史，includeArchived 时应当可见。
    const filtered = opts.includeInvalidated ? raw : raw.filter((f) => !f.invalidatedAt);
    const base = opts.workspaceId
      ? filtered.filter((f) => (f.workspaceId ?? DEFAULT_WORKSPACE_ID) === opts.workspaceId)
      : filtered;
    const sortBy = opts.sortBy ?? "updated";
    return base.sort((a, b) => {
      if (sortBy === "importance") return b.importance - a.importance;
      if (sortBy === "value") return effectiveValue(b, nowMs) - effectiveValue(a, nowMs);
      return b.lastAccessed - a.lastAccessed;
    });
  }

  /**
   * 召回：先用「召回门控」决定要不要检索（廉价字符串信号，见 recallGate），
   * 命中后按 effectiveValue（时间衰减×重要度×置信度×重复次数）排序取前 N 条。
   * 为什么不由调用方传入全量：记忆会增长，检索必须自带预算。
   */
  recall(query: string, limit = 6, opts: { workspaceId?: string } = {}): { fact: MemoryFact; score: number }[] {
    const nowMs = this.now();
    // D2：失效条目默认不参与召回（可被显式查回，但不再自动注入）。
    const pool = (opts.workspaceId
      ? this.facts.filter((f) => (f.workspaceId ?? DEFAULT_WORKSPACE_ID) === opts.workspaceId)
      : this.facts
    ).filter((f) => f.status === "active" && !f.invalidatedAt);
    const scored: { fact: MemoryFact; score: number }[] = [];
    for (const fact of pool) {
      const similarity = jaccardCJK(query, fact.content);
      const tagHit = fact.tags.some((tag) => query.includes(tag));
      // 拒答门控（D4）：只共享单字（「的」「是」）不算相关，必须共享实词 bigram 或 tag 命中。
      if (!tagHit && sharedBigrams(query, fact.content) === 0) continue;
      const score = effectiveValue(fact, nowMs) * (0.2 + similarity) + (tagHit ? 0.15 : 0);
      scored.push({ fact, score });
    }
    return scored
      .filter((item) => item.score > 0.02)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** 召回结果格式化为提示词片段（空 = 不注入）。 */
  recallPrompt(query: string, limit = 6, opts: { workspaceId?: string } = {}): string {
    const hits = this.recall(query, limit, opts);
    if (hits.length === 0) return "";
    // 读取侧格式（D1 轻量版）：每条带分类 / 时间 / 来源，模型与用户都能判断「这条从哪来」。
    const lines = hits.map(({ fact }) => {
      const day = new Date(fact.timestamp).toISOString().slice(0, 10);
      const source = fact.provenance?.sessionId ? "会话" : fact.provenance?.trust === "web" ? "网页" : "记录";
      return `- [${fact.category}] ${day} · ${source} · ${fact.content}`;
    });
    const scope = opts.workspaceId ? "本工作区" : "过往会话";
    return `以下是${scope}的长期记忆（共 ${hits.length} 条，可能过时，按需使用）：\n${lines.join("\n")}`;
  }

  stats(workspaceId?: string): MemoryStats {
    const inScope = (fact: MemoryFact): boolean =>
      !workspaceId || (fact.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId;
    const all = this.facts.filter(inScope);
    const archived = this.archived.filter(inScope);
    const byCategory: Record<string, number> = {};
    for (const fact of all) byCategory[fact.category] = (byCategory[fact.category] ?? 0) + 1;
    const byWorkspace: Record<string, number> = {};
    for (const fact of this.facts) {
      const ws = fact.workspaceId ?? DEFAULT_WORKSPACE_ID;
      byWorkspace[ws] = (byWorkspace[ws] ?? 0) + 1;
    }
    return {
      total: all.length + archived.length,
      active: all.length,
      archived: archived.length,
      links: all.reduce((sum, f) => sum + f.links.length, 0),
      totalAccess: all.reduce((sum, f) => sum + f.accessCount, 0),
      byCategory,
      crossAgentLinks: all.reduce((sum, f) => sum + (f.crossAgentLinks?.length ?? 0), 0),
      byWorkspace,
      invalidated: this.facts.filter((f) => f.invalidatedAt || f.status !== "active").length,
    };
  }
}

type Partially<T> = { [K in keyof T]?: T[K] };
