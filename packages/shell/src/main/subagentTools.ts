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
import type { SubagentTaskStore } from "./subagentTaskStore.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_GOAL_CHARS = 4_000;
const MAX_RESULT_CHARS = 12_000;
const MAX_PARALLEL_TASKS = 4;
const MAX_PARALLEL_CONCURRENCY = 3;
const MAX_PARALLEL_OUTPUT_CHARS = 24_000;
const MAX_TREE_TASKS = 12;
const MAX_TREE_DEPTH = 2;
const MAX_TREE_CHILDREN = 4;

/** 预定义只读任务树节点；子代理不会在运行时再委派，树由父代理一次给出。 */
export interface DelegatedTreeTask {
  goal: string;
  context?: string;
  children?: DelegatedTreeTask[];
}

const DelegatedTreeTaskSchema: z.ZodType<DelegatedTreeTask> = z.lazy(() =>
  z.object({
    goal: z.string().min(4).max(MAX_GOAL_CHARS),
    context: z.string().max(MAX_GOAL_CHARS).optional(),
    children: z.array(DelegatedTreeTaskSchema).max(MAX_TREE_CHILDREN).optional(),
  }),
);

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
        tool.name !== "delegate_parallel" &&
        tool.name !== "delegate_tree" &&
        tool.name !== "subagent_tasks" &&
        tool.name !== "subagent_read" &&
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

export function registerSubagentTools(
  registry: ToolRegistry,
  runner: SubagentRunner,
  store?: SubagentTaskStore,
): void {
  registry.register({
    name: "delegate_research",
    description:
      "把一个只读调研任务委派给子代理（独立上下文、只读工具面：文件/搜索/记忆等；禁止写入、终端、联网、浏览器）。子代理完成后把结论回灌当前轮，并把任务记录到父会话（可用 subagent_tasks 回查）。适合大范围读代码/查资料，避免主上下文被中间过程塞满。",
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
      const parent = ctx.sessionId ?? "";
      const record = store?.create({ parentSessionId: parent, kind: "research", goal, context: params.context });
      const tag = record ? `\n[任务记录] ${record.id}` : "";
      const prompt = params.context?.trim()
        ? `${goal}\n\n参考上下文（父代理提供，仅作线索，需自行核实）：\n${params.context.trim()}`
        : goal;
      try {
        const result = await runner.run({
          goal: prompt,
          sessionId: parent,
        });
        const text = result.finalText.trim().slice(0, MAX_RESULT_CHARS);
        if (result.status === "aborted") {
          if (record) store?.finish(parent, record.id, "aborted", text, `超过 ${DEFAULT_TIMEOUT_MS / 1000}s 或父任务已停止`);
          return { ok: false, content: `[子代理中止] 超过 ${DEFAULT_TIMEOUT_MS / 1000}s 或父任务已停止。${text}${tag}` };
        }
        if (result.status !== "done") {
          if (record) store?.finish(parent, record.id, "failed", text, result.reason);
          return { ok: false, content: `[子代理${result.status}] ${result.reason}\n${text}${tag}` };
        }
        if (record) store?.finish(parent, record.id, "done", text);
        return {
          ok: true,
          content: `[只读子代理完成]\n${text || "（子代理未返回正文）"}${tag}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (record) store?.finish(parent, record.id, "failed", undefined, message);
        return { ok: false, content: `[子代理失败] ${message}${tag}` };
      }
    },
  });

  registry.register({
    name: "delegate_parallel",
    description:
      "并行委派 2–4 个只读调研任务（独立上下文、同一只读工具面；最多同时跑 3 个）。适合互不依赖的读代码/查资料；每个任务单独超时，结果按任务顺序回灌，并逐条记录到父会话（可用 subagent_tasks 回查）。需要写文件/终端/浏览器/联网时不要用本工具。",
    permissions: { read: true },
    schema: z.object({
      tasks: z
        .array(
          z.object({
            goal: z.string().min(4).max(MAX_GOAL_CHARS),
            context: z.string().max(MAX_GOAL_CHARS).optional(),
          }),
        )
        .min(2)
        .max(MAX_PARALLEL_TASKS),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { tasks: Array<{ goal: string; context?: string }> };
      const allowlist = readOnlyToolAllowlist(registry);
      if (allowlist.length === 0) return { ok: false, content: "[错误] 没有可用的只读工具，子代理未启动" };
      const parent = ctx.sessionId ?? "";
      const tasks = params.tasks.map((task) => ({
        goal: task.goal.trim(),
        prompt: task.context?.trim()
          ? `${task.goal.trim()}\n\n参考上下文（父代理提供，仅作线索，需自行核实）：\n${task.context.trim()}`
          : task.goal.trim(),
      }));
      const records = params.tasks.map((task, index) =>
        store?.create({
          parentSessionId: parent,
          kind: "parallel",
          goal: tasks[index].goal,
          ...(task.context?.trim() ? { context: task.context } : {}),
        }),
      );
      const results: Array<{ ok: boolean; text: string }> = new Array(tasks.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const index = next;
          next += 1;
          if (index >= tasks.length) return;
          const record = records[index];
          try {
            const result = await runner.run({ goal: tasks[index].prompt, sessionId: parent });
            const text = result.finalText.trim().slice(0, MAX_RESULT_CHARS);
            if (result.status === "done") {
              if (record) store?.finish(parent, record.id, "done", text);
              results[index] = { ok: true, text: text || "（子代理未返回正文）" };
            } else if (result.status === "aborted") {
              if (record) store?.finish(parent, record.id, "aborted", text, "超时或父任务已停止");
              results[index] = { ok: false, text: `[中止] 超过 ${DEFAULT_TIMEOUT_MS / 1000}s 或父任务已停止。${text}` };
            } else {
              if (record) store?.finish(parent, record.id, "failed", text, result.reason);
              results[index] = { ok: false, text: `[${result.status}] ${result.reason}\n${text}` };
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (record) store?.finish(parent, record.id, "failed", undefined, message);
            results[index] = { ok: false, text: `[失败] ${message}` };
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MAX_PARALLEL_CONCURRENCY, tasks.length) }, () => worker()),
      );
      const sections = results.map((result, index) => {
        const taskId = records[index]?.id ? ` · ${records[index].id}` : "";
        const label = `## 任务 ${index + 1}${taskId}：${tasks[index].goal.slice(0, 120)}`;
        return `${label}\n${result.ok ? "" : "（未完成）"}${result.text}`;
      });
      const completed = results.filter((result) => result.ok).length;
      const body = sections.join("\n\n").slice(0, MAX_PARALLEL_OUTPUT_CHARS);
      return {
        ok: completed > 0,
        content: `[并行只读子代理 ${completed}/${results.length} 完成]\n\n${body}`,
      };
    },
  });

  registry.register({
    name: "delegate_tree",
    description:
      "按预定义树结构委派只读子任务：父任务下可挂 0–4 个子任务，树最多 3 层/12 个任务。子代理只读、独立上下文，每个节点单独超时并记录 taskId；子代理不能在运行时再委派。结果按深度优先顺序回灌。",
    permissions: { read: true },
    schema: z.object({ task: DelegatedTreeTaskSchema }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = ctx.params as { task: DelegatedTreeTask };
      const allowlist = readOnlyToolAllowlist(registry);
      if (allowlist.length === 0) return { ok: false, content: "[错误] 没有可用的只读工具，子代理未启动" };
      const parent = ctx.sessionId ?? "";
      let total = 0;
      let completed = 0;

      const runNode = async (
        task: DelegatedTreeTask,
        depth: number,
        parentTaskId?: string,
      ): Promise<string[]> => {
        if (depth > MAX_TREE_DEPTH) throw new Error(`任务树超过 ${MAX_TREE_DEPTH + 1} 层`);
        total += 1;
        if (total > MAX_TREE_TASKS) throw new Error(`任务树超过 ${MAX_TREE_TASKS} 个任务`);
        const record = store?.create({
          parentSessionId: parent,
          kind: "tree",
          goal: task.goal,
          ...(task.context?.trim() ? { context: task.context } : {}),
          ...(parentTaskId ? { parentTaskId } : {}),
        });
        const indent = "  ".repeat(depth);
        const tag = record ? ` · ${record.id}` : "";
        const prompt = task.context?.trim()
          ? `${task.goal.trim()}\n\n参考上下文（父代理提供，仅作线索，需自行核实）：\n${task.context.trim()}`
          : task.goal.trim();
        let status = "failed";
        let body = "";
        try {
          const result = await runner.run({ goal: prompt, sessionId: parent });
          body = result.finalText.trim().slice(0, MAX_RESULT_CHARS);
          if (result.status === "done") {
            status = "done";
            completed += 1;
            if (record) store?.finish(parent, record.id, "done", body);
          } else if (result.status === "aborted") {
            status = "aborted";
            if (record) store?.finish(parent, record.id, "aborted", body, "超时或父任务已停止");
          } else {
            if (record) store?.finish(parent, record.id, "failed", body, result.reason);
          }
        } catch (err) {
          body = err instanceof Error ? err.message : String(err);
          if (record) store?.finish(parent, record.id, "failed", undefined, body);
        }
        const lines = [`${indent}- [${status}] ${task.goal.slice(0, 160)}${tag}`];
        if (body) lines.push(`${indent}  ${body.replace(/\s+/g, " ").slice(0, 300)}`);
        for (const child of task.children ?? []) {
          lines.push(...(await runNode(child, depth + 1, record?.id)));
        }
        return lines;
      };

      try {
        const lines = await runNode(params.task, 0);
        return {
          ok: completed > 0,
          content: `[子代理任务树 ${completed}/${total} 完成]\n${lines.join("\n").slice(0, MAX_PARALLEL_OUTPUT_CHARS)}`,
        };
      } catch (err) {
        return { ok: false, content: `[子代理任务树失败] ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  registry.register({
    name: "subagent_tasks",
    description:
      "列出当前父会话派出的子代理任务记录（research/parallel，含状态、目标、时间、任务 id）。用于找回之前委派的结果；只读。",
    permissions: { read: true },
    schema: z.object({
      sessionId: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      if (!store) return { ok: false, content: "[错误] 子代理任务记录未装配" };
      const params = ctx.params as { sessionId?: string; limit?: number };
      const parent = params.sessionId ?? ctx.sessionId ?? "_default";
      const tasks = store.list(parent, params.limit ?? 30);
      if (tasks.length === 0) return { ok: true, content: `[子代理任务] 会话 ${parent} 暂无记录` };
      const lines = tasks.map((task) => {
        const when = new Date(task.startedAt).toISOString().replace("T", " ").slice(0, 19);
        const result = task.result ? `\n  结果：${task.result.replace(/\s+/g, " ").slice(0, 240)}` : "";
        const error = task.error ? `\n  错误：${task.error.slice(0, 240)}` : "";
        return `- ${task.id} [${task.status}] ${when} ${task.kind} · ${task.goal.slice(0, 160)}${result}${error}`;
      });
      return { ok: true, content: `[子代理任务 ${tasks.length} 条 · 会话 ${parent}]\n${lines.join("\n")}` };
    },
  });

  registry.register({
    name: "subagent_read",
    description: "读一条子代理任务记录的完整结果/错误（按 subagent_tasks 返回的 taskId）。只读。",
    permissions: { read: true },
    schema: z.object({
      taskId: z.string().min(8).max(120),
      sessionId: z.string().max(200).optional(),
    }),
    execute: async (ctx): Promise<ToolResult> => {
      if (!store) return { ok: false, content: "[错误] 子代理任务记录未装配" };
      const params = ctx.params as { taskId: string; sessionId?: string };
      const parent = params.sessionId ?? ctx.sessionId ?? "_default";
      const task = store.read(parent, params.taskId);
      if (!task) return { ok: false, content: `[错误] 未找到任务 ${params.taskId}（会话 ${parent}）` };
      return { ok: true, content: JSON.stringify(task, null, 2) };
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
