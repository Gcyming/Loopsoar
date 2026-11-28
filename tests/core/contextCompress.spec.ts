/**
 * 上下文自动压缩：预算内不动；超预算压早期消息、保留 system 与最近原文；摘要包含早期用户诉求。
 */
import { describe, expect, it } from "vitest";
import {
  compressConversation,
  compressForLoop,
  estimateMessagesTokens,
  estimateTokens,
  estimateToolsTokens,
  historyBudgetChars,
  LOOP_SUMMARY_MARKER,
  messageChars,
  type CompactableMessage,
  type TokenizableMessage,
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

  it("压缩边界切在工具轮中间：保留窗口不以孤儿 tool 消息开头", () => {
    const big = "内容".repeat(1000);
    const messages: CompactableMessage[] = [
      { role: "system", content: "系统稳定段" },
      { role: "user", content: `早期诉求 ${big}` },
      { role: "assistant", content: "调用工具", tool_calls: [{ id: "t1", name: "file_read", args: {} }] },
      { role: "tool", content: `工具结果 ${big}`, tool_call_id: "t1" },
      { role: "assistant", content: `最终回答 ${big}` },
    ];
    const result = compressConversation(messages, { budgetChars: 4000, keepRecent: 2 });
    expect(result.compressed).toBe(true);
    const afterSummary = result.messages.slice(2);
    expect(afterSummary[0]?.role).not.toBe("tool");
    expect(afterSummary[afterSummary.length - 1]?.content).toBe(messages[messages.length - 1].content);
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

describe("token 估算（上下文进度 / loop 压缩共用口径）", () => {
  it("中文按 1 字/token 计，英文按约 3.6 字符/token 计（旧 4 字符/token 会低估中文）", () => {
    const zh = estimateTokens("长".repeat(100));
    const en = estimateTokens("a".repeat(360));
    expect(zh).toBeGreaterThanOrEqual(99);
    expect(zh).toBeLessThanOrEqual(101);
    expect(Math.abs(en - 100)).toBeLessThanOrEqual(2);
    // 同样字符数下中文 token 更多：这正是旧估算失真的根因
    expect(estimateTokens("长".repeat(200))).toBeGreaterThan(estimateTokens("a".repeat(200)));
  });

  it("工具 schema 计入估算（工具面本身也占 prompt）", () => {
    const withoutTool = estimateMessagesTokens([{ role: "user", content: "hi" }]);
    expect(estimateToolsTokens([{ name: "browser_snapshot", description: "抓页面", parameters: { type: "object" } }])).toBeGreaterThan(0);
    expect(estimateMessagesTokens([{ role: "user", content: "hi" }])).toBe(withoutTool);
  });
});

function loopHistory(count: number, chars: number): TokenizableMessage[] {
  return [
    { role: "system", content: "系统稳定段" },
    ...Array.from({ length: count }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "第" + i + "条：" + "长".repeat(chars),
    })),
  ];
}

describe("loop 内上下文压缩", () => {
  it("预算内原样返回（不压缩），仍给出上下文快照", () => {
    const messages = loopHistory(4, 50);
    const result = compressForLoop(messages, { contextWindowTokens: 128_000, toolsTokens: 100 });
    expect(result.compressed).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.stats.usedTokens).toBeGreaterThan(0);
    expect(result.stats.windowTokens).toBe(128_000);
  });

  it("超窗口：保留最近消息原文，早期消息进滚动纪要", () => {
    const messages = loopHistory(24, 300);
    const last = messages[messages.length - 1];
    const result = compressForLoop(messages, {
      contextWindowTokens: 6_000,
      keepRecent: 8,
      minKeepRecent: 4,
    });
    expect(result.compressed).toBe(true);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.messages[0]).toEqual(messages[0]); // system 永远在最前
    expect(result.messages.some((m) => typeof m.content === "string" && m.content.startsWith(LOOP_SUMMARY_MARKER))).toBe(true);
    expect(result.messages[result.messages.length - 1].content).toBe(last.content);
  });

  it("连续压缩不咀嚼上一版纪要：最早的目标仍在（避免逐轮失忆）", () => {
    const first = compressForLoop(loopHistory(24, 300), { contextWindowTokens: 6000, keepRecent: 8 });
    expect(first.compressed).toBe(true);
    // 模拟下一轮继续追加消息
    const next = [
      ...first.messages,
      ...Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: "新消息" + i + "：" + "新".repeat(300),
      })),
    ];
    const second = compressForLoop(next, { contextWindowTokens: 6000, keepRecent: 8 });
    expect(second.compressed).toBe(true);
    const summary = second.messages.find(
      (m) => typeof m.content === "string" && m.content.startsWith(LOOP_SUMMARY_MARKER),
    );
    expect(summary).toBeTruthy();
    // 第一条纪要行（用户最初的第 0 条）必须还在：这就是「不二次摘要」的验收点
    expect(String(summary?.content)).toContain("第0条");
  });

  it("边界不切开 assistant(tool_calls)/tool 结果：保留窗口不以 tool 开头", () => {
    const big = "长".repeat(600);
    const messages: TokenizableMessage[] = [
      { role: "system", content: "系统" },
      { role: "user", content: "任务" + big },
      { role: "assistant", content: "", tool_calls: [{ name: "file_read", args: { path: "a.txt" } }] },
      { role: "tool", content: "结果1" + big },
      { role: "tool", content: "结果2" + big },
      { role: "assistant", content: "继续" + big },
      { role: "user", content: "下一步" + big },
    ];
    // keepRecent=3 时 cut 落在 tool 上 → 必须回头把 assistant(tool_calls) 一起保留
    const result = compressForLoop(messages, { contextWindowTokens: 3_000, keepRecent: 3, minKeepRecent: 2 });
    expect(result.compressed).toBe(true);
    const afterSummary = result.messages.slice(1);
    expect(afterSummary[0]?.role).not.toBe("tool");
  });
});
