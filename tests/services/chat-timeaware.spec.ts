/**
 * 模型可见墙钟时间：ChatService 组请求时，
 *  · system 稳定段带格式说明（静态，不含具体时间）；
 *  · 历史消息与当前用户消息带 `[YYYY-MM-DD HH:mm]` 前缀；
 *  · 当前时间放 volatile 段（每轮刷新）。
 */
import { describe, expect, it } from "vitest";
import { ChatService } from "../../packages/services/src/chat.ts";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import type { LlmRequest } from "../../packages/core/src/llm/index.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";
import { formatWallClock } from "../../packages/core/src/messageTime.ts";

/** 记录每次 LLM 请求的客户端：只回一段文本 + done。 */
function recordingClient(seen: LlmRequest[]): MockLlmClient {
  const mock = new MockLlmClient();
  const original = mock.invoke.bind(mock);
  mock.invoke = (req: LlmRequest) => {
    seen.push(req);
    mock.addScript([{ kind: "text", text: "收到" }, { kind: "done" }]);
    return original(req);
  };
  return mock;
}

describe("ChatService · 模型可见时间戳", () => {
  it("历史消息与当前消息带时间前缀；system 带格式说明；当前时间进 volatile 段", async () => {
    const seen: LlmRequest[] = [];
    const llm = recordingClient(seen);
    const sandbox = new SandboxManager();
    sandbox.syncKnownTools([]);
    const userTs = new Date(2026, 10, 7, 9, 5).getTime();
    const assistantTs = new Date(2026, 10, 7, 9, 6).getTime();
    const service = new ChatService({
      llm,
      platform: createNodePlatform(),
      registry: new ToolRegistry(),
      sandbox,
      agent: { name: "T", role: "测试" },
      filterOutput: false,
      getHistory: () => [
        { role: "user", content: "昨天的旧请求", ts: userTs },
        { role: "assistant", content: "昨天的旧回复", ts: assistantTs },
      ],
    });

    const result = await service.stream({ message: "今天的新请求" });
    expect(result.status).toBe("done");
    expect(seen).toHaveLength(1);
    const messages = seen[0].messages;

    // system 稳定段：格式说明存在，且不含具体时间
    const system = messages.find((m) => m.role === "system");
    expect(system?.content).toContain("[YYYY-MM-DD HH:mm]");
    expect(system?.content).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

    // 历史消息：每条都有时间前缀（格式与时间戳一致）
    const history = messages.filter((m) => m.role === "user" || m.role === "assistant");
    expect(history[0].content).toContain(`[${formatWallClock(userTs)}] 昨天的旧请求`);
    expect(history[1].content).toContain(`[${formatWallClock(assistantTs)}] 昨天的旧回复`);

    // 当前用户消息：带当前时间前缀 + volatile 的「当前本地时间」
    const current = history[history.length - 1];
    expect(current.content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 今天的新请求/);
    expect(current.content).toContain("当前本地时间：");
    expect(current.content).toContain(formatWallClock(Date.now()).slice(0, 13)); // 年月日 时（允许跨分钟）
  });
});
