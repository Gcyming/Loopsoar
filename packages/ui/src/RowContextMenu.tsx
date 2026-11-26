/** 管理页行右键菜单：定位、边界收敛、Esc/点空白关闭；条目由页面注入。 */
import * as React from "react";
import { createPortal } from "react-dom";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";

export interface RowMenuItem {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  danger?: boolean;
  hint?: string;
  separatorBefore?: boolean;
  onClick: () => void;
}

export default function RowContextMenu({
  x,
  y,
  items,
  onClose,
  suppressNativeMenu = false,
}: {
  x: number;
  y: number;
  items: RowMenuItem[];
  onClose: () => void;
  /** 主窗口菜单需要抑制主进程原生右键菜单；浮层窗口没有原生菜单，传 false 避免污染全局计数。 */
  suppressNativeMenu?: boolean;
}): React.JSX.Element {
  const api = useLoopsoarApi();
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState({ left: x, top: y });
  const [hover, setHover] = React.useState<string | null>(null);

  // 菜单先量自身尺寸再夹到窗口内，避免贴边时被裁掉。
  React.useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y, items.length]);

  React.useEffect(() => {
    // 菜单打开期间禁止原生右键菜单（主进程 appContextMenu 也会读这个标记）。
    if (suppressNativeMenu) void api?.ui?.setContextMenuSuppressed?.({ suppressed: true }).catch(() => undefined);
    const onContext = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("contextmenu", onContext, true);
    return () => {
      document.removeEventListener("contextmenu", onContext, true);
      if (suppressNativeMenu) void api?.ui?.setContextMenuSuppressed?.({ suppressed: false }).catch(() => undefined);
    };
  }, [api, suppressNativeMenu]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <>
      <div style={styles.backdrop} onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
      <div
        ref={menuRef}
        role="menu"
        style={{ ...styles.menu, left: pos.left, top: pos.top }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onMouseLeave={() => setHover(null)}
      >
        {items.map((item) => (
          <React.Fragment key={item.id}>
            {item.separatorBefore ? <div style={styles.sep} /> : null}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.hint}
              style={{
                ...styles.item,
                ...(hover === item.id && !item.disabled ? styles.itemHover : null),
                ...(item.disabled ? styles.itemDisabled : null),
                ...(item.danger && !item.disabled ? styles.itemDanger : null),
              }}
              onMouseEnter={() => setHover(item.id)}
              onClick={() => {
                if (item.disabled) return;
                item.onClick();
                onClose();
              }}
            >
              {item.icon ? <Icon name={item.icon} size={13} style={styles.icon} /> : <span style={styles.icon} />}
              <span style={styles.label}>{item.label}</span>
            </button>
          </React.Fragment>
        ))}
      </div>
    </>,
    document.body,
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: "fixed", inset: 0, zIndex: 89, background: "transparent" },
  menu: {
    position: "fixed",
    zIndex: 90,
    minWidth: 210,
    maxWidth: 300,
    padding: 6,
    borderRadius: 10,
    border: `1px solid ${BRAND.borderStrong}`,
    background: BRAND.inkRaised,
    boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "7px 9px",
    borderRadius: 7,
    border: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 12.5,
    textAlign: "left",
    cursor: "pointer",
  },
  itemHover: { background: "rgba(255,255,255,0.06)" },
  itemDisabled: { color: BRAND.linenFaint, cursor: "default", opacity: 0.65 },
  itemDanger: { color: "#f87171" },
  icon: { flex: "none", color: "currentColor" },
  label: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  sep: { height: 1, background: BRAND.border, margin: "4px 2px" },
};
