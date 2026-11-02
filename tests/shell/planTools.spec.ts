/**
 * todo_write 规划工具：Markdown checklist 渲染、按会话隔离、状态继承、参数校验。
 * 为什么单测：时间线的规划卡与推进播报完全依赖这里输出的清单格式。
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerPlanTools } from "../../packages/shell/src/main/planTools.ts";

function setup(): ToolRegistry {
  const registry = new ToolRegistry();
  registerPlanTools(registry);
  return registry;
}

function run(registry: ToolRegistry, sessionId: string, items: unknown) {
  const tool = registry.get("todo_write")!;
  return tool.execute({ agentId: "test", sessionId, platform: {}, params: { items } });
}

describe("todo_write 规划工具", () => {
  it("渲染 Markdown checklist 与完成度统计", async () => {
    const registry = setup();
    const result = await run(registry, "sess-a", [
      { content: "读代码", status: "completed" },
      { content: "改实现", status: "in_progress" },
      { content: "跑测试" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("任务规划（1/3 完成）");
    expect(result.content).toContain("- [x] 读代码");
    expect(result.content).toContain("- [ ] 改实现 ← 进行中");
    expect(result.content).toContain("- [ ] 跑测试");
  });

  it("按 sessionId 隔离清单（后台会话不串台）", async () => {
    const registry = setup();
    await run(registry, "sess-a", [{ content: "A 的任务" }]);
    const b = await run(registry, "sess-b", [{ content: "B 的任务" }]);
    expect(b.content).toContain("B 的任务");
    expect(b.content).not.toContain("A 的任务");
    expect(b.content).toContain("0/1 完成");
  });

  it("未给状态的条目继承同位置旧状态（推进时不必重复回填）", async () => {
    const registry = setup();
    await run(registry, "sess-c", [
      { content: "步骤一", status: "in_progress" },
      { content: "步骤二" },
    ]);
    const next = await run(registry, "sess-c", [{ content: "步骤一" }, { content: "步骤二" }]);
    expect(next.content).toContain("步骤一 ← 进行中");
  });

  it("参数非法时返回可读错误且不污染清单", async () => {
    const registry = setup();
    const bad = await run(registry, "sess-d", [{ content: "" }]);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("[错误]");
    const tooMany = await run(registry, "sess-d", Array.from({ length: 51 }, (_, i) => ({ content: `t${i}` })));
    expect(tooMany.ok).toBe(false);
    const ok = await run(registry, "sess-d", [{ content: "正常" }]);
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain("正常");
  });

  it("权限声明为空（纯元数据操作，不需要确认）", () => {
    const registry = setup();
    const tool = registry.get("todo_write")!;
    expect(tool.permissions).toEqual({});
  });
});
