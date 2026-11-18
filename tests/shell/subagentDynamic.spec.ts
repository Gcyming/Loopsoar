import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import {
  createChatSubagentRunner,
  registerSubagentTools,
} from "../../packages/shell/src/main/subagentTools.ts";
import { SubagentTaskStore } from "../../packages/shell/src/main/subagentTaskStore.ts";

const dirs: string[] = [];
function tempStore(): SubagentTaskStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-subdynamic-"));
  dirs.push(dir);
  return new SubagentTaskStore(dir);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function done(text: string) {
  return {
    status: "done" as const,
    reason: "",
    finalText: text,
    usage: { rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 1 },
    chunks: [],
    claims: [],
  };
}

describe("子代理动态再委派与上下文恢复（P1-5）", () => {
  it("子代理可在运行时委派孙任务，parentTaskId 串成任务链", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "file_read",
      description: "read",
      permissions: { read: true },
      schema: { parse: (v: unknown) => v } as never,
      execute: async () => ({ ok: true, content: "" }),
    });
    const store = tempStore();
    const seen: Array<{ goal: string; history: unknown[] }> = [];
    const fakeChat = {
      async runScoped(input: { message: string; sessionId?: string }, _allow: string[], _signal?: AbortSignal, history: unknown[] = []) {
        seen.push({ goal: input.message, history });
        if (input.message.startsWith("根任务")) {
          const child = await registry.get("delegate_child")!.execute({
            agentId: "test",
            sessionId: input.sessionId,
            params: { goal: "孙任务：查一个细节" },
            platform: {},
          });
          expect(child.ok).toBe(true);
          return done(`根结论：${child.content.includes("孙结论") ? "已包含孙结论" : "缺少孙结论"}`);
        }
        if (input.message.startsWith("孙任务")) return done("孙结论");
        return done("重跑结论");
      },
    };
    registerSubagentTools(
      registry,
      createChatSubagentRunner(fakeChat as never, registry),
      store,
    );

    const result = await registry.get("delegate_research")!.execute({
      agentId: "test",
      sessionId: "sess-dyn",
      params: { goal: "根任务：调研入口" },
      platform: {},
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("已包含孙结论");

    const records = store.list("sess-dyn");
    const root = records.find((record) => record.kind === "research");
    const child = records.find((record) => record.kind === "child");
    expect(root).toBeTruthy();
    expect(child).toBeTruthy();
    expect(child?.parentTaskId).toBe(root?.id);
    expect(root?.history?.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(child?.history?.map((item) => item.role)).toEqual(["user", "user", "assistant"]);
    expect(seen[0]?.history).toEqual([]);
    expect(seen[1]?.history).toEqual([{ role: "user", content: "根任务：调研入口" }]);
  });

  it("超过动态深度上限时拒绝再委派", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "file_read",
      description: "read",
      permissions: { read: true },
      schema: { parse: (v: unknown) => v } as never,
      execute: async () => ({ ok: true, content: "" }),
    });
    const store = tempStore();
    const fakeChat = {
      async runScoped(input: { message: string; sessionId?: string }) {
        if (input.message.startsWith("根任务")) {
          await registry.get("delegate_child")!.execute({
            agentId: "test",
            sessionId: input.sessionId,
            params: { goal: "孙任务" },
            platform: {},
          });
          return done("根结论");
        }
        if (input.message.startsWith("孙任务")) {
          const blocked = await registry.get("delegate_child")!.execute({
            agentId: "test",
            sessionId: input.sessionId,
            params: { goal: "曾孙任务" },
            platform: {},
          });
          expect(blocked.ok).toBe(false);
          expect(blocked.content).toContain("最多 2 层");
          return done("孙结论");
        }
        return done("其他");
      },
    };
    registerSubagentTools(registry, createChatSubagentRunner(fakeChat as never, registry), store);

    const result = await registry.get("delegate_research")!.execute({
      agentId: "test",
      sessionId: "sess-depth",
      params: { goal: "根任务" },
      platform: {},
    });
    expect(result.ok).toBe(true);
    expect(store.list("sess-depth").filter((record) => record.kind === "child")).toHaveLength(1);
  });

  it("subagent_resume 把原记录历史注入新子会话", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "file_read",
      description: "read",
      permissions: { read: true },
      schema: { parse: (v: unknown) => v } as never,
      execute: async () => ({ ok: true, content: "" }),
    });
    const store = tempStore();
    let receivedHistory: unknown[] = [];
    registerSubagentTools(
      registry,
      {
        async run(input) {
          receivedHistory = input.history ?? [];
          return done("恢复答复");
        },
      },
      store,
    );
    const source = store.create({
      parentSessionId: "sess-resume-history",
      kind: "research",
      goal: "原始任务",
      history: [
        { role: "user", content: "原始任务" },
        { role: "assistant", content: "原始答复" },
      ],
    });
    const result = await registry.get("subagent_resume")!.execute({
      agentId: "test",
      sessionId: "sess-resume-history",
      params: { taskId: source.id },
      platform: {},
    });
    expect(result.ok).toBe(true);
    expect(receivedHistory).toEqual([
      { role: "user", content: "原始任务" },
      { role: "assistant", content: "原始答复" },
    ]);
    const rerun = store.list("sess-resume-history").find((record) => record.parentTaskId === source.id);
    expect(rerun?.history?.map((item) => item.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
