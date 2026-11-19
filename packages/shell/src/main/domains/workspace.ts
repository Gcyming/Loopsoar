/**
 * workspace 域：项目工作区（挂载文件夹）+ 文件读写 + 会话 worktree。
 *
 * 工作区是"主项目区域"：会话归属工作区；Agent 的文件/终端根目录由
 * 「会话 worktree > 会话工作区 > 活动工作区」决定。
 * 所有 git 操作限制在 Loopsoar 管理的 worktrees 根目录内，且只接受 loopsoar/* 分支。
 */
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
  workspaces?: WorkspaceStore;
  sessions?: SessionStore;
  /** Loopsoar 管理的 worktree 根目录（<dataDir>/worktrees）。 */
  worktreesRoot?: string;
  /** 弹系统文件夹选择框；返回 null=取消。 */
  pickFolder?: () => Promise<string | null>;
  /** 用系统文件管理器打开目录（index 注入 shell.openPath，避免本文件 import electron）。 */
  openPath?: (target: string) => Promise<string> | string;
}

export function registerWorkspaceDomain(deps: WorkspaceDeps): void {
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

  /** 把工作区绑定到会话（工作区选择器；会话/标签页与工作区绑定）。 */
  handleTrusted(deps, "workspace:bindSession", (payload) => {
    const p = payload as { sessionId?: string; workspaceId: string };
    const sessionId = p.sessionId ?? deps.sessions?.currentId() ?? null;
    const workspace = deps.workspaces?.get(p.workspaceId) ?? null;
    if (!sessionId || !workspace) return { ok: false, error: "会话或工作区不存在" };
    deps.sessions?.setWorkspaceId(sessionId, workspace.id);
    deps.workspaces?.select(workspace.id);
    return {
      ok: true,
      sessions: deps.sessions?.list() ?? [],
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

  /** 重命名工作区：只改显示名，不移动目录；名字去空白后为空则拒绝。 */
  handleTrusted(deps, "workspace:rename", (payload) => {
    const p = payload as { id: string; name: string };
    const name = String(p.name ?? "").trim();
    if (!name) {
      return { ok: false, error: "工作区名称不能为空", workspaces: deps.workspaces?.list() ?? [], activeId: deps.workspaces?.activeId() ?? null };
    }
    const renamed = deps.workspaces?.rename(p.id, name.slice(0, 64)) ?? null;
    return {
      ok: Boolean(renamed),
      workspace: renamed ?? undefined,
      workspaces: deps.workspaces?.list() ?? [],
      activeId: deps.workspaces?.activeId() ?? null,
      ...(renamed ? {} : { error: "工作区不存在" }),
    };
  });

  /** 在系统文件管理器中打开工作区根目录（路径不存在时返回可读错误）。 */
  handleTrusted(deps, "workspace:openFolder", async (payload) => {
    const p = payload as { id: string };
    const workspace = deps.workspaces?.get(p.id) ?? null;
    if (!workspace) return { ok: false, error: "工作区不存在" };
    if (!deps.openPath) return { ok: false, error: "当前环境无法打开文件夹" };
    try {
      const result = await deps.openPath(workspace.root);
      return result ? { ok: false, error: result } : { ok: true, root: workspace.root };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
