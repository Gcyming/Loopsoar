import { describe, expect, it } from "vitest";
import { ToolEvidence } from "../../packages/shell/src/main/toolEvidence.ts";

function fakeMemory() {
  const added: { content: string; category: string; tags?: string[]; workspaceId?: string }[] = [];
  return {
    added,
    async add(candidate: any) {
      added.push(candidate);
      return { id: "m" + added.length, content: candidate.content, category: candidate.category } as any;
    },
  };
}

describe("工具失败证据", () => {
  it("第一次失败不写，第二次同错误写 lesson，第三次不重复", async () => {
    const memory = fakeMemory();
    const evidence = new ToolEvidence(memory, { threshold: 2 });
    const base = { sessionId: "s", workspaceId: "w", toolName: "shell", ok: false, error: "ENOENT: no such file: /tmp/a" };
    expect((await evidence.observe(base)).lesson).toBeNull();
    expect(memory.added).toHaveLength(0);
    const second = await evidence.observe(base);
    expect(second.lesson?.category).toBe("lesson");
    expect(memory.added).toHaveLength(1);
    expect(memory.added[0].content).toContain("连续失败 2 次");
    expect(memory.added[0].workspaceId).toBe("w");
    await evidence.observe(base);
    expect(memory.added).toHaveLength(1);
  });

  it("成功后清零，再失败会重新计数", async () => {
    const memory = fakeMemory();
    const evidence = new ToolEvidence(memory, { threshold: 2 });
    const fail = { sessionId: "s", toolName: "read", ok: false, error: "permission denied" };
    await evidence.observe(fail);
    await evidence.observe({ ...fail, ok: true });
    await evidence.observe(fail);
    expect(memory.added).toHaveLength(0);
    await evidence.observe(fail);
    expect(memory.added).toHaveLength(1);
  });

  it("规则拒绝/用户停止不写 lesson", async () => {
    const memory = fakeMemory();
    const evidence = new ToolEvidence(memory, { threshold: 2 });
    for (let i = 0; i < 3; i += 1) {
      await evidence.observe({ sessionId: "s", toolName: "write", ok: false, error: "规则禁止：不要修改 dist/" });
      await evidence.observe({ sessionId: "s", toolName: "shell", ok: false, error: "已停止" });
    }
    expect(memory.added).toHaveLength(0);
  });

  it("不同工具互不影响", async () => {
    const memory = fakeMemory();
    const evidence = new ToolEvidence(memory, { threshold: 2 });
    await evidence.observe({ sessionId: "s", toolName: "a", ok: false, error: "boom" });
    await evidence.observe({ sessionId: "s", toolName: "b", ok: false, error: "boom" });
    expect(memory.added).toHaveLength(0);
    await evidence.observe({ sessionId: "s", toolName: "a", ok: false, error: "boom" });
    expect(memory.added).toHaveLength(1);
  });
});
