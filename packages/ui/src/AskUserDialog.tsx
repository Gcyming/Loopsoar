/**
 * ask_user 弹窗：Agent 调用 ask_user 工具时暂停任务，向用户提一个问题。
 *
 * 定位：这是「人机协作」的关键一环——不是权限确认，而是 Agent 缺信息时必须由人回答。
 * 交互：选项按钮（点选即回答）/ 自由文本（Ctrl+Enter 提交）/ 取消（Esc 或按钮）。
 * 组件只做展示与本地输入，真正的 IPC 回填（api.ask.respond）由 App 负责：
 *   · answer=null  → 取消（cancelled:true）
 *   · answer=string → 回答内容
 *
 * 无障碍：role=dialog + aria-modal + aria-labelledby/describedby；挂载时聚焦首个可操作元素，
 * Esc 在捕获阶段处理（避免同时触发下层设置面板的 Esc 关闭）；Tab 在弹窗内循环。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import type { AskUserRequest } from "./types.js";

export interface AskUserDialogProps {
  /** 挂起中的问题（来自 ask:user 事件）。 */
  request: AskUserRequest;
  /** 回答或取消；null = 取消。 */
  onRespond: (answer: string | null) => void;
}

export default function AskUserDialog({ request, onRespond }: AskUserDialogProps): React.JSX.Element {
  const tr = useT();
  const titleId = React.useId();
  const questionId = React.useId();
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);
  const firstOptionRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const [text, setText] = React.useState("");

  const options = request.options ?? [];
  // 与 shell 的默认语义一致：未显式声明时，有选项=只让选，无选项=只让打字
  const allowFreeText = request.allowFreeText ?? options.length === 0;

  // 焦点管理：弹窗打开时优先聚焦第一个选项（键盘可一键选择），没有选项则聚焦自由文本；
  // 关闭时把焦点还给打开前的元素。
  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = firstOptionRef.current ?? textRef.current;
    target?.focus();
    return () => previous?.focus?.();
  }, [allowFreeText]);

  // Esc 取消：捕获阶段拦截并阻断继续传播（否则下层设置面板也会被 Esc 关掉）
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onRespond(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onRespond]);

  const submitText = (): void => {
    const value = text.trim();
    if (!value) return;
    onRespond(value);
  };

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Ctrl/Cmd+Enter：提交自由文本
    if (allowFreeText && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitText();
      return;
    }
    // 基础焦点圈定：Tab 在弹窗内首尾循环，避免焦点跑到遮罩后的界面
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'),
    ).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    // 焦点落在对话框容器本身（点击空白处后）：直接送进首/尾元素
    if (document.activeElement === root) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  };

  return (
    <div
      className="ask-overlay"
      data-fullpage-overlay="ask"
      role="presentation"
      onMouseDown={(event) => {
        // 点遮罩空白只把焦点收回弹窗（不误关弹窗：取消必须显式按钮/Esc）
        if (event.target === event.currentTarget) dialogRef.current?.focus();
      }}
    >
      <div
        ref={dialogRef}
        className="ask-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={questionId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <div className="ask-head">
          <Icon name="bulb" size={15} style={{ color: BRAND.ochreHover }} />
          <span id={titleId} className="ask-title">
            {tr("ask.title")}
          </span>
        </div>
        <div id={questionId} className="ask-question">
          {request.question}
        </div>
        {options.length > 0 ? (
          <div className="ask-options" role="group" aria-label={tr("ask.ariaOptions")}>
            {options.map((option, index) => (
              <button
                key={`${index}-${option}`}
                ref={index === 0 ? firstOptionRef : undefined}
                type="button"
                className="ask-option"
                title={tr("ask.optionTitle")}
                onClick={() => onRespond(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
        {allowFreeText ? (
          <div className="ask-free">
            <textarea
              ref={textRef}
              className="ask-input"
              rows={2}
              value={text}
              // 契约 AskRespondSchema.answer 上限 4000 字符：输入侧先拦住，避免提交被 schema 拒绝
              maxLength={4000}
              onChange={(event) => setText(event.target.value)}
              placeholder={options.length > 0 ? tr("ask.placeholderOptions") : tr("ask.placeholderFree")}
              aria-label={tr("ask.ariaFree")}
              spellCheck={false}
            />
            <div className="ask-hint">{tr("ask.hintCtrl")}</div>
          </div>
        ) : options.length === 0 ? (
          <div className="ask-hint">{tr("ask.hintOnlyCancel")}</div>
        ) : (
          <div className="ask-hint">{tr("ask.hintOptions")}</div>
        )}
        <div className="ask-actions">
          <button type="button" className="ask-cancel" onClick={() => onRespond(null)}>
            {tr("ask.cancel")}
          </button>
          {allowFreeText ? (
            <button type="button" className="ask-submit" onClick={submitText} disabled={!text.trim()} title="Ctrl+Enter">
              {tr("ask.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
