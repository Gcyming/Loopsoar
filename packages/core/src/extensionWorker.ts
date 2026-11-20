/**
 * 扩展运行时协议（纯逻辑，可单测）：
 *   · 父进程（ExtensionRuntime）与子进程（extensionWorker.mjs）之间用 stdin/stdout 行分隔 JSON；
 *   · 子进程加载扩展模块，调用 activate(api) 注册工具/事件；父进程把工具桥接进 ToolRegistry，
 *     把事件分发给声明了 events 的扩展。
 * 为什么走子进程：扩展是第三方代码，崩溃/死循环/阻塞不能拖垮主进程（隔离优先）。
 *
 * 协议版本：宿主与 worker 在 ready 消息里协商；不匹配直接 fail-closed，
 * 避免「宿主以为扩展支持事件、扩展其实按旧协议返回」的半兼容状态。
 */
import { z } from "zod";

/** 当前 worker 行分隔 JSON 协议版本。 */
export const EXTENSION_WORKER_PROTOCOL_VERSION = 2;

/** 扩展工具声明（worker 上报给父进程）。 */
export const ExtensionToolDefSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(20_000).optional(),
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
  z.object({
    type: z.literal("ready"),
    /** 缺省按 1 处理（历史 worker），但宿主会拒绝需要事件能力的旧协议。 */
    protocol: z.number().int().min(1).max(100).optional(),
    apiVersion: z.string().max(80).optional(),
    tools: z.array(ExtensionToolDefSchema),
    /** worker 实际注册的事件（宿主声明的子集；用于诊断）。 */
    events: z.array(z.string().max(80)).max(16).optional(),
  }),
  z.object({
    type: z.literal("result"),
    id: z.number(),
    ok: z.boolean(),
    content: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("eventResult"),
    id: z.number(),
    ok: z.boolean(),
    /** tool.before 专用：allow=false 时否决本次工具调用。 */
    allow: z.boolean().optional(),
    reason: z.string().max(2_000).optional(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("viewMessage"),
    viewId: z.string().min(1).max(80),
    message: z.unknown(),
  }),
  z.object({ type: z.literal("fatal"), message: z.string() }),
  z.object({ type: z.literal("log"), level: z.enum(["info", "warn", "error"]).optional(), message: z.string() }),
]);
export type WorkerToParent = z.infer<typeof WorkerToParentSchema>;

/** 父进程 → worker。 */
export type ParentToWorker =
  | { type: "call"; id: number; tool: string; args: unknown }
  | { type: "event"; id: number; event: string; payload: unknown }
  | { type: "viewMessage"; viewId: string; message: unknown }
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
