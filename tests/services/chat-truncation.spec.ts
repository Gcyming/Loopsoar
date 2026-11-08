/**
 * ChatService 截断根除回归（m02515）：
 *   · done 事件携带的 finalText 是权威全文（含过滤缓冲尾巴），且与推给 UI 的 chunk 拼接一致；
 *   · 用户中止时 finalText 保留已流出正文（落库后重启不丢尾巴）。
 */
import { describe, expect, it } from "vitest";
import { ChatService } from "../../packages/services/src/chat.ts";
import { MockLlmClient, type LlmChunk, type LlmClient, type LlmRequest } from "../../packages/core/src/llm/index.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";
import { applyOutputFilter } from "../../packages/core/src/filter.ts";
import type { ChunkItem } from "../../packages/services/src/chat.ts";

function makeService(client: LlmClient): { service: ChatService; chunks: ChunkItem[] } {
  const registry = new ToolRegistry();
  const sandbox = new SandboxManager();
  sandbox.syncKnownTools([]);
  const chunks: ChunkItem[] = [];
  const service = new ChatService({
    llm: client,
    platform: createNodePlatform(),
    registry,
    sandbox,
    agent: { name: "T", role: "测试" },
    filterOutput: true,
  });
  return { service, chunks };
}

function donePayload(chunks: ChunkItem[]): { finalText?: string; status?: string; reason?: string } {
  const done = chunks.find((c) => (c.meta as { type?: string } | undefined)?.type === "done");
  return done ? JSON.parse(done.content) : {};
}

describe("ChatService 全文一致性", () => {
  it("done.finalText 等于流式过滤后的完整正文（含跨 chunk 缓冲尾巴）", async () => {
    const client = new MockLlmClient();
    const full = `开头内容${"中间".repeat(300)}这是底层模型的结尾。`;
    // 故意把「底层模型」拆到两个 chunk：流式过滤器会缓冲尾部，必须在收尾 flush 补回来
    const cut = full.lastIndexOf("底层");
    client.addScript([
      { kind: "text", text: full.slice(0, cut) },
      { kind: "text", text: full.slice(cut) },
      { kind: "done", finishReason: "stop" },
    ]);
    const { service, chunks } = makeService(client);
    const result = await service.stream({ message: "hi" }, (item) => chunks.push(item));
    expect(result.status).toBe("done");
    const expected = applyOutputFilter(full);
    expect(result.finalText).toBe(expected);
    const payload = donePayload(chunks);
    expect(payload.finalText).toBe(expected);
    // 推给 UI 的所有正文 chunk 拼接后也必须等于权威全文（否则 UI 少了尾巴）
    const streamed = chunks
      .filter((c) => (c.meta as { type?: string } | undefined)?.type === "chunk")
      .map((c) => c.content)
      .join("");
    expect(streamed).toBe(expected);
  });

  it("中止时 finalText 保留已流出正文（重启恢复不丢尾巴）", async () => {
    const partial = "已生成的前半段正文，用户中途点了停止";
    const client: LlmClient = {
      async *invoke(req: LlmRequest): AsyncIterable<LlmChunk> {
        yield { kind: "text", text: partial };
        // 模拟上游卡住：等待外部中止（真实场景里用户点「停止」）
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("Aborted", "AbortError");
      },
    };
    const { service, chunks } = makeService(client);
    const promise = service.stream({ message: "写长文", sessionId: "sess-abort" }, (item) => chunks.push(item));
    await new Promise((r) => setTimeout(r, 40));
    expect(service.stop("sess-abort")).toBe(true);
    const result = await promise;
    expect(result.status).toBe("aborted");
    expect(result.finalText).toBe(partial);
    expect(donePayload(chunks).finalText).toBe(partial);
  });
});
