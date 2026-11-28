/**
 * ask_user 弹窗：Agent 调用 ask_user 工具时暂停任务，向用户提一个「决策分叉」问题。
 *
 * 定位：这是「人机协作」的关键一环 —— 不是权限确认，而是 Agent 缺信息时必须由人拍板。
 * 交互（对标 slime 的决策分叉窗口）：
 *   · 每个选项展示 label（做什么）+ description（选择它的后果/代价），模型推荐项标「推荐」；
 *   · 单选：点击或按数字键立即回答；
 *   · 多选：点击切换选中，点「确认选择」提交（可同时补充自由文本）；
 *   · 永远保留「其他」出口（自由文本）与「跳过，先继续」（不替用户做决定，也不让任务卡死）。
 *
 * 组件只做展示与本地输入，真正的 IPC 回填（api.ask.respond）由 App 负责：
 *   · null              → 取消（cancelled:true）
 *   · { choice }        → 单选
 *   · { choices }       → 多选
 *   · { answer }        → 自由文本
 *   · { skipped:true }  → 跳过（不回答，但要求 Agent 继续）
 *
 * 无障碍：role=dialog + aria-modal + aria-labelledby/describedby；挂载时聚焦首个选项，
 * Esc 在捕获阶段处理（避免同时触发下层面板的 Esc 关闭）；Tab 在弹窗内循环。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import { useT } from "./i18n.js";
import type { AskUserOption, AskUserReply, AskUserRequest } from "./types.js";

export interface AskUserDialogProps {
  /** 挂起中的问题（来自 ask:user 事件）。 */
  request: AskUserRequest;
  /** 回答 / 跳过 / 取消；null = 取消。 */
  onRespond: (reply: AskUserReply | null) => void;
  /** 会话内联卡片（默认 false = 旧的全屏模态；新界面应传 true）。 */
  inline?: boolean;
}

const MAX_OPTIONS = 8;

/** 兼容旧壳层的 string[]：统一成结构化选项。 */
function normalizeOptions(raw: AskUserRequest["options"]): AskUserOption[] {
  if (!Array.isArray(raw)) return [];
  const list: AskUserOption[] = [];
  for (const item of raw) {
    const option: AskUserOption = typeof item === "string" ? { label: item } : item;
    const label = typeof option.label === "string" ? option.label.trim() : "";
    if (!label) continue;
    list.push({
      label: label.slice(0, 200),
      ...(typeof option.description === "string" && option.description.trim()
        ? { description: option.description.trim().slice(0, 300) }
        : {}),
      ...(option.recommended === true ? { recommended: true } : {}),
    });
    if (list.length >= MAX_OPTIONS) break;
  }
  return list;
}

export default function AskUserDialog({ request, onRespond, inline = false }: AskUserDialogProps): React.JSX.Element {
  const tr = useT();
  const titleId = React.useId();
  const questionId = React.useId();
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);
  const firstOptionRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const [text, setText] = React.useState("");
  /** 多选：已选中的 label（顺序即用户点击顺序）。 */
  const [selected, setSelected] = React.useState<string[]>([]);
  /** 每秒推进一次，仅用于敏感确认的倒计时（到期后弹窗由 App 收起）。 */
  const [now, setNow] = React.useState(() => Date.now());

  const options = React.useMemo(() => normalizeOptions(request.options), [request.options]);
  // 与 shell 的默认语义一致：允许自由文本（选项之外永远有「其他」出口）
  const allowFreeText = request.allowFreeText ?? true;
  /** 敏感步骤确认：不回显选项列表与自由文本，只给「确认执行 / 取消」两个明确动作。 */
  const isSensitive = request.kind === "sensitive";
  const multiSelect = request.multiSelect === true && options.length > 0 && !isSensitive;
  const remainingMs = typeof request.expiresAt === "number" ? Math.max(0, request.expiresAt - now) : null;
  const expired = remainingMs !== null && remainingMs <= 0;

  React.useEffect(() => {
    if (typeof request.expiresAt !== "number") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [request.expiresAt]);

  // 焦点管理：弹窗打开时优先聚焦第一个选项（键盘可一键选择），没有选项则聚焦自由文本；
  // 关闭时把焦点还给打开前的元素。
  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 敏感确认没有选项列表与输入框：焦点落到弹窗本体，保证 Esc 与 Tab 圈定都从正确位置开始。
    const target = firstOptionRef.current ?? textRef.current ?? dialogRef.current;
    target?.focus();
    return () => previous?.focus?.();
  }, [allowFreeText, options.length]);

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

  // 数字键 1..8 直选（单选）：把「点选项」的成本降到一次按键。
  // 输入框内不拦截（用户可能在写数字）；多选/敏感确认不启用（避免误提交）。
  React.useEffect(() => {
    if (isSensitive || multiSelect || options.length === 0) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      const digit = Number.parseInt(event.key, 10);
      if (!Number.isInteger(digit) || digit < 1 || digit > options.length) return;
      event.preventDefault();
      onRespond({ choice: options[digit - 1].label });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isSensitive, multiSelect, options, onRespond]);

  const pick = (option: AskUserOption): void => {
    if (multiSelect) {
      setSelected((prev) =>
        prev.includes(option.label) ? prev.filter((label) => label !== option.label) : [...prev, option.label],
      );
      return;
    }
    onRespond({ choice: option.label });
  };

  const submit = (): void => {
    const value = text.trim();
    if (multiSelect) {
      if (selected.length === 0 && !value) return;
      onRespond({
        ...(selected.length > 0 ? { choices: selected } : {}),
        ...(value ? { answer: value } : {}),
      });
      return;
    }
    if (!value) return;
    onRespond({ answer: value });
  };

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Ctrl/Cmd+Enter：提交自由文本（多选时连同已选项一起提交）
    if (allowFreeText && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
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
      className={inline ? "ask-inline" : "ask-overlay"}
      data-fullpage-overlay={inline ? undefined : "ask"}
      role="presentation"
      onMouseDown={
        inline
          ? undefined
          : (event) => {
              // 点遮罩空白只把焦点收回弹窗（不误关弹窗：取消必须显式按钮/Esc）
              if (event.target === event.currentTarget) dialogRef.current?.focus();
            }
      }
    >
      <div
        ref={dialogRef}
        className="ask-dialog"
        data-kind={isSensitive ? "sensitive" : "ask"}
        data-multi={multiSelect ? "true" : "false"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={questionId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <div className="ask-head">
          <Icon
            name={isSensitive ? "warning" : "bulb"}
            size={15}
            style={{ color: isSensitive ? "var(--ls-danger)" : BRAND.ochreHover }}
          />
          <span id={titleId} className="ask-title">
            {isSensitive ? request.title ?? tr("ask.sensitiveTitle") : tr("ask.title")}
          </span>
          {!isSensitive && request.header ? (
            <span className="ask-header-badge" title={request.header}>
              {request.header}
            </span>
          ) : null}
        </div>
        <div id={questionId} className="ask-question">
          {request.question}
        </div>
        {isSensitive && request.detail && request.detail.length > 0 ? (
          <div className="ask-detail">
            {request.detail.map((row) => (
              <div key={row.label} className="ask-detail-row">
                <span className="ask-detail-label">{row.label}</span>
                <span className="ask-detail-value" title={row.value}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {!isSensitive && options.length > 0 ? (
          <div className="ask-options" role="group" aria-label={tr("ask.ariaOptions")}>
            {options.map((option, index) => {
              const active = multiSelect && selected.includes(option.label);
              return (
                <button
                  key={option.label + "-" + index}
                  ref={index === 0 ? firstOptionRef : undefined}
                  type="button"
                  className="ask-option"
                  data-recommended={option.recommended ? "true" : "false"}
                  data-selected={active ? "true" : "false"}
                  aria-pressed={multiSelect ? active : undefined}
                  title={option.description ?? tr("ask.optionTitle")}
                  onClick={() => pick(option)}
                >
                  <span className="ask-option-index" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="ask-option-body">
                    <span className="ask-option-label">
                      {option.label}
                      {option.recommended ? <span className="ask-badge-rec">{tr("ask.recommended")}</span> : null}
                    </span>
                    {option.description ? <span className="ask-option-desc">{option.description}</span> : null}
                  </span>
                  {multiSelect ? (
                    <span className="ask-option-check" data-on={active ? "true" : "false"} aria-hidden="true">
                      {active ? <Icon name="check" size={12} /> : null}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {isSensitive ? null : allowFreeText ? (
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
          {/* 倒计时只给敏感确认：普通提问是「等你想清楚」，显示倒计时是无谓催促 */}
          {isSensitive && remainingMs !== null ? (
            <span className="ask-countdown" data-expired={expired ? "true" : "false"} aria-live="off">
              {expired
                ? tr("ask.expired")
                : tr("ask.countdown", { seconds: Math.ceil(remainingMs / 1000) })}
            </span>
          ) : null}
          {/* 跳过：不替用户选，也不让任务卡死（Agent 会带着假设继续，并在最终回复里说明） */}
          {!isSensitive ? (
            <button type="button" className="ask-skip" onClick={() => onRespond({ skipped: true })}>
              {tr("ask.skip")}
            </button>
          ) : null}
          <button type="button" className="ask-cancel" onClick={() => onRespond(null)}>
            {isSensitive ? tr("ask.sensitiveCancel") : tr("ask.cancel")}
          </button>
          {isSensitive ? (
            <button
              type="button"
              className="ask-submit"
              data-danger="true"
              disabled={expired}
              onClick={() => onRespond({ answer: "confirm" })}
            >
              {tr("ask.sensitiveConfirm")}
            </button>
          ) : multiSelect ? (
            <button
              type="button"
              className="ask-submit"
              onClick={submit}
              disabled={selected.length === 0 && !text.trim()}
              title={tr("ask.hintMulti")}
            >
              {selected.length > 0 ? tr("ask.confirmChoices", { count: selected.length }) : tr("ask.submit")}
            </button>
          ) : allowFreeText ? (
            <button type="button" className="ask-submit" onClick={submit} disabled={!text.trim()} title="Ctrl+Enter">
              {tr("ask.submit")}
            </button>
          ) : null}
        </div>
        {!isSensitive && options.length > 0 && !multiSelect && allowFreeText ? (
          <div className="ask-hint">{tr("ask.hintNumberKeys")}</div>
        ) : null}
      </div>
    </div>
  );
}
