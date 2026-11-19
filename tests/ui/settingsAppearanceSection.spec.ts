import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("设置 · 外观分区的状态所有权", () => {
  it("侧栏卷轴状态由 AppearanceSettingsSection 持有，Settings 只传偏好与通知", () => {
    const settings = read("packages/ui/src/Settings.tsx");
    const appearance = read("packages/ui/src/AppearanceSettingsSection.tsx");

    expect(settings).toContain('import AppearanceSettingsSection from "./AppearanceSettingsSection.js"');
    expect(settings).toMatch(/case "appearance":[\s\S]{0,400}<AppearanceSettingsSection/);
    expect(settings).not.toMatch(/\bRailParams\b|\bTopicRail\b|\bloadRailParams\b|\bsaveRailParams\b/);

    expect(appearance).toContain("useState<RailParams>");
    expect(appearance).toContain("loadRailParams()");
    expect(appearance).toContain("saveRailParams");
    expect(appearance).toContain("onPrefsChange");
    expect(appearance).toContain("onPreferencesSaved");
  });
});
