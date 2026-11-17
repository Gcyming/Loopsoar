import { describe, expect, it } from "vitest";
import { checkRuleGuards, compileRuleGuards } from "../../packages/core/src/rules/guard.ts";

function guardsOf(...rules: string[]) {
  return compileRuleGuards(rules.map((text, index) => ({ id: "r" + index, text })));
}

describe("规则 → 工具守卫", () => {
  it("中文写路径禁令：dist/ 命中，src/ 放行", () => {
    const guards = guardsOf("不要修改 dist/ 下的文件");
    expect(guards).toHaveLength(1);
    expect(checkRuleGuards(guards, { toolName: "write", kind: "write", args: { path: "dist/app.js" } })?.action).toBe("deny");
    expect(checkRuleGuards(guards, { toolName: "write", kind: "write", args: { path: "src/app.ts" } })).toBeNull();
  });

  it("绝对路径按 workspace 归一化后命中", () => {
    const guards = guardsOf("禁止编辑 build/");
    const root = "D:/proj";
    expect(checkRuleGuards(guards, { toolName: "edit", kind: "write", args: { path: "D:/proj/build/out.js" }, workspaceRoot: root })?.action).toBe("deny");
    expect(checkRuleGuards(guards, { toolName: "edit", kind: "write", args: { path: "D:/other/build/out.js" }, workspaceRoot: root })).toBeNull();
  });

  it("英文 Never edit files in ...", () => {
    const guards = guardsOf("Never edit files in node_modules/");
    expect(checkRuleGuards(guards, { toolName: "write", kind: "write", target: "node_modules/x/index.js" })?.action).toBe("deny");
  });

  it("读取禁令只拦 read，不拦 write", () => {
    const guards = guardsOf("禁止读取 .env");
    expect(checkRuleGuards(guards, { toolName: "read", kind: "read", args: { path: ".env" } })?.action).toBe("deny");
    expect(checkRuleGuards(guards, { toolName: "read", kind: "read", args: { path: "src/.env" } })?.action).toBe("deny");
    expect(checkRuleGuards(guards, { toolName: "write", kind: "write", args: { path: ".env" } })).toBeNull();
  });

  it("没有路径的规则不编译（只留给 prompt/checklist）", () => {
    expect(guardsOf("只能使用 pnpm", "所有项目都必须加中文注释")).toEqual([]);
  });

  it("问句/正向描述不会误编译", () => {
    expect(guardsOf("为什么不要修改 dist/？")).toEqual([]);
    expect(guardsOf("可以修改 dist/ 下的文件")).toEqual([]);
  });
});
