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
import type { PermissionsState, ProviderStatus, WorkspaceRecord } from "./types.js";
import type { ModelGroup } from "./modelGroups.js";
import { formatContextWindow, supportsImageInput } from "./modelGroups.js";
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
  /** 会话级「浏览器控制」开关：关闭（默认）时 browser_* 工具对模型不可见。 */
  browserControl: boolean;
  /** 切换「浏览器控制」（App 落库到会话；草稿态先记待落库标志）。 */
  onToggleBrowserControl: () => void;
  /** 斜杠命令执行入口（App 负责 /new /clear /stop /settings /compact /help 的实际动作）。 */
  onCommand?: (command: string) => void;
  /** 扩展贡献命令：选中后把 prompt 填进输入框（不直接发送、不执行扩展代码）。 */
  onExtensionCommand?: (prompt: string) => void;
  /** 组件内异步操作（粘贴图片/选文件/命令）的提示出口；缺省则静默。 */
  onNotice?: (text: string) => void;
  /** 工作区选择（输入框下方可展开按钮）：已有工作区 + 添加工作区。 */
  workspaces?: WorkspaceRecord[];
  activeWorkspaceId?: string | null;
  onSelectWorkspace?: (workspaceId: string) => void;
  onAddWorkspace?: () => void;
}

const PERMISSION_CATEGORIES = [
  { key: "read", labelKey: "composer.perm.read" },
  { key: "write", labelKey: "composer.perm.write" },
  { key: "terminal", labelKey: "composer.perm.terminal" },
  { key: "browser", labelKey: "composer.perm.browser" },
  { key: "network", labelKey: "composer.perm.network" },
] as const;

interface SlashCommand {
  cmd: string;
  descKey?: string;
  description?: string;
  prompt?: string;
  extensionId?: string;
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

function Composer({
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
  browserControl,
  onToggleBrowserControl,
  onCommand,
  onExtensionCommand,
  onNotice,
  workspaces = [],
  activeWorkspaceId = null,
  onSelectWorkspace,
  onAddWorkspace,
}: ComposerProps): React.ReactElement {
  // 输入区左下角「+」菜单 / 权限菜单 / 模型菜单互斥：同一时刻只开一个。
  const [openMenu, setOpenMenu] = React.useState<"plus" | "perm" | "model" | null>(null);
  const permAnchorRef = React.useRef<HTMLSpanElement | null>(null);
  const modelAnchorRef = React.useRef<HTMLSpanElement | null>(null);
  const plusAnchorRef = React.useRef<HTMLSpanElement | null>(null);
  const sendAnchorRef = React.useRef<HTMLButtonElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const api = useLoopsoarApi();
  const tr = useT();
  /** 斜杠命令面板：当前选中项 + 是否被 Esc 手动关闭（继续输入会重新展开）。 */
  const [commandIndex, setCommandIndex] = React.useState(0);
  const [commandDismissed, setCommandDismissed] = React.useState(false);
  /** 运行控制条：暂停态 + 「暂停期间是否有改动」表单（复位条件：busy=false / 重新发送）。 */
  const [paused, setPaused] = React.useState(false);
  const [pauseBusy, setPauseBusy] = React.useState(false);
  const [resumeDraft, setResumeDraft] = React.useState("");

  // 流结束（正常完成/停止/出错）后控制条必须收起，避免「已暂停」挂在空会话上。
  React.useEffect(() => {
    if (!busy) {
      setPaused(false);
      setResumeDraft("");
    }
  }, [busy]);
  /** 扩展贡献的提示词命令：只填输入框，用户可改；启停扩展后自动刷新。 */
  const [extensionCommands, setExtensionCommands] = React.useState<SlashCommand[]>([]);

  React.useEffect(() => {
    let alive = true;
    const load = (): void => {
      if (!api?.extensions?.list) return;
      void api.extensions
        .list()
        .then((result) => {
          if (!alive) return;
          const commands = result.extensions
            .filter((extension) => extension.enabled)
            .flatMap((extension) =>
              (extension.manifest.contributes?.commands ?? [])
                .filter((command) => command.prompt.trim())
                .map((command) => ({
                  cmd: `/${extension.manifest.id}.${command.id}`,
                  description: `${command.title} · ${extension.manifest.name}`,
                  prompt: command.prompt,
                  extensionId: extension.manifest.id,
                })),
            );
          setExtensionCommands(commands);
        })
        .catch(() => {
          if (alive) setExtensionCommands([]);
        });
    };
    load();
    let off: (() => void) | undefined;
    try {
      off = api?.on("extensions:updated", load);
    } catch {
      off = undefined;
    }
    return () => {
      alive = false;
      off?.();
    };
  }, [api]);

  // 斜杠命令：仅当输入以 / 开头且尚未出现空格/换行时展开（/new、/settings 等）
  const slashActive = value.startsWith("/") && !/[\s\n]/.test(value);
  const commandQuery = slashActive ? value.slice(1).toLowerCase() : "";
  const allCommands = React.useMemo(
    () => [...SLASH_COMMANDS, ...extensionCommands],
    [extensionCommands],
  );
  const commandItems =
    slashActive && !commandDismissed
      ? allCommands.filter((command) => command.cmd.slice(1).startsWith(commandQuery))
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
    // 剪贴板可能同时带文字与图片（从网页/文档复制图文）：两者都要保留。
    // 旧实现 preventDefault 后只保存图片，文字被静默丢掉。
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    if (text.trim()) insertText(text);
    void savePastedImages(files);
  };

  /** Ctrl+U：用主进程文件选择框取路径，插入为附件引用（@ 不再作为快捷键，避免打不出字）。 */
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
    const selected = allCommands.find((item) => item.cmd === command);
    if (!selected) {
      notify(tr("composer.unknownCommand", { cmd: command }));
      return;
    }
    if (selected.prompt !== undefined) {
      if (!onExtensionCommand) {
        notify(tr("composer.commandUnwired", { cmd: command }));
        return;
      }
      onExtensionCommand(selected.prompt);
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
    // 中文输入法：isComposing 覆盖绝大多数情况；部分 IME（微软拼音）在「回车选词」时会补发
    // 一次 isComposing=false 的 Enter keydown，keyCode 229 是这类合成键的通用判据。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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

    // 注意：不要把可打印字符 @ 注册成快捷键——那会让邮箱/提及/命令行参数全部打不出来
    // （用户可感知：按 @ 就弹系统文件框，取消后 @ 也没上屏）。取文件只保留 Ctrl+U 与「+」菜单。
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
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const workspaceAnchorRef = React.useRef<HTMLSpanElement | null>(null);
  usePopover("composer-workspace", workspaceOpen, (next) => {
    if (!next) setWorkspaceOpen(false);
  });
  const activeWorkspaceName =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? tr("chat.workspaceFallback");

  usePopover("composer-plus", openMenu === "plus", (next) => {
    if (!next) setOpenMenu(null);
  });
  /** 左下角「+」：圆形框格（附件 + 会话级「浏览器控制」开关）；后续新增项统一收进这里。 */
  const openPlusMenu = (): void => {
    onCloseModelMenu();
    setOpenMenu((prev) => (prev === "plus" ? null : "plus"));
  };
  const openPermissionMenu = (): void => {
    if (!permSummary) return;
    onCloseModelMenu();
    setOpenMenu((prev) => (prev === "perm" ? null : "perm"));
  };
  const openModelMenuSafely = (): void => {
    setOpenMenu(null);
    onOpenModelMenu();
  };
  const adjustPermission = (category: "read" | "write" | "terminal" | "network" | "browser", value: "allow" | "confirm" | "deny"): void => {
    if (!permSummary) return;
    onPermissionChange({
      ...permSummary,
      permissions: { ...permSummary.permissions, [category]: value },
    });
  };

  /** 暂停：只在下一次工具边界生效；返回 false（流已结束）时不进入暂停态。 */
  const requestPause = async (): Promise<void> => {
    if (!api || pauseBusy) return;
    setPauseBusy(true);
    try {
      const result = await api.chat.pause({});
      if (result.paused) setPaused(true);
      else onNotice?.(result.error ?? tr("composer.pauseUnavailable"));
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setPauseBusy(false);
    }
  };

  /** 恢复：无改动 → 直接放行；有改动 → 先 steer 再放行（注入下一轮）。 */
  const requestResume = async (change?: string): Promise<void> => {
    if (!api || pauseBusy) return;
    const text = change?.trim();
    setPauseBusy(true);
    try {
      const result = await api.chat.resume(text ? { change: text } : {});
      if (result.resumed) {
        setPaused(false);
        setResumeDraft("");
        onNotice?.(text ? tr("composer.resumeChanged") : tr("composer.resumePlain"));
      } else {
        onNotice?.(result.error ?? tr("composer.resumeUnavailable"));
      }
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setPauseBusy(false);
    }
  };

  return (
    <div style={styles.composer}>
      {busy ? (
        <div style={styles.runBar} data-testid="composer-run-bar">
          <div style={styles.runBarHead}>
            <span style={{ ...styles.runDot, ...(paused ? styles.runDotPaused : {}) }} aria-hidden />
            <span style={styles.runLabel}>
              {paused ? tr("composer.paused") : tr("composer.running")}
            </span>
            <span style={styles.runHint}>
              {paused ? tr("composer.pausedHint") : tr("composer.runningHint")}
            </span>
            <span style={{ flex: 1 }} />
            {paused ? (
              <button
                type="button"
                className="run-action run-action-primary"
                style={styles.runActionPrimary}
                disabled={pauseBusy}
                onClick={() => void requestResume()}
              >
                {tr("composer.noChanges")}
              </button>
            ) : (
              <button
                type="button"
                className="run-action"
                style={styles.runAction}
                disabled={pauseBusy}
                onClick={() => void requestPause()}
              >
                {tr("composer.pause")}
              </button>
            )}
            <button
              type="button"
              className="run-action run-action-danger"
              style={styles.runActionDanger}
              onClick={onStop}
            >
              {tr("composer.terminate")}
            </button>
          </div>
          {paused ? (
            <div style={styles.resumePanel}>
              <div style={styles.resumeQuestion}>{tr("composer.resumeQuestion")}</div>
              <textarea
                style={styles.resumeInput}
                rows={2}
                value={resumeDraft}
                placeholder={tr("composer.resumePlaceholder")}
                onChange={(event) => setResumeDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void requestResume(resumeDraft);
                  }
                }}
              />
              <div style={styles.resumeActions}>
                <span style={styles.resumeHint}>{tr("composer.resumeSendHint")}</span>
                <button
                  type="button"
                  className="run-action run-action-primary"
                  style={styles.runActionPrimary}
                  disabled={pauseBusy || resumeDraft.trim() === ""}
                  onClick={() => void requestResume(resumeDraft)}
                >
                  {tr("composer.resumeWithChanges")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
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
          {/* 左下角圆形「+」：附件等入口收进这里（用户 2026-11-10：先放「附件」） */}
          <span ref={plusAnchorRef} style={styles.anchor} data-popover-trigger>
            <button
              type="button"
              className="composer-plus"
              style={styles.plusBtn}
              title={tr("composer.moreActions")}
              aria-label={tr("composer.moreActions")}
              aria-haspopup="menu"
              aria-expanded={openMenu === "plus"}
              onClick={openPlusMenu}
            >
              <Icon name="plus" size={14} />
            </button>
            <Popover anchorRef={plusAnchorRef} open={openMenu === "plus"} onClose={() => setOpenMenu(null)} width={200}>
              <div style={styles.modelMenuHead}>{tr("composer.moreActions")}</div>
              <button
                type="button"
                className="model-item"
                style={styles.modelMenuItem}
                onClick={() => {
                  setOpenMenu(null);
                  onPickAttachment();
                }}
              >
                <span style={styles.modelItemName}>
                  <Icon name="file" size={14} style={{ marginRight: 8 }} />
                  {tr("composer.attachLabel")}
                </span>
              </button>
            </Popover>
          </span>

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
              {modelGroups === null ? (
                <div style={styles.modelMenuItem}>{tr("composer.modelMenuLoading")}</div>
              ) : modelGroups.length === 0 ? (
                <div style={styles.modelMenuItem}>{tr("composer.modelMenuEmpty")}</div>
              ) : (
                modelGroups.map((group) => (
                  <div key={group.providerId} style={styles.modelGroup}>
                    <div style={styles.modelGroupHead}>
                      <span style={styles.modelGroupName}>{group.provider}</span>
                      {group.plan ? (
                        <span style={styles.modelGroupBadge}>
                          {tr(group.plan === "go" ? "composer.modelPlanGo" : "composer.modelPlanPayg")}
                        </span>
                      ) : null}
                      {group.active ? <span style={styles.modelGroupBadge}>{tr("composer.modelCurrent")}</span> : null}
                      <span style={styles.modelGroupHost} title={group.baseUrl}>
                        {group.baseUrl.replace(/^https?:\/\//, "").slice(0, 28)}
                      </span>
                    </div>
                    {group.models.map((model) => {
                      const current = group.active && model.id === provider?.model;
                      // 紧凑能力提示：上下文窗口（1M/131K）+ 图片输入徽标；无值不渲染，避免菜单变宽。
                      const contextLabel = formatContextWindow(model.contextWindow);
                      const imageInput = supportsImageInput(model.vision, model.inputModalities);
                      return (
                        <button
                          key={`${group.providerId}-${model.id}`}
                          type="button"
                          className="model-item"
                          style={{ ...styles.modelMenuItem, ...(current ? styles.modelMenuItemActive : {}) }}
                          onClick={() => onChooseModel(model.id, group.providerId)}
                          title={`${group.provider} · ${model.id}${contextLabel ? ` · ${contextLabel}` : ""}${imageInput ? ` · ${tr("composer.modelBadge.image")}` : ""}${model.thinkingEfforts?.length ? ` · ${model.thinkingEfforts.join("/")}` : ""}`}
                        >
                          <span style={styles.modelItemName}>
                            {model.id}
                            {contextLabel ? <span style={styles.modelHint}>{contextLabel}</span> : null}
                            {model.thinking ? <span style={styles.modelBadge}>{tr("composer.modelBadge.thinking")}</span> : null}
                            {imageInput ? <span style={styles.modelBadge}>{tr("composer.modelBadge.image")}</span> : null}
                          </span>
                          {current ? <Icon name="check" size={12} /> : null}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
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
            title={interruptMode ? tr("composer.stop") : busy ? tr("composer.queueSend") : tr("composer.send")}
            aria-label={interruptMode ? tr("composer.stop") : busy ? tr("composer.queueSend") : tr("composer.send")}
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
                    <span className="command-desc">{command.descKey ? tr(command.descKey) : command.description ?? ""}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="command-hint">{tr("composer.commandHint")}</div>
          </div>
        </Popover>
      </div>
      {/* 输入框下方：工作区选择（可展开；已有工作区 + 添加工作区） */}
      <div style={styles.workspaceRow}>
        <span ref={workspaceAnchorRef} data-popover-trigger style={styles.anchor}>
          <button
            type="button"
            style={styles.workspaceChip}
            title={tr("chat.workspaceTitle")}
            aria-haspopup="menu"
            aria-expanded={workspaceOpen}
            data-testid="composer-workspace"
            onClick={() => setWorkspaceOpen((value) => !value)}
          >
            <Icon name="folder" size={11} style={{ marginRight: 4 }} />
            <span style={styles.workspaceChipText}>{activeWorkspaceName}</span>
            <Icon name="chevron-down" size={10} style={{ marginLeft: 3, opacity: 0.65 }} />
          </button>
        </span>
        <Popover anchorRef={workspaceAnchorRef} open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} width={240}>
          <div style={styles.modelMenuHead}>{tr("chat.workspaceTitle")}</div>
          <div style={styles.workspaceList}>
            {workspaces.length === 0 ? <div style={styles.workspaceEmpty}>{tr("chat.workspaceFallback")}</div> : null}
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                style={styles.workspaceItem}
                onClick={() => {
                  onSelectWorkspace?.(workspace.id);
                  setWorkspaceOpen(false);
                }}
              >
                <Icon name="folder" size={12} style={{ marginRight: 6 }} />
                <span style={styles.workspaceItemName}>{workspace.name}</span>
                {workspace.id === activeWorkspaceId ? <Icon name="check" size={12} /> : null}
              </button>
            ))}
          </div>
          <div style={styles.workspaceDivider} />
          <button
            type="button"
            style={styles.workspaceAdd}
            data-testid="composer-workspace-add"
            onClick={() => {
              onAddWorkspace?.();
              setWorkspaceOpen(false);
            }}
          >
            <Icon name="workspace-add" size={13} style={{ marginRight: 6 }} />
            {tr("chat.addWorkspace")}
          </button>
        </Popover>
        {/* 会话级「浏览器控制」开关：与工作区选择同一行、位于其右侧；开启时品牌色高亮 */}
        <button
          type="button"
          style={{ ...(browserControl ? styles.browserChip : styles.browserChipOff), cursor: "pointer" }}
          title={tr("composer.browserControlHint")}
          aria-pressed={browserControl}
          aria-label={browserControl ? tr("composer.browserControlOn") : tr("composer.browserControl")}
          data-testid="composer-browser-chip"
          onClick={onToggleBrowserControl}
        >
          <Icon name="globe" size={11} style={{ marginRight: 4 }} />
          {tr("composer.browserControl")}
        </button>
      </div>
    </div>
  );
}

/** 只比较非函数 props：输入/运行态/模型等变化才重渲染，流式 token 不再带着 1200 行输入区一起跑。 */
function composerPropsEqual(prev: ComposerProps, next: ComposerProps): boolean {
  for (const key of Object.keys(prev) as (keyof ComposerProps)[]) {
    if (typeof prev[key] === "function") continue;
    if (prev[key] !== next[key]) return false;
  }
  return true;
}

export default React.memo(Composer, composerPropsEqual);

const styles: Record<string, React.CSSProperties> = {
  // 只让「输入框本身」是一个独立色块：外层保持会话栏底色（raised），
  // 卡片下沉到更深的 ink 一档并保留圆角，形成清晰的凹陷输入区，而不是把周围整条涂深。
  composer: { flex: "none", padding: "10px 12px 8px" },
  runBar: {
    marginBottom: 8,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 10,
    background: BRAND.inkPanel,
    padding: "8px 10px",
  },
  runBarHead: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  runDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: BRAND.teal,
    boxShadow: `0 0 8px ${BRAND.teal}`,
    flexShrink: 0,
  },
  runDotPaused: { background: BRAND.ochre, boxShadow: `0 0 8px ${BRAND.ochre}` },
  runLabel: { fontSize: 11.5, fontWeight: 700, color: BRAND.linen, flexShrink: 0 },
  runHint: {
    fontSize: 10.5,
    color: BRAND.linenFaint,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  runAction: {
    border: `1px solid ${BRAND.borderStrong}`,
    background: "transparent",
    color: BRAND.linenMuted,
    borderRadius: 7,
    padding: "3px 10px",
    fontSize: 11.5,
    cursor: "pointer",
    flexShrink: 0,
  },
  runActionPrimary: {
    border: `1px solid ${BRAND.ochre}`,
    background: BRAND.ochreSoft,
    color: BRAND.ochreHover,
    borderRadius: 7,
    padding: "3px 10px",
    fontSize: 11.5,
    fontWeight: 700,
    cursor: "pointer",
    flexShrink: 0,
  },
  runActionDanger: {
    border: `1px solid ${BRAND.danger}`,
    background: BRAND.dangerSoft,
    color: BRAND.danger,
    borderRadius: 7,
    padding: "3px 10px",
    fontSize: 11.5,
    fontWeight: 700,
    cursor: "pointer",
    flexShrink: 0,
  },
  resumePanel: {
    marginTop: 8,
    paddingTop: 8,
    borderTop: `1px solid ${BRAND.border}`,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  resumeQuestion: { fontSize: 11.5, color: BRAND.linen, fontWeight: 600 },
  resumeInput: {
    width: "100%",
    boxSizing: "border-box",
    resize: "vertical",
    borderRadius: 7,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.ink,
    color: BRAND.linen,
    fontSize: 12,
    padding: 7,
    outline: "none",
  },
  resumeActions: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  resumeHint: { fontSize: 10, color: BRAND.linenFaint },
  workspaceRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 6, minWidth: 0 },
  workspaceChip: {
    maxWidth: 240,
    height: 26,
    padding: "0 10px",
    fontSize: 11.5,
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    minWidth: 0,
    color: BRAND.ochreHover,
    background: BRAND.ochreSoft,
    border: "1px solid rgba(200,118,60,0.55)",
    borderRadius: 999,
    boxShadow: "0 2px 10px rgba(200,118,60,0.12)",
    cursor: "pointer",
    transition: "background 120ms, border-color 120ms, color 120ms",
  },
  workspaceChipText: { maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  /** 「浏览器控制」胶囊：沿用工作区胶囊的品牌色语言，但不带 .chip 类（见 ADR-0085 补充2）。 */
  browserChip: {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 8px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    color: BRAND.ochreHover,
    background: BRAND.ochreSoft,
    border: "1px solid rgba(200,118,60,0.55)",
    boxShadow: "0 2px 10px rgba(200,118,60,0.12)",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  browserChipCompact: { width: 24, padding: 0, justifyContent: "center" },
  /** 「浏览器控制」关闭态：不抢眼（无底无边），但仍可点击开关。 */
  browserChipOff: {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 8px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    color: BRAND.linenMuted,
    background: "transparent",
    border: "1px solid transparent",
    whiteSpace: "nowrap",
    flexShrink: 0,
    transition: "background 120ms, color 120ms",
  },
  workspaceList: { display: "flex", flexDirection: "column", gap: 1, maxHeight: 240, overflowY: "auto" },
  workspaceItem: { display: "flex", alignItems: "center", gap: 2, width: "100%", padding: "6px 8px", border: "none", borderRadius: 6, background: "transparent", color: BRAND.linen, fontSize: 12, cursor: "pointer", textAlign: "left" },
  workspaceItemName: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  workspaceEmpty: { padding: "8px", fontSize: 11.5, color: BRAND.linenFaint },
  workspaceDivider: { height: 1, background: BRAND.border, margin: "4px 0" },
  workspaceAdd: { display: "flex", alignItems: "center", width: "100%", padding: "6px 8px", border: "none", borderRadius: 6, background: "transparent", color: BRAND.linenMuted, fontSize: 12, cursor: "pointer", textAlign: "left" },
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
  /** 左下角圆形「+」：圆形框格（用户 2026-11-10）；与 chip 同高但更圆、更醒目一点。 */
  plusBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    padding: 0,
    borderRadius: "50%",
    border: `1px solid ${BRAND.borderStrong}`,
    background: "transparent",
    color: BRAND.linenMuted,
    cursor: "pointer",
    transition: "background 120ms, border-color 120ms, color 120ms",
  },
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
  /** 模型名后的紧凑能力提示（上下文窗口 1M/131K 等），只在有值时渲染。 */
  modelHint: { fontSize: 9.5, color: BRAND.linenFaint, flexShrink: 0, fontVariantNumeric: "tabular-nums" },
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
