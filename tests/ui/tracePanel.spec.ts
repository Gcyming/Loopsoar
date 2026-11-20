import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("设置 · 运行轨迹面板", () => {
  const settings = read("packages/ui/src/Settings.tsx");
  const panel = read("packages/ui/src/TraceSection.tsx");

  it("挂载在高级/诊断页，拆成独立组件而不是继续堆 Settings", () => {
    expect(settings).toContain('import TraceSection from "./TraceSection.js"');
    expect(settings).toMatch(/case "advanced":[\s\S]{0,2500}<TraceSection api=\{api\} \/>/);
    expect(panel).toContain("export default function TraceSection");
  });

  it("数据只走只读 IPC：sessions 取 currentId，settings.traces 取报告", () => {
    expect(panel).toContain("api.chat.sessions()");
    expect(panel).toContain("api.settings.traces({ sessionId: state.currentId, limit: 50 })");
    expect(panel).not.toContain("JSONL");
    expect(panel).not.toMatch(/readFile|fs\./);
  });

  it("展示聚合、工具表、最近事件与定价说明", () => {
    expect(panel).toContain("summary.turns");
    expect(panel).toContain("byTool.slice(0, 8)");
    expect(panel).toContain("report!.pricingNote");
    expect(panel).toContain("summary.lastError");
    expect(panel).toContain("money(summary.costUsd)");
    expect(panel).toContain("settings.traces.noPrice");
  });

  it("技能安装入口：先选目录再导入（不在 UI 里拼路径）", () => {
    const skills = read("packages/ui/src/SkillsSection.tsx");
    expect(skills).toContain("onImport");
    expect(skills).toContain('tr("settings.skills.import")');
    expect(settings).toContain('api.dialog.pickPath({ kind: "directory"');
    expect(settings).toMatch(/api\.skills\.import\(\{ sourcePath \}\)/);
    expect(settings).toMatch(/overwrite: true/);
  });
});
