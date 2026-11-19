/**
 * 思考时间线（对齐 slime 的交错时间线设计）：
 *   思考过程卡 → 按「工作阶段」分组 → 节点（思考 / 穿插正文 / 工具 / 任务规划 / 推进播报 / 引导）。
 *
 * 视觉与交互约定（全部来自 slime 的最终形态）：
 *   · 左侧 2px 轴线 + 8px 节点圆点（思考=圆形、正文=方形、工具=按类别着色）；
 *   · 思考段：摘要行 + chevron，内容折叠（grid 0fr↔1fr 高度插值，不卸载 DOM）；
 *   · 穿插正文：不做折叠，直接 Markdown；
 *   · 工具卡：整行可点展开，分类徽标 + 详情 + 状态胶囊（运行中呼吸 / 落定弹动）；
 *   · 规划卡：进度 + 当前项；推进播报：完成项划掉动画；
 *   · 引导卡：用户中途插入，独立卡片；
 *   · 分组：历史组默认折叠，流式中恒展开；
 *   · 流式中最后一段文本走吐字渐入。
 * 纯展示组件（Markdown/打开链接由 props 注入），不做 IPC。
 */
import * as React from "react";
import { BRAND } from "./theme.js";
import { Icon } from "./Icon.js";
import StreamFadeText from "./StreamFade.js";
import DiffBlock from "./DiffBlock.js";
import { useT } from "./i18n.js";
import { RefPanel, UrlPanel } from "./ArtifactPanels.js";
import { collectReferences, diffStat, diffLines, parseDiffResult } from "./artifacts.js";
import {
  groupTimeline,
  isToolFailure,
  toolCategoryOf,
  toolDisplayLabel,
  toolVisual,
  type PlanItem,
  type TimelineGroup,
  type TimelineStep,
} from "./timeline.js";

type MarkdownFn = (props: { text: string; streaming?: boolean; compact?: boolean }) => React.ReactNode;

export interface TimelineProps {
  steps: TimelineStep[];
  liveStream?: boolean;
  /** 演示/验收：强制展开所有工作阶段（平时历史阶段默认折叠）。 */
  expandAll?: boolean;
  /** 「回复耗时」文案（如「用时 1.2s」，由调用方本地化）；无思考过程的消息不传，直接省略。 */
  durationText?: string;
  open: boolean;
  onToggleOpen: () => void;
  Markdown: MarkdownFn;
  onOpenUrl?: (url: string) => void;
}

/** 思考过程卡标题行的「用时」：小号数字、单行不换行（窄侧栏也不把标题挤到第二行）。 */
const DURATION_STYLE: React.CSSProperties = {
  color: BRAND.linenFaint,
  fontSize: 10.5,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

function Chevron({ open, size = 11 }: { open: boolean; size?: number }): React.ReactElement {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        flexShrink: 0,
        color: BRAND.linenFaint,
        fontSize: size,
        lineHeight: 1,
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 140ms ease",
      }}
    >
      ›
    </span>
  );
}

function Collapse({ open, children }: { open: boolean; children: React.ReactNode }): React.ReactElement {
  return (
    <div className={`collapse${open ? " is-open" : ""}`}>
      <div>{children}</div>
    </div>
  );
}

/** 剥离工具名的命名空间，展示人类可读标签。 */
function toolLabel(name: string): string {
  return toolDisplayLabel(name);
}

export default function Timeline({ steps, liveStream = false, expandAll = false, durationText, open, onToggleOpen, Markdown, onOpenUrl }: TimelineProps): React.ReactElement | null {
  const tr = useT();
  const groups = React.useMemo(() => groupTimeline(steps), [steps]);
  const references = React.useMemo(() => collectReferences(steps), [steps]);
  if (steps.length === 0) return null;
  const toolCount = steps.filter((step) => step.kind === "tool").length;
  return (
    <div className="think-card">
      <button type="button" className="think-card-title" onClick={onToggleOpen} title={open ? tr("chat.thinkingCollapse") : tr("chat.thinkingExpand")}>
        <span className="think-card-brain" aria-hidden><Icon name="sparkle" size={12} /></span>
        <span className="think-card-label">{tr("timeline.thinking")}</span>
        {toolCount > 0 ? <span className="think-card-count">{tr("timeline.actions", { count: toolCount })}</span> : null}
        {durationText ? (
          <span className="think-card-duration" style={DURATION_STYLE}>
            {durationText}
          </span>
        ) : null}
        <span style={{ marginLeft: "auto", display: "inline-flex" }}>
          <Chevron open={open} />
        </span>
      </button>
      <Collapse open={open}>
        <UrlPanel urls={references.urls} onOpenUrl={onOpenUrl} />
        <RefPanel files={references.files} />
        <div className={`think-timeline${liveStream ? " is-live" : ""}`}>
          {groups.map((group) => (
            <TimelineGroupBlock
              key={`g${group.from}`}
              group={group}
              liveStream={liveStream}
              expandAll={expandAll}
              Markdown={Markdown}
              onOpenUrl={onOpenUrl}
            />
          ))}
        </div>
      </Collapse>
    </div>
  );
}

function TimelineGroupBlock({
  group,
  liveStream,
  expandAll,
  Markdown,
  onOpenUrl,
}: {
  group: TimelineGroup;
  liveStream: boolean;
  expandAll: boolean;
  Markdown: MarkdownFn;
  onOpenUrl?: (url: string) => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(expandAll);
  const hasShell = group.steps.length > 1;
  const holdOpen = liveStream || expandAll;
  const canCollapse = hasShell && !group.isLast && !holdOpen;
  const effectiveOpen = group.isLast || holdOpen ? true : open;
  const body = (
    <div className="think-timeline-inner">
      {group.steps.map((step, index) => {
        const isLastOfGroup = index === group.steps.length - 1;
        const streamingTail = Boolean(liveStream && group.isLast && isLastOfGroup && (step.kind === "think" || step.kind === "body"));
        return (
          <TimelineNode
            key={`s${group.from + index}`}
            step={step}
            autoExpand={group.isLast && isLastOfGroup}
            forceExpand={expandAll}
            streamingTail={streamingTail}
            groupHeadline={group.headline}
            Markdown={Markdown}
            onOpenUrl={onOpenUrl}
          />
        );
      })}
    </div>
  );
  if (!hasShell) return body;
  const headInner = (
    <>
      <span className="think-group-headline">{group.headline}</span>
      {group.toolCount > 0 ? <span className="think-group-steps">{group.toolCount} 步</span> : null}
    </>
  );
  return (
    <div className="think-group">
      {canCollapse ? (
        <button type="button" className="think-group-head" onClick={() => setOpen((value) => !value)} title={open ? "收起这一阶段" : "展开这一阶段"}>
          <Chevron open={open} size={10} />
          {headInner}
        </button>
      ) : (
        <div className="think-group-head is-static">
          <span style={{ width: 10, flexShrink: 0 }} />
          {headInner}
        </div>
      )}
      <Collapse open={effectiveOpen}>{body}</Collapse>
    </div>
  );
}

function TimelineNode({
  step,
  autoExpand,
  forceExpand,
  streamingTail,
  groupHeadline,
  Markdown,
  onOpenUrl,
}: {
  step: TimelineStep;
  autoExpand?: boolean;
  /** E2E/演示：强制展开所有思考段（?expandAllGroups=1）。 */
  forceExpand?: boolean;
  streamingTail?: boolean;
  /** 所在工作阶段的组头（用于去重：组头已展示同一句时，省掉重复的摘要行）。 */
  groupHeadline?: string;
  Markdown: MarkdownFn;
  onOpenUrl?: (url: string) => void;
}): React.ReactElement | null {
  const tr = useT();
  const [expanded, setExpanded] = React.useState(Boolean(autoExpand || forceExpand));

  if (step.kind === "think") {
    const clean = step.text.trim();
    if (!clean) return null;
    const preview = clean.replace(/[#*`>_]/g, "").replace(/\s+/g, " ").slice(0, 120);
    const normalizedPreview = preview.trim();
    const normalizedHeadline = (groupHeadline ?? "").replace(/…$/, "").trim();
    // 组头已经显示同一句话时不再重复（slime 的组头 + 摘要双行在窄栏里很吵）
    const duplicateOfHeadline =
      Boolean(normalizedPreview) &&
      (normalizedHeadline === normalizedPreview ||
        (normalizedHeadline.length >= 8 && normalizedPreview.startsWith(normalizedHeadline)));
    const displayPreview = duplicateOfHeadline ? "" : preview;
    return (
      <div className="think-step" data-kind="think">
        <span className="think-step-mark" />
        <button type="button" className="think-step-toggle" onClick={() => setExpanded((value) => !value)} title={expanded ? "收起这段思考" : "展开这段思考（Markdown）"}>
          <Chevron open={expanded} size={10} />
          <span className="think-step-icon" aria-hidden><Icon name="bulb" size={11} /></span>
          <span className="think-step-kind">{tr("timeline.stepThinking")}</span>
          <span className="think-step-preview">
            {displayPreview || (duplicateOfHeadline ? (expanded ? tr("timeline.thinkingCollapse") : tr("timeline.thinkingExpandShort")) : tr("timeline.thinkingHint"))}
            {!duplicateOfHeadline && clean.length > 120 ? "…" : ""}
          </span>
        </button>
        <Collapse open={expanded}>
          <div className="think-step-text">
            {streamingTail ? (
              <StreamFadeText text={clean} Markdown={({ text }) => Markdown({ text, compact: true })} />
            ) : (
              Markdown({ text: clean, compact: true })
            )}
          </div>
        </Collapse>
      </div>
    );
  }

  if (step.kind === "body") {
    const text = step.text.trim();
    if (!text) return null;
    return (
      <div className="think-step" data-kind="body">
        <span className="think-step-mark body-step-mark" />
        <div className="think-step-text body-step-text">
          {streamingTail ? <StreamFadeText text={text} Markdown={Markdown} /> : Markdown({ text })}
        </div>
      </div>
    );
  }

  if (step.kind === "plan") return <PlanNode items={step.items} />;

  if (step.kind === "todo") {
    const done = step.state === "done";
    return (
      <div className="think-step" data-kind="todo">
        <span className={`think-step-mark todo-step-mark${done ? " is-done" : ""}`} />
        <div className={`todo-announce${done ? " is-done" : ""}`} data-state={done ? "done" : "start"}>
          <span className="todo-announce-mark" aria-hidden>{done ? <Icon name="check" size={9} /> : <Icon name="play" size={9} />}</span>
          <span className="todo-announce-kind">{tr("timeline.progress")}</span>
          <span className="todo-announce-text" title={step.text}>{step.text}</span>
          <span className="todo-announce-tag">{done ? tr("timeline.done") : tr("timeline.start")}</span>
        </div>
      </div>
    );
  }

  if (step.kind === "steer") {
    const text = step.text.trim();
    if (!text) return null;
    return (
      <div className="think-step" data-kind="steer">
        <span className="think-step-mark steer-step-mark" />
        <div className="steer-card">
          <button type="button" className="steer-card-head" onClick={() => setExpanded((value) => !value)} title={expanded ? "收起这条引导" : "展开这条引导"}>
            <Chevron open={expanded} size={10} />
            <span className="steer-card-icon" aria-hidden><Icon name="guide-arrow" size={11} /></span>
            <span className="steer-card-title">{tr("timeline.steer")}</span>
            {!expanded ? <span className="steer-card-preview">{text.replace(/\s+/g, " ").slice(0, 80)}</span> : null}
          </button>
          <Collapse open={expanded}>
            <div className="steer-card-text">{text}</div>
          </Collapse>
        </div>
      </div>
    );
  }

  return <ToolNode step={step} expanded={expanded} onToggle={() => setExpanded((value) => !value)} onOpenUrl={onOpenUrl} />;
}

function PlanNode({ items }: { items: PlanItem[] }): React.ReactElement {
  const tr = useT();
  const [expanded, setExpanded] = React.useState(false);
  const done = items.filter((item) => item.status === "completed").length;
  const active = items.find((item) => item.status === "in_progress");
  return (
    <div className="think-step" data-kind="plan">
      <span className="think-step-mark plan-step-mark" />
      <div className="plan-card">
        <button type="button" className="plan-card-head" onClick={() => setExpanded((value) => !value)} title={expanded ? "收起任务规划" : "展开任务规划"}>
          <Chevron open={expanded} size={10} />
          <span className="plan-card-icon" aria-hidden><Icon name="list-details" size={12} /></span>
          <span className="plan-card-title">{tr("timeline.plan")}</span>
          <span className="plan-card-progress" data-all-done={done === items.length && items.length > 0 ? "1" : "0"}>{done}/{items.length}</span>
          {!expanded && active ? <span className="plan-card-active">· {active.content}</span> : null}
        </button>
        <Collapse open={expanded}>
          <div className="plan-card-list">
            {items.map((item, index) => (
              <div key={`${index}-${item.content}`} className="plan-item" data-status={item.status}>
                <span className="plan-item-mark" aria-hidden>{item.status === "completed" ? <Icon name="check" size={10} /> : item.status === "in_progress" ? <Icon name="play" size={10} /> : <Icon name="circle" size={9} />}</span>
                <span className="plan-item-text">{item.content}</span>
              </div>
            ))}
          </div>
        </Collapse>
      </div>
    </div>
  );
}

function ToolNode({
  step,
  expanded,
  onToggle,
  onOpenUrl,
}: {
  step: Extract<TimelineStep, { kind: "tool" }>;
  expanded: boolean;
  onToggle: () => void;
  onOpenUrl?: (url: string) => void;
}): React.ReactElement {
  const tr = useT();
  const failed = isToolFailure(step.name, step.result, step.ok);
  const running = step.state === "running";
  const { color } = toolCategoryOf(step.name);
  const visual = toolVisual(step.name);
  const status = running ? "执行中" : failed ? "失败" : "成功";
  const hasBody = Boolean(step.detail || step.result);
  const isUrl = Boolean(step.detail && /^https?:\/\//i.test(step.detail));
  const parsedDiff = React.useMemo(() => parseDiffResult(step.result), [step.result]);
  const resultText = parsedDiff.clean.trim();
  const diffStats = React.useMemo(() => {
    if (!parsedDiff.diff) return null;
    return diffStat(diffLines(parsedDiff.diff.oldText, parsedDiff.diff.newText));
  }, [parsedDiff.diff]);
  const isCommand = visual.label === "执行命令";
  const urls = React.useMemo(() => {
    const found = (step.result ?? "").match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
    return [...new Set(found)].slice(0, 4);
  }, [step.result]);
  return (
    <div className="think-tool-node" data-kind="tool" data-tool={step.name}>
      <span className="think-tool-mark" style={{ background: failed ? "var(--ls-danger, #f87171)" : color }} />
      <div
        className="think-tool-btn"
        data-status={running ? "running" : failed ? "fail" : "ok"}
        role={hasBody ? "button" : undefined}
        tabIndex={hasBody ? 0 : undefined}
        onClick={() => { if (hasBody) onToggle(); }}
        onKeyDown={(event) => {
          if (hasBody && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onToggle();
          }
        }}
        title={hasBody ? (expanded ? "点击收起详情" : "点击展开详情") : undefined}
        style={{ cursor: hasBody ? "pointer" : "default" }}
      >
        <span className="think-tool-glyph" aria-hidden><Icon name={visual.icon} size={12} /></span>
        <span className="think-tool-type">{visual.label}</span>
        <span className="think-tool-name" style={{ color: failed ? "var(--ls-danger, #f87171)" : BRAND.ochreHover }} title={step.name}>{toolLabel(step.name)}</span>
        {diffStats ? (
          <span className="think-diff-inline">
            <span className="think-diff-add">+{diffStats.add}</span>
            <span className="think-diff-del">−{diffStats.del}</span>
          </span>
        ) : null}
        {step.detail ? (
          isUrl ? (
            <a
              className="think-tool-detail is-link"
              href={step.detail}
              title={`打开：${step.detail}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenUrl?.(step.detail!);
              }}
            >
              {step.detail.slice(0, 120)}
            </a>
          ) : (
            <span className="think-tool-detail" title={step.detail}>{step.detail.slice(0, 120)}</span>
          )
        ) : null}
        <span
          className="think-tool-status"
          data-running={running ? "1" : undefined}
          data-settled={!running ? "1" : undefined}
          style={{ color: running ? BRAND.ochreHover : failed ? "var(--ls-danger, #f87171)" : "#4ade80" }}
          title={running ? "正在执行" : failed ? "执行失败" : "执行成功"}
        >
          {status}
        </span>
        {hasBody ? (
          <button
            type="button"
            className="think-tool-chevron"
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
            title={expanded ? "收起详情" : "展开详情"}
          >
            <Chevron open={expanded} size={10} />
          </button>
        ) : null}
      </div>
      {hasBody ? (
        <Collapse open={expanded}>
          <div className="think-tool-detail-box">
            {step.detail ? (
              <div className="think-tool-detail-line">
                <span aria-hidden>{isUrl ? <Icon name="link" size={11} style={{ verticalAlign: "-1px" }} /> : "↳"}</span>
                <span className="think-tool-detail-text">{step.detail}</span>
              </div>
            ) : null}
            {parsedDiff.diff ? (
              <DiffBlock oldText={parsedDiff.diff.oldText} newText={parsedDiff.diff.newText} path={parsedDiff.diff.path} />
            ) : null}
            {resultText ? (
              isCommand ? (
                <pre className="think-terminal">{resultText.slice(0, 6000)}{resultText.length > 6000 ? `\n…${tr("timeline.truncated", { count: resultText.length })}` : ""}</pre>
              ) : (
                <div className="think-tool-result" style={{ color: failed ? "var(--ls-danger, #f87171)" : BRAND.linenMuted }}>
                  <span className="think-tool-result-mark" aria-hidden>{failed ? <Icon name="close" size={10} /> : <Icon name="check" size={10} />}</span>
                  {/* 工具结果不静默截断：完整文本放进可滚动的详情框（.think-tool-detail-box 自带 max-height+滚动）。 */}
                  <span className="think-tool-result-text">{resultText}</span>
                </div>
              )
            ) : null}
            {urls.length > 0 ? (
              <div className="think-tool-links">
                {urls.map((url) => (
                  <a
                    key={url}
                    className="think-tool-link"
                    href={url}
                    title={url}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpenUrl?.(url);
                    }}
                  >
                    <Icon name="link" size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} /> {url.replace(/^https?:\/\//, "").slice(0, 48)}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </Collapse>
      ) : null}
    </div>
  );
}
