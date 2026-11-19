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
