/**
 * 思考内容在工具边界必须完整落在「工具之前」：
 * 旧实现里流式过滤器保留 20 字符尾巴，遇到工具调用不 flush，尾巴会被推到工具之后、
 * 与下一段思考拼在一起——界面表现就是「思考东一句西一句、每段开头缺半句」（用户 m03384）。
 */
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import { ChatService } from "../../packages/services/src/chat.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";
import { z } from "zod";

const SEG1 = "第一段思考内容需要超过二十个字符才能暴露缓冲尾巴";
const SEG2 = "第二段思考";

describe("ChatService · 推理流在工具边界 flush", () => {
  it("工具之前的思考包含完整第一段；工具之后的思考从第二段开始", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "回显",
      permissions: {},
      schema: z.object({ text: z.string().optional() }),
      execute: async () => ({ ok: true, content: "ok" }),
    });
    const sandbox = new SandboxManager();
    sandbox.syncKnownTools(["echo"]);

    const mock = new MockLlmClient();
    mock.addScript([
      // 故意拆成两个 delta：跨 chunk 缓冲才会被触发
      { kind: "reasoning", text: SEG1.slice(0, 10) },
      { kind: "reasoning", text: SEG1.slice(10) },
      { kind: "tool_call", toolCall: { id: "t1", name: "echo", args: {} } },
      { kind: "reasoning", text: SEG2 },
      { kind: "text", text: "完成" },
      { kind: "done" },
    ]);

    const service = new ChatService({
      llm: mock,
      platform: createNodePlatform(),
      registry,
      sandbox,
      agent: { name: "T", role: "测试" },
      permTimeoutMs: 50,
    });
    const result = await service.stream({ message: "hi" });
    const events = result.chunks
      .flatMap((batch) => batch.chunks)
      .map((item) => ({ type: String(item.meta?.type ?? ""), content: item.content }));
    const toolAt = events.findIndex((item) => item.type === "tool");
    expect(toolAt).toBeGreaterThan(0);
    const before = events.slice(0, toolAt).filter((item) => item.type === "reasoning").map((item) => item.content).join("");
    expect(before).toBe(SEG1);
    const after = events.slice(toolAt + 1).filter((item) => item.type === "reasoning").map((item) => item.content).join("");
    expect(after.startsWith(SEG2)).toBe(true);
    expect(after).not.toContain(SEG1.slice(-20));
  });
});
