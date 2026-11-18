import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerSubagentTools } from "../../packages/shell/src/main/subagentTools.ts";
import { SubagentTaskStore } from "../../packages/shell/src/main/subagentTaskStore.ts";

const dirs: string[] = [];
function tempStore(): SubagentTaskStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-subtasks-"));
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

describe("子代理任务记录（P1-5 第二步）", () => {
  it("创建/完成/按父会话回查", () => {
    const store = tempStore();
    const task = store.create({ parentSessionId: "sess-a", kind: "research", goal: "读一下入口" });
    expect(task.status).toBe("running");
    store.finish("sess-a", task.id, "done", "结论 A");
    const list = store.list("sess-a");
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("done");
    expect(list[0].result).toBe("结论 A");
    expect(store.read("sess-a", task.id)?.goal).toBe("读一下入口");
    expect(store.list("sess-b")).toHaveLength(0);
  });

  it("损坏文件与路径穿越不拖垮列表", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-subtasks-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "sess-a"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sess-a", "bad.json"), "{broken");
    const store = new SubagentTaskStore(dir);
    expect(store.list("sess-a")).toEqual([]);
    expect(store.read("../../etc", "passwd")).toBeNull();
  });

  it("委派后可用 subagent_tasks / subagent_read 找回结果", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "file_read",
      description: "read",
      permissions: { read: true },
      schema: { parse: (v: unknown) => v } as never,
      execute: async () => ({ ok: true, content: "" }),
    });
    const store = tempStore();
    registerSubagentTools(
      registry,
      { async run() { return done("持久化结论"); } },
      store,
    );
    const delegated = await registry.get("delegate_research")!.execute({
      agentId: "test",
      sessionId: "sess-persist",
      params: { goal: "查一下任务记录" },
      platform: {},
    });
    expect(delegated.ok).toBe(true);
    expect(delegated.content).toMatch(/\[任务记录\] [0-9a-f-]{36}/);
    const listed = await registry.get("subagent_tasks")!.execute({
      agentId: "test",
      sessionId: "sess-persist",
      params: {},
      platform: {},
    });
    expect(listed.ok).toBe(true);
    expect(listed.content).toContain("[done]");
    expect(listed.content).toContain("持久化结论");
    const id = (delegated.content.match(/\[任务记录\] ([0-9a-f-]{36})/) ?? [])[1];
    const read = await registry.get("subagent_read")!.execute({
      agentId: "test",
      sessionId: "sess-persist",
      params: { taskId: id },
      platform: {},
    });
    expect(read.ok).toBe(true);
    expect(JSON.parse(read.content).result).toBe("持久化结论");
  });
});
