/**
 * ask_user 工具（Agent 的「问人」通道）。
 *
 * 语义：任务缺少关键信息（偏好、目标路径、二选一方案）时，暂停等用户回答；
 * 超时/取消按取消结算而非伪造回答——fail-closed，避免 Agent 替用户编答案。
 * 工具本身不做权限确认：弹窗即交互，用户必须回答或取消。
 */
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { AskBus } from "./askBus.js";

export const ASK_USER_TOOL_NAME = "ask_user";

/** 等待用户回答的时间上限（工具循环对 ask_user 使用独立的静默超时）。 */
export const ASK_USER_TIMEOUT_MS = 600_000;

export function registerAskTools(registry: ToolRegistry, askBus: AskBus): void {
  registry.register({
    name: ASK_USER_TOOL_NAME,
    description:
      "向用户提一个必须由人回答的问题（缺关键信息/需要用户在多个方案中选择时使用）。调用后任务会暂停，等待用户在界面回答；不要用它问自己可以查到的事。",
    permissions: { read: true },
    schema: z.object({
      question: z.string().min(1).max(2000),
      options: z.array(z.string().min(1).max(200)).max(8).optional(),
      allowFreeText: z.boolean().optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as {
        question?: string;
        options?: string[];
        allowFreeText?: boolean;
      };
      const question = (params.question ?? "").trim();
      if (!question) return { ok: false, content: "[错误] 缺少 question 参数" };
      try {
        const answer = await askBus.request({
          question,
          options: Array.isArray(params.options) ? params.options : undefined,
          allowFreeText: params.allowFreeText,
          timeoutMs: ASK_USER_TIMEOUT_MS,
          // 会话归属：后台会话的提问只在对应会话里弹窗（不抢用户当前会话的界面）。
          sessionId: ctx.sessionId,
          kind: "ask",
        });
        if (answer.cancelled) {
          return {
            ok: false,
            content: `用户取消了回答${answer.answer ? `：${answer.answer}` : ""}。不要编造用户的答案；可换一种方式询问或回到已知信息继续。`,
          };
        }
        return { ok: true, content: `用户回答：${answer.answer ?? ""}` };
      } catch (err) {
        return {
          ok: false,
          content: `[错误] ask_user 执行失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
}
