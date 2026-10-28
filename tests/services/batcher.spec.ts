/**
 * 流式批量器：40ms/24000 字合批。
 */
import { describe, expect, it } from "vitest";
import { StreamChunkBatcher, type ChunkBatch } from "../../packages/services/src/events.ts";

describe("StreamChunkBatcher", () => {
  it("close() 立即合批", () => {
    const batches: ChunkBatch[] = [];
    const b = new StreamChunkBatcher((x) => batches.push(x));
    b.push({ content: "hello" });
    b.push({ content: " world" });
    b.close();
    expect(batches.length).toBe(1);
    expect(batches[0].totalChars).toBe(11);
  });

  it("达到 24000 字立即合批", () => {
    const batches: ChunkBatch[] = [];
    const b = new StreamChunkBatcher((x) => batches.push(x));
    b.push({ content: "x".repeat(24000) });
    expect(batches.length).toBe(1);
  });

  it("定时 40ms 合批", async () => {
    const batches: ChunkBatch[] = [];
    const b = new StreamChunkBatcher((x) => batches.push(x));
    b.push({ content: "abc" });
    await new Promise((r) => setTimeout(r, 80));
    expect(batches.length).toBe(1);
    expect(batches[0].chunks[0].content).toBe("abc");
  });
});
