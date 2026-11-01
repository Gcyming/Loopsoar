/**
 * workspace 域：项目工作区（挂载文件夹）+ 文件读写 + 会话 worktree。
 *
 * 工作区是"主项目区域"：会话归属工作区；Agent 的文件/终端根目录由
 * 「会话 worktree > 会话工作区 > 活动工作区」决定。
 * 所有 git 操作限制在 Loopsoar 管理的 worktrees 根目录内，且只接受 loopsoar/* 分支。
 */
import { FILE_WRITE_MAX_BYTES } from "loopsoar-contracts/security-policy";
import type { LoopsoarPlatform } from "loopsoar-core/platform";
import type { SessionStore } from "../sessionStore.js";
import type { WorkspaceStore } from "../workspaceStore.js";
import {
  createWorktree,
  getRepoStatus,
  getWorktreeDiff,
  mergeWorktree,
  removeWorktree,
} from "../gitWorktree.js";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export interface WorkspaceDeps extends TrustedIpcDeps {
  platform: LoopsoarPlatform;
  workspaces?: WorkspaceStore;
  sessions?: SessionStore;
  /** Loopsoar 管理的 worktree 根目录（<dataDir>/worktrees）。 */
  worktreesRoot?: string;
  /** 弹系统文件夹选择框；返回 null=取消。 */
  pickFolder?: () => Promise<string | null>;
}

export function registerWorkspaceDomain(deps: WorkspaceDeps): void {
  handleTrusted(deps, "file:read", async (payload) => {
    const { path, offset = 0, limit = 1000 } = payload as {
      path: string;
      offset?: number;
      limit?: number;
    };
    try {
      const text = await deps.platform.fs.readFileUtf8(path);
      const lines = text.split(/\r?\n/);
      const page = lines.slice(offset, offset + limit);
      return { ok: true, content: page.join("\n"), totalLines: lines.length };
    } catch (err) {
      return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handleTrusted(deps, "file:write", async (payload) => {
    const { path, content } = payload as { path: string; content: string };
    if (content.length > FILE_WRITE_MAX_BYTES) {
      return { ok: false, content: "[错误] 内容超过 5MB 单文件写入上限" };
    }
    try {
      await deps.platform.fs.writeFileUtf8(path, content);
      return { ok: true, content: `已写入 ${path}` };
    } catch (err) {
      return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ── 工作区（挂载项目文件夹）──
  handleTrusted(deps, "workspace:list", () => ({
    workspaces: deps.workspaces?.list() ?? [],
    activeId: deps.workspaces?.activeId() ?? null,
  }));

  handleTrusted(deps, "workspace:create", async (payload) => {
    const p = payload as { root?: string; name?: string };
    let root = p.root?.trim() ?? "";
    if (!root) {
      const picked = (await deps.pickFolder?.()) ?? null;
      if (!picked) {
        return {
          ok: false,
          error: "已取消选择文件夹",
          workspaces: deps.workspaces?.list() ?? [],
          activeId: deps.workspaces?.activeId() ?? null,
        };
      }
      root = picked;
    }
    const created = deps.workspaces?.create(root, p.name) ?? { ok: false as const, error: "工作区未装配" };
    if (!created.ok) {
      return {
        ok: false,
        error: created.error,
        workspaces: deps.workspaces?.list() ?? [],
        activeId: deps.workspaces?.activeId() ?? null,
      };
    }
    return {
      ok: true,
      workspace: created.workspace,
      workspaces: deps.workspaces?.list() ?? [],
      activeId: deps.workspaces?.activeId() ?? null,
    };
  });

  handleTrusted(deps, "workspace:select", (payload) => {
    const p = payload as { id: string };
    const workspace = deps.workspaces?.select(p.id) ?? null;
    return {
      ok: Boolean(workspace),
      workspace,
      workspaces: deps.workspaces?.list() ?? [],
      activeId: deps.workspaces?.activeId() ?? null,
      ...(workspace ? {} : { error: "工作区不存在" }),
    };
  });

  handleTrusted(deps, "workspace:remove", (payload) => {
    const p = payload as { id: string };
    const boundSessions = (deps.sessions?.list() ?? []).filter((item) => item.workspaceId === p.id);
    if (boundSessions.length > 0) {
      return {
        ok: false,
        error: `该工作区下还有 ${boundSessions.length} 个会话，请先删除这些会话`,
        workspaces: deps.workspaces?.list() ?? [],
        activeId: deps.workspaces?.activeId() ?? null,
      };
    }
    const removed = deps.workspaces?.remove(p.id) ?? { ok: false, error: "工作区未装配" };
    return {
      ok: removed.ok,
      ...(removed.error ? { error: removed.error } : {}),
      workspaces: deps.workspaces?.list() ?? [],
      activeId: deps.workspaces?.activeId() ?? null,
    };
  });

  handleTrusted(deps, "workspace:status", async (payload) => {
    const p = payload as { id?: string };
    const workspace = p.id ? deps.workspaces?.get(p.id) ?? null : deps.workspaces?.active() ?? null;
    if (!workspace) return { ok: false, error: "工作区不存在" };
    const git = await getRepoStatus(workspace.root);
    const sessions = (deps.sessions?.list() ?? []).filter((item) => item.workspaceId === workspace.id);
    const worktrees = sessions
      .map((item) => ({ sessionId: item.id, title: item.title, worktree: deps.sessions?.getWorktree(item.id) ?? null }))
      .filter((item) => item.worktree !== null);
    return {
      ok: true,
      workspace,
      git,
      sessions: sessions.map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt })),
      worktrees,
      activeId: deps.workspaces?.activeId() ?? null,
    };
  });

  // ── 会话 worktree（隔离改动 / diff / 合并）──
  handleTrusted(deps, "worktree:create", async (payload) => {
    const p = payload as { sessionId: string };
    const session = deps.sessions?.get(p.sessionId) ?? null;
    if (!session) return { ok: false, error: "会话不存在" };
    if (session.worktree) return { ok: false, error: "该会话已有 worktree", worktree: session.worktree };
    let workspace = session.workspaceId ? deps.workspaces?.get(session.workspaceId) ?? null : null;
    if (!workspace) {
      workspace = deps.workspaces?.active() ?? null;
      if (workspace) deps.sessions?.setWorkspaceId(p.sessionId, workspace.id);
    }
    if (!workspace) return { ok: false, error: "会话没有绑定工作区" };
    const created = await createWorktree({
      workspaceRoot: workspace.root,
      worktreesRoot: deps.worktreesRoot ?? "",
      workspaceId: workspace.id,
      sessionId: p.sessionId,
    });
    if (!created.ok) return { ok: false, error: created.error };
    deps.sessions?.setWorktree(p.sessionId, created.worktree);
    return { ok: true, worktree: created.worktree, workspaceId: workspace.id };
  });

  handleTrusted(deps, "worktree:remove", async (payload) => {
    const p = payload as { sessionId: string; force?: boolean; deleteBranch?: boolean };
    const session = deps.sessions?.get(p.sessionId) ?? null;
    if (!session?.worktree) return { ok: false, error: "该会话没有 worktree" };
    const removed = await removeWorktree({
      repoRoot: session.worktree.repoRoot,
      worktreesRoot: deps.worktreesRoot ?? "",
      worktreePath: session.worktree.path,
      branch: session.worktree.branch,
      force: p.force ?? true,
      deleteBranch: p.deleteBranch ?? true,
    });
    if (!removed.ok) return { ok: false, error: removed.error };
    deps.sessions?.setWorktree(p.sessionId, null);
    return { ok: true };
  });

  handleTrusted(deps, "worktree:diff", async (payload) => {
    const p = payload as { sessionId: string };
    const session = deps.sessions?.get(p.sessionId) ?? null;
    if (!session?.worktree) return { ok: false, error: "该会话没有 worktree" };
    const diff = await getWorktreeDiff({
      worktreePath: session.worktree.path,
      branch: session.worktree.branch,
      baseBranch: session.worktree.baseBranch,
    });
    if ("error" in diff) return { ok: false, error: diff.error };
    return { ok: true, diff, worktree: session.worktree };
  });

  handleTrusted(deps, "worktree:merge", async (payload) => {
    const p = payload as { sessionId: string; message?: string };
    const session = deps.sessions?.get(p.sessionId) ?? null;
    if (!session?.worktree) return { ok: false, error: "该会话没有 worktree" };
    const result = await mergeWorktree({
      repoRoot: session.worktree.repoRoot,
      worktreePath: session.worktree.path,
      branch: session.worktree.branch,
      baseBranch: session.worktree.baseBranch,
      message: p.message || `loopsoar: merge session ${p.sessionId}`,
    });
    return { ...result };
  });
}
