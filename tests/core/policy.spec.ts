/**
 * T6 测试：packages/core/src/tools/policy.ts
 * 覆盖 classifyToolCall 三态与 explainDenial 可读建议
 */
import { describe, expect, it } from "vitest";
import { classifyToolCall, explainDenial } from "../../packages/core/src/tools/policy.ts";

describe("classifyToolCall 三态", () => {
  it("deny 列表命中 → block", () => {
    expect(classifyToolCall("rm", "terminal", { deny: ["rm"] })).toBe("block");
  });

  it("requireApproval 命中 → confirm", () => {
    expect(classifyToolCall("write", "write", { requireApproval: ["write"] })).toBe("confirm");
  });

  it("autoApprove 命中 → auto", () => {
    expect(classifyToolCall("ls", "read", { autoApprove: ["ls"] })).toBe("auto");
  });

  it("全部空开关 → 默认 confirm（安全默认拒绝）", () => {
    expect(classifyToolCall("anything", "read", {})).toBe("confirm");
  });

  it("deny 优先级高于 require/auto", () => {
    const s = { deny: ["x"], requireApproval: ["x"], autoApprove: ["x"] };
    expect(classifyToolCall("x", "read", s)).toBe("block");
  });
});

describe("explainDenial 可读建议", () => {
  it("返回包含工具名与类型的可读文案", () => {
    const msg = explainDenial("cat", "read");
    expect(msg).toContain("cat");
    expect(msg).toContain("read");
    expect(msg).toContain("拒绝执行");
    expect(msg).toContain("建议检查权限");
  });
});
