/**
 * 上下文自动压缩（纯逻辑，无 IO/LLM 依赖）。
 *
 * 问题：长会话把所有历史都塞给模型 → 上下文爆掉 / 上游 400 / 费用失控；
 * 直接截断又会让模型"失忆"，出现莫名截断（slime 的坏经验）。
 *
 * 策略（确定性、可测试，不额外调用模型）：
 *   1. system 消息永远保留在最前面；
 *   2. 最近的 N 条消息原样保留（默认 14 条）；
 *   3. 更早的消息压成一段「早期对话摘要」：每条保留角色 + 前 K 字符（默认 240），
 *      并明确标注「已自动压缩 N 条」；
 *   4. 总字符超过预算才触发；压缩后仍可能超预算时，进一步减少保留条数/摘要长度。
 * 为什么不用 LLM 总结：多一次请求 = 多一次失败/延迟/费用；确定性摘要对"记住用户需求/已做决定"足够。
 */

export interface CompactableMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; name: string; args: unknown }[];
  tool_call_id?: string;
}

export interface ContextCompressOptions {
  /** 触发/目标预算（字符数，粗略等价于 token×3）。 */
  budgetChars?: number;
  /** 原样保留的最近消息条数。 */
  keepRecent?: number;
  /**
   * 收紧压缩时「最近消息」的下限（条数）。默认 2（允许为进预算牺牲保留条数）；
   * /compact 这类用户显式操作传 14，保证「摘要 + 最近 14 条」的可预期语义。
   */
  minKeepRecent?: number;
  /** 摘要中每条早期消息保留的字符数。 */
  summaryItemChars?: number;
}

export interface ContextCompressResult {
  messages: CompactableMessage[];
  compressed: boolean;
  droppedCount: number;
  beforeChars: number;
  afterChars: number;
  /** 压缩摘要（供 UI/日志展示；未压缩时为空）。 */
  summary: string;
  /** 尝试所有收紧策略后仍超出预算（说明历史仍可能超过模型上下文，调用方应给用户可见提示）。 */
  stillOverBudget?: boolean;
}

export const DEFAULT_CONTEXT_BUDGET_CHARS = 60_000;
export const DEFAULT_KEEP_RECENT = 14;
export const DEFAULT_SUMMARY_ITEM_CHARS = 240;

/** 估算消息字符数（含工具调用参数；用于预算判断）。 */
export function messageChars(message: CompactableMessage): number {
  let total = message.content.length;
  for (const call of message.tool_calls ?? []) {
    total += call.name.length + 32;
    try {
      total += JSON.stringify(call.args ?? {}).length;
    } catch {
      // 循环引用等异常：按 0 计
    }
  }
  return total;
}

/** 摘要行：去掉多余空白，截断到 itemChars。 */
function summarizeMessage(message: CompactableMessage, itemChars: number): string {
  const text = message.content.replace(/\s+/g, " ").trim();
  const clipped = text.length > itemChars ? `${text.slice(0, itemChars)}…` : text;
  const label = message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role === "tool" ? "工具" : "系统";
  return `- ${label}：${clipped}`;
}

/**
 * 压缩会话历史。
 * 新消息（本轮 user 消息、volatile 注入）不应传进来——只压缩历史部分。
 */
export function compressConversation(
  messages: CompactableMessage[],
  options: ContextCompressOptions = {},
): ContextCompressResult {
  const budgetChars = Math.max(4000, options.budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS);
  const beforeChars = messages.reduce((sum, message) => sum + messageChars(message), 0);
  const systemMessages = messages.filter((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");
  if (beforeChars <= budgetChars || conversation.length <= 1) {
    return { messages, compressed: false, droppedCount: 0, beforeChars, afterChars: beforeChars, summary: "" };
  }

  let keepRecent = Math.min(Math.max(1, options.keepRecent ?? DEFAULT_KEEP_RECENT), conversation.length - 1);
  let summaryItemChars = Math.max(40, options.summaryItemChars ?? DEFAULT_SUMMARY_ITEM_CHARS);
  const minKeepRecent = Math.max(1, Math.floor(options.minKeepRecent ?? 2));

  // 尽量收紧直到进入预算；最近 N 条消息**永远不会被截断**（只减少保留条数/压缩更早的摘要），
  // 因为那才是模型继续任务所需的上下文。若穷尽策略仍超预算，返回 stillOverBudget 让调用方可见提示。
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const older = conversation.slice(0, conversation.length - keepRecent);
    const recent = conversation.slice(-keepRecent);
    // 上游要求 tool 消息必须紧跟对应的 assistant(tool_calls)。压缩边界若正好切在
    // tool 轮中间，保留窗口会以 role="tool" 开头 → 请求 400。丢弃这些孤儿工具结果。
    while (recent.length > 1 && recent[0]?.role === "tool") recent.shift();
    const summaryLines = older.map((message) => summarizeMessage(message, summaryItemChars));
    const summary = [
      "## 早期对话摘要（系统自动压缩，原文仍保存在本地会话记录中）",
      ...summaryLines,
      `（以上 ${older.length} 条早期消息已压缩；最近 ${recent.length} 条保留原文）`,
    ].join("\n");
    const compacted: CompactableMessage[] = [
      ...systemMessages,
      { role: "system", content: summary },
      ...recent,
    ];
    const afterChars = compacted.reduce((sum, message) => sum + messageChars(message), 0);
    if (afterChars <= budgetChars || attempt === 7) {
      return {
        messages: compacted,
        compressed: true,
        droppedCount: older.length,
        beforeChars,
        afterChars,
        summary: `已自动压缩 ${older.length} 条早期消息（${beforeChars} → ${afterChars} 字符）`,
        ...(afterChars > budgetChars ? { stillOverBudget: true } : {}),
      };
    }
    keepRecent = Math.max(minKeepRecent, Math.floor(keepRecent * 0.6));
    summaryItemChars = Math.max(40, Math.floor(summaryItemChars * 0.7));
  }
  // 理论不可达
  return { messages, compressed: false, droppedCount: 0, beforeChars, afterChars: beforeChars, summary: "" };
}

/**
 * 由模型上下文窗口（token）推导历史预算字符数。
 * 口径：历史占上下文窗口 ~60%（其余留给 system/工具结果/输出），中英混合约 2 字符/token；
 * 未探测到窗口时用保守默认 6 万字符（≈ 2.4~3 万 token），宁可多压缩，也不让上游静默截断提示词。
 * 注意：旧实现有 32k 字符下限，对 8k/16k 窗口的小模型会把历史撑爆 → 上游 400 或静默丢上下文。
 */
export function historyBudgetChars(contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return DEFAULT_CONTEXT_BUDGET_CHARS;
  return Math.max(8_000, Math.min(600_000, Math.floor(contextWindowTokens * 1.2)));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * token 估算 + loop 内上下文压缩
 *
 * 为什么单独一套：上半部分的 compressConversation 是「一轮对话开始前」对持久化历史做的
 * 一次性压缩（字符口径）；而工具循环里每一轮都会追加 assistant 工具调用 + 工具结果，
 * 一轮对话内部就可能把窗口撑爆。因此需要：
 *   1. 按 **token** 口径估算整份 prompt（含工具 schema），与模型上下文窗口对齐；
 *   2. 每轮请求前滚动压缩，且**不反复咀嚼上一版摘要**（否则信息逐轮衰减）；
 *   3. 压缩边界不能切开 assistant(tool_calls) / tool 结果这一对，否则上游直接 400。
 * 纯逻辑、零 IO、零模型调用：可单测、可复现。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 单条消息的模板开销（角色标记 / 分隔符），各家 chat 模板不同，取保守值。 */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** 一张图片按低细节估算的 token（不真实解码，避免为估算做 IO）。 */
const IMAGE_TOKENS = 1_200;
/** loop 压缩纪要的固定标记：后续压缩据此识别「这是上一版纪要」，合并而不是再摘要。 */
export const LOOP_SUMMARY_MARKER = "## 上下文压缩纪要（loop 自动维护，原文仍在本地会话记录中）";
/** 换行符常量：避免在源码里写转义字符（易被编辑器/传输层二次解释）。 */
const NEWLINE = String.fromCharCode(10);

/** 可参与 token 估算的内容块（兼容 LlmContentPart 的文本/图片两种形态）。 */
export type TokenContentPart = { type: string; text?: string; base64?: string };
export interface TokenizableMessage {
  role: string;
  content: string | readonly TokenContentPart[];
  tool_calls?: readonly { name: string; args?: unknown }[];
}

/** CJK / 全角字符：多数分词器接近 1 字 1 token。 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // 汉字扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 汉字基本区
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
    (cp >= 0xff00 && cp <= 0xffef) // 全角标点/字母
  );
}

/**
 * 文本 → token 估算（确定性，不引入分词器依赖）。
 *
 * 口径：CJK ≈ 1 字/token；其余 ≈ 3.6 字符/token（英文/代码/JSON 的经验均值）。
 * 旧实现统一按「4 字符 = 1 token」：中文会被低估约 3.5 倍 —— 上下文进度环偏低，
 * 压缩迟迟不触发，直到上游 400 才暴露。这里按字符类别分别计。
 */
export function estimateTokens(text: string): number {
  const value = typeof text === "string" ? text : "";
  if (!value) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of value) {
    if (isCjkCodePoint(char.codePointAt(0) ?? 0)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 3.6));
}

/** 内容 → 纯文本（图片按固定 token 计，不把 base64 当文本算）。 */
function contentText(content: string | readonly TokenContentPart[] | undefined): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("");
}

/** 内容里的图片张数。 */
function contentImages(content: string | readonly TokenContentPart[] | undefined): number {
  if (!content || typeof content === "string") return 0;
  return content.reduce((count, part) => count + (part.type === "image" ? 1 : 0), 0);
}

/** 单条消息的 token 估算（含工具调用参数）。 */
export function estimateMessageTokens(message: TokenizableMessage): number {
  let total = estimateTokens(contentText(message.content)) + MESSAGE_OVERHEAD_TOKENS;
  total += contentImages(message.content) * IMAGE_TOKENS;
  for (const call of message.tool_calls ?? []) {
    total += estimateTokens(call.name);
    try {
      total += estimateTokens(JSON.stringify(call.args ?? {}));
    } catch {
      // 循环引用等异常：参数按 0 计，不阻断压缩
    }
  }
  return total;
}

/** 整段消息的 token 估算。 */
export function estimateMessagesTokens(messages: readonly TokenizableMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/**
 * 工具 schema 的 token 估算：工具面本身也占 prompt（Loopsoar 内置 + MCP 可达数万 token），
 * 不计入就会「估算很宽松、实际已爆窗」。
 */
export function estimateToolsTokens(
  tools: readonly { name: string; description?: string; parameters?: unknown }[],
): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name) + estimateTokens(tool.description ?? "");
    try {
      total += estimateTokens(JSON.stringify(tool.parameters ?? {}));
    } catch {
      // 忽略不可序列化的 schema
    }
    total += MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/** 消息的字符数（与 token 估算同一份内容口径：文本 + 工具参数 JSON）。 */
export function estimateMessageChars(message: TokenizableMessage): number {
  let total = contentText(message.content).length;
  for (const call of message.tool_calls ?? []) {
    try {
      total += JSON.stringify(call.args ?? {}).length;
    } catch {
      // 忽略不可序列化参数
    }
  }
  return total;
}

/**
 * 把「token 目标」换算成 compressConversation 需要的**字符预算**。
 *
 * 为什么必须按当前这批消息换算：中文 ≈1 字/token、英文/代码 ≈3.6 字符/token。
 * 旧实现固定按 4 字符/token 反推（historyBudgetChars = window×1.2 字符），
 * 对中文相当于允许 1.2×窗口 token 的历史 —— 压缩永远不触发，直到上游 400。
 * 这里用这批消息自己的 token/字符比缩放，中英混排都能落在目标附近。
 */
export function budgetCharsForTokenTarget(
  messages: readonly TokenizableMessage[],
  targetTokens: number,
  options: { floorChars?: number } = {},
): number {
  const floorChars = Math.max(1000, Math.floor(options.floorChars ?? 4000));
  const tokens = estimateMessagesTokens(messages);
  const chars = messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
  if (tokens <= 0 || chars <= 0) return Math.max(floorChars, Math.floor(targetTokens));
  // 比例做防御性夹取：异常内容（纯符号/超长 base64）不应把预算算到天上或地下。
  const ratio = Math.max(0.25, Math.min(4, chars / tokens));
  return Math.max(floorChars, Math.floor(targetTokens * ratio));
}

/** loop 压缩选项（全部可选，默认值面向「128k 上下文 + 中文会话」调过）。 */
export interface LoopCompressOptions {
  /** 模型上下文窗口（tokens）；必填，压缩阈值都按它算。 */
  contextWindowTokens: number;
  /** 触发压缩的占比（占窗口，默认 0.75）。 */
  triggerRatio?: number;
  /** 压缩目标占比（占窗口，默认 0.55）：穷尽策略后仍高于它 → stillOverBudget。 */
  targetRatio?: number;
  /** 首次原样保留的最近消息条数（默认 12）。 */
  keepRecent?: number;
  /** 收紧时的保留下限（默认 4）：再少就会丢掉「刚做完什么」。 */
  minKeepRecent?: number;
  /** 纪要里每条早期消息保留的字符数（默认 200）。 */
  summaryItemChars?: number;
  /** 纪要最多保留的行数（默认 60）：超出时保留最早 5 行（目标/约束）+ 最近若干行。 */
  maxSummaryLines?: number;
  /** 工具 schema 的 token 数（由调用方用 estimateToolsTokens 计算）。 */
  toolsTokens?: number;
}

/** 一次上下文快照（UI 进度环直接消费）。 */
export interface LoopContextStats {
  /** 估算的 prompt 总量 = 消息 + 工具 schema。 */
  usedTokens: number;
  messageTokens: number;
  toolsTokens: number;
  windowTokens: number;
  /** usedTokens / windowTokens（0~1+）。 */
  ratio: number;
}

export interface LoopCompressResult<T extends TokenizableMessage> {
  /** 压缩后的消息（未压缩时是原数组的浅拷贝）。 */
  messages: T[];
  compressed: boolean;
  /** 进入纪要的早期消息条数。 */
  droppedCount: number;
  /** 实际保留的最近消息条数。 */
  keepRecent: number;
  beforeTokens: number;
  afterTokens: number;
  /** 压缩后的上下文快照（未压缩时也给出，UI 用它画进度环）。 */
  stats: LoopContextStats;
  /** 穷尽收紧后仍高于触发阈值（调用方应给出可见提示）。 */
  stillOverBudget?: boolean;
  /** 一句人读摘要（未压缩时为空串）。 */
  summary: string;
}

/** 这条消息是不是上一版 loop 纪要。 */
export function isLoopSummary(message: TokenizableMessage): boolean {
  return message.role === "system" && typeof message.content === "string" && message.content.startsWith(LOOP_SUMMARY_MARKER);
}

/** 纪要正文（去掉标记行）。 */
function summaryBodyOf(message: TokenizableMessage): string {
  if (typeof message.content !== "string") return "";
  const index = message.content.indexOf(NEWLINE);
  return index >= 0 ? message.content.slice(index + 1) : "";
}

/** 单条早期消息 → 一行纪要（工具调用折叠成「→工具名」）。 */
function summarizeForLoop(message: TokenizableMessage, itemChars: number): string {
  const role =
    message.role === "user"
      ? "用户"
      : message.role === "assistant"
        ? "助手"
        : message.role === "tool"
          ? "工具结果"
          : message.role;
  const text = contentText(message.content).replace(/[ \t\r\n]+/g, " ").trim();
  const clipped = text.length > itemChars ? `${text.slice(0, itemChars)}…` : text;
  const calls = (message.tool_calls ?? []).map((call) => call.name).join("、");
  const suffix = calls ? `（调用 ${calls}）` : "";
  return `- ${role}：${clipped}${suffix}`;
}

/**
 * 合并「上一版纪要 + 本轮新折叠的早期消息」。
 *
 * 关键：上一版纪要**原样保留**（只按行裁剪），不重新摘要 —— 重新摘要会让同一段信息
 * 每次压缩再打一次折扣，几轮之后用户最初的目标就消失了（slime 的「莫名失忆」）。
 * 行数超限时保留最早 5 行（目标/约束/决策）+ 最近若干行（当前进展）。
 */
function mergeSummaryLines(previousBody: string, newLines: string[], maxLines: number, maxChars: number): string {
  const previous = previousBody
    .split(NEWLINE)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const all = [...previous, ...newLines];

  let lines = all;
  if (all.length > maxLines) {
    const headCount = Math.min(5, Math.floor(maxLines / 3));
    const tailCount = Math.max(1, maxLines - headCount - 1);
    const omitted = all.length - headCount - tailCount;
    lines = [
      ...all.slice(0, headCount),
      "- （更早的 " + omitted + " 条纪要行已折叠；本地会话记录仍保留原文）",
      ...all.slice(all.length - tailCount),
    ];
  }

  // 字数上限是硬约束：纪要本身也可能把预算吃光（早期消息很多时尤其明显）。
  // 截断策略与行数一致：保留最早一行（通常是用户目标）+ 最近的若干行。
  let joined = lines.join(NEWLINE);
  if (joined.length <= maxChars || lines.length <= 2) {
    return joined.length > maxChars ? joined.slice(0, Math.max(0, maxChars)) : joined;
  }
  const head = lines[0];
  const tail: string[] = [];
  let used = head.length;
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    const line = lines[index];
    if (used + line.length + 1 > maxChars) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  joined = [head, "- （中间 " + (lines.length - 1 - tail.length) + " 条纪要行已折叠）", ...tail].join(NEWLINE);
  return joined.length > maxChars ? joined.slice(0, Math.max(0, maxChars)) : joined;
}

/**
 * loop 内上下文压缩：每轮 LLM 请求前调用（纯函数）。
 *
 * 策略：
 *   1. system 消息（稳定提示 + 上一版纪要之外的系统段）永远保留在最前；
 *   2. 最近 N 条原样保留；边界若落在 tool 消息上，回头补齐它的 assistant(tool_calls)，
 *      保证「assistant 调用 → tool 结果」不被切开；
 *   3. 更早的消息折叠进滚动纪要（上一版纪要原样带过来，不二次摘要）；
 *   4. 一次进入目标就返回；否则逐步收紧保留条数，最多 8 轮；仍超阈值 → stillOverBudget。
 */
export function compressForLoop<T extends TokenizableMessage>(
  messages: readonly T[],
  options: LoopCompressOptions,
): LoopCompressResult<T> {
  const windowTokens = Math.max(1024, Math.floor(options.contextWindowTokens));
  const triggerRatio = Math.min(0.98, Math.max(0.3, options.triggerRatio ?? 0.75));
  const targetRatio = Math.min(triggerRatio, Math.max(0.2, options.targetRatio ?? 0.55));
  const triggerTokens = Math.floor(windowTokens * triggerRatio);
  const targetTokens = Math.floor(windowTokens * targetRatio);
  const toolsTokens = Math.max(0, Math.floor(options.toolsTokens ?? 0));
  let itemChars = Math.max(40, Math.floor(options.summaryItemChars ?? 200));
  const maxLines = Math.max(8, Math.floor(options.maxSummaryLines ?? 60));
  // 纪要最多占目标的 50%（chars≈tokens 对中文成立；英文下这只会更保守）。
  const summaryCharBudget = Math.max(400, Math.floor(targetTokens * 0.5));
  const minKeepRecent = Math.max(2, Math.floor(options.minKeepRecent ?? 4));

  const messageTokens = estimateMessagesTokens(messages);
  const beforeTokens = messageTokens + toolsTokens;
  const snapshot = (usedTokens: number): LoopContextStats => ({
    usedTokens,
    messageTokens: Math.max(0, usedTokens - toolsTokens),
    toolsTokens,
    windowTokens,
    ratio: windowTokens > 0 ? usedTokens / windowTokens : 0,
  });

  const unchanged = (): LoopCompressResult<T> => ({
    messages: [...messages],
    compressed: false,
    droppedCount: 0,
    keepRecent: 0,
    beforeTokens,
    afterTokens: beforeTokens,
    stats: snapshot(beforeTokens),
    summary: "",
  });

  // 没到触发线 / 消息太少：不动（压缩本身也有信息损耗，不能无谓触发）。
  if (beforeTokens <= triggerTokens || messages.length <= 2) return unchanged();

  const systems = messages.filter((message) => message.role === "system" && !isLoopSummary(message)) as T[];
  const previousSummary = messages.filter(isLoopSummary).map(summaryBodyOf).filter(Boolean).join("\n");
  const conversation = messages.filter((message) => message.role !== "system") as T[];
  if (conversation.length <= 1) return unchanged();

  let keepRecent = Math.min(
    Math.max(minKeepRecent, Math.floor(options.keepRecent ?? 12)),
    Math.max(minKeepRecent, conversation.length - 1),
  );

  for (let attempt = 0; attempt < 8; attempt += 1) {
    let cut = Math.max(0, conversation.length - keepRecent);
    // 边界落在 tool 消息上：回头补齐 assistant(tool_calls)，否则保留窗口以孤儿 tool 开头 → 上游 400。
    while (cut > 0 && conversation[cut]?.role === "tool") cut -= 1;
    if (cut <= 0) return { ...unchanged(), stillOverBudget: true };

    const older = conversation.slice(0, cut);
    const recent = conversation.slice(cut);
    const lines = older.map((message) => summarizeForLoop(message, itemChars));
    const body = mergeSummaryLines(previousSummary, lines, maxLines, summaryCharBudget);
    const summaryMessage = {
      role: "system" as const,
      content: `${LOOP_SUMMARY_MARKER}\n${body}`,
    } as unknown as T;
    const next = [...systems, summaryMessage, ...recent];
    const afterTokens = estimateMessagesTokens(next) + toolsTokens;

    if (afterTokens <= targetTokens || attempt === 7) {
      return {
        messages: next,
        compressed: true,
        droppedCount: countDropped(older),
        keepRecent: recent.length,
        beforeTokens,
        afterTokens,
        stats: snapshot(afterTokens),
        ...(afterTokens > triggerTokens ? { stillOverBudget: true } : {}),
        summary: `loop 上下文压缩：${countDropped(older)} 条早期消息 → 纪要（${beforeTokens} → ${afterTokens} tokens）`,
      };
    }
    // 两个收紧杠杆：保留条数（最近消息本身过大时）与每条纪要长度（早期消息过多时）。
    // 只收 keepRecent 会在「早期消息很多」时越压越大（更多消息进入纪要），所以必须同时收 itemChars。
    keepRecent = Math.max(minKeepRecent, Math.floor(keepRecent * 0.7));
    itemChars = Math.max(60, Math.floor(itemChars * 0.7));
  }

  // 理论不可达（循环内 attempt===7 必返回）
  return { ...unchanged(), stillOverBudget: true };
}

/** 参与折叠的消息条数（排除上一版纪要合成消息，它不计入「被压缩的原始消息」）。 */
function countDropped(messages: readonly TokenizableMessage[]): number {
  return messages.filter((message) => !isLoopSummary(message)).length;
}

