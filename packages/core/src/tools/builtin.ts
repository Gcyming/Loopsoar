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
        // 图片按 UTF-8 读只会得到二进制乱码，模型会误以为「内容坏了」。直接给可执行的下一步。
        if (/\.(png|jpe?g|webp|gif|bmp|ico)$/i.test(p)) {
          return {
            ok: false,
            content:
              "[提示] 这是图片文件，file_read 只能读文本。请用 browser_screenshot 截图后查看（需要模型支持视觉），" +
              "或请用户把图片作为附件发送；设置·通用里可确认「图片输入」已开启。",
          };
        }
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
