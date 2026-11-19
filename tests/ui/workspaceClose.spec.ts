/**
 * Agent 工作区（折叠标签）必须有「关闭此网页」入口：
 *   · 浮层每行一个关闭按钮（chrome-pop-close），发 closeTab 动作；
 *   · 主窗口收到 closeTab 后走 closeTab(tabId)（关页不关会话，也不退出程序）。
 * 这是用户 m03335 的验收前置：没有关闭入口就无法复核折叠标签。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Agent 工作区 · 关闭入口", () => {
  it("浮层层渲染关闭按钮并派发 closeTab", () => {
    const source = read(path.join("packages", "ui", "src", "PopoverApp.tsx"));
    expect(source).toContain("chrome-pop-row");
    expect(source).toContain("chrome-pop-close");
    expect(source).toContain('dispatch("closeTab"');
  });

  it("主窗口处理 closeTab 动作（复用标签关闭链路）", () => {
    const source = read(path.join("packages", "ui", "src", "useSessionActions.ts"));
    expect(source).toContain('p?.action === "closeTab"');
    expect(source).toContain("closeTab(p.payload.tabId)");
  });

  it("折叠 chip 自身也有整组关闭入口，会话列表有任务/分支标记", () => {
    const tabs = read(path.join("packages", "ui", "src", "BrowserTabs.tsx"));
    expect(tabs).toContain("workspace-chip-close");
    expect(tabs).toContain("onCloseWorkspace");
    const app = read(path.join("packages", "ui", "src", "App.tsx"));
    expect(app).toContain("closeAgentWorkspace");
    expect(app).toContain("onCloseWorkspace={closeAgentWorkspace}");
    const list = read(path.join("packages", "ui", "src", "SessionListPanel.tsx"));
    expect(list).toContain("session-task-badge");
    expect(list).toContain("session-fork-badge");
  });

  it("关闭按钮样式存在，且与标签条关闭同一套视觉语言", () => {
    const html = read(path.join("packages", "ui", "index.html"));
    expect(html).toContain(".chrome-pop-close");
    expect(html).toContain(".chrome-pop-row");
  });
});
