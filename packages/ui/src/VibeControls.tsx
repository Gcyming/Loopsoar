/** Vibecoding 控制条：模型、推理等级、build/plan、工作区与附件。 */
import * as React from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import { usePopover } from "./popover.js";
import { styles } from "./startPageStyles.js";
import type { ModelGroup } from "./modelGroups.js";
import type { WorkspaceRecord } from "./types.js";

function VibeModelChip({
  modelLabel,
  modelGroups,
  onChooseModel,
  compact,
}: {
  modelLabel: string;
  modelGroups: ModelGroup[] | null;
  onChooseModel: (modelId: string, providerId: string) => void;
  compact?: boolean;
}): React.JSX.Element {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  /** 胶囊在视口里的位置：菜单用 fixed + portal 挂到 body，彻底脱离页面内的层叠上下文。 */
  const [anchor, setAnchor] = React.useState<{ left: number; bottom: number } | null>(null);
  const chipRef = React.useRef<HTMLButtonElement | null>(null);
  usePopover("vibe-model-chip", open, setOpen);

  const toggleMenu = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 320;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setAnchor({ left, bottom: window.innerHeight - rect.top + 8 });
    setOpen(true);
  };
  return (
    <span style={styles.modelChipWrap}>
      <button
        ref={chipRef}
        type="button"
        style={{ ...styles.controlChip, ...(compact ? styles.controlChipCompact : null) }}
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tr("browser.ntp.modelChipTitle", { model: modelLabel })}
        data-testid="vibe-model-chip"
        data-popover-trigger
      >
        <Icon name="bolt" size={11} style={styles.modelChipIcon} />
        <span style={styles.controlChipText}>{modelLabel}</span>
      </button>
      {open && anchor && typeof document !== "undefined"
        ? createPortal(
        <div
          style={{ ...styles.modelMenu, position: "fixed", left: anchor.left, bottom: anchor.bottom, zIndex: 1000 }}
          data-popover
          data-vibe-model-menu
          role="menu"
        >
          {modelGroups === null ? (
            <div style={styles.modelMenuNote}>{tr("browser.ntp.modelLoading")}</div>
          ) : modelGroups.length === 0 ? (
            <div style={styles.modelMenuNote}>{tr("browser.ntp.modelEmpty")}</div>
          ) : (
            modelGroups.map((group) => (
              <div key={group.providerId} style={styles.modelGroup}>
                <div style={styles.modelGroupHead}>
                  <span>{group.provider}</span>
                  {group.plan ? <span style={styles.modelGroupPlan}>{group.plan === "go" ? "Go" : "Zen"}</span> : null}
                </div>
                {group.models.map((model) => (
                  <button
                    key={`${group.providerId}:${model.id}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={false}
                    style={styles.modelItem}
                    onClick={() => {
                      onChooseModel(model.id, group.providerId);
                      setOpen(false);
                    }}
                  >
                    {model.id}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>,
        document.body,
      )
        : null}
    </span>
  );
}


/* ───────────────────────────── Vibecoding 控制条 ───────────────────────────── */

export interface VibeControlsProps {
  modelLabel: string;
  modelGroups: ModelGroup[] | null;
  onChooseModel: (modelId: string, providerId: string) => void;
  effortOptions: string[];
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  effortLabel: (value: string) => string;
  chatBuildMode: "build" | "plan";
  onToggleBuildMode: () => void;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  /** 选择附件后插入当前输入草稿。 */
  onAttach: () => void;
  /** 会话级「浏览器控制」开关（关闭时 browser_* 工具对模型不可见）。 */
  browserControl: boolean;
  onToggleBrowserControl: () => void;
  /** 工作区「更多」：打开详细工作区面板（WorkspacePanel）。 */
  onOpenWorkspacePanel?: () => void;
  compact?: boolean;
}

interface MenuAnchor {
  left: number;
  /** 向上展开：距视口底部的距离（菜单贴住触发器上方）。 */
  bottom?: number;
  /** 向下展开：菜单顶部位置（贴住触发器下方）。 */
  top?: number;
}

/** 浮层菜单锚点：固定在触发器上方、夹在视口内（与模型菜单同款，避免被页内层叠上下文影响）。 */
function useFloatingMenu(width: number, direction: "up" | "down" = "up"): {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  anchor: MenuAnchor | null;
  open: boolean;
  toggle: () => void;
  close: () => void;
} {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = React.useState<MenuAnchor | null>(null);
  const [open, setOpen] = React.useState(false);
  const close = (): void => {
    setOpen(false);
    setAnchor(null);
  };
  const toggle = (): void => {
    if (open) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setAnchor(
      direction === "down"
        ? { left, top: rect.bottom + 8 }
        : { left, bottom: window.innerHeight - rect.top + 8 },
    );
    setOpen(true);
  };
  return { triggerRef, anchor, open, toggle, close };
}

function FloatingMenu({
  anchor,
  width,
  children,
}: {
  anchor: MenuAnchor | null;
  width: number;
  children: React.ReactNode;
}): React.ReactElement | null {
  if (!anchor || typeof document === "undefined") return null;
  const downStyle =
    anchor.top !== undefined
      ? { top: anchor.top, maxHeight: Math.max(120, window.innerHeight - anchor.top - 12), overflowY: "auto" as const }
      : { bottom: anchor.bottom };
  return createPortal(
    <div data-popover role="menu" style={{ ...styles.floatingMenu, left: anchor.left, ...downStyle, width }}>
      {children}
    </div>,
    document.body,
  );
}

export function VibeControls(props: VibeControlsProps): React.JSX.Element {
  return (
    <span style={styles.controls} data-testid="vibe-controls">
      <PlusControl {...props} />
      <VibeModelChip modelLabel={props.modelLabel} modelGroups={props.modelGroups} onChooseModel={props.onChooseModel} compact={props.compact} />
      {props.effortOptions.length > 0 ? <EffortControl {...props} /> : null}
      <ModeControl chatBuildMode={props.chatBuildMode} onToggleBuildMode={props.onToggleBuildMode} compact={props.compact} />
    </span>
  );
}

/** 输入框下方的工作区选择按钮（Vibecoding 页）：展开已有工作区 + 最下面「添加工作区」。 */
export function VibeWorkspacePicker({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onOpenWorkspacePanel,
}: Pick<VibeControlsProps, "workspaces" | "activeWorkspaceId" | "onSelectWorkspace" | "onAddWorkspace" | "onOpenWorkspacePanel">): React.JSX.Element {
  const tr = useT();
  const menu = useFloatingMenu(240, "down");
  usePopover("vibe-workspace-picker", menu.open, (next) => {
    if (!next) menu.close();
  });
  const active = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  return (
    <span style={styles.menuWrap}>
      <button
        ref={menu.triggerRef}
        type="button"
        style={styles.workspacePickChip}
        data-popover-trigger
        title={active ? tr("browser.vibe.workspaceCurrent", { name: active.name }) : tr("browser.vibe.workspaceChoose")}
        aria-label={tr("browser.vibe.workspaceChoose")}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        data-testid="vibe-workspace-picker"
      >
        <Icon name="folder" size={11} style={{ marginRight: 4 }} />
        <span style={styles.workspacePickText}>{active ? active.name : tr("browser.vibe.workspaceChoose")}</span>
        <Icon name="chevron-down" size={10} style={{ marginLeft: 3, opacity: 0.65 }} />
      </button>
      {menu.open ? (
        <FloatingMenu anchor={menu.anchor} width={240}>
          <div style={styles.menuTitle}>{tr("browser.vibe.workspaceMenuTitle")}</div>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              style={styles.menuItem}
              title={workspace.root}
              onClick={() => {
                onSelectWorkspace(workspace.id);
                menu.close();
              }}
            >
              <Icon name={workspace.id === activeWorkspaceId ? "check" : "folder"} size={12} style={styles.menuItemIcon} />
              <span style={styles.menuItemText}>{workspace.name}</span>
            </button>
          ))}
          <div style={styles.menuDivider} />
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              menu.close();
              onAddWorkspace();
            }}
            data-testid="vibe-workspace-picker-add"
          >
            <Icon name="workspace-add" size={12} style={styles.menuItemIcon} />
            <span style={styles.menuItemText}>{tr("chat.addWorkspace")}</span>
          </button>
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              menu.close();
              onOpenWorkspacePanel?.();
            }}
            data-testid="vibe-workspace-picker-more"
          >
            <Icon name="more" size={12} style={styles.menuItemIcon} />
            <span style={styles.menuItemText}>{tr("browser.vibe.workspaceMore")}</span>
          </button>
        </FloatingMenu>
      ) : null}
    </span>
  );
}

/**
 * 圆形「+」：与右侧会话输入区同款（Composer.plusBtn）；菜单 = 工作区（切换/选择文件夹）
 * + 更多操作（附件、会话级「浏览器控制」开关）。附件不再是独立按钮，统一折叠进这里。
 */
function PlusControl({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onAttach,
}: VibeControlsProps): React.JSX.Element {
  const tr = useT();
  const menu = useFloatingMenu(240);
  usePopover("vibe-workspace-menu", menu.open, (next) => {
    if (!next) menu.close();
  });
  const active = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  return (
    <span style={styles.menuWrap}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="composer-plus vibe-plus"
        style={styles.vibePlusBtn}
        data-popover-trigger
        title={active ? tr("browser.vibe.workspaceCurrent", { name: active.name }) : tr("browser.vibe.workspaceChoose")}
        aria-label={tr("browser.vibe.workspaceChoose")}
        onClick={menu.toggle}
        data-testid="vibe-plus"
      >
        <Icon name="plus" size={14} />
      </button>
      {menu.open ? (
        <FloatingMenu anchor={menu.anchor} width={240}>
          <div style={styles.menuTitle}>{tr("browser.vibe.workspaceMenuTitle")}</div>
          {workspaces.length === 0 ? <div style={styles.menuEmpty}>{tr("browser.vibe.workspaceEmpty")}</div> : null}
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              style={styles.menuItem}
              title={workspace.root}
              onClick={() => {
                onSelectWorkspace(workspace.id);
                menu.close();
              }}
            >
              <Icon name={workspace.id === activeWorkspaceId ? "check" : "folder"} size={12} style={styles.menuItemIcon} />
              <span style={styles.menuItemText}>{workspace.name}</span>
            </button>
          ))}
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              menu.close();
              onAddWorkspace();
            }}
            data-testid="vibe-workspace-add"
          >
            <Icon name="folder" size={12} style={styles.menuItemIcon} />
            <span style={styles.menuItemText}>{tr("browser.vibe.workspaceAdd")}</span>
          </button>
          <div style={styles.menuDivider} />
          <div style={styles.menuTitle}>{tr("composer.moreActions")}</div>
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              menu.close();
              onAttach();
            }}
            data-testid="vibe-attach"
          >
            <Icon name="paperclip" size={12} style={styles.menuItemIcon} />
            <span style={styles.menuItemText}>{tr("composer.attachLabel")}</span>
          </button>
        </FloatingMenu>
      ) : null}
    </span>
  );
}
function EffortControl({
  effortOptions,
  reasoningEffort,
  onReasoningEffortChange,
  effortLabel,
  compact,
}: VibeControlsProps): React.JSX.Element {
  const tr = useT();
  const menu = useFloatingMenu(180);
  usePopover("vibe-effort-menu", menu.open, (next) => {
    if (!next) menu.close();
  });
  return (
    <span style={styles.menuWrap}>
      <button
        ref={menu.triggerRef}
        type="button"
        style={{ ...styles.controlChip, ...(compact ? styles.controlChipCompact : null) }}
        data-popover-trigger
        title={tr("browser.vibe.effortTitle")}
        onClick={menu.toggle}
        data-testid="vibe-effort-chip"
      >
        <Icon name="bolt" size={11} />
        <span style={styles.controlChipText}>{effortLabel(reasoningEffort)}</span>
      </button>
      {menu.open ? (
        <FloatingMenu anchor={menu.anchor} width={180}>
          <div style={styles.menuTitle}>{tr("browser.vibe.effortMenuTitle")}</div>
          <button
            type="button"
            style={styles.menuItem}
            onClick={() => {
              onReasoningEffortChange("");
              menu.close();
            }}
          >
            <Icon name={reasoningEffort === "" ? "check" : "circle"} size={11} style={styles.menuItemIcon} />
            <span style={styles.menuItemText}>{effortLabel("")}</span>
          </button>
          {effortOptions.map((value) => (
            <button
              key={value}
              type="button"
              style={styles.menuItem}
              onClick={() => {
                onReasoningEffortChange(value);
                menu.close();
              }}
            >
              <Icon name={reasoningEffort === value ? "check" : "circle"} size={11} style={styles.menuItemIcon} />
              <span style={styles.menuItemText}>{effortLabel(value)}</span>
            </button>
          ))}
        </FloatingMenu>
      ) : null}
    </span>
  );
}

function ModeControl({
  chatBuildMode,
  onToggleBuildMode,
  compact,
}: {
  chatBuildMode: "build" | "plan";
  onToggleBuildMode: () => void;
  compact?: boolean;
}): React.JSX.Element {
  const tr = useT();
  const isPlan = chatBuildMode === "plan";
  return (
    <button
      type="button"
      style={{ ...styles.controlChip, ...(compact ? styles.controlChipCompact : null) }}
      title={tr("browser.vibe.modeTitle", { mode: isPlan ? tr("browser.vibe.modePlan") : tr("browser.vibe.modeBuild") })}
      onClick={onToggleBuildMode}
      data-testid="vibe-mode-chip"
    >
      <Icon name={isPlan ? "notes" : "bolt"} size={11} />
      <span style={styles.controlChipText}>{isPlan ? tr("browser.vibe.modePlan") : tr("browser.vibe.modeBuild")}</span>
    </button>
  );
}
