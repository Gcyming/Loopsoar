/**
 * 新标签页「快捷方式」网格（用户 m04220）。
 *
 * 与旧实现的区别：以前这排图标是**历史记录镜像**（最近 6 条访问），既不可编辑也会随浏览漂移；
 * 现在换成用户主动维护的快捷方式：末尾固定一个「+」磁贴，右键可改名/改址/删除/移到最前，
 * 数据落在 shortcuts.json（最多 24 条），图标抓一次写回，打开新标签页不再联网。
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.js";
import RowContextMenu, { type RowMenuItem } from "./RowContextMenu.js";
import { useT } from "./i18n.js";
import { BRAND, RADIUS } from "./theme.js";
import { hostOf } from "./startPageModel.js";
import type { ShortcutItem } from "./types.js";
import type { ShortcutActions } from "./useShortcuts.js";

export interface ShortcutsGridProps {
  shortcuts: ShortcutActions;
  onOpenUrl: (url: string) => void;
  /** 建议列表（来自历史的常见站点）：添加弹窗里一点即填充。 */
  suggestions: { url: string; title: string }[];
}

interface EditorState {
  /** 编辑已有条目时带 id；新增时为 null。 */
  id: string | null;
  title: string;
  url: string;
}

export default function ShortcutsGrid({ shortcuts, onOpenUrl, suggestions }: ShortcutsGridProps): React.ReactElement {
  const tr = useT();
  const [editor, setEditor] = React.useState<EditorState | null>(null);
  const [error, setError] = React.useState("");
  const [menu, setMenu] = React.useState<{ x: number; y: number; item: ShortcutItem } | null>(null);
  const items = shortcuts.items ?? [];

  const openAdd = (): void => {
    setError("");
    setEditor({ id: null, title: "", url: "" });
  };

  const submit = async (): Promise<void> => {
    if (!editor) return;
    setError("");
    const url = editor.url.trim();
    if (!url) {
      setError(tr("browser.ntp.shortcutUrlRequired"));
      return;
    }
    const result = editor.id
      ? await shortcuts.update(editor.id, { title: editor.title.trim(), url })
      : await shortcuts.add({ url, title: editor.title.trim() || undefined });
    if (!result.ok) {
      setError(result.error ?? tr("browser.ntp.shortcutSaveFailed"));
      return;
    }
    setEditor(null);
  };

  const menuItems = (item: ShortcutItem): RowMenuItem[] => [
    {
      id: "edit",
      label: tr("browser.ntp.shortcutEdit"),
      icon: "edit",
      onClick: () => {
        setError("");
        setEditor({ id: item.id, title: item.title, url: item.url });
      },
    },
    {
      id: "pin",
      label: tr("browser.ntp.shortcutPin"),
      icon: "pin",
      onClick: () => void shortcuts.pin(item.id),
    },
    {
      id: "remove",
      label: tr("browser.ntp.shortcutRemove"),
      icon: "delete",
      danger: true,
      separatorBefore: true,
      onClick: () => void shortcuts.remove(item.id),
    },
  ];

  const dialog =
    editor && typeof document !== "undefined"
      ? createPortal(
          <div style={S.backdrop} onPointerDown={(event) => event.target === event.currentTarget && setEditor(null)}>
            <div style={S.dialog} role="dialog" aria-modal="true" aria-label={editor.id ? tr("browser.ntp.shortcutEditTitle") : tr("browser.ntp.shortcutAddTitle")}>
              <div style={S.dialogHead}>
                <span style={S.dialogTitle}>{editor.id ? tr("browser.ntp.shortcutEditTitle") : tr("browser.ntp.shortcutAddTitle")}</span>
                <button type="button" className="icon-btn" style={S.dialogClose} aria-label={tr("browser.ntp.shortcutCancel")} onClick={() => setEditor(null)}>
                  <Icon name="close" size={13} />
                </button>
              </div>
              <label style={S.fieldLabel} htmlFor="ntp-shortcut-name">{tr("browser.ntp.shortcutName")}</label>
              <input
                id="ntp-shortcut-name"
                value={editor.title}
                onChange={(event) => setEditor({ ...editor, title: event.target.value })}
                placeholder={tr("browser.ntp.shortcutNamePlaceholder")}
                style={S.input}
                autoFocus
              />
              <label style={S.fieldLabel} htmlFor="ntp-shortcut-url">{tr("browser.ntp.shortcutUrl")}</label>
              <input
                id="ntp-shortcut-url"
                value={editor.url}
                onChange={(event) => setEditor({ ...editor, url: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
                placeholder="example.com"
                style={S.input}
                spellCheck={false}
              />
              {error ? <div style={S.error}>{error}</div> : null}
              <div style={S.dialogActions}>
                <button
                  type="button"
                  style={{ ...S.primary, opacity: editor.url.trim() ? 1 : 0.5 }}
                  disabled={!editor.url.trim()}
                  onClick={() => void submit()}
                >
                  {editor.id ? tr("browser.ntp.shortcutSave") : tr("browser.ntp.shortcutAddAction")}
                </button>
                <button type="button" style={S.secondary} onClick={() => setEditor(null)}>
                  {tr("browser.ntp.shortcutCancel")}
                </button>
              </div>
              {editor.id === null && suggestions.length > 0 ? (
                <>
                  <div style={S.suggestTitle}>{tr("browser.ntp.shortcutSuggest")}</div>
                  <div style={S.suggestRow}>
                    {suggestions.slice(0, 6).map((item) => (
                      <button
                        key={item.url}
                        type="button"
                        style={S.suggestItem}
                        title={item.url}
                        onClick={() => setEditor({ ...editor, url: item.url })}
                      >
                        {hostOf(item.url)}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div style={S.grid} aria-label={tr("browser.ntp.quickLinks")}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            style={S.tile}
            title={item.url}
            onClick={() => onOpenUrl(item.url)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenu({ x: event.clientX, y: event.clientY, item });
            }}
          >
            <span style={S.icon}>
              {item.icon ? (
                <img src={item.icon} alt="" width={22} height={22} style={S.favicon} />
              ) : (
                (item.title || hostOf(item.url)).trim().charAt(0).toUpperCase() || "·"
              )}
            </span>
            <span style={S.label}>{item.title || hostOf(item.url)}</span>
          </button>
        ))}
        <button type="button" style={S.tile} title={tr("browser.ntp.shortcutAdd")} onClick={openAdd}>
          <span style={{ ...S.icon, ...S.iconAdd }}>
            <Icon name="plus" size={16} />
          </span>
          <span style={S.label}>{tr("browser.ntp.shortcutAdd")}</span>
        </button>
      </div>
      {menu
        ? createPortal(
            <RowContextMenu
              x={menu.x}
              y={menu.y}
              items={menuItems(menu.item)}
              onClose={() => setMenu(null)}
            />,
            document.body,
          )
        : null}
      {dialog}
    </>
  );
}

const S: Record<string, React.CSSProperties> = {
  grid: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "10px 12px", marginTop: 22, maxWidth: 560 },
  tile: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 7,
    width: 72,
    padding: "6px 2px",
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    cursor: "pointer",
    font: "inherit",
  },
  icon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 40,
    height: 40,
    borderRadius: 11,
    background: "rgba(255,255,255,0.06)",
    border: `1px solid ${BRAND.border}`,
    color: BRAND.linen,
    fontSize: 15,
    fontWeight: 700,
    overflow: "hidden",
  },
  iconAdd: { borderStyle: "dashed", color: BRAND.linenFaint, background: "transparent" },
  favicon: { borderRadius: 5, objectFit: "contain" },
  label: { width: "100%", fontSize: 11, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  backdrop: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.45)",
    zIndex: 80,
  },
  dialog: {
    width: 360,
    maxWidth: "calc(100vw - 32px)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 16,
    borderRadius: RADIUS.md,
    background: BRAND.inkRaised,
    border: `1px solid ${BRAND.borderStrong}`,
    color: BRAND.linen,
  },
  dialogHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  dialogTitle: { fontSize: 13.5, fontWeight: 700 },
  dialogClose: { display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, border: "none", borderRadius: 6, background: "transparent", color: BRAND.linenMuted, cursor: "pointer" },
  fieldLabel: { fontSize: 11, color: BRAND.linenMuted, marginTop: 4 },
  input: {
    height: 32,
    padding: "0 10px",
    borderRadius: RADIUS.sm,
    border: `1px solid ${BRAND.border}`,
    background: "rgba(255,255,255,0.04)",
    color: BRAND.linen,
    font: "inherit",
    outline: "none",
  },
  error: { fontSize: 11.5, color: BRAND.danger },
  dialogActions: { display: "flex", gap: 8, marginTop: 10 },
  primary: {
    flex: 1,
    height: 32,
    borderRadius: 8,
    border: "none",
    background: "rgba(200,118,60,0.22)",
    color: BRAND.ochreHover,
    fontWeight: 700,
    cursor: "pointer",
    font: "inherit",
  },
  secondary: {
    flex: 1,
    height: 32,
    borderRadius: 8,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenMuted,
    cursor: "pointer",
    font: "inherit",
  },
  suggestTitle: { marginTop: 12, fontSize: 11, color: BRAND.linenMuted },
  suggestRow: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 },
  suggestItem: {
    maxWidth: 150,
    padding: "4px 9px",
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11,
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};
