/**
 * 上下文自动压缩：预算内不动；超预算压早期消息、保留 system 与最近原文；摘要包含早期用户诉求。
 */
import { describe, expect, it } from "vitest";
import {
  compressConversation,
  historyBudgetChars,
  messageChars,
  type CompactableMessage,
} from "../../packages/core/src/contextCompress.ts";

function makeHistory(count: number, charsPerMessage = 100): CompactableMessage[] {
  return [
    { role: "system", content: "系统稳定段" },
    ...Array.from({ length: count }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `${i % 2 === 0 ? "用户" : "助手"}消息 ${i}：` + "内容".repeat(Math.floor(charsPerMessage / 2)),
    })),
  ];
}

describe("上下文自动压缩", () => {
  it("预算内：原样返回，不触发压缩", () => {
    const messages = makeHistory(4, 50);
    const result = compressConversation(messages, { budgetChars: 100_000 });
    expect(result.compressed).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.droppedCount).toBe(0);
  });

  it("超预算：保留 system 与最近消息，早期消息进入摘要", () => {
    const messages = makeHistory(30, 400);
    const result = compressConversation(messages, { budgetChars: 5000, keepRecent: 6, summaryItemChars: 80 });
    expect(result.compressed).toBe(true);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[1].role).toBe("system");
    expect(result.messages[1].content).toContain("早期对话摘要");
    expect(result.messages[1].content).toContain("已压缩");
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.afterChars).toBeLessThan(result.beforeChars);
    // 最近 6 条原文仍在
    const tail = result.messages.slice(-6);
    expect(tail[tail.length - 1].content).toBe(messages[messages.length - 1].content);
    // 摘要包含早期用户内容
    expect(result.messages[1].content).toContain("用户消息 0");
  });

  it("极端超预算：多轮收紧后仍返回可用结果（不会空）", () => {
    const messages = makeHistory(60, 1000);
    const result = compressConversation(messages, { budgetChars: 4000, keepRecent: 20 });
    expect(result.compressed).toBe(true);
    expect(result.messages.length).toBeGreaterThan(2);
    expect(result.messages.some((m) => m.role === "system" && m.content.includes("早期对话摘要"))).toBe(true);
    expect(result.messages[result.messages.length - 1].content).toBe(messages[messages.length - 1].content);
  });

  it("预算换算：按上下文窗口比例给历史，且有上下限", () => {
    expect(historyBudgetChars(undefined)).toBe(60_000);
    expect(historyBudgetChars(8000)).toBe(9_600);
    expect(historyBudgetChars(128_000)).toBe(153_600);
    expect(historyBudgetChars(2_000_000)).toBe(600_000);
  });

  it("工具调用参数计入字符预算", () => {
    const message: CompactableMessage = {
      role: "assistant",
      content: "调用",
      tool_calls: [{ id: "1", name: "browser_snapshot", args: { url: "x".repeat(100) } }],
    };
    expect(messageChars(message)).toBeGreaterThan(100);
  });
});
