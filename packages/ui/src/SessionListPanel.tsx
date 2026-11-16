/**
 * 会话列表面板（右侧栏 / Vibecoding 内嵌）。
 *
 * 结构与交互（用户 m05281 对标 EDGE/VS Code 类会话面板）：
 *   · 顶部搜索框（标题相关度排序，精确优先）；
 *   · 工作区 → 会话两层树；工作区箭头展开/收起（向下/向右旋转 160ms）；
 *   · 工作区标题行悬浮显示「更多 / 添加会话」；更多菜单 = 重命名 / 在文件夹显示 / 删除工作区；
 *   · 会话行悬浮显示「更多 / 置顶 / 删除」；更多菜单 = 置顶切换 / 复制会话 ID / 删除会话；
 *   · 置顶会话排在组内最前（localStorage 持久化），置顶项标题前显示 pin 图标；
 *   · 底部「新建会话」。纯展示；全部动作由 App 注入。
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import { usePopover } from "./popover.js";
import type { SessionMeta, WorkspaceRecord } from "./types.js";
import { sessionMatchScore } from "./sessionSearch.js";

export interface SessionListPanelProps {
  sessions: SessionMeta[];
  workspaces: WorkspaceRecord[];
  currentSession: string | null;
  onSwitchSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  /** 重命名 / 分叉（App 负责调 chat 域并刷新列表）。 */
  onRenameSession?: (sessionId: string, title: string) => void;
  onForkSession?: (sessionId: string, keepCount: number) => void;
  onNewSession: () => void;
  /** 在某工作区下新建会话（先切换工作区再建）。 */
  onNewSessionInWorkspace?: (workspaceId: string) => void;
  /** 工作区操作（App 负责调 workspace 域并刷新 state）。 */
  onRenameWorkspace?: (workspaceId: string, name: string) => void;
  onRemoveWorkspace?: (workspaceId: string) => void;
  onOpenWorkspaceFolder?: (workspaceId: string) => void;
  /** 操作反馈（可选；App 通常注入 setNotice）。 */
  onNotice?: (text: string) => void;
  /** 添加工作区（原生文件夹选择器；App 注入）。 */
  onAddWorkspace?: () => void;
  /** 内嵌右侧栏（Vibecoding 会话列表）：占满高度、隐藏内部标题/不抢焦点。 */
  inline?: boolean;
}

/** 相对时间（参考浏览器会话面板：刚刚/x 分钟前/x 小时前/x 天前，超过 30 天显示日期）。 */
function formatTime(at: number): string {
  if (!at || !Number.isFinite(at)) return "";
  const diff = Date.now() - at;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  try {
    return new Date(at).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  } catch {
    return "";
  }
}

const PINNED_KEY = "loopsoar.pinned-sessions";

function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writePinned(ids: string[]): void {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {
    // 本地存储不可用：置顶只在本组件生命周期内生效
  }
}

type RowMenu =
  | { kind: "workspace"; id: string; left: number; top: number }
  | { kind: "session"; id: string; left: number; top: number };

export default function SessionListPanel({
  sessions,
  workspaces,
  currentSession,
  onSwitchSession,
  onDeleteSession,
  onRenameSession,
  onForkSession,
  onNewSession,
  onNewSessionInWorkspace,
  onRenameWorkspace,
  onRemoveWorkspace,
  onOpenWorkspaceFolder,
  onNotice,
  onAddWorkspace,
  inline = false,
}: SessionListPanelProps): React.ReactElement {
  const tr = useT();
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [pinned, setPinned] = React.useState<string[]>(readPinned);
  const [menu, setMenu] = React.useState<RowMenu | null>(null);
  const [renaming, setRenaming] = React.useState<{ id: string; value: string } | null>(null);
  const [renamingSession, setRenamingSession] = React.useState<{ id: string; value: string } | null>(null);

  // 会话列表本身在 `app-session` 浮层里；再用 usePopover 登记会 claim 掉父浮层，
  // 父浮层关闭 → 本组件卸载 → 菜单瞬间消失。这里用本地 outside-click，不抢父浮层。
  React.useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-popover],[data-popover-trigger]")) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onPointerDown as unknown as (event: MouseEvent) => void, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onPointerDown as unknown as (event: MouseEvent) => void, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  const togglePin = (id: string): void => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      writePinned(next);
      return next;
    });
  };

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>, kind: "workspace" | "session", id: string): void => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = kind === "workspace" ? 180 : 190;
    setMenu({
      kind,
      id,
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      top: Math.min(rect.bottom + 4, window.innerHeight - 200),
    });
  };

  const search = query.trim();
  const ranked = React.useMemo(() => {
    if (!search) return [];
    return sessions
      .map((session) => ({ session, score: sessionMatchScore(session, search) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt)
      .map((item) => item.session);
  }, [sessions, search]);

  /** 组内排序：置顶会话最前，其余按更新时间倒序。 */
  const sortSessions = (items: SessionMeta[]): SessionMeta[] =>
    [...items].sort((a, b) => {
      const pa = pinned.includes(a.id) ? 1 : 0;
      const pb = pinned.includes(b.id) ? 1 : 0;
      return pb - pa || b.updatedAt - a.updatedAt;
    });

  // 按工作区分组：工作区顺序沿用 App 的顺序，未归属会话放最后一组。
  const groups = React.useMemo(() => {
    const known = new Set(workspaces.map((workspace) => workspace.id));
    const order = workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }));
    const ungrouped = sessions.filter((session) => !session.workspaceId || !known.has(session.workspaceId));
    if (ungrouped.length > 0 || order.length === 0) order.push({ id: "__none", name: tr("chat.sessionWorkspaceOther") });
    return order.map((workspace) => ({
      ...workspace,
      sessions: sortSessions(
        sessions.filter((session) =>
          workspace.id === "__none" ? !session.workspaceId || !known.has(session.workspaceId) : session.workspaceId === workspace.id,
        ),
      ),
    }));
    // pinned 参与排序
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, workspaces, tr, pinned]);

  const toggleWorkspace = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const commitRename = (): void => {
    if (!renaming) return;
    const name = renaming.value.trim();
    if (name) onRenameWorkspace?.(renaming.id, name);
    setRenaming(null);
  };

  const commitSessionRename = (): void => {
    if (!renamingSession) return;
    const name = renamingSession.value.trim();
    if (name) onRenameSession?.(renamingSession.id, name);
    setRenamingSession(null);
  };

  const sessionRow = (session: SessionMeta): React.ReactElement => {
    const isPinned = pinned.includes(session.id);
    const isActive = session.id === currentSession;
    return (
      <div key={session.id} style={{ ...styles.row, ...(isActive ? styles.rowActive : {}) }} className="session-item-row" role="treeitem" aria-selected={isActive} data-testid="session-item-row">
        <button
          type="button"
          style={styles.item}
          onClick={() => onSwitchSession(session.id)}
          title={session.preview}
          data-testid="session-item"
        >
          {isPinned ? <Icon name="pin" size={11} style={styles.pinMark} /> : null}
          {session.task ? (
            <span className="session-task-badge" title={tr("chat.taskSession")}>
              <Icon name="layers-linked" size={9} />
              {tr("chat.taskSessionLabel")}
            </span>
          ) : null}
          {session.forkedFrom ? (
            <span className="session-fork-badge" title={tr("chat.forkSession")}>
              {tr("chat.forkSessionLabel")}
            </span>
          ) : null}
          {renamingSession?.id === session.id ? (
            <input
              value={renamingSession.value}
              onChange={(event) => setRenamingSession({ id: session.id, value: event.target.value })}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitSessionRename();
                if (event.key === "Escape") setRenamingSession(null);
              }}
              onBlur={commitSessionRename}
              style={styles.inlineRename}
              autoFocus
            />
          ) : (
            <span style={styles.itemTitle}>{session.title}</span>
          )}
        </button>
        <span className="session-item-time" style={styles.itemTime}>{formatTime(session.updatedAt)}</span>
        <span className="session-row-actions" style={styles.rowActions}>
          <button type="button" className="icon-btn" style={styles.rowActionBtn} title={tr("chat.sessionMenu")} onClick={(event) => openMenu(event, "session", session.id)}
            data-testid="session-more">
            <Icon name="more" size={13} />
          </button>
          <button
            type="button"
            className="icon-btn"
            style={{ ...styles.rowActionBtn, ...(isPinned ? styles.rowActionOn : null) }}
            title={isPinned ? tr("chat.unpinSession") : tr("chat.pinSession")}
            onClick={(event) => {
              event.stopPropagation();
              togglePin(session.id);
            }}
            data-testid="session-pin"
          >
            <Icon name="pin" size={12} />
          </button>
          <button
            type="button"
            className="icon-btn"
            style={styles.rowActionBtn}
            title={tr("chat.deleteSession")}
            onClick={(event) => {
              event.stopPropagation();
              onDeleteSession(session.id);
            }}
            data-testid="session-delete"
          >
            <Icon name="delete" size={12} />
          </button>
        </span>
      </div>
    );
  };

  return (
    <div style={{ ...styles.root, ...(inline ? styles.rootInline : null) }} data-testid="session-list-panel">
      {inline ? null : (
        <div style={styles.head}>
          <span style={styles.title}>
            <Icon name="list-details" size={13} style={{ marginRight: 6 }} />
            {tr("chat.sessionListTitle")}
          </span>
          <span style={styles.count}>{sessions.length}</span>
        </div>
      )}
      <div style={styles.searchRow}>
        <Icon name="search" size={12} style={styles.searchIcon} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr("chat.sessionSearchPlaceholder")}
          aria-label={tr("chat.sessionSearchPlaceholder")}
          style={styles.searchInput}
          data-testid="session-search"
          autoFocus={!inline}
        />
      </div>

      {onAddWorkspace ? (
        <button type="button" className="session-add-workspace" style={styles.addWorkspace} onClick={onAddWorkspace} data-testid="workspace-add">
          <Icon name="workspace-add" size={13} />
          <span>{tr("chat.addWorkspace")}</span>
        </button>
      ) : null}

      <div style={styles.list} role="tree" aria-label={tr("chat.sessionListTitle")}>
        {sessions.length === 0 ? <div style={styles.empty}>{tr("chat.noSessions")}</div> : null}
        {search ? (
          ranked.length === 0 ? (
            <div style={styles.empty}>{tr("chat.sessionNoMatch")}</div>
          ) : (
            ranked.map((session) => sessionRow(session))
          )
        ) : (
          groups.map((group) => {
            const open = !collapsed.has(group.id);
            const canManage = group.id !== "__none";
            const isRenaming = renaming?.id === group.id;
            return (
              <div key={group.id} style={styles.group} role="group">
                <div style={styles.groupRow} className="session-workspace-row" data-testid="session-workspace-row">
                  <button
                    type="button"
                    style={styles.groupHead}
                    onClick={() => toggleWorkspace(group.id)}
                    aria-expanded={open}
                    title={group.name}
                    data-testid="session-workspace-head"
                  >
                    <Icon
                      name="chevron-down"
                      size={12}
                      style={{ ...styles.groupChevron, transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
                    />
                    {isRenaming ? (
                      <input
                        style={styles.renameInput}
                        value={renaming.value}
                        autoFocus
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setRenaming({ id: group.id, value: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitRename();
                          if (event.key === "Escape") setRenaming(null);
                        }}
                        onBlur={commitRename}
                        aria-label={tr("chat.renameWorkspace")}
                      />
                    ) : (
                      <span style={styles.groupName}>{group.name}</span>
                    )}
                  </button>
                  <span className="session-group-count" style={styles.groupCount}>{group.sessions.length}</span>
                  <span className="session-row-actions" style={styles.rowActions}>
                    {canManage ? (
                      <>
                        <button
                          type="button"
                          className="icon-btn"
                          style={styles.rowActionBtn}
                          title={tr("chat.workspaceMenu")}
                          onClick={(event) => openMenu(event, "workspace", group.id)}
                          data-testid="workspace-more"
                        >
                          <Icon name="more" size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          style={styles.rowActionBtn}
                          title={tr("chat.addSessionInWorkspace")}
                          onClick={(event) => {
                            event.stopPropagation();
                            onNewSessionInWorkspace?.(group.id);
                          }}
                          data-testid="workspace-add-session"
                        >
                          <Icon name="plus" size={13} />
                        </button>
                      </>
                    ) : null}
                  </span>
                </div>
                {open
                  ? group.sessions.map((session) => sessionRow(session))
                  : null}
              </div>
            );
          })
        )}
      </div>

      <button type="button" style={styles.newBtn} onClick={onNewSession} data-testid="session-new">
        <Icon name="plus" size={12} style={{ marginRight: 6 }} />
        {tr("chat.newSession")}
      </button>

      {menu && typeof document !== "undefined"
        ? createPortal(
            <div
              data-popover
              role="menu"
              style={{ ...styles.menu, left: menu.left, top: menu.top }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {menu.kind === "workspace" ? (
                <>
                  <button
                    type="button"
                    style={styles.menuItem}
                    onClick={() => {
                      const workspace = groups.find((item) => item.id === menu.id);
                      setRenaming({ id: menu.id, value: workspace?.name ?? "" });
                      setMenu(null);
                    }}
                  >
                    <Icon name="edit" size={12} style={styles.menuIcon} />
                    <span>{tr("chat.renameWorkspace")}</span>
                  </button>
                  <button
                    type="button"
                    style={styles.menuItem}
                    onClick={() => {
                      onOpenWorkspaceFolder?.(menu.id);
                      setMenu(null);
                    }}
                  >
                    <Icon name="folder" size={12} style={styles.menuIcon} />
                    <span>{tr("chat.revealWorkspace")}</span>
                  </button>
                  <div style={styles.menuDivider} />
                  <button
                    type="button"
                    style={{ ...styles.menuItem, ...styles.menuItemDanger }}
                    onClick={() => {
                      onRemoveWorkspace?.(menu.id);
                      setMenu(null);
                    }}
                  >
                    <Icon name="delete" size={12} style={styles.menuIcon} />
                    <span>{tr("chat.removeWorkspace")}</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    style={styles.menuItem}
                    onClick={() => {
                      togglePin(menu.id);
                      setMenu(null);
                    }}
                  >
                    <Icon name="pin" size={12} style={styles.menuIcon} />
                    <span>{pinned.includes(menu.id) ? tr("chat.unpinSession") : tr("chat.pinSession")}</span>
                  </button>
                  <button
                    type="button"
                    style={styles.menuItem}
                    onClick={() => {
                      const session = sessions.find((item) => item.id === menu.id);
                      setRenamingSession({ id: menu.id, value: session?.title ?? "" });
                      setMenu(null);
                    }}
                  >
                    <Icon name="edit" size={12} style={styles.menuIcon} />
                    <span>{tr("chat.renameSession")}</span>
                  </button>
                  <button
                    type="button"
                    style={styles.menuItem}
                    onClick={() => {
                      const session = sessions.find((item) => item.id === menu.id);
                      onForkSession?.(menu.id, session?.messageCount ?? 0);
                      setMenu(null);
                    }}
                  >
                    <Icon name="layers-linked" size={12} style={styles.menuIcon} />
                    <span>{tr("chat.forkSessionMenu")}</span>
                  </button>
                  <button
                    type="button"
                    style={styles.menuItem}
                    onClick={() => {
                      onSwitchSession(menu.id);
                      setMenu(null);
                    }}
                  >
                    <Icon name="arrow-go" size={12} style={styles.menuIcon} />
                    <span>{tr("chat.openInApp")}</span>
                  </button>
                  <button
                    type="button"
                    style={styles.menuItem}
                    onClick={() => {
                      void navigator.clipboard?.writeText(menu.id).catch(() => undefined);
                      onNotice?.(tr("chat.sessionIdCopied"));
                      setMenu(null);
                    }}
                  >
                    <Icon name="copy" size={12} style={styles.menuIcon} />
                    <span>{tr("chat.copySessionId")}</span>
                  </button>
                  <div style={styles.menuDivider} />
                  <button
                    type="button"
                    style={{ ...styles.menuItem, ...styles.menuItemDanger }}
                    onClick={() => {
                      onDeleteSession(menu.id);
                      setMenu(null);
                    }}
                  >
                    <Icon name="delete" size={12} style={styles.menuIcon} />
                    <span>{tr("chat.deleteSession")}</span>
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", minHeight: 0, maxHeight: 460, gap: 6 },
  rootInline: { flex: 1, maxHeight: "none", height: "100%", gap: 8 },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px 0" },
  title: { display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: BRAND.linenMuted },
  count: { fontSize: 10, color: BRAND.linenFaint },
  addWorkspace: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    padding: "0 8px",
    border: `1px dashed ${BRAND.border}`,
    borderRadius: 6,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    flex: "none",
  },
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    padding: "0 8px",
    borderRadius: 8,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    boxSizing: "border-box",
  },
  searchIcon: { color: BRAND.linenFaint, flex: "none" },
  searchInput: { flex: 1, minWidth: 0, height: "100%", border: "none", outline: "none", background: "transparent", color: BRAND.linen, fontSize: 11.5 },
  list: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1, paddingRight: 2 },
  empty: { padding: "14px 8px", fontSize: 11.5, color: BRAND.linenFaint },
  group: { display: "flex", flexDirection: "column", gap: 1, marginBottom: 2 },
  groupRow: { position: "relative", display: "flex", alignItems: "center", gap: 2, borderRadius: 6 },
  groupHead: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flex: 1,
    minWidth: 0,
    padding: "5px 5px 4px",
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    textAlign: "left",
  },
  groupChevron: { color: BRAND.linenFaint, flex: "none", transition: "transform 160ms ease" },
  groupName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  row: { position: "relative", display: "flex", alignItems: "center", gap: 6, borderRadius: 7, padding: "0 8px 2px 0", boxSizing: "border-box" },
  rowActive: { background: "rgba(200,118,60,0.14)" },
  item: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
    padding: "4px 6px 6px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    textAlign: "left",
  },
  itemNested: { paddingLeft: 22 },
  itemActive: { color: BRAND.ochreHover },
  itemTitle: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 },
  inlineRename: { flex: 1, minWidth: 0, border: `1px solid ${BRAND.border}`, borderRadius: 4, background: BRAND.inkPanel, color: BRAND.linen, fontSize: 11.5, padding: "2px 4px", outline: "none" },
  itemTime: { flex: "none", marginLeft: "auto", fontSize: 9.5, color: BRAND.linenFaint, whiteSpace: "nowrap", transition: "opacity 120ms ease" },
  pinMark: { flex: "none", color: BRAND.ochreHover },
  /** 悬浮操作：默认透明且不可点，行 hover 时淡入（CSS 见 index.html 的 .session-item-row/.session-workspace-row）。 */
  /** 悬浮操作与时间/数量共用右侧同一位置：绝对定位覆盖，默认透明，hover 时互斥切换。 */
  rowActions: { position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", display: "inline-flex", alignItems: "center", gap: 1, flex: "none", padding: "0 2px", borderRadius: 6 },
  groupCount: { flex: "none", marginRight: 10, fontSize: 9.5, color: BRAND.linenFaint, transition: "opacity 120ms ease" },
  rowActionBtn: { width: 22, height: 22, flex: "none", borderRadius: 6 },
  rowActionOn: { color: BRAND.ochreHover },
  newBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 28,
    borderRadius: 8,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    flexShrink: 0,
  },
  menu: {
    position: "fixed",
    zIndex: 1100,
    width: 190,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: 6,
    borderRadius: 12,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
    animation: "fadeUp 120ms ease both",
  },
  menuItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "6px 8px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 12,
    cursor: "pointer",
    textAlign: "left",
  },
  menuItemDanger: { color: "#f87171" },
  menuIcon: { flex: "none", color: BRAND.linenFaint },
  menuDivider: { height: 1, margin: "4px 2px", background: BRAND.border },
  renameInput: {
    flex: 1,
    minWidth: 0,
    height: 22,
    padding: "0 6px",
    borderRadius: 5,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.ink,
    color: BRAND.linen,
    fontSize: 12,
    outline: "none",
  },
};
