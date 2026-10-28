/**
 * memory 域：记忆条目的列表/新增/编辑/删除/清空/统计（供设置面板「记忆」分区）。
 * 写入治理与召回在 MemoryService 内完成（五门 + 容量软归档）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { MemoryService } from "../memoryService.js";

export interface MemoryDeps extends TrustedIpcDeps {
  memory: MemoryService;
  push?: (event: string, payload: unknown) => void;
}

export function registerMemoryDomain(deps: MemoryDeps): void {
  handleTrusted(deps, "memory:list", () => ({
    facts: deps.memory.list({ includeArchived: false }).map((fact) => ({
      id: fact.id,
      content: fact.content,
      category: fact.category,
      tags: fact.tags,
      importance: fact.importance,
      source: fact.source,
      layer: fact.layer,
      repeated: fact.repeated,
      confidence: fact.confidence,
      links: fact.links,
      updatedAt: fact.lastAccessed,
    })),
    archivedCount: deps.memory.stats().archived,
    stats: deps.memory.stats(),
    filePath: deps.memory.filePath,
  }));

  handleTrusted(deps, "memory:stats", () => deps.memory.stats());

  handleTrusted(deps, "memory:add", async (payload) => {
    const p = payload as {
      content: string;
      category: string;
      tags?: string[];
      importance?: number;
    };
    const fact = await deps.memory.add({
      content: p.content,
      category: p.category,
      tags: p.tags,
      importance: p.importance,
      source: "manual",
    });
    deps.push?.("memory:updated", { action: "add", id: fact.id, total: deps.memory.stats().total });
    return { added: true, id: fact.id };
  });

  handleTrusted(deps, "memory:update", async (payload) => {
    const p = payload as {
      id: string;
      content?: string;
      category?: string;
      tags?: string[];
      importance?: number;
    };
    const fact = await deps.memory.update(p.id, {
      content: p.content,
      category: p.category,
      tags: p.tags,
      importance: p.importance,
    });
    if (!fact) return { updated: false };
    deps.push?.("memory:updated", { action: "update", id: fact.id });
    return { updated: true };
  });

  handleTrusted(deps, "memory:delete", async (payload) => {
    const removed = await deps.memory.remove((payload as { id: string }).id);
    if (removed) deps.push?.("memory:updated", { action: "delete" });
    return { deleted: removed };
  });

  handleTrusted(deps, "memory:clear", async () => {
    await deps.memory.clear();
    deps.push?.("memory:updated", { action: "clear" });
    return { cleared: true };
  });
}
