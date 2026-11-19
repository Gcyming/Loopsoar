import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("设置 · 规则分区的状态所有权", () => {
  it("规则草稿/候选/历史由 RulesSettingsSection 持有，Settings 只挂载", () => {
    const settings = read("packages/ui/src/Settings.tsx");
    const rules = read("packages/ui/src/RulesSettingsSection.tsx");

    expect(settings).toContain('import RulesSettingsSection from "./RulesSettingsSection.js"');
    expect(settings).toMatch(/case "rules":[\s\S]{0,200}<RulesSettingsSection/);
    expect(settings).not.toMatch(/\bruleCandidates\b|\brulePending\b|\bapplyRules\b|\baddDraft\b|\bremoveDraft\b/);
    expect(settings).not.toContain("api.rules.");

    expect(rules).toContain("useState<RulesSnapshot | null>");
    expect(rules).toContain("setRuleCandidates");
    expect(rules).toContain("setRulePending");
    expect(rules).toContain("setRuleHistory");
    expect(rules).toContain("api.rules.acceptCandidate");
    expect(rules).toContain("settings.rules.saveAll");
  });
});
