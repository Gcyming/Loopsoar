/**
 * Agent 定义与权限模型：注册表校验 / builtin 保护 / 工具白名单语义（fail-closed）。
 */
import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  BUILTIN_AGENT,
  canUseTool,
  type AgentDefinition,
} from "../../packages/core/src/agent.ts";

function agent(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id, name: id, role: "测试 Agent", ...extra };
}

describe("Agent 注册表", () => {
  it("内置默认 Agent：注册即成为默认", () => {
    const reg = new AgentRegistry();
    reg.registerBuiltin(BUILTIN_AGENT);
    expect(reg.defaultAgent()?.id).toBe("loopsoar");
    expect(reg.get("loopsoar")?.builtin).toBe(true);
  });

  it("非法 id / 重复 id 拒绝", () => {
    const reg = new AgentRegistry();
    reg.registerBuiltin(BUILTIN_AGENT);
    expect(() => reg.register(agent("Bad_ID"))).toThrow(/不合法/);
    expect(() => reg.register(agent("loopsoar"))).toThrow(/已存在/);
  });

  it("builtin 不可删除；自定义可删且默认回落", () => {
    const reg = new AgentRegistry();
    reg.registerBuiltin(BUILTIN_AGENT);
    reg.register(agent("helper"));
    reg.setDefault("helper");
    expect(() => reg.remove("loopsoar")).toThrow(/内置/);
    reg.remove("helper");
    expect(reg.defaultAgent()?.id).toBe("loopsoar");
  });

  it("maxRounds 必须是正整数", () => {
    const reg = new AgentRegistry();
    expect(() => reg.register(agent("bad-rounds", { maxRounds: 0 }))).toThrow(/正整数/);
    expect(() => reg.register(agent("bad-rounds2", { maxRounds: 1.5 }))).toThrow(/正整数/);
  });

  it("setDefault 不存在的 Agent → 拒绝", () => {
    const reg = new AgentRegistry();
    expect(() => reg.setDefault("ghost")).toThrow(/不存在/);
  });
});

describe("工具白名单语义（fail-closed）", () => {
  const base = agent("a");

  it("undefined = 全部允许（内置默认）", () => {
    expect(canUseTool({ ...base, toolAllowlist: undefined }, "file_write")).toBe(true);
  });

  it("空数组 = 全部禁止", () => {
    expect(canUseTool({ ...base, toolAllowlist: [] }, "file_read")).toBe(false);
  });

  it("非空白名单 = 仅名单内", () => {
    const a = { ...base, toolAllowlist: ["file_read"] };
    expect(canUseTool(a, "file_read")).toBe(true);
    expect(canUseTool(a, "file_write")).toBe(false);
  });
});
