/**
 * 工作区面板：挂载项目文件夹、切换活动工作区、查看 Git 状态，
 * 并为当前会话创建/合并/清理隔离 git worktree。
 *
 * 数据全部经 window.loopsoarAPI（workspace/worktree 域）；组件不直接碰 Node。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { useT } from "./i18n.js";
import type {
  WorkspaceGitStatus,
  WorkspaceRecord,
  WorkspaceStatusResult,
  WorktreeDiff,
  SessionWorktree,
} from "./types.js";

export interface WorkspacePanelProps {
  open: boolean;
  onClose: () => void;
  currentSessionId: string | null;
  currentSessionTitle: string;
  sessionWorkspaceId: string | null;
  onChanged: (notice?: string) => void;
  onNotice: (text: string) => void;
}

function shortPath(root: string): string {
  if (root.length <= 52) return root;
  return `${root.slice(0, 24)}…${root.slice(-24)}`;
}

export default function WorkspacePanel({
  open,
  onClose,
  currentSessionId,
  currentSessionTitle,
  sessionWorkspaceId,
  onChanged,
  onNotice,
}: WorkspacePanelProps): React.ReactElement | null {
  const api = useLoopsoarApi();
  const tr = useT();
  const [workspaces, setWorkspaces] = React.useState<WorkspaceRecord[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<WorkspaceStatusResult | null>(null);
  const [worktree, setWorktree] = React.useState<SessionWorktree | null>(null);
  const [diff, setDiff] = React.useState<WorktreeDiff | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [action, setAction] = React.useState<string>("");

  const refreshWorkspaces = React.useCallback(async (): Promise<void> => {
    if (!api) return;
    const result = await api.workspace.list().catch(() => null);
    if (!result) return;
    setWorkspaces(result.workspaces);
    setActiveId(result.activeId);
    setSelectedId((current) => {
      if (current && result.workspaces.some((item) => item.id === current)) return current;
      return sessionWorkspaceId ?? result.activeId ?? result.workspaces[0]?.id ?? null;
    });
  }, [api, sessionWorkspaceId]);

  const refreshStatus = React.useCallback(
    async (workspaceId: string | null): Promise<void> => {
      if (!api || !workspaceId) {
        setStatus(null);
        return;
      }
      setLoading(true);
      try {
        const result = await api.workspace.status({ id: workspaceId });
        setStatus(result);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  const refreshWorktree = React.useCallback(async (): Promise<void> => {
    if (!api || !currentSessionId) {
      setWorktree(null);
      setDiff(null);
      return;
    }
    const result = await api.worktree.diff({ sessionId: currentSessionId }).catch(() => null);
    if (result?.ok && result.worktree) {
      setWorktree(result.worktree);
      setDiff(result.diff ?? null);
      return;
    }
    const workspaceState = await api.workspace.status(sessionWorkspaceId ? { id: sessionWorkspaceId } : {}).catch(() => null);
    const found = workspaceState?.worktrees?.find((item) => item.sessionId === currentSessionId)?.worktree ?? null;
    setWorktree(found);
    setDiff(null);
  }, [api, currentSessionId, sessionWorkspaceId]);

  React.useEffect(() => {
    if (!open) return;
    void refreshWorkspaces();
  }, [open, refreshWorkspaces]);

  React.useEffect(() => {
    if (!open || !selectedId) return;
    void refreshStatus(selectedId);
  }, [open, selectedId, refreshStatus]);

  React.useEffect(() => {
    if (!open) return;
    void refreshWorktree();
  }, [open, refreshWorktree]);

  if (!open) return null;

  const selected = workspaces.find((item) => item.id === selectedId) ?? null;
  const git: WorkspaceGitStatus | null = status?.git ?? null;
  const sessions = status?.sessions ?? [];

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setAction(label);
    try {
      await fn();
    } finally {
      setAction("");
    }
  };

  const pickFolder = (): void => {
    void run("create", async () => {
      if (!api) return;
      const result = await api.workspace.create({});
      if (!result.ok) {
        if (result.error && !result.error.includes("取消") && !result.error.toLowerCase().includes("cancel")) onNotice(result.error);
        return;
      }
      setWorkspaces(result.workspaces);
      setActiveId(result.activeId);
      if (result.workspace) setSelectedId(result.workspace.id);
      onChanged(tr("workspace.mountSuccess"));
      onNotice(tr("workspace.mounted", { name: result.workspace?.name ?? tr("workspace.title") }));
    });
  };

  const selectWorkspace = (id: string): void => {
    setSelectedId(id);
    void run("select", async () => {
      if (!api) return;
      const result = await api.workspace.select({ id });
      if (!result.ok) {
        onNotice(result.error ?? tr("workspace.switchFailed"));
        return;
      }
      setWorkspaces(result.workspaces);
      setActiveId(result.activeId);
      onChanged();
      onNotice(tr("workspace.setActive"));
    });
  };

  const removeWorkspace = (workspace: WorkspaceRecord): void => {
    if (!api) return;
    if (!window.confirm(tr("workspace.deleteConfirm", { name: workspace.name }))) return;
    void run("remove", async () => {
      const result = await api.workspace.remove({ id: workspace.id });
      if (!result.ok) {
        onNotice(result.error ?? tr("workspace.deleteFailed"));
        return;
      }
      setWorkspaces(result.workspaces);
      setActiveId(result.activeId);
      setSelectedId(result.activeId);
      onChanged(tr("workspace.deleted"));
      onNotice(tr("workspace.deleted"));
    });
  };

  const createWorktree = (): void => {
    if (!api || !currentSessionId) return;
    void run("worktree-create", async () => {
      const result = await api.worktree.create({ sessionId: currentSessionId });
      if (!result.ok) {
        onNotice(result.error ?? tr("workspace.worktreeCreateFailed"));
        return;
      }
      await refreshWorktree();
      await refreshStatus(selectedId);
      onChanged(tr("workspace.worktreeCreated"));
      onNotice(tr("workspace.worktreeCreatedNote"));
    });
  };

  const mergeWorktree = (): void => {
    if (!api || !currentSessionId) return;
    if (!window.confirm(tr("workspace.mergeConfirm"))) return;
    void run("worktree-merge", async () => {
      const result = await api.worktree.merge({ sessionId: currentSessionId });
      if (!result.ok) {
        onNotice(result.error ?? tr("workspace.mergeFailed"));
        return;
      }
      await refreshWorktree();
      await refreshStatus(selectedId);
      onChanged(tr("workspace.mergedNote"));
      onNotice(result.committed ? tr("workspace.mergedCommitted") : tr("workspace.merged"));
    });
  };

  const removeWorktree = (): void => {
    if (!api || !currentSessionId) return;
    if (!window.confirm(tr("workspace.cleanupConfirm"))) return;
    void run("worktree-remove", async () => {
      const result = await api.worktree.remove({ sessionId: currentSessionId, force: true, deleteBranch: true });
      if (!result.ok) {
        onNotice(result.error ?? tr("workspace.cleanupFailed"));
        return;
      }
      setWorktree(null);
      setDiff(null);
      await refreshStatus(selectedId);
      onChanged(tr("workspace.cleanedNote"));
      onNotice(tr("workspace.cleaned"));
    });
  };

  return (
    <div className="modal-overlay" style={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card" style={styles.card} role="dialog" aria-label={tr("workspace.dialogAria")}>
        <div style={styles.header}>
          <Icon name="folder" size={16} style={{ color: BRAND.ochre }} />
          <span style={styles.title}>{tr("workspace.title")}</span>
          <span style={styles.subtitle}>{tr("workspace.subtitle")}</span>
          <button type="button" className="win-btn" title={tr("workspace.close")} style={styles.close} onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.listPane}>
            <div style={styles.listHead}>
              <span>{tr("workspace.title")}</span>
              <button type="button" className="btn-ghost" style={{ ...styles.btn, ...styles.smallBtn }} disabled={Boolean(action)} onClick={pickFolder}>
                {action === "create" ? tr("workspace.picking") : tr("workspace.pickFolder")}
              </button>
            </div>
            <div style={styles.list}>
              {workspaces.map((workspace) => {
                const isSelected = workspace.id === selectedId;
                const isActive = workspace.id === activeId;
                return (
                  <div
                    key={workspace.id}
                    style={{ ...styles.wsRow, ...(isSelected ? styles.wsRowActive : {}) }}
                    onClick={() => selectWorkspace(workspace.id)}
                  >
                    <span style={styles.wsIcon}><Icon name="folder" size={13} /></span>
                    <span style={styles.wsMain}>
                      <span style={styles.wsName} title={workspace.name}>{workspace.name}</span>
                      <span style={styles.wsPath} title={workspace.root}>{shortPath(workspace.root)}</span>
                    </span>
                    {isActive ? <span style={styles.activeBadge}>{tr("workspace.activeBadge")}</span> : null}
                    <button
                      type="button"
                      className="msg-action"
                      title={tr("workspace.deleteTitle")}
                      style={styles.trash}
                      disabled={Boolean(action)}
                      onClick={(event) => {
                        event.stopPropagation();
                        removeWorkspace(workspace);
                      }}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div style={styles.hint}>{tr("workspace.intro")}</div>
          </div>

          <div style={styles.detailPane}>
            {selected ? (
              <>
                <div style={styles.detailTitle}>{selected.name}</div>
                <div style={styles.rootPath} title={selected.root}>{selected.root}</div>
                <div style={styles.statusRow}>
                  {loading || !status ? (
                    <span style={styles.gitChip}>{tr("workspace.gitReading")}</span>
                  ) : git?.isRepo ? (
                    <>
                      <span style={styles.gitChip}>{git.branch ?? "detached"}</span>
                      <span style={styles.gitHead}>@{git.head ?? "?"}</span>
                      <span style={{ ...styles.gitChip, ...(git.dirty ? styles.gitDirty : styles.gitClean) }}>
                        {git.dirty ? tr("workspace.gitDirty", { count: git.changedFiles }) : tr("workspace.gitClean")}
                      </span>
                    </>
                  ) : (
                    <span style={styles.gitChip}>{tr("workspace.gitNotRepo")}</span>
                  )}
                  <button type="button" className="msg-action" title={tr("workspace.refresh")} style={styles.refresh} onClick={() => void refreshStatus(selectedId)}>
                    <Icon name="reload" size={12} />
                  </button>
                </div>
                <div style={styles.sectionHead}>{tr("workspace.sessionsHead", { count: sessions.length })}</div>
                <div style={styles.sessionList}>
                  {sessions.slice(0, 8).map((session) => (
                    <div key={session.id} style={styles.sessionRow}>
                      <span style={{ ...styles.sessionDot, background: session.id === currentSessionId ? BRAND.ochre : "transparent" }} />
                      <span style={styles.sessionTitle} title={session.title}>{session.title}</span>
                      {session.id === currentSessionId ? <span style={styles.currentBadge}>{tr("workspace.currentBadge")}</span> : null}
                    </div>
                  ))}
                  {sessions.length === 0 ? <div style={styles.empty}>{tr("workspace.noSessions")}</div> : null}
                </div>

                <div style={styles.sectionHead}>
                  {tr("workspace.worktreeSection")}
                  {worktree ? <span style={styles.wtBadge}>{worktree.branch}</span> : null}
                </div>
                {!currentSessionId ? (
                  <div style={styles.empty}>{tr("workspace.pickSessionFirst")}</div>
                ) : worktree ? (
                  <div style={styles.wtBox}>
                    <div style={styles.wtPath} title={worktree.path}>{shortPath(worktree.path)}</div>
                    {diff ? (
                      <>
                        <div style={styles.diffSummary}>
                          {tr("workspace.diffSummary", { files: diff.files.length, commits: diff.commits.length })}
                          {diff.dirty ? tr("workspace.diffDirty") : ""}
                        </div>
                        <div style={styles.diffList}>
                          {diff.files.slice(0, 12).map((file) => (
                            <div key={file.path} style={styles.diffRow}>
                              <span style={styles.diffStatus}>{file.status}</span>
                              <span style={styles.diffPath} title={file.path}>{file.path}</span>
                              <span style={styles.diffStat}>+{file.additions} −{file.deletions}</span>
                            </div>
                          ))}
                          {diff.files.length === 0 ? <div style={styles.empty}>{tr("workspace.noFileChanges")}</div> : null}
                        </div>
                      </>
                    ) : <div style={styles.empty}>{tr("workspace.loadingChanges")}</div>}
                    <div style={styles.actions}>
                      <button type="button" className="btn-ghost" style={styles.btn} disabled={Boolean(action)} onClick={() => void refreshWorktree()}>{tr("workspace.refresh")}</button>
                      <button type="button" className="btn-primary" style={styles.btnPrimary} disabled={Boolean(action)} onClick={mergeWorktree}>
                        {action === "worktree-merge" ? tr("workspace.merging") : tr("workspace.mergeIntoMain")}
                      </button>
                      <button type="button" className="btn-ghost" style={styles.btn} disabled={Boolean(action)} onClick={removeWorktree}>
                        {action === "worktree-remove" ? tr("workspace.cleaning") : tr("workspace.cleanupWorktree")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={styles.wtBox}>
                    <div style={styles.wtEmptyText}>
                      {tr("workspace.worktreeIntro")}{" "}
                      {tr("workspace.worktreeSessionNote", { title: currentSessionTitle || tr("workspace.currentSession") })}
                    </div>
                    <div style={styles.actions}>
                      <button
                        type="button"
                        className="btn-primary"
                        style={styles.btnPrimary}
                        disabled={Boolean(action) || !git?.isRepo}
                        title={git?.isRepo ? undefined : tr("workspace.notGitTitle")}
                        onClick={createWorktree}
                      >
                        {action === "worktree-create" ? tr("workspace.creating") : tr("workspace.createWorktree")}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={styles.empty}>{tr("workspace.selectWorkspace")}</div>
            )}
          </div>
        </div>
        {loading ? <div style={styles.loading}>{tr("workspace.loadingStatus")}</div> : null}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1200,
    background: "rgba(2, 4, 8, 0.72)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    width: 880,
    maxWidth: "94vw",
    height: 620,
    maxHeight: "88vh",
    background: BRAND.ink,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 14,
    boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 14px",
    borderBottom: `1px solid ${BRAND.border}`,
  },
  title: { fontSize: 13, fontWeight: 700, color: BRAND.linen },
  subtitle: { fontSize: 11, color: BRAND.linenFaint, flex: 1 },
  close: { width: 26, height: 26, background: "transparent", border: "none", color: BRAND.linenMuted, cursor: "pointer" },
  body: { flex: 1, minHeight: 0, display: "flex" },
  listPane: {
    width: 292,
    flexShrink: 0,
    borderRight: `1px solid ${BRAND.border}`,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    padding: "10px 10px 8px",
  },
  listHead: { display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, fontWeight: 700, color: BRAND.linenMuted, marginBottom: 8 },
  smallBtn: { fontSize: 11, padding: "3px 8px" },
  btn: {
    padding: "5px 12px",
    borderRadius: 7,
    border: `1px solid ${BRAND.border}`,
    background: "rgba(255,255,255,0.035)",
    color: BRAND.linenMuted,
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  btnPrimary: {
    padding: "5px 13px",
    borderRadius: 7,
    border: "1px solid transparent",
    background: BRAND.ochre,
    color: BRAND.ink,
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  list: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 },
  wsRow: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "7px 8px",
    borderRadius: 8,
    cursor: "pointer",
    border: "1px solid transparent",
  },
  wsRowActive: { background: "rgba(var(--ls-accent-rgb, 200, 118, 60),0.12)", borderColor: "rgba(var(--ls-accent-rgb, 200, 118, 60),0.35)" },
  wsIcon: { color: BRAND.ochre, display: "inline-flex", flexShrink: 0 },
  wsMain: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 },
  wsName: { fontSize: 12, fontWeight: 600, color: BRAND.linen, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  wsPath: { fontSize: 10, color: BRAND.linenFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  activeBadge: { fontSize: 9.5, color: BRAND.ochre, border: `1px solid rgba(var(--ls-accent-rgb, 200, 118, 60),0.45)`, borderRadius: 8, padding: "0 5px", flexShrink: 0 },
  trash: { padding: 2, flexShrink: 0, color: BRAND.linenFaint },
  hint: { fontSize: 10, lineHeight: 1.6, color: BRAND.linenFaint, marginTop: 6, padding: "6px 4px 0", borderTop: `1px solid ${BRAND.border}` },
  detailPane: { flex: 1, minWidth: 0, overflowY: "auto", padding: "12px 16px" },
  detailTitle: { fontSize: 14, fontWeight: 700, color: BRAND.linen },
  rootPath: { fontSize: 10.5, color: BRAND.linenFaint, marginTop: 2, wordBreak: "break-all" },
  statusRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 8 },
  gitChip: { fontSize: 10.5, padding: "2px 7px", borderRadius: 8, background: "rgba(255,255,255,0.05)", color: BRAND.linenMuted },
  gitHead: { fontSize: 10.5, color: BRAND.linenFaint },
  gitDirty: { color: "#e6b35c", background: "rgba(230,179,92,0.12)" },
  gitClean: { color: "#7fbf8f", background: "rgba(127,191,143,0.12)" },
  refresh: { marginLeft: "auto", padding: 2 },
  sectionHead: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: BRAND.linenMuted, marginTop: 16, marginBottom: 6 },
  sessionList: { display: "flex", flexDirection: "column", gap: 2 },
  sessionRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: BRAND.linenMuted, padding: "3px 0" },
  sessionDot: { width: 5, height: 5, borderRadius: "50%", flexShrink: 0 },
  sessionTitle: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  currentBadge: { fontSize: 9.5, color: BRAND.ochre },
  empty: { fontSize: 11, color: BRAND.linenFaint, padding: "4px 0" },
  wtBadge: { fontSize: 9.5, fontWeight: 400, color: BRAND.ochre, border: `1px solid rgba(var(--ls-accent-rgb, 200, 118, 60),0.35)`, borderRadius: 8, padding: "0 5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  wtBox: { border: `1px solid ${BRAND.border}`, borderRadius: 9, padding: 10, background: "rgba(255,255,255,0.015)" },
  wtPath: { fontSize: 10.5, color: BRAND.linenFaint, wordBreak: "break-all" },
  wtEmptyText: { fontSize: 11.5, lineHeight: 1.7, color: BRAND.linenMuted },
  diffSummary: { fontSize: 11, color: BRAND.linenMuted, marginTop: 6 },
  diffList: { display: "flex", flexDirection: "column", gap: 2, marginTop: 5, maxHeight: 170, overflowY: "auto" },
  diffRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 10.5 },
  diffStatus: { width: 52, color: BRAND.linenFaint, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis" },
  diffPath: { flex: 1, minWidth: 0, color: BRAND.linenMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  diffStat: { color: "#7fbf8f", flexShrink: 0 },
  actions: { display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10 },
  loading: { padding: "6px 14px", fontSize: 10.5, color: BRAND.linenFaint, borderTop: `1px solid ${BRAND.border}` },
};
