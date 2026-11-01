/**
 * 会话工作根解析（纯逻辑）：会话 worktree > 会话工作区 > 活动工作区 > 兜底。
 * 目录存在性由调用方注入（便于单测；也避免这里碰 fs）。
 */
export interface SessionRootInput {
  worktreePath?: string | null;
  sessionWorkspaceRoot?: string | null;
  activeWorkspaceRoot?: string | null;
  fallback: string;
  isDirectory?: (dir: string) => boolean;
}

export function resolveSessionRoot(input: SessionRootInput): string {
  const exists = input.isDirectory ?? (() => true);
  if (input.worktreePath && exists(input.worktreePath)) return input.worktreePath;
  if (input.sessionWorkspaceRoot && exists(input.sessionWorkspaceRoot)) return input.sessionWorkspaceRoot;
  if (input.activeWorkspaceRoot && exists(input.activeWorkspaceRoot)) return input.activeWorkspaceRoot;
  return input.fallback;
}
