import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("设置 · 记忆分区的状态所有权", () => {
  it("记忆状态与动作由 MemorySettingsSection 持有，Settings 只负责挂载", () => {
    const settings = read("packages/ui/src/Settings.tsx");
    const memory = read("packages/ui/src/MemorySettingsSection.tsx");

    expect(settings).toContain('import MemorySettingsSection from "./MemorySettingsSection.js"');
    expect(settings).toMatch(/case "memory":[\s\S]{0,400}<MemorySettingsSection/);
    expect(settings).not.toMatch(/\bmemWs\b|\bmemGraph\b|\baddMemory\b|\bsaveMemEdit\b/);
    expect(settings).not.toContain("api.memory.list()");

    expect(memory).toContain("useState<MemoryListResult | null>");
    expect(memory).toContain("setMemWs");
    expect(memory).toContain('memWs === "all"');
    expect(memory).toContain("memory-replay");
    expect(memory).toContain("onPrefsChange");
    expect(memory).toContain("onSavePrefs");
  });

  it("记忆筛选/回放状态进入 component 的 memo 依赖，避免切工作区后不刷新", () => {
    const memory = read("packages/ui/src/MemorySettingsSection.tsx");
    const memo = memory.slice(memory.indexOf("const body = useMemo"));
    const deps = memo.slice(memo.lastIndexOf("}, ["));
    expect(deps).toContain("memWs");
    expect(deps).toContain("memGraph");
    expect(deps).toContain("graphSel");
    expect(deps).toContain("replayAt");
    expect(deps).toContain("replayDomain");
    expect(deps).toContain("mForm");
  });
});
