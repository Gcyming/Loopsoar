/** Git worktree：创建隔离分支 / diff / 合并 / 清理（真实 git 临时仓库）。 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  getRepoStatus,
  getWorktreeDiff,
  mergeWorktree,
  removeWorktree,
} from "../../packages/shell/src/main/gitWorktree.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-wt-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

let gitAvailable = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  gitAvailable = false;
}

describe.skipIf(!gitAvailable)("worktree 服务", () => {
  function initRepo(): { repo: string; worktreesRoot: string } {
    const repo = tempDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.name", "Loopsoar Test"]);
    git(repo, ["config", "user.email", "test@loopsoar.local"]);
    fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    return { repo, worktreesRoot: path.join(tempDir(), "managed-worktrees") };
  }

  it("创建 worktree → 隔离改动 → diff → 合并到主工作区 → 清理", async () => {
    const { repo, worktreesRoot } = initRepo();
    const created = await createWorktree({
      workspaceRoot: repo,
      worktreesRoot,
      workspaceId: "ws-1",
      sessionId: "sess-1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktree = created.worktree;
    expect(fs.existsSync(worktree.path)).toBe(true);
    expect(worktree.branch.startsWith("loopsoar/")).toBe(true);
    expect(worktree.baseBranch).not.toBe("");

    fs.writeFileSync(path.join(worktree.path, "feature.ts"), "export const ok = true;\n");
    const diff = await getWorktreeDiff({
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
    });
    expect("error" in diff).toBe(false);
    if (!("error" in diff)) {
      expect(diff.files.map((file) => file.path)).toContain("feature.ts");
      expect(diff.dirty).toBe(true);
    }

    const merged = await mergeWorktree({
      repoRoot: repo,
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      message: "loopsoar: test merge",
    });
    expect(merged.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, "feature.ts"), "utf8")).toContain("ok = true");
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);
    expect((await getRepoStatus(repo)).isRepo).toBe(true);

    const removed = await removeWorktree({
      repoRoot: repo,
      worktreesRoot,
      worktreePath: worktree.path,
      branch: worktree.branch,
      deleteBranch: true,
    });
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(worktree.path)).toBe(false);
  });

  it("非 git 目录拒绝创建；主工作区有未提交改动时拒绝合并", async () => {
    const plain = tempDir();
    const created = await createWorktree({ workspaceRoot: plain, worktreesRoot: tempDir(), workspaceId: "w", sessionId: "s" });
    expect(created.ok).toBe(false);

    const { repo, worktreesRoot } = initRepo();
    const made = await createWorktree({ workspaceRoot: repo, worktreesRoot, workspaceId: "w", sessionId: "s2" });
    if (!made.ok) throw new Error(made.error);
    fs.writeFileSync(path.join(made.worktree.path, "x.txt"), "x");
    // 修改已跟踪文件：主工作区 dirty（未跟踪文件不算，与实现一致）
    fs.appendFileSync(path.join(repo, "README.md"), "\ndirty\n");
    const merged = await mergeWorktree({
      repoRoot: repo,
      worktreePath: made.worktree.path,
      branch: made.worktree.branch,
      baseBranch: made.worktree.baseBranch,
      message: "merge",
    });
    expect(merged.ok).toBe(false);
    expect(merged.error).toContain("未提交改动");
  });
});
