/**
 * 第 5 闸：跨 agent 指针（ADR-0007 记忆升级）。
 * 为什么这些断言：多 Agent 场景下「同一事实被不同 agent 各自记住」不能去重/合并（会抹掉归属），
 * 必须保留双份条目 + 双向 crossAgentLinks 指针；旧数据（无 agentId）要向后兼容。
 */
import { describe, expect, it } from "vitest";
import { createFact, type MemoryFact } from "../../packages/core/src/memory/fact.ts";
import { DEFAULT_AGENT_ID, agentOf, gateCrossAgent } from "../../packages/core/src/memory/fiveGate.ts";
import { MemoryStore } from "../../packages/core/src/memory/store.ts";

function fact(id: string, content: string, agentId?: string): MemoryFact {
  return createFact({ id, content, category: "fact", agentId });
}

describe("gateCrossAgent（第 5 闸纯函数）", () => {
  it("同内容不同 agent → crossAgent=true 且返回已有条目指针", () => {
    const existing = [fact("f1", "部署前必须先跑契约检查", DEFAULT_AGENT_ID)];
    const incoming = fact("f2", "部署前必须先跑契约检查", "agent-b");
    const result = gateCrossAgent(existing, incoming, "agent-b");
    expect(result.crossAgent).toBe(true);
    expect(result.pointers.map((item) => item.id)).toEqual(["f1"]);
  });

  it("同 agent 同内容 → false（交回去重/合并闸，旧行为不变）", () => {
    const existing = [fact("f1", "用户偏好深色主题")];
    const incoming = fact("f2", "用户偏好深色主题");
    expect(gateCrossAgent(existing, incoming, DEFAULT_AGENT_ID).crossAgent).toBe(false);
  });

  it("不同内容不同 agent → false（不是同内容，不建指针）", () => {
    const existing = [fact("f1", "用户偏好深色主题")];
    const incoming = fact("f2", "部署前必须先跑契约检查", "agent-b");
    expect(gateCrossAgent(existing, incoming, "agent-b").crossAgent).toBe(false);
  });

  it("agentOf：缺省 / 空串 / 空白归一为 loopsoar（旧数据向后兼容）", () => {
    expect(agentOf(fact("a", "x"))).toBe(DEFAULT_AGENT_ID);
    expect(agentOf(fact("a", "x", ""))).toBe(DEFAULT_AGENT_ID);
    expect(agentOf(fact("a", "x", "   "))).toBe(DEFAULT_AGENT_ID);
    expect(agentOf(fact("a", "x", "agent-b"))).toBe("agent-b");
  });
});

describe("MemoryStore.write 接入第 5 闸", () => {
  it("同内容不同 agent → 新增条目（不去重/不合并）+ 双向 crossAgentLinks", () => {
    const store = new MemoryStore();
    const first = store.write([{ content: "部署前必须先跑契约检查", category: "lesson" }]);
    expect(first.added).toHaveLength(1);
    expect(first.crossAgent).toBe(0);
    const firstFact = first.added[0];
    expect(agentOf(firstFact)).toBe(DEFAULT_AGENT_ID);

    const second = store.write([
      { content: "部署前必须先跑契约检查", category: "lesson", agentId: "agent-b" },
    ]);
    expect(second.deduped).toHaveLength(0);
    expect(second.merged).toHaveLength(0);
    expect(second.added).toHaveLength(1);
    expect(second.crossAgent).toBe(1);
    const secondFact = second.added[0];
    expect(secondFact.agentId).toBe("agent-b");
    expect(secondFact.crossAgentLinks).toContain(firstFact.id);
    expect(firstFact.crossAgentLinks).toContain(secondFact.id);

    expect(store.size()).toBe(2);
    expect(store.stats().crossAgentLinks).toBe(2);
  });

  it("同 agent 重复内容 → 仍按旧行为去重（不新增、repeated+1）", () => {
    const store = new MemoryStore();
    store.write([{ content: "用户偏好深色主题界面", category: "preference" }]);
    const again = store.write([{ content: "用户偏好深色主题界面", category: "preference" }]);
    expect(again.added).toHaveLength(0);
    expect(again.deduped).toHaveLength(1);
    expect(again.crossAgent).toBe(0);
    expect(store.size()).toBe(1);
    expect(store.list()[0].repeated).toBe(1);
  });

  it("MemoryStore({ agentId }) 作为默认归属；候选 agentId 可覆盖", () => {
    const store = new MemoryStore({ agentId: "agent-a" });
    const first = store.write([{ content: "团队约定分支从 main 切出", category: "convention" }]);
    expect(first.added[0].agentId).toBe("agent-a");
    const override = store.write([
      { content: "另一个约定：提交必须带验证记录", category: "convention", agentId: "agent-b" },
    ]);
    expect(override.added[0].agentId).toBe("agent-b");
  });

  it("快照 JSON round-trip 保留 agentId / crossAgentLinks（持久化兼容）", () => {
    const store = new MemoryStore();
    store.write([{ content: "同一事实的甲版本", category: "fact" }]);
    store.write([{ content: "同一事实的甲版本", category: "fact", agentId: "agent-b" }]);
    const state = JSON.parse(JSON.stringify(store.snapshot())) as ReturnType<MemoryStore["snapshot"]>;
    const restored = new MemoryStore();
    restored.restore(state);
    const otherAgent = restored.list().find((item) => agentOf(item) === "agent-b");
    expect(otherAgent).toBeTruthy();
    expect(otherAgent!.crossAgentLinks).toHaveLength(1);
    expect(restored.stats().crossAgentLinks).toBe(2);
  });

  it("旧数据（无 agentId 字段）按默认 agent 归一，不抛错", () => {
    const legacy = fact("old", "旧记忆内容");
    legacy.agentId = undefined;
    expect(agentOf(legacy)).toBe(DEFAULT_AGENT_ID);
    // 旧数据 vs 新数据（默认 agent）→ 同 agent，走普通去重逻辑
    expect(gateCrossAgent([legacy], fact("new", "旧记忆内容", DEFAULT_AGENT_ID), DEFAULT_AGENT_ID).crossAgent).toBe(
      false,
    );
  });
});
