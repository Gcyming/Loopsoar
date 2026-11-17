import { describe, expect, it } from "vitest";
import { checkCommandGuards, compileCommandGuards } from "../../packages/core/src/rules/commandGuard.ts";

const compile = (...rules: string[]) => compileCommandGuards(rules.map((text, index) => ({ id: "r" + index, text })));

describe("命令守卫", () => {
  it("只能使用 pnpm → 拒绝 npm/yarn/bun，放行 pnpm", () => {
    const guards = compile("以后只能使用 pnpm 管理依赖");
    expect(guards[0].managers).toEqual(["npm", "yarn", "bun"]);
    expect(checkCommandGuards(guards, "npm install")?.manager).toBe("npm");
    expect(checkCommandGuards(guards, "yarn build")?.manager).toBe("yarn");
    expect(checkCommandGuards(guards, "pnpm install")).toBeNull();
  });

  it("不要用 npm → 只拒绝 npm", () => {
    const guards = compile("不要使用 npm");
    expect(checkCommandGuards(guards, "npm run build")?.manager).toBe("npm");
    expect(checkCommandGuards(guards, "pnpm build")).toBeNull();
  });

  it("没有包管理器约束不编译", () => {
    expect(compile("提交信息用中文", "不要修改 dist/")).toEqual([]);
  });

  it("函数调用/路径里的 npm 也会命中（显式规则优先）", () => {
    const guards = compile("禁止使用 npm");
    expect(checkCommandGuards(guards, "node -e \"console.log('npm')\"")).not.toBeNull();
  });
});
