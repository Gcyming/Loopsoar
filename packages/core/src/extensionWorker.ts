/**
 * 扩展运行时协议（纯逻辑，可单测）：
 *   · 父进程（ExtensionRuntime）与子进程（extensionWorker.mjs）之间用 stdin/stdout 行分隔 JSON；
 *   · 子进程加载扩展模块，调用 activate(api) 注册工具；父进程把工具桥接进 ToolRegistry。
 * 为什么走子进程：扩展是第三方代码，崩溃/死循环/阻塞不能拖垮主进程（隔离优先）。
 */
import { z } from "zod";

/** 扩展工具声明（worker 上报给父进程）。 */
export const ExtensionToolDefSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(2000).optional(),
  /** JSON Schema（OpenAI function parameters 形态；不合法时父进程降级为空对象）。 */
  parameters: z.unknown().optional(),
  permissions: z
    .object({
      read: z.boolean().optional(),
      write: z.boolean().optional(),
      terminal: z.boolean().optional(),
      network: z.boolean().optional(),
    })
    .optional(),
});
export type ExtensionToolDef = z.infer<typeof ExtensionToolDefSchema>;

/** worker → 父进程。 */
export const WorkerToParentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), tools: z.array(ExtensionToolDefSchema) }),
  z.object({
    type: z.literal("result"),
    id: z.number(),
    ok: z.boolean(),
    content: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("fatal"), message: z.string() }),
  z.object({ type: z.literal("log"), level: z.enum(["info", "warn", "error"]).optional(), message: z.string() }),
]);
export type WorkerToParent = z.infer<typeof WorkerToParentSchema>;

/** 父进程 → worker。 */
export type ParentToWorker =
  | { type: "call"; id: number; tool: string; args: unknown }
  | { type: "shutdown" };

/** 扩展工具在全局工具表里的注册名：ext__<extensionId>__<toolName>。 */
export function extensionToolRegistryName(extensionId: string, toolName: string): string {
  const safeId = extensionId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `ext__${safeId}__${safeTool}`;
}

/** 从一行 stdout 解析消息；坏行返回 null（父进程忽略，不崩溃）。 */
export function parseWorkerLine(line: string): WorkerToParent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = WorkerToParentSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
