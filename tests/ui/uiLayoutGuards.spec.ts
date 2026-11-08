/**
 * 用户 m02010 的界面布局回归守卫（node 环境源码扫描，无需 jsdom——与 icons.spec 同思路）。
 *
 * 覆盖三类容易在后续重构里被改回去的点：
 *   1) 助手悬停元信息行在回复最底部、「思考」按钮已删除（点思考过程标题即可展开）；
 *   2) 所有复制动作统一使用 `copy` 图标（消息/会话/代码块），不要再用 file 图标；
 *   3) 输入框下方的 composerFoot 已移除，Build/Plan 模式提示改由底部状态栏渲染；
 *   4) 思考时间线每种动作都有「图标 + 类型标签」（think/tool/plan/todo/steer）。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("消息/输入区布局守卫（用户 m02010）", () => {
  const chat = read("packages/ui/src/ChatMessageView.tsx");

  it("助手悬停元信息行在回复底部，且「思考」按钮已删除", () => {
    expect(chat).toContain("msg-hover-bottom");
    expect(chat).not.toContain("msg-think-toggle");
    // 源码顺序即 DOM 顺序：底部行必须出现在正文之后
    const bodyAt = chat.indexOf('className="msg-body-text"');
    const bottomAt = chat.indexOf("msg-hover-bottom");
    expect(bodyAt).toBeGreaterThan(-1);
    expect(bottomAt).toBeGreaterThan(bodyAt);
  });

  it("复制按钮统一使用 copy 图标（消息 / 会话 / 代码块）", () => {
    expect(chat.match(/<Icon name="copy"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(read("packages/ui/src/AgentSidebar.tsx")).toContain('<Icon name="copy"');
    expect(read("packages/ui/src/Markdown.tsx")).toContain('<Icon name="copy"');
  });

  it("输入框下不再渲染 composerFoot；模式提示改由状态栏渲染", () => {
    expect(read("packages/ui/src/Composer.tsx")).not.toContain("composerFoot");
    const statusBar = read("packages/ui/src/StatusBar.tsx");
    expect(statusBar).toContain("status-mode");
    expect(statusBar).toContain("composer.buildFoot");
    expect(statusBar).toContain("composer.planFoot");
    // App 只把 mode 传进状态栏（notice 仍走 Toast，不再塞回输入框下方）
    expect(read("packages/ui/src/App.tsx")).toMatch(/<StatusBar[\s\S]*?mode=\{mode\}/);
  });
});

describe("思考时间线图标化守卫", () => {
  const timeline = read("packages/ui/src/TimelineView.tsx");

  it("每种动作都有图标 + 类型标签", () => {
    expect(timeline).toContain("toolVisual(");
    expect(timeline).toContain('data-kind="think"');
    expect(timeline).toContain('data-kind="body"');
    expect(timeline).toContain('data-kind="tool"');
    expect(timeline).toContain('data-kind="plan"');
    expect(timeline).toContain('data-kind="todo"');
    expect(timeline).toContain('data-kind="steer"');
    expect(timeline).toContain("think-step-kind");
    expect(timeline).toContain("think-tool-type");
    expect(timeline).toContain("plan-card-icon");
    expect(timeline).toContain("todo-announce-kind");
    expect(timeline).toContain("steer-card-icon");
  });
});
