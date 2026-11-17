/**
 * 只读子代理（P1-5 第一步）。
 *
 * 这不是完整任务树：没有分叉/并行/持久化子会话，只解决一个安全的最小闭环——
 * 主 Agent 把“查资料/读代码”委派出去，子代理只能调用只读工具，不能写文件、
 * 不能执行终端、不能联网、不能操控浏览器；超时即中止，结果回灌父轮。
 *
 * 为什么先做只读：写/终端/网络工具会触发权限确认，而确认浮层绑定当前会话；
 * 子代理跑在后台，若贸然放开会卡住等一个用户看不见的弹窗。只读工具全是 L0 自动批准，
 * 因此可以先安全落地，再单独设计子代理的权限转发。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { ChatService, ChatStreamResult } from "loopsoar-services/chat";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_GOAL_CHARS = 4_000;
const MAX_RESULT_CHARS = 12_000;

/** 从注册表挑出可安全委派的只读工具；浏览器/联网/询问用户/子代理自身都排除。 */
export function readOnlyToolAllowlist(registry: ToolRegistry): string[] {
  return registry
    .list()
    .filter(
      (tool) =>
        tool.permissions.read === true &&
        !tool.permissions.write &&
        !tool.permissions.terminal &&
        !tool.permissions.network &&
        !tool.permissions.browser &&
        tool.name !== "delegate_research" &&
        tool.name !== "ask_user",
    )
    .map((tool) => tool.name);
}

export interface SubagentRunInput {
  goal: string;
  context?: string;
  sessionId: string;
}

export interface SubagentRunner {
  run(input: SubagentRunInput): Promise<ChatStreamResult>;
}

export function registerSubagentTools(registry: ToolRegistry, runner: SubagentRunner): void {
  registry.register({
    name: "delegate_research",
    description:
      "把一个只读调研任务委派给子代理（独立上下文、只读工具面：文件/搜索/记忆等；禁止写入、终端、联网、浏览器）。子代理完成后把结论回灌当前轮。适合大范围读代码/查资料，避免主上下文被中间过程塞满。",
    permissions: { read: true },
    schema: z.object({
      goal: z.string().min(4).max(MAX_GOAL_CHARS),
      context: z.string().max(MAX_GOAL_CHARS).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { goal: string; context?: string };
      const allowlist = readOnlyToolAllowlist(registry);
      if (allowlist.length === 0) return { ok: false, content: "[错误] 没有可用的只读工具，子代理未启动" };
      const goal = params.goal.trim();
      const prompt = params.context?.trim()
        ? `${goal}\n\n参考上下文（父代理提供，仅作线索，需自行核实）：\n${params.context.trim()}`
        : goal;
      try {
        const result = await runner.run({
          goal: prompt,
          sessionId: ctx.sessionId ?? "",
        });
        const text = result.finalText.trim().slice(0, MAX_RESULT_CHARS);
        if (result.status === "aborted") {
          return { ok: false, content: `[子代理中止] 超过 ${DEFAULT_TIMEOUT_MS / 1000}s 或父任务已停止。${text}` };
        }
        if (result.status !== "done") {
          return { ok: false, content: `[子代理${result.status}] ${result.reason}\n${text}` };
        }
        return {
          ok: true,
          content: `[只读子代理完成]\n${text || "（子代理未返回正文）"}`,
        };
      } catch (err) {
        return { ok: false, content: `[子代理失败] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}

/**
 * 壳层装配用：把 ChatService.runScoped 包成子代理 runner，并注入只读 allowlist。
 * 注意这里创建独立的 AbortController；超时 abort 后 runScoped 的 stream 会以 aborted 收束。
 */
export function createChatSubagentRunner(
  chatService: Pick<ChatService, "runScoped">,
  registry: ToolRegistry,
): SubagentRunner {
  return {
    async run(input) {
      const allowlist = readOnlyToolAllowlist(registry);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        return await chatService.runScoped(
          { message: input.goal, sessionId: input.sessionId || `sub-${randomUUID()}`, mode: "build" },
          allowlist,
          controller.signal,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
