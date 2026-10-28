/**
 * 身份/诚实/反迎合 + stable/volatile 前缀分离。
 */
import { describe, expect, it } from "vitest";
import {
  IDENTITY_CONSTRAINT,
  HONESTY_PROTOCOL,
  ANTI_SYCOPHANCY_RULE,
  buildSystemSegments,
  assertStableUnchanged,
} from "../../packages/core/src/session.ts";

describe("身份与稳定前缀", () => {
  it("身份约束含「我是 {name}」且不透露底层模型", () => {
    const s = IDENTITY_CONSTRAINT("Loopsoar", "你的本地助理");
    expect(s).toContain("我是 Loopsoar");
    expect(s).toContain("不透露");
  });

  it("诚实协议四条", () => {
    expect(HONESTY_PROTOCOL.length).toBe(4);
    expect(HONESTY_PROTOCOL.join()).toContain("声称前必须真执行");
  });

  it("反迎合规则：不编造认同", () => {
    expect(ANTI_SYCOPHANCY_RULE).toContain("不编造认同");
  });

  it("stable/volatile 分离：volatile 变化不影响 stable 字节", () => {
    const a = buildSystemSegments({ name: "Loopsoar", role: "助手", volatile: "记忆A" });
    const b = buildSystemSegments({ name: "Loopsoar", role: "助手", volatile: "记忆B" });
    expect(a.stable).toBe(b.stable);
    expect(a.volatile).not.toBe(b.volatile);
  });

  it("assertStableUnchanged：变更即抛错", () => {
    expect(() => assertStableUnchanged("x", "x")).not.toThrow();
    expect(() => assertStableUnchanged("x", "y")).toThrow(/稳定段/);
  });
});
