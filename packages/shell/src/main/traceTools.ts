/**
 * trace 回读工具：让模型（和用户）能回答「刚才为什么慢/失败在哪一步」，
 * 而不是只能凭记忆复述。两个工具都只读：
 *   · trace_summary：按工具聚合（次数/失败/平均/最大耗时）+ 回合/令牌总计；
 *   · trace_read：最近 N 条原始记录（参数已脱敏、输出不入库）。
 */
import { z } from "zod";
import type { ToolDefinition, ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import type { TraceStore } from "./traceStore.js";

function formatTime(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(11, 19);
}

export function registerTraceTools(registry: ToolRegistry, store: TraceStore): void {
  const summary: ToolDefinition = {
    name: "trace_summary",
    description:
      "汇总本会话的工具调用轨迹：回合数、工具调用次数、失败数、tokens，以及每个工具的调用/失败/平均与最大耗时。诊断「为什么慢/哪一步失败」时先看它；只读。",
    permissions: { read: true },
    schema: z.object({}),
    execute: async (ctx): Promise<ToolResult> => {
      const stats = store.summary(ctx.sessionId ?? "default");
      if (stats.toolCalls === 0 && stats.turns === 0) {
        return { ok: true, content: "本会话还没有工具调用记录（trace 从下一次工具调用开始）。" };
      }
      const split =
        stats.inputTokens > 0 || stats.outputTokens > 0
          ? `（输入 ${stats.inputTokens} / 输出 ${stats.outputTokens}）`
          : "";
      const cost = stats.costUsd > 0 ? `｜估算成本 $${stats.costUsd.toFixed(6)}` : "";
      const model = stats.model ? `｜模型 ${stats.model}` : "";
      const lines = [
        `回合 ${stats.turns}｜工具调用 ${stats.toolCalls}｜失败 ${stats.failures}｜tokens ${stats.tokens}${split}${model}${cost}`,
      ];
      if (stats.byTool.length > 0) {
        lines.push("", "| 工具 | 调用 | 失败 | 平均 | 最大 |", "| --- | --- | --- | --- | --- |");
        for (const item of stats.byTool.slice(0, 12)) {
          lines.push(`| ${item.tool} | ${item.calls} | ${item.failures} | ${item.avgMs}ms | ${item.maxMs}ms |`);
        }
      }
      if (stats.lastError) lines.push("", `最近错误：${stats.lastError}`);
      return { ok: true, content: lines.join("\n") };
    },
  };

  const read: ToolDefinition = {
    name: "trace_read",
    description:
      "读取本会话最近的工具调用原始记录（时间、工具、成功与否、耗时、脱敏参数摘要、错误）。定位具体失败步骤用；只读，不含工具完整输出。",
    permissions: { read: true },
    schema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    execute: async (ctx): Promise<ToolResult> => {
      const params = (ctx.params ?? {}) as { limit?: number };
      const records = store.read(ctx.sessionId ?? "default", params.limit ?? 20);
      if (records.length === 0) return { ok: true, content: "本会话还没有 trace 记录。" };
      const lines = records.map((record) => {
        if (record.kind === "turn") {
          return `${formatTime(record.at)} 回合结束 rounds=${record.rounds ?? "?"} tools=${record.toolCalls ?? "?"} tokens=${record.tokens ?? "?"}${record.note ? ` (${record.note})` : ""}`;
        }
        if (record.kind === "error") {
          return `${formatTime(record.at)} [error] ${record.error ?? ""}`;
        }
        const state = record.ok === false ? "失败" : "成功";
        const ms = record.ms !== undefined ? `${record.ms}ms` : "?";
        const args = record.args ? ` ${record.args}` : "";
        const error = record.error ? ` → ${record.error}` : "";
        return `${formatTime(record.at)} ${record.tool} ${state} ${ms}${args}${error}`;
      });
      return { ok: true, content: lines.join("\n") };
    },
  };

  registry.register(summary);
  registry.register(read);
}
