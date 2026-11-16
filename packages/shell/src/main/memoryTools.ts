/**
 * 记忆工具（memory_*）：让 Agent 主动读写长期记忆库。
 *
 * 为什么是显式工具而不是全自动注入：
 *   Anthropic 的记忆工具模式是「检索按需、写入可控」——自动注入只在召回门控命中信号时发生
 *   （见 MemoryService.recallPrompt / core recallGate），而「记住这条 / 查一下上次说的」这类
 *   确定性意图需要模型显式调用工具，避免把记忆库当成隐式上下文塞爆 token。
 *
 * 权限：memory_search 只读（plan 模式可用）；add/update/delete 声明 write（默认需确认）。
 * 失败一律返回 `[错误] …` 可读文本（不抛异常，避免中断整个工具轮）。
 */
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { MemoryFact } from "loopsoar-core/memory";
import type { MemoryService } from "./memoryService.js";

/** 记忆条目 id 上限：内部 id 形如 mem-1-xxxx，120 足够且防超长入参。 */
const MEMORY_ID_MAX = 120;
/** 单条记忆内容上限（与 contracts 的 MemoryAddSchema 对齐）。 */
const CONTENT_MAX = 5_000;
const CATEGORY_MAX = 40;
const TAG_MAX = 24;
const TAG_COUNT_MAX = 10;

const SearchSchema = z.object({
  query: z.string().min(1).max(2_000),
  limit: z.number().int().min(1).max(20).optional(),
});

const AddSchema = z.object({
  content: z.string().min(1).max(CONTENT_MAX),
  category: z.string().min(1).max(CATEGORY_MAX).optional(),
  tags: z.array(z.string().max(TAG_MAX)).max(TAG_COUNT_MAX).optional(),
  importance: z.number().int().min(1).max(10).optional(),
});

const UpdateSchema = z
  .object({
    id: z.string().min(1).max(MEMORY_ID_MAX),
    content: z.string().min(1).max(CONTENT_MAX).optional(),
    category: z.string().min(1).max(CATEGORY_MAX).optional(),
    tags: z.array(z.string().max(TAG_MAX)).max(TAG_COUNT_MAX).optional(),
    importance: z.number().int().min(1).max(10).optional(),
  })
  // 为什么要求至少一个字段：空 patch 会刷新 lastAccessed 却什么都不改，误导模型以为更新成功
  .refine(
    (value) =>
      value.content !== undefined ||
      value.category !== undefined ||
      value.tags !== undefined ||
      value.importance !== undefined,
    { message: "至少提供 content / category / tags / importance 之一" },
  );

const DeleteSchema = z.object({ id: z.string().min(1).max(MEMORY_ID_MAX) });

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(参数)"}：${issue.message}`)
    .join("；");
}

function invalidParams(error: z.ZodError): ToolResult {
  return { ok: false, content: `[错误] 参数不合法：${formatIssues(error)}`, error: "invalid-params" };
}

/**
 * memory_add 落盘后取「真正被写入/命中的条目」：
 * store.add 在去重/合并命中时返回的不是命中项本身（core 语义不在本任务内改动），
 * 这里按内容反查一次，保证返回的 id 后续 update/delete 可用。
 */
function factAfterAdd(memory: MemoryService, saved: MemoryFact, content: string): MemoryFact {
  const trimmed = content.trim();
  const facts = memory.list();
  const exact = facts.find((fact) => fact.content === trimmed);
  if (exact) return exact;
  const merged = facts.find((fact) => fact.content.endsWith(`；${trimmed}`));
  return merged ?? saved;
}

/** 注册 4 个记忆工具（由 index.ts 装配：与 MemoryService 单例共用同一份记忆库）。 */
export function registerMemoryTools(
  registry: ToolRegistry,
  memory: MemoryService,
  opts: { workspaceIdForSession?: (sessionId?: string) => string | undefined } = {},
): void {
  const workspaceOf = (sessionId?: string): string | undefined => opts.workspaceIdForSession?.(sessionId);
  registry.register({
    name: "memory_search",
    description:
      "搜索长期记忆库：按关键词召回相关记忆（返回 id / 分类 / 内容 / 相关度）。想不起用户之前说过的偏好或约定时先搜一下；无结果会明确说明。",
    permissions: { read: true },
    schema: SearchSchema,
    execute: async (ctx): Promise<ToolResult> => {
      const parsed = SearchSchema.safeParse(ctx.params ?? {});
      if (!parsed.success) return invalidParams(parsed.error);
      const { query, limit } = parsed.data;
      // 语义向量可用时走 searchAsync（llama-server 嵌入）；旧装配/测试只有同步 search 时自动回退
      // D1：工具检索同样只看本会话所属工作区，跨区记忆不可见。
      const ws = workspaceOf(ctx.sessionId);
      const hits =
        typeof memory.searchAsync === "function"
          ? await memory.searchAsync(query, limit ?? 6, ws)
          : memory.search(query, limit ?? 6, ws);
      if (hits.length === 0) {
        return {
          ok: true,
          content: `未找到与「${query}」相关的记忆（记忆库当前 ${memory.stats().active} 条）。可以换个关键词，或用 memory_add 记录新信息。`,
        };
      }
      const lines = hits.map(
        ({ fact, score }, index) =>
          `${index + 1}. [${fact.category}] ${fact.content}（id: ${fact.id}，相关度 ${score.toFixed(2)}）`,
      );
      return {
        ok: true,
        content: `找到 ${hits.length} 条相关记忆：\n${lines.join("\n")}\n\n可用 memory_update / memory_delete 按 id 修改或删除。`,
      };
    },
  });

  registry.register({
    name: "memory_add",
    description:
      "把一条值得长期记住的信息写入记忆库（用户偏好、约定、经验教训等）。写入前会做去重/合并；返回条目 id，后续可用 memory_update / memory_delete 操作。",
    permissions: { write: true },
    schema: AddSchema,
    execute: async (ctx): Promise<ToolResult> => {
      const parsed = AddSchema.safeParse(ctx.params ?? {});
      if (!parsed.success) return invalidParams(parsed.error);
      const { content, category, tags, importance } = parsed.data;
      const actualCategory = category ?? "fact";
      try {
        const ws = workspaceOf(ctx.sessionId);
        const saved = await memory.add({
          content,
          category: actualCategory,
          tags,
          importance,
          source: "agent",
          ...(ws ? { workspaceId: ws } : {}),
          provenance: {
            ...(ws ? { workspaceId: ws } : {}),
            trust: "agent",
            capturedBy: "tool",
          },
        });
        const fact = factAfterAdd(memory, saved, content);
        const tagText = fact.tags.length > 0 ? `，标签: ${fact.tags.join("/")}` : "";
        return {
          ok: true,
          content: `已记住记忆（id: ${fact.id}，分类: ${fact.category}${tagText}，重要度: ${fact.importance}）。\n内容：${fact.content}`,
        };
      } catch (err) {
        return {
          ok: false,
          content: `[错误] 记忆写入失败：${err instanceof Error ? err.message : String(err)}`,
          error: "memory-write-failed",
        };
      }
    },
  });

  registry.register({
    name: "memory_update",
    description:
      "修改已有记忆条目（按 id）：可改内容/分类/标签/重要度，至少提供一个字段。先 memory_search 拿到 id 再更新。",
    permissions: { write: true },
    schema: UpdateSchema,
    execute: async (ctx): Promise<ToolResult> => {
      const parsed = UpdateSchema.safeParse(ctx.params ?? {});
      if (!parsed.success) return invalidParams(parsed.error);
      const { id, content, category, tags, importance } = parsed.data;
      try {
        const fact = await memory.update(id, {
          ...(content !== undefined ? { content } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(importance !== undefined ? { importance } : {}),
        });
        if (!fact) {
          return { ok: false, content: `[错误] 记忆不存在（id: ${id}），可先用 memory_search 查 id`, error: "not-found" };
        }
        return {
          ok: true,
          content: `已更新记忆（id: ${fact.id}，分类: ${fact.category}，重要度: ${fact.importance}）。\n内容：${fact.content}`,
        };
      } catch (err) {
        return {
          ok: false,
          content: `[错误] 记忆更新失败：${err instanceof Error ? err.message : String(err)}`,
          error: "memory-write-failed",
        };
      }
    },
  });

  registry.register({
    name: "memory_delete",
    description:
      "删除一条记忆（按 id，物理删除）。只在用户明确要求遗忘/删除时使用；先 memory_search 确认 id。",
    permissions: { write: true },
    schema: DeleteSchema,
    execute: async (ctx): Promise<ToolResult> => {
      const parsed = DeleteSchema.safeParse(ctx.params ?? {});
      if (!parsed.success) return invalidParams(parsed.error);
      const { id } = parsed.data;
      try {
        const removed = await memory.remove(id);
        if (!removed) {
          return {
            ok: false,
            content: `[错误] 记忆不存在或已删除（id: ${id}），可先用 memory_search 查 id`,
            error: "not-found",
          };
        }
        return { ok: true, content: `已删除记忆（id: ${id}）。` };
      } catch (err) {
        return {
          ok: false,
          content: `[错误] 记忆删除失败：${err instanceof Error ? err.message : String(err)}`,
          error: "memory-write-failed",
        };
      }
    },
  });
}
