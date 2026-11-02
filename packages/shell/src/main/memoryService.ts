/**
 * 记忆服务（壳层）：持久化 JSON + 五个门的写入治理 + 召回注入。
 * 存储位置可配置（设置 · 存储 · 记忆库路径），默认 <dataDir>/memory/memory.json。
 * 为什么是 JSON 而不是直接上 sqlite-vec：记忆规模先到万级、语义检索用 Jaccard 足够；
 * 向量库属于 ADR-0007 的待裁决项（W5 基准后切换），接口（load/save/write/recall）已按可替换设计。
 */
import fs from "node:fs";
import path from "node:path";
import { MemoryStore, shouldRecall, type MemoryCandidate, type MemoryFact } from "loopsoar-core/memory";
import { extractMemoryCandidates } from "loopsoar-core/memory";
import type { LoopsoarPlatform } from "loopsoar-core/platform";

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
}

export class MemoryService {
  private store: MemoryStore;
  private loaded = false;

  constructor(private opts: MemoryServiceOptions) {
    this.store = new MemoryStore({ capacity: opts.capacity });
  }

  get filePath(): string {
    return this.opts.filePath;
  }

  /** 切换存储路径（设置里改了记忆库位置后调用）：先保存旧库，再指向新库并加载。 */
  async relocate(filePath: string): Promise<void> {
    await this.save();
    this.opts = { ...this.opts, filePath };
    this.store = new MemoryStore({ capacity: this.opts.capacity });
    this.loaded = false;
    await this.load();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const exists = await this.opts.platform.fs.exists(this.opts.filePath);
      if (exists) {
        const raw = await this.opts.platform.fs.readFileUtf8(this.opts.filePath);
        const parsed = JSON.parse(raw) as { facts?: MemoryFact[]; archived?: MemoryFact[] };
        this.store.restore(parsed);
      }
    } catch {
      // 损坏的记忆文件 → 以空库启动（不阻断应用）
      this.store.restore({});
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    fs.mkdirSync(path.dirname(this.opts.filePath), { recursive: true });
    await this.opts.platform.fs.writeFileUtf8(
      this.opts.filePath,
      JSON.stringify(this.store.snapshot(), null, 2),
    );
  }

  list(opts?: { includeArchived?: boolean; sortBy?: "updated" | "value" | "importance" }): MemoryFact[] {
    return this.store.list(opts);
  }

  stats(): ReturnType<MemoryStore["stats"]> {
    return this.store.stats();
  }

  get(id: string): MemoryFact | null {
    return this.store.get(id);
  }

  async add(candidate: MemoryCandidate): Promise<MemoryFact> {
    const fact = this.store.add(candidate);
    await this.save();
    return fact;
  }

  async update(
    id: string,
    patch: Partial<Pick<MemoryFact, "content" | "category" | "tags" | "importance">>,
  ): Promise<MemoryFact | null> {
    const fact = this.store.update(id, patch);
    if (fact) await this.save();
    return fact;
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.store.remove(id);
    if (removed) await this.save();
    return removed;
  }

  async clear(): Promise<void> {
    this.store.clear();
    await this.save();
  }

  /**
   * 召回提示词片段（供 ChatService 注入 volatile 段）。
   * 门控开启时（默认）：core recallGate 无信号命中 → 返回 ""，即不检索、不注入。
   * 为什么先门控再检索：记忆会增长，若无条件检索，普通寒暄也会被塞入几条低相关记忆（噪声 + token 成本）。
   */
  recallPrompt(text: string): string {
    if (this.recallGateEnabled() && !shouldRecall(text).hit) return "";
    return this.store.recallPrompt(text);
  }

  /** 召回门控是否生效（默认开启；显式 recallGate:false 才关闭，便于测试/兼容对照）。 */
  private recallGateEnabled(): boolean {
    return this.opts.recallGate !== false;
  }

  /**
   * 显式检索（memory_search 工具用）：不走召回门控——模型/用户明确要求搜索时应当拿到结果。
   * 返回 { fact, score }[]，score 由 core 的有效值 × 相似度排序；limit 收敛到 [1, 20]。
   */
  search(query: string, limit = 6): { fact: MemoryFact; score: number }[] {
    const raw = Number.isFinite(limit) ? Math.floor(limit) : 6;
    const safeLimit = Math.max(1, Math.min(20, raw));
    return this.store.recall(query, safeLimit);
  }

  /**
   * 召回门控诊断：返回 shouldRecall 命中的信号列表（空数组 = 无信号、不会自动召回）。
   * 为什么暴露：日志/测试需要判断「这次没召回是没信号还是库里没有」，否则难排查。
   */
  recallSignals(query: string, lastTaskType?: string): string[] {
    return shouldRecall(query, lastTaskType).signals;
  }

  /**
   * 会话结束自动汇总：抽候选 → 五门治理写入 → 返回动作明细。
   * 为什么在 done 时做：一轮对话的最终文本只有一个稳定版本，避免流式中间态污染记忆。
   */
  async captureFromTurn(input: {
    userMessage: string;
    assistantReply: string;
  }): Promise<{ added: number; merged: number; deduped: number }> {
    const candidates = extractMemoryCandidates(input);
    if (candidates.length === 0) return { added: 0, merged: 0, deduped: 0 };
    const result = this.store.write(candidates);
    if (result.added.length || result.merged.length || result.deduped.length) {
      await this.save();
    }
    return {
      added: result.added.length,
      merged: result.merged.length,
      deduped: result.deduped.length,
    };
  }
}
