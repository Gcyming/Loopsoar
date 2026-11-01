/**
 * Git worktree 服务（壳层，无 electron）：
 *   · 每个会话可以有独立 worktree（隔离 branch + 目录），Agent 改动不污染主工作区；
 *   · diff / 合并 / 清理经由 git CLI 完成；所有路径限制在 Loopsoar 管理目录内。
 *
 * 对标主流 Agent：Cursor 的 /worktree、Claude Code 的 --worktree、Codex 环境的 git worktree。
 * Loopsoar 额外把 worktree 绑定到会话：切回会话会自动落在它自己的隔离目录。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

export interface RepoStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  changedFiles: number;
}

export async function getRepoStatus(root: string): Promise<RepoStatus> {
  const empty: RepoStatus = { isRepo: false, root: null, branch: null, head: null, dirty: false, changedFiles: 0 };
  try {
    if (!root || !fs.existsSync(root)) return empty;
  } catch {
    return empty;
  }
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return empty;
  const repoRoot = top.stdout.trim();
  const branch = await git(root, ["branch", "--show-current"]);
  const head = await git(root, ["rev-parse", "--short", "HEAD"]);
  const status = await git(root, ["status", "--porcelain"]);
  const changed = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
  return {
    isRepo: true,
    root: repoRoot,
    branch: branch.stdout.trim() || null,
    head: head.stdout.trim() || null,
    dirty: changed > 0,
    changedFiles: changed,
  };
}

function slug(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "session").slice(0, 48);
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface WorktreeRecord {
  path: string;
  branch: string;
  baseBranch: string;
  repoRoot: string;
  createdAt: number;
}

export type WorktreeCreateResult =
  | { ok: true; worktree: WorktreeRecord }
  | { ok: false; error: string };

export async function createWorktree(input: {
  workspaceRoot: string;
  worktreesRoot: string;
  workspaceId: string;
  sessionId: string;
  /** 分支显示用（一般=会话标题/短 id）。 */
  label?: string;
}): Promise<WorktreeCreateResult> {
  const repo = await getRepoStatus(input.workspaceRoot);
  if (!repo.isRepo || !repo.root) return { ok: false, error: "当前工作区不是 Git 仓库，无法创建 worktree" };
  const baseBranch = repo.branch || "HEAD";
  const branchBase = slug(input.label || input.sessionId);
  let branch = `loopsoar/${branchBase}`;
  const exists = await git(repo.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists.code === 0) {
    branch = `loopsoar/${branchBase}-${Date.now().toString(36).slice(-5)}`;
  }
  const worktreePath = path.join(input.worktreesRoot, slug(input.workspaceId), slug(input.sessionId));
  if (!isInside(input.worktreesRoot, worktreePath)) return { ok: false, error: "worktree 路径越界" };
  if (fs.existsSync(worktreePath)) return { ok: false, error: "该会话的 worktree 目录已存在（可能残留），请先清理" };
  try {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  } catch (err) {
    return { ok: false, error: `创建 worktree 父目录失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const added = await git(repo.root, ["worktree", "add", "-b", branch, worktreePath, baseBranch], 120_000);
  if (added.code !== 0) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // 清理失败不影响错误返回
    }
    return { ok: false, error: `git worktree add 失败：${(added.stderr || added.stdout).trim().slice(0, 800)}` };
  }
  return {
    ok: true,
    worktree: {
      path: worktreePath,
      branch,
      baseBranch,
      repoRoot: repo.root,
      createdAt: Date.now(),
    },
  };
}

export async function removeWorktree(input: {
  repoRoot: string;
  worktreesRoot: string;
  worktreePath: string;
  branch: string;
  force?: boolean;
  deleteBranch?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  if (!isInside(input.worktreesRoot, input.worktreePath)) {
    return { ok: false, error: "只允许删除 Loopsoar 管理目录下的 worktree" };
  }
  if (!/^loopsoar\/[A-Za-z0-9._-]+$/.test(input.branch)) {
    return { ok: false, error: "分支名不是 Loopsoar 管理的 worktree 分支，拒绝删除" };
  }
  const args = ["worktree", "remove", ...(input.force ? ["--force"] : []), input.worktreePath];
  const removed = await git(input.repoRoot, args, 60_000);
  if (removed.code !== 0) {
    const forced = await git(input.repoRoot, ["worktree", "remove", "--force", input.worktreePath], 60_000);
    if (forced.code !== 0) {
      return {
        ok: false,
        error: `删除 worktree 失败：${(forced.stderr || forced.stdout).trim().slice(0, 500)}`,
      };
    }
  }
  await git(input.repoRoot, ["worktree", "prune"]);
  if (input.deleteBranch) {
    await git(input.repoRoot, ["branch", "-D", input.branch]);
  }
  return { ok: true };
}

export interface WorktreeFileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "unknown";
  additions: number;
  deletions: number;
}

export interface WorktreeDiff {
  branch: string;
  baseBranch: string;
  files: WorktreeFileChange[];
  commits: { hash: string; subject: string }[];
  dirty: boolean;
  ahead: number;
}

function mapStatus(code: string): WorktreeFileChange["status"] {
  if (code === "??") return "untracked";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("M")) return "modified";
  return "unknown";
}

export async function getWorktreeDiff(input: {
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): Promise<WorktreeDiff | { error: string }> {
  const status = await git(input.worktreePath, ["status", "--porcelain"]);
  if (status.code !== 0) return { error: status.stderr.trim() || "无法读取 worktree 状态" };
  const fileMap = new Map<string, WorktreeFileChange>();
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const raw = line.slice(3).trim();
    const filePath = raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw;
    fileMap.set(filePath, { path: filePath, status: mapStatus(code), additions: 0, deletions: 0 });
  }
  const numstat = await git(input.worktreePath, ["diff", "HEAD", "--numstat"]);
  if (numstat.code === 0) {
    for (const line of numstat.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [add, del, rawPath] = line.split("\t");
      if (!rawPath) continue;
      const filePath = rawPath.includes(" => ") ? rawPath.split(" => ").at(-1)!.replace(/[{}]/g, "") : rawPath;
      const change = fileMap.get(filePath) ?? { path: filePath, status: "modified" as const, additions: 0, deletions: 0 };
      change.additions = Number(add) || 0;
      change.deletions = Number(del) || 0;
      fileMap.set(filePath, change);
    }
  }
  const commits: { hash: string; subject: string }[] = [];
  const log = await git(input.worktreePath, ["log", "--format=%h%x09%s", `${input.baseBranch}..HEAD`, "-50"]);
  if (log.code === 0) {
    for (const line of log.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [hash, ...subject] = line.split("\t");
      commits.push({ hash, subject: subject.join("\t") });
    }
  }
  return {
    branch: input.branch,
    baseBranch: input.baseBranch,
    files: [...fileMap.values()],
    commits,
    dirty: fileMap.size > 0,
    ahead: commits.length,
  };
}

export interface MergeResult {
  ok: boolean;
  committed: boolean;
  mergeCommit?: string;
  conflicts?: string[];
  error?: string;
}

export async function mergeWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  message: string;
}): Promise<MergeResult> {
  if (!/^loopsoar\/[A-Za-z0-9._-]+$/.test(input.branch)) {
    return { ok: false, committed: false, error: "分支名不是 Loopsoar 管理的 worktree 分支" };
  }
  const currentBranch = await git(input.repoRoot, ["branch", "--show-current"]);
  const base = currentBranch.stdout.trim();
  if (!base) return { ok: false, committed: false, error: "主工作区处于 detached HEAD，请先切回基准分支" };
  if (base !== input.baseBranch) {
    return {
      ok: false,
      committed: false,
      error: `主工作区当前在 ${base}，worktree 基准是 ${input.baseBranch}；请先切回基准分支再合并`,
    };
  }
  const mainStatus = await git(input.repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (mainStatus.stdout.trim()) {
    return { ok: false, committed: false, error: "主工作区有未提交改动，请先提交或 stash 后再合并 worktree" };
  }

  // 1) worktree 内提交未提交改动（Agent 产出先落 branch）
  await git(input.worktreePath, ["add", "-A"]);
  const staged = await git(input.worktreePath, ["diff", "--cached", "--quiet"]);
  let committed = false;
  if (staged.code !== 0) {
    const commit = await git(
      input.worktreePath,
      ["commit", "-m", input.message || "loopsoar: worktree changes", "--no-verify"],
      120_000,
    );
    if (commit.code !== 0) {
      return { ok: false, committed: false, error: `worktree 提交失败：${(commit.stderr || commit.stdout).trim().slice(0, 500)}` };
    }
    committed = true;
  }

  // 2) 主工作区合并（--no-ff 保留分支痕迹）
  const merged = await git(input.repoRoot, ["merge", "--no-ff", "--no-edit", input.branch], 120_000);
  if (merged.code !== 0) {
    const conflictsOut = await git(input.repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
    const conflicts = conflictsOut.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    await git(input.repoRoot, ["merge", "--abort"]);
    return {
      ok: false,
      committed,
      conflicts,
      error: conflicts.length > 0
        ? `合并冲突，已 abort：${conflicts.slice(0, 12).join(", ")}`
        : `git merge 失败：${(merged.stderr || merged.stdout).trim().slice(0, 500)}`,
    };
  }
  const head = await git(input.repoRoot, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, committed, mergeCommit: head.stdout.trim() || undefined };
}
