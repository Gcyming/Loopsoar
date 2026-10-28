/**
 * 内置工具最小集（§4.3 S4）
 * 仅注册 file_read；其余后续阶段补
 */
import { z } from "zod";
import { ToolRegistry } from "./registry.js";
import type { LoopsoarPlatform } from "../platform/types.js";
import type { ToolContext, ToolResult } from "./registry.js";

export function registerBuiltinMinimal(registry: ToolRegistry, platform: LoopsoarPlatform): void {
  registry.register({
    name: "file_read",
    description: "读取文件内容（支持分页 offset/limit）",
    permissions: { read: true },
    schema: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
    execute: async (ctx: ToolContext): Promise<ToolResult> => {
      try {
        const params = ctx.params as { path?: string; offset?: number; limit?: number };
        const p = params?.path ?? "";
        if (!p) return { ok: false, content: "[错误] 缺少 path 参数" };
        const content = await platform.fs.readFileUtf8(p);
        const offset = params?.offset ?? 0;
        const limit = params?.limit ?? content.length;
        const sliced = content.slice(offset, offset + limit);
        return { ok: true, content: sliced };
      } catch (e: any) {
        return { ok: false, content: `[错误] ${e?.message ?? e}` };
      }
    },
  });
}
