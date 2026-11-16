/**
 * memory 域：记忆条目的列表/新增/编辑/删除/清空/统计（供设置面板「记忆」分区）。
 * 写入治理与召回在 MemoryService 内完成（五门 + 容量软归档）。
 */
import { buildMemoryGraph, layoutMemoryGraph } from "loopsoar-core/memory";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { MemoryService } from "../memoryService.js";
import type { SessionStore } from "../sessionStore.js";

export interface MemoryDeps extends TrustedIpcDeps {
  memory: MemoryService;
  sessions?: SessionStore;
  push?: (event: string, payload: unknown) => void;
}

export function registerMemoryDomain(deps: MemoryDeps): void {
  handleTrusted(deps, "memory:list", () => ({
    // D1：一次返回全部工作区（条目带 workspaceId），由面板按当前工作区过滤；
    // 召回侧（recallPrompt）才是隔离的硬边界，面板只是展示。
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
      workspaceId: fact.workspaceId,
      trust: fact.provenance?.trust ?? "user",
      sessionId: fact.provenance?.sessionId,
    })),
    archivedCount: deps.memory.stats().archived,
    stats: deps.memory.stats(),
    filePath: deps.memory.filePath,
  }));

  handleTrusted(deps, "memory:stats", () => deps.memory.stats());

  /**
   * 记忆图谱（E-M0）：事实 + 会话 → 节点/边 → 确定性环带布局（1000×1000 画布坐标系）。
   * 布局放在壳层算：渲染层不需要依赖 core，且同一份数据在任何窗口得到同一张图。
   */
  handleTrusted(deps, "memory:graph", (payload) => {
    // M4：at = 回放时刻；此时把已失效条目也取出来，由 buildMemoryGraph 按时间戳判定
    // 「当时还活着」还是「当时已失效」，图才有演化感。缺省仍然只取存活条目。
    const at = (payload as { at?: number } | undefined)?.at;
    const facts = deps.memory.list({ includeArchived: false, includeInvalidated: at !== undefined });
    const sessions = (deps.sessions?.list() ?? []).map((session) => ({
      sessionId: session.id,
      title: session.title,
      workspaceId: session.workspaceId ?? null,
      updatedAt: session.updatedAt,
    }));
    const model = buildMemoryGraph({
      facts,
      sessions,
      usage: deps.memory.usageSnapshot(),
      ...(at !== undefined ? { at } : {}),
    });
    const points = layoutMemoryGraph(model, { width: 1000, height: 1000, padding: 24 });
    return { ...model, points };
  });

  handleTrusted(deps, "memory:add", async (payload) => {
    const p = payload as {
      content: string;
      category: string;
      tags?: string[];
      importance?: number;
      workspaceId?: string;
    };
    const fact = await deps.memory.add({
      content: p.content,
      category: p.category,
      tags: p.tags,
      importance: p.importance,
      source: "manual",
      ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
      provenance: {
        ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
        trust: "user",
        capturedBy: "user",
      },
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

  // D3 后半：手动触发一次后台巩固（合并近似重复 + 归档长期未用条目）。
  handleTrusted(deps, "memory:consolidate", async () => {
    const report = await deps.memory.consolidate();
    deps.push?.("memory:updated", { action: "consolidate", ...report });
    return report;
  });

  handleTrusted(deps, "memory:clear", async () => {
    await deps.memory.clear();
    deps.push?.("memory:updated", { action: "clear" });
    return { cleared: true };
  });
}
