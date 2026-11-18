import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAutoSkillDraft, maybeAutoSkillCandidate } from "../../packages/shell/src/main/skillAutoCapture.js";
import { SkillHost } from "../../packages/shell/src/main/skills.js";

const dirs: string[] = [];
function tempSkillDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-auto-skill-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const base = {
  status: "done",
  toolCalls: 2,
  userText: "帮我排查登录接口 401 并补一个回归测试",
  finalText: "找到原因是 refresh token 过期后未清理本地缓存；已补测试并验证 401 分支。",
};

describe("自动技能候选", () => {
  it("成功且至少两次工具调用时生成候选草稿", () => {
    const draft = buildAutoSkillDraft(base);
    expect(draft).not.toBeNull();
    expect(draft!.name).toContain("登录接口");
    expect(draft!.tags).toEqual(["auto-candidate"]);
    expect(draft!.body).toContain("## 适用场景");
    expect(draft!.body).toContain("## 验证");
  });

  it("非 done、工具调用不足或正文过短时不生成", () => {
    expect(buildAutoSkillDraft({ ...base, status: "aborted" })).toBeNull();
    expect(buildAutoSkillDraft({ ...base, toolCalls: 1 })).toBeNull();
    expect(buildAutoSkillDraft({ ...base, userText: "短" })).toBeNull();
    expect(buildAutoSkillDraft({ ...base, finalText: "太短" })).toBeNull();
  });

  it("写入技能库时默认禁用，需人工启用", () => {
    const dir = tempSkillDir();
    const host = new SkillHost(dir);
    const record = maybeAutoSkillCandidate(base, host);
    expect(record).not.toBeNull();
    expect(record!.enabled).toBe(false);
    expect(host.promptFor("登录接口")).toBe("");
  });

  it("同名自动候选不重复生成（不自动覆盖人工草稿）", () => {
    const dir = tempSkillDir();
    const host = new SkillHost(dir);
    const first = maybeAutoSkillCandidate(base, host);
    const second = maybeAutoSkillCandidate({ ...base, finalText: `${base.finalText} 补充：新增边界用例。` }, host);
    expect(second).toBeNull();
    expect(host.list()).toHaveLength(1);
    expect(host.list()[0].body).toBe(first!.body);
  });
});
