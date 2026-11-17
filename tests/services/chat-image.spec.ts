import { describe, expect, it } from "vitest";
import type { LlmChunk, LlmClient, LlmRequest } from "../../packages/core/src/llm/index.ts";
import { ChatService } from "../../packages/services/src/chat.ts";

function captureClient(seen: LlmRequest[]): LlmClient {
  return {
    async *invoke(req): AsyncIterable<LlmChunk> {
      seen.push(req);
      yield { kind: "text", text: "已看到" };
      yield { kind: "done" };
    },
  };
}

describe("ChatService 图片附件（P1-4）", () => {
  it("当前用户轮含图片附件时，最后一条 user 消息转成 text+image 内容块", async () => {
    const seen: LlmRequest[] = [];
    const service = new ChatService({
      llm: captureClient(seen),
      agent: { name: "T", role: "测试" },
      filterOutput: false,
      readImageAttachment: (path) =>
        path.endsWith(".png") ? { mime: "image/png", base64: "QUJD" } : null,
    });

    const result = await service.stream({ message: "看看这张图【附件】C:\\shot.png" });
    expect(result.status).toBe("done");

    const last = seen[0]?.messages.at(-1);
    expect(Array.isArray(last?.content)).toBe(true);
    if (Array.isArray(last?.content)) {
      expect(last.content[0]).toMatchObject({ type: "text" });
      expect(last.content.some((part) => part.type === "image" && part.mime === "image/png")).toBe(true);
    }
  });

  it("非图片/读取失败不打断发送：最后一条仍是字符串", async () => {
    const seen: LlmRequest[] = [];
    const service = new ChatService({
      llm: captureClient(seen),
      agent: { name: "T", role: "测试" },
      filterOutput: false,
      readImageAttachment: () => null,
    });

    await service.stream({ message: "读文档【附件】C:\\a.pdf" });
    const last = seen[0]?.messages.at(-1);
    expect(typeof last?.content).toBe("string");
  });
});
