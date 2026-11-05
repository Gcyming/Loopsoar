/**
 * 输入区（Composer）：多行输入 + Build/权限/模型/附件 chip + 模型菜单 + 推理等级 +
 * 单按钮「发送 ↔ 中断」状态机（运行中且输入为空 = 中断，运行中且输入非空 = 转向发送）。
 *
 * 纯展示 + 回调注入：所有业务动作（发送/转向/权限保存/模型切换）由 App 提供；
 * 组件的菜单开合是本地 UI 状态，不进入会话数据。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import type { PermissionsState, ProviderStatus } from "./types.js";
import type { ModelGroup } from "./modelGroups.js";
import { usePopover } from "./popover.js";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import { useT, getLanguage, t } from "./i18n.js";
import Popover from "./AnchoredPopover.js";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  canSend: boolean;
  mode: "build" | "plan";
  onToggleMode: () => void;
  compactUi: boolean;
  squeezeRatio: number;
  boxRef: React.RefObject<HTMLDivElement | null>;
  measureRef: React.RefObject<HTMLDivElement | null>;
  provider: ProviderStatus | null;
  permSummary: PermissionsState | null;
  onPermissionChange: (next: PermissionsState) => void;
  onOpenSettings: (section?: string) => void;
  modelMenuOpen: boolean;
  onOpenModelMenu: () => void;
  onCloseModelMenu: () => void;
  /** 跨供应商模型清单（按供应商分组）；null = 加载中。 */
  modelGroups: ModelGroup[] | null;
  onChooseModel: (modelId: string, providerId: string) => void;
  effortOptions: string[];
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  effortLabel: (value: string) => string;
  permissionLabel: (state: PermissionsState) => string;
  onPickAttachment: () => void;
  notice: string;
  /** 斜杠命令执行入口（App 负责 /new /clear /stop /settings /compact /help 的实际动作）。 */
  onCommand?: (command: string) => void;
  /** 组件内异步操作（粘贴图片/选文件/命令）的提示出口；缺省则静默。 */
  onNotice?: (text: string) => void;
}

const PERMISSION_CATEGORIES = [
  { key: "read", labelKey: "composer.perm.read" },
  { key: "write", labelKey: "composer.perm.write" },
  { key: "terminal", labelKey: "composer.perm.terminal" },
  { key: "network", labelKey: "composer.perm.network" },
] as const;

interface SlashCommand {
  cmd: string;
  descKey: string;
}

/** 本地斜杠命令清单：解析在 Composer，执行交 onCommand（App 接线）。 */
const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/new", descKey: "composer.command.new.desc" },
  { cmd: "/clear", descKey: "composer.command.clear.desc" },
  { cmd: "/stop", descKey: "composer.command.stop.desc" },
  { cmd: "/settings", descKey: "composer.command.settings.desc" },
  { cmd: "/compact", descKey: "composer.command.compact.desc" },
  { cmd: "/help", descKey: "composer.command.help.desc" },
];

/** File → base64（去掉 dataURL 前缀，只留纯 base64 给 fs.saveImage）。 */
function readFileAsBase64(file: File): Promise<string> {
  const readFailed = (): Error => new Error(t(getLanguage(), "composer.imageReadFailed"));
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(readFailed());
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? readFailed());
    reader.readAsDataURL(file);
  });
}

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  canSend,
  mode,
  onToggleMode,
  compactUi,
  squeezeRatio,
  boxRef,
  measureRef,
  provider,
  permSummary,
  onPermissionChange,
  onOpenSettings,
  modelMenuOpen,
  onOpenModelMenu,
  onCloseModelMenu,
  modelGroups,
  onChooseModel,
  effortOptions,
  reasoningEffort,
  onReasoningEffortChange,
  effortLabel,
  permissionLabel,
  onPickAttachment,
  notice,
  onCommand,
  onNotice,
}: ComposerProps): React.ReactElement {
  // 权限/模型菜单互斥：同一时刻只开一个（打开另一个会自动收起）。
  const [openMenu, setOpenMenu] = React.useState<"perm" | "model" | null>(null);
  const permAnchorRef = React.useRef<HTMLSpanElement | null>(null);
  const modelAnchorRef = React.useRef<HTMLSpanElement | null>(null);
  const sendAnchorRef = React.useRef<HTMLButtonElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const api = useLoopsoarApi();
  const tr = useT();
  /** 斜杠命令面板：当前选中项 + 是否被 Esc 手动关闭（继续输入会重新展开）。 */
  const [commandIndex, setCommandIndex] = React.useState(0);
  const [commandDismissed, setCommandDismissed] = React.useState(false);

  // 斜杠命令：仅当输入以 / 开头且尚未出现空格/换行时展开（/new、/settings 等）
  const slashActive = value.startsWith("/") && !/[\s\n]/.test(value);
  const commandQuery = slashActive ? value.slice(1).toLowerCase() : "";
  const commandItems =
    slashActive && !commandDismissed
      ? SLASH_COMMANDS.filter((command) => command.cmd.slice(1).startsWith(commandQuery))
      : [];
  const commandOpen = slashActive && !commandDismissed;
  const activeCommandIndex = commandItems.length === 0 ? 0 : Math.min(commandIndex, commandItems.length - 1);

  usePopover("composer-command", commandOpen, (next) => {
    if (!next) setCommandDismissed(true);
  });

  /** 面板提示出口（App 的 toast）；未接线则静默。 */
  const notify = (text: string): void => {
    onNotice?.(text);
  };

  /** 在光标处插入文本；必要时补换行，插入后恢复焦点与光标。 */
  const insertText = (text: string): void => {
    const el = textareaRef.current;
    const current = el?.value ?? value;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
    const snippet = `${prefix}${text}`;
    onChange(`${before}${snippet}${after}`);
    window.requestAnimationFrame(() => {
      el?.focus();
      const position = before.length + snippet.length;
      el?.setSelectionRange(position, position);
    });
  };

  /** 剪贴板图片：File → base64 → fs.saveImage（主进程限 6MB/图片白名单）→ 插入附件路径。 */
  const savePastedImages = async (files: File[]): Promise<void> => {
    if (!api?.fs?.saveImage) {
      notify(tr("composer.imageUnavailable"));
      return;
    }
    const errors: string[] = [];
    let saved = 0;
    for (const file of files) {
      try {
        const dataBase64 = await readFileAsBase64(file);
        const result = await api.fs.saveImage({
          dataBase64,
          mime: file.type || "image/png",
          ...(file.name ? { name: file.name } : {}),
        });
        if (result.ok && result.path) {
          insertText(tr("composer.insertAttachment", { path: result.path }));
          saved += 1;
        } else {
          errors.push(result.error ?? "unknown error");
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (saved > 0) notify(tr("composer.imageSaved", { count: saved }));
    if (errors.length > 0) notify(tr("composer.imageFailed", { error: errors[0] }));
  };

  /** 粘贴：只接管剪贴板里的图片（普通文本/文件保持默认粘贴行为）。 */
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = event.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length === 0) return;
    event.preventDefault();
    void savePastedImages(files);
  };

  /** @ / Ctrl+U：用主进程文件选择框取路径，插入为附件引用。 */
  const pickFileReference = async (): Promise<void> => {
    if (!api?.dialog?.pickPath) {
      notify(tr("composer.fileUnavailable"));
      return;
    }
    try {
      const result = await api.dialog.pickPath({ kind: "file", title: tr("composer.pickFile") });
      if (result.canceled || !result.path) return;
      insertText(tr("composer.insertAttachment", { path: result.path }));
    } catch {
      notify(tr("composer.fileUnavailable"));
    }
  };

  /** 执行斜杠命令：已知命令交 onCommand；未知/未接线给出提示（不静默吞掉）。 */
  const runCommand = (command: string): void => {
    onChange("");
    setCommandDismissed(true);
    setCommandIndex(0);
    const known = SLASH_COMMANDS.some((item) => item.cmd === command);
    if (!known) {
      notify(tr("composer.unknownCommand", { cmd: command }));
      return;
    }
    if (!onCommand) {
      notify(tr("composer.commandUnwired", { cmd: command }));
      return;
    }
    onCommand(command);
  };

  /** 输入变化统一入口：重置命令面板状态（Esc 关闭后继续输入会重新展开）。 */
  const handleValueChange = (next: string): void => {
    onChange(next);
    setCommandDismissed(false);
    setCommandIndex(0);
  };

  const handleTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const key = event.key;

    if (commandOpen) {
      if (key === "ArrowDown") {
        event.preventDefault();
        if (commandItems.length > 0) setCommandIndex((activeCommandIndex + 1) % commandItems.length);
        return;
      }
      if (key === "ArrowUp") {
        event.preventDefault();
        if (commandItems.length > 0) setCommandIndex((activeCommandIndex - 1 + commandItems.length) % commandItems.length);
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        setCommandDismissed(true);
        return;
      }
      if (key === "Tab") {
        event.preventDefault();
        const chosen = commandItems[activeCommandIndex];
        if (chosen) handleValueChange(`${chosen.cmd} `);
        return;
      }
      if (key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const chosen = commandItems[activeCommandIndex];
        if (chosen) {
          runCommand(chosen.cmd);
          return;
        }
        if (commandQuery.trim() !== "") {
          runCommand(`/${commandQuery.trim()}`);
          return;
        }
        // 只输入了 "/"：按普通消息处理
        setCommandDismissed(true);
      }
    }

    if (key === "@" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      void pickFileReference();
      return;
    }
    if ((key === "u" || key === "U") && (event.ctrlKey || event.metaKey) && !event.altKey) {
      event.preventDefault();
      void pickFileReference();
      return;
    }
    if (key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      requestSend();
    }
  };

  /**
   * 发送入口（Enter 与发送按钮共用）：运行中直接 onSend（App 走 steer 注入，不打断生成）。
   * 「运行中且输入为空」的中断动作由主按钮状态机单独处理（onStop，不经此函数）。
   */
  const requestSend = (): void => {
    if (!value.trim()) return;
    onSend();
  };
  // 主按钮三态：运行中+空输入 = 中断（不禁用）；运行中+有输入 = 转向发送；
  // 非运行中 = 普通发送（无可发送内容时禁用）。
  const interruptMode = busy && value.trim() === "";
  const sendDisabled = !busy && !canSend;
  usePopover("composer-perm", openMenu === "perm", (next) => {
    if (!next) setOpenMenu(null);
  });
  usePopover("composer-model", modelMenuOpen, (next) => {
    if (!next) onCloseModelMenu();
  });
  const openPermissionMenu = (): void => {
    if (!permSummary) return;
    onCloseModelMenu();
    setOpenMenu((prev) => (prev === "perm" ? null : "perm"));
  };
  const openModelMenuSafely = (): void => {
    setOpenMenu(null);
    onOpenModelMenu();
  };
  const adjustPermission = (category: "read" | "write" | "terminal" | "network", value: "allow" | "confirm" | "deny"): void => {
    if (!permSummary) return;
    onPermissionChange({
      ...permSummary,
      permissions: { ...permSummary.permissions, [category]: value },
    });
  };
  return (
    <div style={styles.composer}>
      <div ref={boxRef} style={styles.composerBox} data-squeeze={squeezeRatio.toFixed(2)}>
        <div ref={measureRef} aria-hidden style={styles.measureRow}>
          <span style={styles.measureChip}><Icon name="bolt" size={12} style={{ marginRight: 4 }} />Build</span>
          <span style={styles.measureChip}>
            <Icon name="check" size={12} style={{ marginRight: 4 }} />
            {permSummary ? permissionLabel(permSummary) : tr("composer.permissionFallback")}
          </span>
          <span style={styles.measureChip}>
            <Icon name="cloud-upload" size={12} style={{ marginRight: 4 }} />
            {provider?.configured ? provider.model : tr("composer.modelUnconfigured")}
          </span>
          <span style={styles.measureChip}><Icon name="file" size={12} style={{ marginRight: 4 }} />{tr("composer.attachLabel")}</span>
          <span style={styles.measureChip}>{tr("composer.stop")}</span>
          <span style={styles.measureChip}>{tr("composer.send")}</span>
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => handleValueChange(event.target.value)}
          onKeyDown={handleTextareaKeyDown}
          onPaste={handlePaste}
          placeholder={tr("composer.placeholder")}
          style={styles.textarea}
          rows={3}
          aria-label={tr("composer.placeholder")}
        />
        <div style={styles.chipRow}>
          <button
            type="button"
            className="chip"
            style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}), ...(mode === "build" ? styles.chipActive : {}) }}
            title={tr("composer.modeTip", {
              detail: `${mode === "build" ? tr("composer.modeBuildDetail") : tr("composer.modePlanDetail")}${compactUi ? tr("composer.compactHint") : ""}`,
            })}
            aria-label={mode === "build" ? tr("composer.modeBuildDetail") : tr("composer.modePlanDetail")}
            onClick={onToggleMode}
          >
            <Icon name="bolt" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
            {compactUi ? null : mode === "build" ? "Build" : "Plan"}
          </button>

          <span ref={permAnchorRef} style={styles.anchor} data-popover-trigger>
            <button
              type="button"
              className="chip"
              style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}) }}
              title={`${tr("composer.permChipTitle")}${compactUi ? tr("composer.compactHint") : ""}`}
              aria-label={tr("composer.permChipTitle")}
              onClick={openPermissionMenu}
            >
              <Icon name="check" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
              {compactUi ? null : permSummary ? permissionLabel(permSummary) : tr("composer.permissionFallback")}
            </button>
            <Popover anchorRef={permAnchorRef} open={openMenu === "perm" && Boolean(permSummary)} onClose={() => setOpenMenu(null)} width={260}>
                <div style={styles.modelMenuHead}>{tr("composer.permMenuTitle")}</div>
                {PERMISSION_CATEGORIES.map((category) => (
                  <div key={category.key} style={styles.permRow}>
                    <span style={styles.permCat}>{tr(category.labelKey)}</span>
                    <span style={styles.permSeg}>
                      {(["allow", "confirm", "deny"] as const).map((decision) => (
                        <button
                          key={decision}
                          type="button"
                          className="perm-seg"
                          style={{
                            ...styles.permSegBtn,
                            ...(permSummary?.permissions[category.key] === decision ? styles.permSegBtnOn : {}),
                          }}
                          onClick={() => adjustPermission(category.key, decision)}
                        >
                          {decision === "allow"
                            ? tr("composer.perm.allow")
                            : decision === "confirm"
                              ? tr("composer.perm.confirm")
                              : tr("composer.perm.deny")}
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
                <div
                  role="button"
                  tabIndex={0}
                  className="model-item"
                  style={{ ...styles.modelMenuItem, ...styles.modelMenuFoot }}
                  onClick={() => {
                    setOpenMenu(null);
                    onOpenSettings("permissions");
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setOpenMenu(null);
                    onOpenSettings("permissions");
                  }}
                >
                  {tr("composer.permOpenFull")}
                </div>
              </Popover>
          </span>

          <span ref={modelAnchorRef} style={styles.anchor} data-popover-trigger>
            <button
              type="button"
              className="chip"
              style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}) }}
              title={tr("composer.modelChipTitle", {
                model: `${provider?.configured ? (provider.model ?? "") : tr("composer.modelUnconfigured")}${compactUi ? tr("composer.compactHint") : ""}`,
              })}
              aria-label={tr("composer.modelChipTitle", { model: provider?.configured ? (provider.model ?? "") : tr("composer.modelUnconfigured") })}
              onClick={openModelMenuSafely}
            >
              <Icon name="cloud-upload" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
              {compactUi ? null : provider?.configured ? (provider.model ?? "") : tr("composer.modelUnconfigured")}
            </button>
            <Popover anchorRef={modelAnchorRef} open={modelMenuOpen} onClose={onCloseModelMenu} width={340}>
              <div style={styles.modelMenuHead}>{tr("composer.modelMenuTitle")}</div>
              {modelGroups === null ? (
                <div style={styles.modelMenuItem}>{tr("composer.modelMenuLoading")}</div>
              ) : modelGroups.length === 0 ? (
                <div style={styles.modelMenuItem}>{tr("composer.modelMenuEmpty")}</div>
              ) : (
                modelGroups.map((group) => (
                  <div key={group.providerId} style={styles.modelGroup}>
                    <div style={styles.modelGroupHead}>
                      <span style={styles.modelGroupName}>{group.provider}</span>
                      {group.active ? <span style={styles.modelGroupBadge}>{tr("composer.modelCurrent")}</span> : null}
                      <span style={styles.modelGroupHost} title={group.baseUrl}>
                        {group.baseUrl.replace(/^https?:\/\//, "").slice(0, 28)}
                      </span>
                    </div>
                    {group.models.map((model) => {
                      const current = group.active && model.id === provider?.model;
                      return (
                        <button
                          key={`${group.providerId}-${model.id}`}
                          type="button"
                          className="model-item"
                          style={{ ...styles.modelMenuItem, ...(current ? styles.modelMenuItemActive : {}) }}
                          onClick={() => onChooseModel(model.id, group.providerId)}
                          title={`${group.provider} · ${model.id}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}K` : ""}${model.thinkingEfforts?.length ? ` · ${model.thinkingEfforts.join("/")}` : ""}`}
                        >
                          <span style={styles.modelItemName}>
                            {model.id}
                            {model.thinking ? <span style={styles.modelBadge}>{tr("composer.modelBadge.thinking")}</span> : null}
                            {model.vision ? <span style={styles.modelBadge}>{tr("composer.modelBadge.vision")}</span> : null}
                          </span>
                          {current ? <Icon name="check" size={12} /> : null}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
              {effortOptions.length > 0 ? (
                <div style={styles.effortSection}>
                  <div style={styles.modelMenuHead}>{tr("composer.effortSection")}</div>
                  <div style={styles.effortRow}>
                    {["", ...effortOptions].map((effort) => (
                      <button
                        key={effort || "off"}
                        type="button"
                        className="chip"
                        style={{ ...styles.chip, ...(reasoningEffort === effort ? styles.chipActive : {}) }}
                        onClick={() => onReasoningEffortChange(effort)}
                        title={effort || tr("composer.effortOff")}
                      >
                        {effortLabel(effort).replace(/^(推理：|Reasoning:\s*)/i, "")}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div
                role="button"
                tabIndex={0}
                className="model-item"
                style={{ ...styles.modelMenuItem, ...styles.modelMenuFoot }}
                onClick={() => {
                  onCloseModelMenu();
                  onOpenSettings("providers");
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onCloseModelMenu();
                  onOpenSettings("providers");
                }}
              >
                {tr("composer.modelMenuManage")}
              </div>
            </Popover>
          </span>

          <button
            type="button"
            className="chip"
            style={{ ...styles.chip, ...(compactUi ? styles.chipCompact : {}) }}
            title={tr("composer.attach")}
            aria-label={tr("composer.attach")}
            onClick={onPickAttachment}
          >
            <Icon name="file" size={13} style={compactUi ? undefined : { marginRight: 4 }} />
            {compactUi ? null : tr("composer.attachLabel")}
          </button>
          <span style={styles.spacer} />
          <button
            ref={sendAnchorRef}
            type="button"
            className="send-btn"
            style={{
              ...styles.sendBtn,
              ...(interruptMode ? styles.sendBtnInterrupt : {}),
              opacity: sendDisabled ? 0.45 : 1,
            }}
            onClick={interruptMode ? onStop : requestSend}
            disabled={sendDisabled}
            title={interruptMode ? tr("composer.stop") : busy ? tr("composer.sendSteer") : tr("composer.send")}
            aria-label={interruptMode ? tr("composer.stop") : busy ? tr("composer.sendSteer") : tr("composer.send")}
          >
            <Icon name={interruptMode ? "stop" : "send"} size={15} />
          </button>
        </div>
        {/* 斜杠命令面板：行首 / 触发；键盘上下选择、Enter 执行、Tab 补全、Esc 关闭 */}
        <Popover anchorRef={sendAnchorRef} open={commandOpen} onClose={() => setCommandDismissed(true)} width={300}>
          <div className="command-panel">
            <div className="command-head">
              <span>{tr("composer.commandTitle")}</span>
              <span className="command-count">{commandItems.length}</span>
            </div>
            {commandItems.length === 0 ? (
              <div className="command-empty">{tr("composer.commandEmpty")}</div>
            ) : (
              <div className="command-list" role="listbox" aria-label={tr("composer.commandTitle")}>
                {commandItems.map((command, index) => (
                  <button
                    key={command.cmd}
                    type="button"
                    role="option"
                    aria-selected={index === activeCommandIndex}
                    className={`command-item${index === activeCommandIndex ? " is-active" : ""}`}
                    onMouseEnter={() => setCommandIndex(index)}
                    onClick={() => runCommand(command.cmd)}
                  >
                    <span className="command-cmd">{command.cmd}</span>
                    <span className="command-desc">{tr(command.descKey)}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="command-hint">{tr("composer.commandHint")}</div>
          </div>
        </Popover>
      </div>
      <div style={styles.composerFoot}>
        <span style={styles.notice}>
          {notice || (busy ? tr("composer.generating") : mode === "plan" ? tr("composer.planFoot") : tr("composer.buildFoot"))}
        </span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // 只让「输入框本身」是一个独立色块：外层保持会话栏底色（raised），
  // 卡片下沉到更深的 ink 一档并保留圆角，形成清晰的凹陷输入区，而不是把周围整条涂深。
  composer: { flex: "none", padding: "10px 12px 8px" },
  composerBox: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 10px",
    borderRadius: 14,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
  },
  measureRow: { display: "flex", gap: 6, height: 0, overflow: "hidden", opacity: 0, pointerEvents: "none" },
  measureChip: { display: "inline-flex", alignItems: "center", fontSize: 12, whiteSpace: "nowrap" },
  textarea: {
    resize: "none",
    border: "none",
    outline: "none",
    background: "transparent",
    color: BRAND.linen,
    fontSize: 13,
    lineHeight: 1.6,
    fontFamily: "inherit",
    minHeight: 46,
    maxHeight: 160,
  },
  chipRow: { display: "flex", alignItems: "center", gap: 5, flexWrap: "nowrap" },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 8px",
    borderRadius: 12,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  chipCompact: { width: 24, padding: 0, justifyContent: "center" },
  chipActive: { borderColor: BRAND.ochre, color: BRAND.ochreHover, background: "rgba(var(--ls-accent-rgb, 200, 118, 60),0.10)" },
  anchor: { position: "relative", display: "inline-flex" },
  spacer: { flex: 1 },
  sendBtn: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    border: "none",
    background: BRAND.ochre,
    color: BRAND.ink,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  /** 中断态：运行中且输入为空时，主按钮切换为「停止」动作（红色强调，不禁用）。 */
  sendBtnInterrupt: { background: BRAND.danger },
  composerFoot: { display: "flex", gap: 8, marginTop: 4, fontSize: 10.5, color: BRAND.linenFaint, minHeight: 14 },
  notice: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  modelMenuHead: { fontSize: 10.5, color: BRAND.linenFaint, padding: "2px 4px 6px" },
  permRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "3px 4px" },
  permCat: { fontSize: 11, color: BRAND.linenMuted },
  permSeg: { display: "inline-flex", gap: 2 },
  permSegBtn: {
    padding: "1px 6px",
    borderRadius: 6,
    border: `1px solid ${BRAND.border}`,
    background: "transparent",
    color: BRAND.linenFaint,
    fontSize: 10.5,
    cursor: "pointer",
  },
  permSegBtnOn: { color: BRAND.ochreHover, borderColor: BRAND.ochre, background: "rgba(var(--ls-accent-rgb, 200, 118, 60),0.12)" },
  modelMenuItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "5px 6px",
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: BRAND.linenMuted,
    fontSize: 11.5,
    cursor: "pointer",
    textAlign: "left",
  },
  modelMenuItemActive: { color: BRAND.ochreHover, background: "rgba(var(--ls-accent-rgb, 200, 118, 60),0.10)" },
  modelItemName: { display: "flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  modelBadge: {
    fontSize: 9,
    padding: "0 4px",
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    color: BRAND.linenFaint,
    flexShrink: 0,
  },
  modelMenuErr: { fontSize: 10.5, color: "#f0a35e", padding: "4px 6px" },
  effortSection: { borderTop: `1px solid ${BRAND.border}`, marginTop: 6, paddingTop: 4 },
  effortRow: { display: "flex", gap: 4, flexWrap: "wrap", padding: "0 2px" },
  modelGroup: { borderTop: `1px solid ${BRAND.border}`, padding: "4px 0" },
  modelGroupHead: { display: "flex", alignItems: "center", gap: 6, padding: "3px 6px 4px" },
  modelGroupName: { fontSize: 11, fontWeight: 650, color: BRAND.linen },
  modelGroupBadge: {
    fontSize: 9,
    padding: "0 4px",
    borderRadius: 999,
    color: BRAND.ochreHover,
    border: `1px solid ${BRAND.ochre}`,
  },
  modelGroupHost: { marginLeft: "auto", fontSize: 9.5, color: BRAND.linenFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  modelMenuFoot: {
    width: "100%",
    marginTop: 6,
    paddingTop: 6,
    borderTop: `1px solid ${BRAND.border}`,
    justifyContent: "center",
    textAlign: "center",
    background: "transparent",
    color: BRAND.linenFaint,
  },
};
