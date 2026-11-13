/**
 * 会话列表（工作区树）交互守卫：
 *   · 展开/收起用 chevron 图标并做旋转过渡；
 *   · 工作区标题行悬浮操作 = 更多 + 添加会话；
 *   · 会话行悬浮操作 = 更多 + 置顶 + 删除；
 *   · 悬浮操作默认隐藏、行 hover 淡入（CSS 规则必须存在）；
 *   · 工作区重命名/在文件夹显示/删除、会话置顶菜单的文案与入口齐全；
 *   · 主进程 workspace 域提供 rename/openFolder 通道。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("会话列表悬浮操作", () => {
  it("chevron 箭头：展开/收起旋转 + 工作区/会话各自的悬浮操作按钮", () => {
    const panel = read("packages/ui/src/SessionListPanel.tsx");
    expect(panel).toContain('name="chevron-down"');
    expect(panel).toContain('rotate(-90deg)');
    expect(panel).toContain('data-testid="session-workspace-row"');
    expect(panel).toContain('data-testid="workspace-more"');
    expect(panel).toContain('data-testid="workspace-add-session"');
    expect(panel).toContain('data-testid="session-more"');
    expect(panel).toContain('data-testid="session-pin"');
    expect(panel).toContain('data-testid="session-delete"');
  });

  it("菜单项：工作区 重命名/在文件夹显示/删除，会话 置顶/复制 ID/删除", () => {
    const panel = read("packages/ui/src/SessionListPanel.tsx");
    for (const key of [
      "chat.renameWorkspace",
      "chat.revealWorkspace",
      "chat.removeWorkspace",
      "chat.pinSession",
      "chat.unpinSession",
      "chat.copySessionId",
      "chat.deleteSession",
    ]) {
      expect(panel).toContain(key);
    }
  });

  it("悬浮操作只在行 hover 时淡入（默认透明 + 不可点）", () => {
    const html = read("packages/ui/index.html");
    expect(html).toContain(".session-item-row .session-row-actions");
    expect(html).toContain(".session-workspace-row .session-row-actions");
    expect(html).toContain("opacity: 0;");
    expect(html).toContain("pointer-events: none;");
    expect(html).toContain(".session-item-row:hover .session-row-actions");
  });

  it("主进程 workspace 域：rename / openFolder 通道 + App 对接", () => {
    const schemas = read("packages/contracts/src/schemas.ts");
    expect(schemas).toContain('"workspace:rename"');
    expect(schemas).toContain('"workspace:openFolder"');
    const domain = read("packages/shell/src/main/domains/workspace.ts");
    expect(domain).toContain('"workspace:rename"');
    expect(domain).toContain('"workspace:openFolder"');
    const app = read("packages/ui/src/App.tsx");
    expect(app).toContain("const renameWorkspace");
    expect(app).toContain("const removeWorkspace");
    expect(app).toContain("const openWorkspaceFolder");
    expect(app).toContain("onNewSessionInWorkspace={newSessionInWorkspace}");
  });
});
