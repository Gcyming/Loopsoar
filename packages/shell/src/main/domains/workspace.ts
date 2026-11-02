/**
 * workspace 域：项目工作区（挂载文件夹）+ 文件读写 + 会话 worktree。
 *
 * 工作区是"主项目区域"：会话归属工作区；Agent 的文件/终端根目录由
 * 「会话 worktree > 会话工作区 > 活动工作区」决定。
 * 所有 git 操作限制在 Loopsoar 管理的 worktrees 根目录内，且只接受 loopsoar/* 分支。
 */
import path from "node:path";
import { FILE_READ_MAX_BYTES, FILE_WRITE_MAX_BYTES } from "loopsoar-contracts/security-policy";
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
  /**
   * 会话工作根解析（worktree > 会话工作区 > 活动工作区），由 index.ts 装配注入。
   * 为什么注入而不是在这里读 store：文件 IPC 必须和 Agent 工具用同一个根（否则两边判定不一致）；
   * 未注入时（守卫测试 / 旧装配）回退活动工作区根 → process.cwd()。
   */
  resolveSessionRoot?: (sessionId?: string) => string;
}

/** 本次 file:read / file:write 允许访问的根目录（fail-closed：解析失败也只会收紧到活动工作区/cwd）。 */
function resolveFileRoot(deps: WorkspaceDeps, sessionId?: string): string {
  if (deps.resolveSessionRoot) {
    try {
      const root = deps.resolveSessionRoot(sessionId);
      if (root && root.trim()) return path.resolve(root);
    } catch {
      // 装配异常时继续走兜底根（仍是受限目录，不会放开到整盘）
    }
  }
  const activeRoot = deps.workspaces?.active()?.root;
  return path.resolve(activeRoot && activeRoot.trim() ? activeRoot : process.cwd());
}

/**
 * 目标是否落在 root 内（含 root 自身）。
 * 用 path.relative 判定而不是字符串 startsWith：避免 "C:/work2" 被 "C:/work" 前缀误判为内部，
 * 也兼容 Windows 盘符/大小写差异（path.relative 在 win32 上按大小写不敏感比较）。
 */
function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(rel);
}

/** 解析并校验目标路径：越界返回 null（调用方给出可读的「路径越界」错误）。 */
function resolveInRoot(root: string, requested: string): string | null {
  const target = path.resolve(root, requested);
  return isInsideRoot(root, target) ? target : null;
}

export function registerWorkspaceDomain(deps: WorkspaceDeps): void {
  handleTrusted(deps, "file:read", async (payload) => {
    const {
      path: requested,
      offset = 0,
      limit = 1000,
      sessionId,
    } = payload as {
      path: string;
      offset?: number;
      limit?: number;
      sessionId?: string;
    };
    try {
      const root = resolveFileRoot(deps, sessionId);
      const target = resolveInRoot(root, requested);
      if (!target) {
        return { ok: false, content: `[错误] 路径越界：${requested} 不在会话工作根内（${root}）` };
      }
      // 先看大小再读：读 5MB 再截断会把主进程内存打满（大文件如日志/数据库）
      const stat = await deps.platform.fs.stat(target);
      if (stat.size > FILE_READ_MAX_BYTES) {
        return {
          ok: false,
          content: `[错误] 文件过大：${target} 为 ${stat.size} 字节，超过读取上限 ${FILE_READ_MAX_BYTES} 字节`,
        };
      }
      const text = await deps.platform.fs.readFileUtf8(target);
      const lines = text.split(/\r?\n/);
      const page = lines.slice(offset, offset + limit);
      return { ok: true, content: page.join("\n"), totalLines: lines.length };
    } catch (err) {
      return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handleTrusted(deps, "file:write", async (payload) => {
    const { path: requested, content, sessionId } = payload as {
      path: string;
      content: string;
      sessionId?: string;
    };
    // 按 UTF-8 实际字节数判上限（content.length 是 UTF-16 码元数，中文会被低估）
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > FILE_WRITE_MAX_BYTES) {
      return { ok: false, content: `[错误] 内容超过 5MB 单文件写入上限（${bytes} 字节）` };
    }
    try {
      const root = resolveFileRoot(deps, sessionId);
      const target = resolveInRoot(root, requested);
      if (!target) {
        return { ok: false, content: `[错误] 路径越界：${requested} 不在会话工作根内（${root}）` };
      }
      await deps.platform.fs.writeFileUtf8(target, content);
      return { ok: true, content: `已写入 ${requested}` };
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
