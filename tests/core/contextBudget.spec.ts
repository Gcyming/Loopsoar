/**
 * 上下文预算与压缩（m02515 截断根除）：
 *   · 小窗口模型不能再用「32k 字符下限」把提示词撑爆（旧实现 historyBudgetChars 的下限是 32000）；
 *   · 未探测到窗口时用保守默认；
 *   · 压缩只动早期消息，最近消息（模型继续任务所需）必须原文保留；
 *   · 穷尽收紧仍超预算时返回 stillOverBudget，供 UI/服务给出可见提示。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_BUDGET_CHARS,
  compressConversation,
  historyBudgetChars,
  type CompactableMessage,
} from "../../packages/core/src/contextCompress.ts";

describe("historyBudgetChars", () => {
  it("小上下文窗口不再被 32k 字符下限撑爆", () => {
    const budget = historyBudgetChars(8_192);
    expect(budget).toBeLessThan(12_000);
    expect(budget).toBeGreaterThan(0);
  });

  it("未探测到窗口时使用保守默认", () => {
    expect(historyBudgetChars(undefined)).toBe(DEFAULT_CONTEXT_BUDGET_CHARS);
    expect(DEFAULT_CONTEXT_BUDGET_CHARS).toBeLessThanOrEqual(60_000);
  });

  it("大窗口按比例放大但封顶 60 万字符", () => {
    expect(historyBudgetChars(128_000)).toBe(Math.floor(128_000 * 1.2));
    expect(historyBudgetChars(2_000_000)).toBe(600_000);
  });
});

function msg(role: "user" | "assistant", text: string): CompactableMessage {
  return { role, content: text };
}

describe("compressConversation", () => {
  it("超预算时压缩早期消息，但最近消息原文完整保留", () => {
    const messages: CompactableMessage[] = [];
    for (let i = 0; i < 30; i += 1) {
      messages.push(msg(i % 2 === 0 ? "user" : "assistant", `第${i}条消息-${"长".repeat(400)}`));
    }
    const last = messages[messages.length - 1];
    const result = compressConversation(messages, { budgetChars: 4_000 });
    expect(result.compressed).toBe(true);
    expect(result.afterChars).toBeLessThanOrEqual(result.beforeChars);
    // 最后一条（最近）必须逐字保留
    const keptLast = result.messages[result.messages.length - 1];
    expect(keptLast.content).toBe(last.content);
    // 早期消息被摘要压缩且标注条数
    expect(result.summary).toContain("已自动压缩");
  });

  it("最近消息本身巨大导致无法进入预算 → stillOverBudget", () => {
    const messages = [msg("user", "早期" + "x".repeat(20_000)), msg("assistant", "最新" + "y".repeat(40_000))];
    const result = compressConversation(messages, { budgetChars: 4_000 });
    expect(result.compressed).toBe(true);
    expect(result.stillOverBudget).toBe(true);
    // 最近消息原文保留（哪怕仍然超预算，也不允许截断它）
    expect(result.messages[result.messages.length - 1].content).toBe(messages[1].content);
  });

  it("未超预算时原样返回（不压缩、不切片）", () => {
    const messages = [msg("user", "问题"), msg("assistant", "回答")];
    const result = compressConversation(messages, { budgetChars: 100_000 });
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
  });
});
