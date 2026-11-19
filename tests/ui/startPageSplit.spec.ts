import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("StartPage 的模块拆分", () => {
  it("主壳只负责加载/失败状态与子视图切换", () => {
    const start = read("packages/ui/src/StartPage.tsx");
    const lines = start.split(/\r?\n/).length;

    expect(lines).toBeLessThan(1500);
    expect(start).toContain('import NewTabPage from "./StartPageNewTab.js"');
    expect(start).toContain('import VibeChatView from "./StartPageChat.js"');
    expect(start).toContain('export type { StartPageProps } from "./startPageTypes.js"');
    expect(start).not.toContain("function NewTabPage");
    expect(start).not.toContain("function VibeChatView");
    expect(start).not.toContain("const styles: Record");
    expect(start).toContain('data-browser-state="error"');
    expect(start).toContain('data-browser-state="loading"');
  });

  it("新标签页、会话页、控制条各自独立且公共表面完整", () => {
    const ntp = read("packages/ui/src/StartPageNewTab.tsx");
    const chat = read("packages/ui/src/StartPageChat.tsx");
    const controls = read("packages/ui/src/VibeControls.tsx");
    const styles = read("packages/ui/src/startPageStyles.ts");

    expect(ntp).toContain("export default function NewTabPage");
    expect(ntp).toContain('data-testid="ntp-search-input"');
    expect(ntp).toContain('data-testid="vibe-composer-box"');
    expect(chat).toContain("export default function VibeChatView");
    expect(chat).toContain('data-browser-state="chat"');
    expect(chat).toContain("<MessageList");
    expect(controls).toContain("export function VibeControls");
    expect(controls).toContain("export function VibeWorkspacePicker");
    expect(controls).not.toContain("const styles: Record");
    expect(styles).toContain("export const styles");
    expect(styles).toContain("browserPane");
  });
});
