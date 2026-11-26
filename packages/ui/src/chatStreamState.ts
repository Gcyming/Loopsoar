/**
 * 会话流事件 → 消息状态（纯函数，可单测）。
 *
 * 这是「事件到时间线」的唯一转换层：App 只负责订阅事件并调用这里的函数，
 * 组件只负责渲染。所有解析/合并/规划折叠都在这里完成，禁止在别处出现第二套。
 */
import {
  appendTimelineStep,
  extractToolDetail,
  foldPlanUpdate,
  lastPlanItems,
  parsePlanItems,
  settleToolStep,
  type PlanItem,
  type TimelineStep,
} from "./timeline.js";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "reasoning" | "tool" | "system";
  text: string;
  /** 流式尾巴：最近一次增量（兼容旧动画用；新渲染走 StreamFade）。 */
  tail?: string;
  tailSeq?: number;
  status?: "streaming" | "done" | "error";
  interrupted?: { status: string; reason: string };
  timing?: { firstTokenMs?: number; totalMs?: number; rounds?: number; toolCalls?: number; tokens?: number };
  createdAt?: number;
  errorText?: string;
  /** 生成本条回复时使用的供应商/模型（历史消息按各自记录展示，不跟当前选择）。 */
  provider?: string;
  model?: string;
  /** 上下文自动压缩提示（来自 progress 事件，渲染在正文之前）。 */
  compressNote?: string;
  /** 压缩报告明细（条数/前后字符数；用于可展开的压缩报告）。 */
  compressStats?: { dropped: number; beforeChars: number; afterChars: number };
  /** 交错时间线（思考 / 穿插正文 / 工具 / 规划 / 播报 / 引导）。 */
  timeline?: TimelineStep[];
}

export interface DoneInfo {
  usage: { rounds?: number; toolCalls?: number; totalTokens?: number };
  interrupted?: { status: string; reason: string };
  statusText: string;
  /**
   * 服务端权威全文（含长回复自动续写、输出过滤后的最终结果）。
   * UI 在 done 时用它覆盖本地累积文本：即使有 chunk 在传输中丢失/乱序，
   * 最终展示与持久化文本也一定是完整的（m02515：截断必须根除，不能靠运气）。
   */
  finalText?: string;
}

/** 正文增量：不存在则创建助手消息（并开始时间线），存在则累加。 */
export function applyChunk(messages: ChatMessage[], id: string, delta: string, options: { tailSeq?: number; now?: number } = {}): ChatMessage[] {
  // IPC 事件可能缺字段/类型不对：先挡住，避免 delta.length 在渲染期抛错拖垮整棵树。
  if (typeof delta !== "string" || !delta) return messages;
  const index = messages.findIndex((message) => message.id === id);
  if (index === -1) {
    return [
      ...messages,
      {
        id,
        role: "assistant",
        text: delta,
        tail: delta,
        tailSeq: options.tailSeq,
        status: "streaming",
        createdAt: options.now ?? Date.now(),
        timeline: [{ kind: "body", text: delta }],
      },
    ];
  }
  const next = [...messages];
  next[index] = {
    ...next[index],
    text: next[index].text + delta,
    tail: delta,
    tailSeq: options.tailSeq ?? next[index].tailSeq,
    status: "streaming",
    timeline: appendTimelineStep(next[index].timeline ?? [], { kind: "body", text: delta }),
  };
  return next;
}

/**
 * 迟到增量（done 之后才到达的尾部 chunk）：**绝不再新建一条助手消息**。
 *
 * 收尾顺序缺陷（done 先于最后一批增量推出，旧服务的 finally 顺序 / 旧构建）会让渲染层在
 * activeId 已清空后收到 chunk；旧实现用 `nextId("a")` 新建气泡 ⇒ 正文被劈成两条：
 * 前半缺尾、后半只有寥寥几字，只有重启 App 从会话库重读完整 finalText 才恢复。
 *
 * 这里把迟到增量并回**最后一条助手消息**（通常就是刚 done 的那条），正文始终完整；
 * 一条助手都没有时才退回正常创建。
 */
export function applyLateChunk(
  messages: ChatMessage[],
  delta: string,
  options: { tailSeq?: number; fallbackId?: string; now?: number } = {},
): ChatMessage[] {
  if (typeof delta !== "string" || !delta) return messages;
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      index = i;
      break;
    }
  }
  if (index === -1) {
    return applyChunk(messages, options.fallbackId ?? `a-late-${Date.now()}`, delta, options);
  }
  const target = messages[index];
  if (target.status === "streaming") {
    return applyChunk(messages, target.id, delta, options);
  }
  const next = [...messages];
  // 迟到 chunk 去重：done 已用权威全文覆盖 text 时，若这段增量已经是正文尾部，不再重复追加
  //（重复追加会在界面上出现「后半段被写两遍」，同样属于内容错误）。
  const alreadyIncluded = delta.length > 0 && target.text.endsWith(delta);
  next[index] = {
    ...target,
    text: alreadyIncluded ? target.text : target.text + delta,
    tail: alreadyIncluded ? target.tail : delta,
    tailSeq: options.tailSeq ?? target.tailSeq,
    timeline: alreadyIncluded ? target.timeline : appendTimelineStep(target.timeline ?? [], { kind: "body", text: delta }),
  };
  return next;
}

/** 思考增量。 */
export function applyReasoning(messages: ChatMessage[], id: string, delta: string): ChatMessage[] {
  if (typeof delta !== "string" || !delta) return messages;
  return messages.map((message) =>
    message.id === id
      ? { ...message, timeline: appendTimelineStep(message.timeline ?? [], { kind: "think", text: delta }) }
      : message,
  );
}

/** 工具开始（运行中节点，UI 显示呼吸状态）。 */
export function applyToolStart(messages: ChatMessage[], id: string, raw: string): ChatMessage[] {
  let started: { toolCallId?: string; toolName?: string; args?: unknown } = {};
  try {
    started = JSON.parse(raw) as typeof started;
  } catch {
    return messages;
  }
  if (!started.toolCallId || !started.toolName) return messages;
  // 事件来自 IPC/持久化：运行时可能是非字符串，渲染层会 .replace/.match 崩溃，这里先归一。
  const toolCallId = typeof started.toolCallId === "string" ? started.toolCallId : String(started.toolCallId);
  const toolName = typeof started.toolName === "string" ? started.toolName : String(started.toolName);
  return messages.map((message) =>
    message.id === id
      ? {
          ...message,
          timeline: appendTimelineStep(message.timeline ?? [], {
            kind: "tool",
            id: toolCallId,
            name: toolName,
            label: toolName,
            detail: extractToolDetail(toolName, started.args),
            state: "running",
          }),
        }
      : message,
  );
}

/** 工具结果：有同 id 的运行中节点则落定，否则直接追加完成节点；规划类工具折叠成规划卡 + 播报。 */
export function applyToolResult(messages: ChatMessage[], id: string, raw: string, newToolId: string): ChatMessage[] {
  let payload: {
    toolCallId?: string;
    toolName?: string;
    name?: string;
    tool?: string;
    args?: unknown;
    result?: { ok?: boolean; content?: string; error?: string };
  } = {};
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    payload = { result: { ok: false, content: raw.slice(0, 2000) } };
  }
  const rawToolName =
    typeof payload.toolName === "string"
      ? payload.toolName
      : typeof payload.name === "string"
        ? payload.name
        : typeof payload.tool === "string"
          ? payload.tool
          : "工具";
  const toolName = rawToolName || "工具";
  const toolArgs = typeof payload.args === "string" ? safeJson(payload.args) : payload.args;
  const toolResult = payload.result ?? null;
  // result.content 运行时可能是结构化对象；先归一成字符串，避免 parsePlanItems/.match 抛错。
  const rawResult = toolResult?.content ?? toolResult?.error;
  const resultText =
    typeof rawResult === "string"
      ? rawResult
      : rawResult == null
        ? ""
        : (() => {
            try {
              return JSON.stringify(rawResult);
            } catch {
              return String(rawResult);
            }
          })();
  const plan = parsePlanArgs(toolName, toolArgs);
  const planItems: PlanItem[] | null =
    plan ??
    (/todo|plan|task/i.test(toolName) && resultText ? (() => {
      const parsed = parsePlanItems(resultText);
      return parsed.length > 0 ? parsed : null;
    })() : null);

  return messages.map((message) => {
    if (message.id !== id) return message;
    let timeline = message.timeline ?? [];
    const running = Boolean(payload.toolCallId) && timeline.some((step) => step.kind === "tool" && step.id === payload.toolCallId);
    timeline = running
      ? settleToolStep(timeline, payload.toolCallId!, { ok: toolResult?.ok !== false, result: resultText || undefined })
      : appendTimelineStep(timeline, {
          kind: "tool",
          id: payload.toolCallId ?? newToolId,
          name: toolName,
          label: toolName,
          detail: extractToolDetail(toolName, toolArgs, resultText),
          result: resultText || undefined,
          ok: toolResult?.ok !== false,
          state: "done",
        });
    if (planItems) timeline = foldPlanUpdate(timeline, planItems, lastPlanItems(timeline));
    return { ...message, timeline };
  });
}

/** 用户引导（steer）折进时间线。 */
export function applySteer(messages: ChatMessage[], id: string, text: string): ChatMessage[] {
  if (typeof text !== "string" || !text.trim()) return messages;
  return messages.map((message) =>
    message.id === id ? { ...message, timeline: appendTimelineStep(message.timeline ?? [], { kind: "steer", text }) } : message,
  );
}

/**
 * 注入回执（chat:steer:applied）到达时：把引导文案折进「最后一条」assistant 消息的时间线。
 *
 * 旧实现是在发送时乐观调用 applySteer：主进程可能在轮次边界才注入（也可能注入前被撤销），
 * 只有回执才是既成事实；先塞会让用户看到一条并未生效的引导卡。
 */
export function applySteerToLatest(messages: ChatMessage[], text: string): ChatMessage[] {
  const content = text.trim();
  if (!content) return messages;
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      index = i;
      break;
    }
  }
  if (index === -1) return messages;
  return messages.map((message, i) =>
    i === index ? { ...message, timeline: appendTimelineStep(message.timeline ?? [], { kind: "steer", text: content }) } : message,
  );
}

/** 解析 done 事件内容（状态/原因/usage）。 */
export function parseDone(raw: string | undefined): DoneInfo {
  try {
    const parsed = JSON.parse(raw ?? "{}") as {
      status?: string;
      reason?: string;
      usage?: { rounds?: number; toolCalls?: number; totalTokens?: number };
      finalText?: string;
    };
    const finalText = typeof parsed.finalText === "string" ? parsed.finalText : undefined;
    if (parsed.status && parsed.status !== "done") {
      return {
        usage: parsed.usage ?? {},
        interrupted: { status: parsed.status, reason: parsed.reason ?? "未提供原因" },
        statusText: `已中断（${parsed.status}）：${parsed.reason ?? ""}`,
        ...(finalText !== undefined ? { finalText } : {}),
      };
    }
    return { usage: parsed.usage ?? {}, statusText: "完成", ...(finalText !== undefined ? { finalText } : {}) };
  } catch {
    return { usage: {}, statusText: "完成" };
  }
}

/** 中止收尾：把仍处于 running 的工具节点落定为「已停止」，避免历史里永远显示「执行中」。 */
export function settleAbortedTools(steps: TimelineStep[] | undefined): TimelineStep[] | undefined {
  if (!steps || steps.length === 0) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.kind === "tool" && step.state === "running") {
      changed = true;
      return { ...step, state: "done" as const, ok: false, result: step.result ?? "已停止" };
    }
    return step;
  });
  return changed ? next : steps;
}

/** 收尾：所有 streaming 消息落定，记录耗时与中断原因。 */
export function applyDone(
  messages: ChatMessage[],
  info: DoneInfo,
  timing: { startedAt: number; firstTokenAt: number; now?: number },
): ChatMessage[] {
  const firstMs = timing.firstTokenAt > 0 && timing.startedAt > 0 ? timing.firstTokenAt - timing.startedAt : undefined;
  const totalMs = timing.startedAt > 0 ? (timing.now ?? Date.now()) - timing.startedAt : undefined;
  return messages.map((message) => {
    if (message.status !== "streaming") return message;
    // done 携带服务端权威全文：直接覆盖本地累积文本。
    // 为什么：流式 chunk 可能在传输/处理后丢失（迟到、过滤缓冲、边界 bug），
    // 本地拼接一旦少一段就是用户看到的「截断」；权威全文是唯一可信来源（m02515）。
    const authoritative = typeof info.finalText === "string" && info.finalText.length > 0 ? info.finalText : undefined;
    return {
      ...message,
      ...(authoritative !== undefined ? { text: authoritative } : {}),
      status: "done",
      tail: undefined,
      timing: { firstTokenMs: firstMs, totalMs, ...info.usage },
      ...(info.interrupted
        ? { interrupted: info.interrupted, timeline: settleAbortedTools(message.timeline) }
        : {}),
    };
  });
}

/** 从持久化历史恢复消息（timeline 原样恢复，旧会话没有就不显示思考卡）。 */
export function restoreMessages(
  history: {
    role: "user" | "assistant";
    text: string;
    timeline?: unknown[];
    provider?: string;
    model?: string;
  }[],
  newId: (role: string) => string,
): ChatMessage[] {
  return history.map((message) => ({
    id: newId(message.role),
    role: message.role,
    // 持久化历史可能来自旧版本/被外部改坏：text 与 timeline 必须过一遍结构校验，
    // 否则渲染层的 .trim/.replace 会抛错并带着整棵树一起卸载（黑屏）。
    text: typeof message.text === "string" ? message.text : "",
    status: "done" as const,
    ...(message.provider ? { provider: message.provider } : {}),
    ...(message.model ? { model: message.model } : {}),
    timeline: Array.isArray(message.timeline) ? sanitizeTimeline(message.timeline) : undefined,
  }));
}

/** 只保留渲染层能安全消费的时间线节点；结构不对的直接丢弃，而不是让渲染期抛错。 */
function sanitizeTimeline(raw: unknown[]): TimelineStep[] | undefined {
  const steps: TimelineStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const step = item as Record<string, unknown>;
    const kind = step.kind;
    if (kind === "think" || kind === "body" || kind === "steer") {
      if (typeof step.text !== "string") continue;
    } else if (kind === "tool") {
      if (typeof step.id !== "string" || typeof step.name !== "string") continue;
    } else if (kind === "plan") {
      if (!Array.isArray(step.items)) continue;
    } else if (kind === "todo") {
      if (typeof step.text !== "string" || typeof step.state !== "string") continue;
    } else {
      continue;
    }
    steps.push(step as unknown as TimelineStep);
  }
  return steps.length > 0 ? steps : undefined;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parsePlanArgs(toolName: string, toolArgs: unknown): PlanItem[] | null {
  if (!/todo|plan|task/i.test(toolName)) return null;
  const args = (toolArgs ?? {}) as Record<string, unknown>;
  const rawSteps = args.steps ?? args.todos ?? args.items ?? args.plan ?? args.tasks;
  if (!Array.isArray(rawSteps)) return null;
  const statusOf = (value: unknown): PlanItem["status"] => {
    const text = String(value ?? "").toLowerCase();
    if (text === "done" || text === "completed" || text === "complete" || text === "success") return "completed";
    if (text === "in_progress" || text === "running" || text === "active" || text === "doing") return "in_progress";
    return "pending";
  };
  const items: PlanItem[] = rawSteps
    .map((step, index) => {
      if (typeof step === "string") return { id: String(index + 1), content: step, status: "pending" as const };
      if (step && typeof step === "object") {
        const record = step as Record<string, unknown>;
        const content = String(record.content ?? record.text ?? record.title ?? record.task ?? "").trim();
        if (!content) return null;
        return { id: String(index + 1), content, status: statusOf(record.status ?? record.state) };
      }
      return null;
    })
    .filter((item): item is PlanItem => item !== null)
    .slice(0, 30);
  return items.length > 0 ? items : null;
}


/** 每个会话独立的流状态：切走/切回时按会话恢复，不串台。 */
export interface SessionStreamMeta {
  activeId: string | null;
  startedAt: number;
  firstTokenAt: number;
  busy: boolean;
  stopping: boolean;
}

export function createSessionStreamMeta(): SessionStreamMeta {
  return { activeId: null, startedAt: 0, firstTokenAt: 0, busy: false, stopping: false };
}
