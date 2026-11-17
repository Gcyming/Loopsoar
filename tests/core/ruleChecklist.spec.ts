import { describe, expect, it } from "vitest";
import { buildRuleChecklist, type ChecklistSource } from "../../packages/core/src/rules/checklist.ts";

const src = (text: string, id = "a", scope: "global" | "workspace" = "workspace"): ChecklistSource => ({ id, scope, name: "AGENTS.md", text });

describe("规则自检清单", () => {
  it("只收约束行，跳过标题/复选框/问句/假设", () => {
    const out = buildRuleChecklist([src("# 规则\n- [ ] 已完成\n- 必须使用 pnpm\n- 为什么不要用 npm？\n- 如果失败就重试")]);
    expect(out.items).toEqual(["必须使用 pnpm"]);
    expect(out.text).toContain("- [ ] 必须使用 pnpm");
  });

  it("去重并排除已被守卫接管的规则", () => {
    const out = buildRuleChecklist([
      src("- 必须使用 pnpm\n- 必须使用 pnpm", "a"),
      src("- 不要修改 dist/ 下的文件", "b"),
    ], ["不要修改 dist/ 下的文件"]);
    expect(out.items).toEqual(["必须使用 pnpm"]);
  });

  it("最多 max 条", () => {
    const out = buildRuleChecklist([src("- 必须 A\n- 必须 B\n- 必须 C")], [], 2);
    expect(out.items).toHaveLength(2);
    expect(out.text.split("\n")).toHaveLength(3);
  });

  it("没有约束行 → 空清单（不注入）", () => {
    expect(buildRuleChecklist([src("# 只有标题\n普通说明文字")]).text).toBe("");
  });
});
