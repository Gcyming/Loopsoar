/**
 * 工作区状态所有权（从 App 拆出）。
 *
 * 负责：工作区列表 / 活动工作区 / 工作区面板开合，以及绑定、创建、重命名、删除、
 * 在文件管理器中打开五个动作。App 只保留「创建工作区后进入新会话」这类跨域编排。
 *
 * 约束：所有 API 失败都收敛为 setNotice，不向上抛；调用方无需 try/catch。
 */
import { useCallback, useState } from "react";
import type { LoopsoarAPI, SessionMeta, WorkspaceRecord } from "./types.js";

export interface UseWorkspacesOptions {
  api: LoopsoarAPI | null;
  /** 当前会话 id 的实时 ref：绑定动作要判断「已有会话还是草稿」。 */
  sessionIdRef: { current: string };
  setSessions: (sessions: SessionMeta[]) => void;
  setNotice: (notice: string) => void;
}

export interface WorkspaceActionResult {
  workspaces: WorkspaceRecord[];
  activeId: string | null;
}

export interface CreatedWorkspace {
  id: string;
  name: string;
}

export function useWorkspaces({ api, sessionIdRef, setSessions, setNotice }: UseWorkspacesOptions) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);

  /** 用主进程返回的权威快照覆盖本地状态；undefined 字段保持原值。 */
  const applyWorkspaces = useCallback((next: Partial<WorkspaceActionResult>): void => {
    if (next.workspaces) setWorkspaces(next.workspaces);
    if (next.activeId !== undefined) setActiveWorkspaceId(next.activeId);
  }, []);

  /** 输入框下方工作区选择器：草稿态只设后续活动区；已有会话才绑定。 */
  const bindWorkspaceToCurrentSession = useCallback(
    (workspaceId: string): void => {
      if (!api) return;
      if (!sessionIdRef.current) {
        void api.workspace
          .select({ id: workspaceId })
          .then((r) => {
            if (!r.ok) {
              setNotice(r.error ?? "切换工作区失败");
              return;
            }
            applyWorkspaces(r);
            setNotice("后续新建页/会话将在此工作区进行");
          })
          .catch((err: unknown) => setNotice("切换工作区失败：" + (err instanceof Error ? err.message : String(err))));
        return;
      }
      void api.workspace
        .bindSession({ workspaceId })
        .then((r) => {
          if (!r.ok) {
            setNotice(r.error ?? "切换工作区失败");
            return;
          }
          if (r.sessions) setSessions(r.sessions);
          applyWorkspaces(r);
          setNotice("已切换工作区");
        })
        .catch((err: unknown) => setNotice("切换工作区失败：" + (err instanceof Error ? err.message : String(err))));
    },
    [api, applyWorkspaces, sessionIdRef, setNotice, setSessions],
  );

  /** 原生文件夹选择器 → 挂载并设为当前工作区；取消返回 null。 */
  const createWorkspace = useCallback(async (): Promise<CreatedWorkspace | null> => {
    if (!api) return null;
    try {
      const r = await api.workspace.create({});
      if (!r.ok) {
        // 用户取消文件夹选择不算错误
        if (r.error && !r.error.includes("取消") && !r.error.toLowerCase().includes("cancel")) setNotice(r.error);
        return null;
      }
      applyWorkspaces(r);
      if (r.workspace) return { id: r.workspace.id, name: r.workspace.name };
      // 兼容只返回 activeId 的旧壳层：仍能进入新工作区，只是没有显示名。
      return r.activeId ? { id: r.activeId, name: "" } : null;
    } catch (err) {
      setNotice(`添加工作区失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }, [api, applyWorkspaces, setNotice]);

  const renameWorkspace = useCallback(
    (workspaceId: string, name: string): void => {
      if (!api) return;
      void api.workspace
        .rename({ id: workspaceId, name })
        .then((r) => {
          applyWorkspaces(r);
          setNotice(r.ok ? "工作区已重命名为「" + (r.workspace?.name ?? name) + "」" : (r.error ?? "重命名失败"));
        })
        .catch((err: unknown) => setNotice("重命名失败：" + (err instanceof Error ? err.message : String(err))));
    },
    [api, applyWorkspaces, setNotice],
  );

  /** 删除工作区（后端会拒绝仍有会话绑定的工作区）。 */
  const removeWorkspace = useCallback(
    (workspaceId: string): void => {
      if (!api) return;
      void api.workspace
        .remove({ id: workspaceId })
        .then((r) => {
          applyWorkspaces(r);
          setNotice(r.ok ? "工作区已删除" : (r.error ?? "删除工作区失败"));
        })
        .catch((err: unknown) => setNotice("删除工作区失败：" + (err instanceof Error ? err.message : String(err))));
    },
    [api, applyWorkspaces, setNotice],
  );

  /** 在系统文件管理器中打开工作区根目录。 */
  const openWorkspaceFolder = useCallback(
    (workspaceId: string): void => {
      if (!api) return;
      void api.workspace
        .openFolder({ id: workspaceId })
        .then((r) => {
          if (!r.ok) setNotice(r.error ?? "无法打开文件夹");
        })
        .catch((err: unknown) => setNotice("无法打开文件夹：" + (err instanceof Error ? err.message : String(err))));
    },
    [api, setNotice],
  );

  return {
    workspaces,
    activeWorkspaceId,
    workspacePanelOpen,
    setWorkspacePanelOpen,
    setWorkspaces,
    setActiveWorkspaceId,
    applyWorkspaces,
    bindWorkspaceToCurrentSession,
    createWorkspace,
    renameWorkspace,
    removeWorkspace,
    openWorkspaceFolder,
  };
}
