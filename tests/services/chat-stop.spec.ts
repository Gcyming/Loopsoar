/**
 * 中断链路回归（task-3）：ChatService.stop() 必须在「下一个事件循环」级别收束流，
 * 不能等上下游 LLM chunk / 工具返回，否则 UI 会一直停在「正在思考」。
 *
 * 断言：
 *   · stop() 后 done 事件立即到达（<1s），status=aborted、reason 是「用户已停止」；
 *   · 用户主动停止不会产生 chat:stream:error（否则 UI 会当成失败并继续等）；
 *   · 已生成的部分正文保留在 finalText 里。
 */
import { describe, expect, it } from "vitest";
import { ChatService } from "../../packages/services/src/chat.ts";
import type { ChunkItem } from "../../packages/services/src/events.ts";
import type { LlmChunk, LlmRequest } from "../../packages/core/src/llm/index.ts";

/** 吐一段正文后挂起、但观察 AbortSignal 的 LLM（模拟正常供应商 + 上游卡住）。 */
class AbortAwareLlm {
  calls = 0;
  invoke(req: LlmRequest): AsyncIterable<LlmChunk> {
    this.calls += 1;
    return (async function* () {
      yield { kind: "text" as const, text: "部分输出" };
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) {
          resolve();
          return;
        }
        req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new DOMException("Aborted", "AbortError");
    })();
  }
}

/** 完全不吐 chunk、但观察 AbortSignal 的 LLM（模拟首字节前就被用户停止）。 */
class SilentAbortAwareLlm {
  invoke(req: LlmRequest): AsyncIterable<LlmChunk> {
    return (async function* () {
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) {
          resolve();
          return;
        }
        req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new DOMException("Aborted", "AbortError");
    })();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor 超时");
    await sleep(5);
  }
}

function typesOf(items: ChunkItem[]): string[] {
  return items.map((item) => String((item.meta as { type?: unknown } | undefined)?.type ?? ""));
}

describe("ChatService 停止链路", () => {
  it("stop() 立即收束：done(aborted)、无 error chunk、保留部分正文", async () => {
    const llm = new AbortAwareLlm();
    // filterOutput=false：身份过滤会把尾部 20 字符先扣住（短正文要等流结束才 flush），
    // 本测试要验证「流还在跑时 stop」的即时性，关闭过滤让第一个 chunk 立刻可见。
    const service = new ChatService({ llm, agent: { name: "T", role: "测试" }, filterOutput: false });
    const items: ChunkItem[] = [];
    const started = Date.now();

    const streamPromise = service.stream({ message: "hi", sessionId: "s1" }, (item) => items.push(item));
    // 等到第一段正文，证明流确实在跑（而不是 stop 打在空闲会话上）
    await waitFor(() => typesOf(items).includes("chunk"));
    expect(service.stop("s1")).toBe(true);

    const result = await streamPromise;
    const elapsed = Date.now() - started;

    expect(result.status).toBe("aborted");
    expect(result.reason).toContain("已停止");
    expect(elapsed).toBeLessThan(1000);
    expect(result.finalText).toContain("部分输出");
    // 主动停止不是失败：不应出现 chat:stream:error
    expect(typesOf(items)).not.toContain("error");

    const done = items.find((item) => (item.meta as { type?: unknown } | undefined)?.type === "done");
    expect(done).toBeTruthy();
    const payload = JSON.parse(done!.content) as { status?: string; reason?: string; finalText?: string };
    expect(payload.status).toBe("aborted");
    expect(payload.reason).toContain("已停止");
    expect(payload.finalText).toContain("部分输出");

    // 控制器已清理：重复 stop 返回 false（不会误伤后续新流）
    expect(service.stop("s1")).toBe(false);
  }, 10_000);

  it("首字节前 stop → 立即 done(aborted)，空正文兜底为「已停止」", async () => {
    const service = new ChatService({ llm: new SilentAbortAwareLlm(), agent: { name: "T", role: "测试" } });
    const items: ChunkItem[] = [];
    const started = Date.now();

    const streamPromise = service.stream({ message: "hi", sessionId: "s2" }, (item) => items.push(item));
    // 没有任何 chunk 到达也应能停止（旧实现会卡到首字节超时 120s）
    await sleep(20);
    expect(service.stop("s2")).toBe(true);

    const result = await streamPromise;
    expect(result.status).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.finalText).toBe("（已停止）");
    expect(typesOf(items)).not.toContain("error");
  }, 10_000);
});
