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
}

export const DEFAULT_CONTEXT_BUDGET_CHARS = 120_000;
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

  // 最多尝试 4 轮收紧：保留更少最近消息 + 更短摘要，直到进入预算
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const older = conversation.slice(0, conversation.length - keepRecent);
    const recent = conversation.slice(-keepRecent);
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
    if (afterChars <= budgetChars || attempt === 3) {
      return {
        messages: compacted,
        compressed: true,
        droppedCount: older.length,
        beforeChars,
        afterChars,
        summary: `已自动压缩 ${older.length} 条早期消息（${beforeChars} → ${afterChars} 字符）`,
      };
    }
    keepRecent = Math.max(2, Math.floor(keepRecent * 0.6));
    summaryItemChars = Math.max(40, Math.floor(summaryItemChars * 0.7));
  }
  // 理论不可达
  return { messages, compressed: false, droppedCount: 0, beforeChars, afterChars: beforeChars, summary: "" };
}

/** 由模型上下文窗口（token）推导历史预算字符数（预留一半给输出/工具/注入）。 */
export function historyBudgetChars(contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return DEFAULT_CONTEXT_BUDGET_CHARS;
  // 经验：中英混合 ≈ 2.5~3 字符/token；历史只占上下文窗口的 50%，其余留给系统段/工具结果/输出。
  return Math.max(32_000, Math.min(600_000, Math.floor(contextWindowTokens * 3 * 0.5)));
}
