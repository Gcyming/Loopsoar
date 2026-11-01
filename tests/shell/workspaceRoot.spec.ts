/** 会话工作根优先级：worktree > 会话工作区 > 活动工作区 > 兜底。 */
import { describe, expect, it } from "vitest";
import { resolveSessionRoot } from "../../packages/shell/src/main/workspaceRoot.ts";

describe("resolveSessionRoot", () => {
  it("worktree 存在时优先使用 worktree", () => {
    expect(
      resolveSessionRoot({
        worktreePath: "/worktrees/s1",
        sessionWorkspaceRoot: "/projects/main",
        activeWorkspaceRoot: "/projects/other",
        fallback: "/fallback",
        isDirectory: (dir) => dir !== "/missing",
      }),
    ).toBe("/worktrees/s1");
  });

  it("worktree 已删除时回退到会话工作区，再回退活动工作区", () => {
    expect(
      resolveSessionRoot({
        worktreePath: "/missing",
        sessionWorkspaceRoot: "/projects/main",
        activeWorkspaceRoot: "/projects/other",
        fallback: "/fallback",
        isDirectory: (dir) => dir !== "/missing",
      }),
    ).toBe("/projects/main");
    expect(
      resolveSessionRoot({
        worktreePath: "/missing",
        sessionWorkspaceRoot: "/missing",
        activeWorkspaceRoot: "/projects/other",
        fallback: "/fallback",
        isDirectory: (dir) => dir !== "/missing",
      }),
    ).toBe("/projects/other");
  });

  it("都没有时使用兜底目录", () => {
    expect(
      resolveSessionRoot({
        worktreePath: "/missing",
        sessionWorkspaceRoot: null,
        activeWorkspaceRoot: null,
        fallback: "/fallback",
        isDirectory: (dir) => dir !== "/missing",
      }),
    ).toBe("/fallback");
  });
});
