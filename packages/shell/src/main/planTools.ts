/**
 * 规划工具（todo_write）：让 Agent 显式维护任务清单。
 *
 * 为什么需要：时间线的「任务规划卡 + 推进播报」需要结构化规划输入；
 * 模型用 todo_write 更新清单，UI 从工具结果（Markdown checklist）解析出规划与进度。
 * 纯元数据操作：只写内存（按 sessionId 隔离），无文件/命令/网络副作用。
 */
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";

interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

const store = new Map<string, PlanEntry[]>();

const TodoItemSchema = z.object({
  content: z.string().min(1).max(500),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
});

function render(items: PlanEntry[]): string {
  const lines = items.map((item) => {
    const box = item.status === "completed" ? "x" : " ";
    const suffix = item.status === "in_progress" ? " ← 进行中" : "";
    return `- [${box}] ${item.content}${suffix}`;
  });
  const done = items.filter((item) => item.status === "completed").length;
  return [`任务规划（${done}/${items.length} 完成）`, "", ...lines].join("\n");
}

export function registerPlanTools(registry: ToolRegistry): void {
  registry.register({
    name: "todo_write",
    description: "维护当前任务清单（规划/推进）：传入完整清单，状态 pending | in_progress | completed；返回可视化清单",
    permissions: {},
    schema: z.object({ items: z.array(TodoItemSchema).min(1).max(50) }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as { items?: unknown };
      // 运行时校验必须与声明 schema 完全一致（含 min/max 条数）：
      // 注册表 schema 只用于给模型看，不会在 execute 前自动校验。
      const parsed = z.array(TodoItemSchema).min(1).max(50).safeParse(params.items);
      if (!parsed.success) {
        return { ok: false, content: `[错误] items 参数不合法：${parsed.error.issues.map((i) => i.message).join("；")}` };
      }
      const key = `${ctx.sessionId ?? "default"}`;
      const previous = store.get(key) ?? [];
      const items: PlanEntry[] = parsed.data.map((item, index) => ({
        content: item.content,
        status: item.status ?? previous[index]?.status ?? "pending",
      }));
      store.set(key, items);
      return { ok: true, content: render(items) };
    },
  });
}
