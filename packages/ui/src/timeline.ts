/**
 * 思考时间线的数据模型与投影（纯逻辑，无 React）。
 *
 * 对齐 slime 的交错时间线：模型的一轮工作由「思考段 / 穿插正文 / 工具调用 / 任务规划 /
 * 推进播报 / 用户引导」按发生顺序组成；渲染层只消费这个数组。
 * 这里刻意做「唯一产地」：App 只负责把事件 append 进来，组件只负责画。
 */

export type TimelineStep =
  | { kind: "think"; text: string }
  | { kind: "body"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      label: string;
      detail?: string;
      result?: string;
      ok?: boolean;
      state: "running" | "done";
    }
  | { kind: "plan"; items: PlanItem[] }
  | { kind: "todo"; text: string; state: "start" | "done" }
  | { kind: "steer"; text: string };

export interface PlanItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export type TimelineEvent =
  | { kind: "think"; text: string }
  | { kind: "body"; text: string }
  | {
      kind: "tool";
      id?: string;
      name: string;
      label?: string;
      detail?: string;
      result?: string;
      ok?: boolean;
      state?: "running" | "done";
    }
  | { kind: "plan"; items: PlanItem[] }
  | { kind: "todo"; text: string; state: "start" | "done" }
  | { kind: "steer"; text: string };

let toolIdSeq = 0;

/** append 规则：连续 think/body 合并成一段；plan 用签名去重并就地刷新；其余各成节点。 */
export function appendTimelineStep(steps: TimelineStep[], event: TimelineEvent): TimelineStep[] {
  if (event.kind === "think" || event.kind === "body") {
    if (!event.text) return steps;
    const last = steps[steps.length - 1];
    if (last && last.kind === event.kind) {
      return [...steps.slice(0, -1), { kind: event.kind, text: (last.text ?? "") + event.text }];
    }
    if (event.kind === "think") return [...steps, { kind: "think", text: event.text }];
    return [...steps, { kind: "body", text: event.text }];
  }
  if (event.kind === "steer") {
    if (!event.text) return steps;
    const last = steps[steps.length - 1];
    if (last && last.kind === "steer" && last.text === event.text) return steps;
    return [...steps, { kind: "steer", text: event.text }];
  }
  if (event.kind === "plan") {
    if (event.items.length === 0) return steps;
    const signature = planSignature(event.items);
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const step = steps[i];
      if (step.kind === "plan") {
        if (planSignature(step.items) === signature) {
          return [...steps.slice(0, i), { kind: "plan", items: event.items }, ...steps.slice(i + 1)];
        }
        break;
      }
    }
    return [...steps, { kind: "plan", items: event.items }];
  }
  if (event.kind === "todo") {
    return [...steps, { kind: "todo", text: event.text, state: event.state }];
  }
  const tool: TimelineStep = {
    kind: "tool",
    id: event.id ?? `tool-${++toolIdSeq}`,
    name: event.name,
    label: event.label ?? event.name,
    detail: event.detail,
    result: event.result,
    ok: event.ok,
    state: event.state ?? (event.result !== undefined ? "done" : "running"),
  };
  return [...steps, tool];
}

/** 让「运行中」的工具节点落定为 done（结果到达时用）。 */
export function settleToolStep(
  steps: TimelineStep[],
  id: string,
  patch: { ok?: boolean; result?: string },
): TimelineStep[] {
  return steps.map((step) =>
    step.kind === "tool" && step.id === id
      ? { ...step, state: "done", ok: patch.ok, result: patch.result ?? step.result }
      : step,
  );
}

export function planSignature(items: PlanItem[]): string {
  return items.map((item) => item.content).join("\u0001");
}

export function lastPlanItems(steps: TimelineStep[]): PlanItem[] | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].kind === "plan") return (steps[i] as { items: PlanItem[] }).items;
  }
  return null;
}

export interface TimelineGroup {
  from: number;
  to: number;
  steps: TimelineStep[];
  headline: string;
  toolCount: number;
  isLast: boolean;
}

function headlineOf(step: TimelineStep): string {
  const raw = step.kind === "think" ? step.text : step.kind === "body" ? step.text : "";
  const firstLine = raw.split("\n").find((line) => line.trim() !== "") ?? "";
  const text = firstLine.replace(/[#*`>]/g, "").trim();
  if (!text) return "工作阶段";
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

/** 分组：新的 think 段开始 = 新工作阶段（与 slime groupTimeline 一致）。 */
export function groupTimeline(steps: TimelineStep[]): TimelineGroup[] {
  if (steps.length === 0) return [];
  const groups: TimelineGroup[] = [];
  let start = 0;
  for (let i = 1; i <= steps.length; i += 1) {
    const boundary = i === steps.length || steps[i].kind === "think";
    if (!boundary) continue;
    const slice = steps.slice(start, i);
    const think = slice.find((step): step is Extract<TimelineStep, { kind: "think" }> => step.kind === "think");
    groups.push({
      from: start,
      to: i - 1,
      steps: slice,
      headline: headlineOf(think ?? slice[0]),
      toolCount: slice.filter((step) => step.kind === "tool").length,
      isLast: false,
    });
    start = i;
  }
  if (groups.length > 0) groups[groups.length - 1] = { ...groups[groups.length - 1], isLast: true };
  return groups;
}

/** 工具名 → 人类可读标签（时间线行首；未知工具保留原名并去掉命名空间）。 */
const TOOL_LABELS: Record<string, string> = {
  browser_snapshot: "读取页面",
  browser_navigate: "打开网页",
  browser_click: "点击元素",
  browser_type: "输入文本",
  browser_scroll: "滚动页面",
  web_fetch: "抓取网页",
  file_read: "读取文件",
  terminal_run: "执行命令",
  todo_write: "更新规划",
};

export function toolDisplayLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const ext = /^ext__[^_]+__(.+)$/.exec(name);
  if (ext) return ext[1];
  const mcp = /^mcp__[^_]+__(.+)$/.exec(name);
  if (mcp) return mcp[1];
  return name;
}

export type ToolCategory = "" | "执行命令" | "写入" | "网页访问" | "读取" | "删除" | "委派子代理" | "规划";

/** 工具分类（决定时间线节点颜色与分类徽标）。 */
export function toolCategoryOf(name: string): { category: ToolCategory; color: string } {
  const raw = name.replace(/^mcp__[^_]+__/, "");
  if (/^(todo_write|todo|plan)/i.test(raw)) return { category: "规划", color: "var(--ls-accent, #c8763c)" };
  if (/^(delegate_subagent|subagent_result|delegate)$/i.test(raw)) return { category: "委派子代理", color: "#c084fc" };
  if (/bash|terminal|exec|command|code_check|\.py|npm|pip|git /i.test(raw)) return { category: "执行命令", color: "#a78bfa" };
  if (/delete|remove|\brm\b|del/i.test(raw)) return { category: "删除", color: "var(--ls-danger, #f87171)" };
  if (/write|edit|create|save|generate/i.test(raw)) return { category: "写入", color: "#34d399" };
  if (/search|fetch|navigate|browse|snapshot|click|type/i.test(raw)) return { category: "网页访问", color: "#60a5fa" };
  if (/read|list|get/i.test(raw)) return { category: "读取", color: "#fbbf24" };
  return { category: "", color: "#8b93a3" };
}

/** 从工具参数里抽出最值得展示的一行（网址 / 路径 / 命令 / 查询）。 */
export function extractToolDetail(name: string, args: unknown, result?: string): string {
  const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const url = record.url ?? record.href;
  if (typeof url === "string" && url) return url;
  const preferred = ["command", "path", "file", "target", "selector", "query", "direction", "text"];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.length > 160 ? `${value.slice(0, 160)}…` : value;
    }
  }
  if (result) {
    const match = /https?:\/\/[^\s"'<>)\]]+/.exec(result);
    if (match) return match[0];
  }
  return "";
}

/** 工具结果状态：失败前缀或 ok:false 视为失败（沙箱拒绝/错误也走这里）。 */
export function isToolFailure(name: string, result: string | undefined, ok?: boolean): boolean {
  if (ok === false) return true;
  const text = (result ?? "").trim();
  if (!text) return false;
  if (/^\[错误\]|^\[失败\]|^\[工具失败\]|权限拒绝|拒绝执行|未找到|not found|error:/i.test(text)) return true;
  void name;
  return false;
}

/**
 * 「回复耗时」的展示格式（思考过程卡标题行用）：
 * <1s 用毫秒整数（如 420ms），≥1s 保留一位小数（如 1.2s）；缺失/异常返回 "—"。
 * 纯函数，便于单测与 E2E 断言文案。
 */
export function formatDurationMs(ms: number | undefined): string {
  if (!ms || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 从 todo_write 结果（Markdown checklist）解析规划条目；解析失败返回空数组。 */
export function parsePlanItems(raw: string | undefined): PlanItem[] {
  const text = (raw ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n").filter((line) => /^\s*-\s*\[[ xX]\]\s+/.test(line));
  return lines.map((line, index) => {
    const done = /^\s*-\s*\[[xX]\]/.test(line);
    const inProgress = /←\s*进行中\s*$/.test(line);
    const content = line.replace(/^\s*-\s*\[[ xX]\]\s*/, "").replace(/\s*←\s*进行中\s*$/, "").trim();
    return {
      id: String(index + 1),
      content,
      status: done ? "completed" : inProgress ? "in_progress" : "pending",
    };
  });
}

/** 一次 todo_write 更新 → 规划卡 + 推进播报行（完成/开始的差异）。 */
export function foldPlanUpdate(
  steps: TimelineStep[],
  items: PlanItem[],
  previous: PlanItem[] | null,
): TimelineStep[] {
  if (items.length === 0) return steps;
  let next = appendTimelineStep(steps, { kind: "plan", items });
  if (!previous) return next;
  const before = new Map(previous.map((item) => [item.content, item.status]));
  for (const item of items) {
    const old = before.get(item.content);
    if (item.status === "completed" && old !== "completed") {
      next = appendTimelineStep(next, { kind: "todo", text: item.content, state: "done" });
    } else if (item.status === "in_progress" && old !== "in_progress" && old !== "completed") {
      next = appendTimelineStep(next, { kind: "todo", text: item.content, state: "start" });
    }
  }
  return next;
}
