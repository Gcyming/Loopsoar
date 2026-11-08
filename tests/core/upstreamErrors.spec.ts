/**
 * 上游错误分类回归（Lead 直连诊断 2026-11-08，opencode-zen）：
 *
 * 真实故障：free 模型返回 HTTP 429 `{"error":{"type":"FreeUsageLimitError",...}}` +
 * `retry-after: 62231`（≈17h 后额度重置）。旧实现把 429 当可重试（每次等 60s × 3 次），
 * 用户看到的是「思考非常慢」——实际是空等约 3 分钟才报错。
 *
 * 本测试锁死：
 *   · 额度/余额/订阅/鉴权/模型类错误 → 立即 error（不 sleep、不重试）；
 *   · 普通 429 只有 retry-after ≤ 15s 才重试，最多 2 次；retry-after 很大/缺失 → 立即报「约 X 后重试」；
 *   · OpenAI 兼容与 Anthropic 两端行为一致。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAiClient } from "../../packages/core/src/llm/openai.ts";
import { createAnthropicClient } from "../../packages/core/src/llm/anthropic.ts";
import type { LlmChunk } from "../../packages/core/src/llm/index.ts";
import {
  classifyFatalUpstreamError,
  humanizeWait,
  parseRetryAfterMs,
  parseUpstreamError,
} from "../../packages/core/src/llm/upstreamError.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function collect(iterable: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sseResponse(lines: string[]): Response {
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const FREE_LIMIT_BODY = {
  type: "error",
  error: {
    type: "FreeUsageLimitError",
    message: "Free usage limit reached. Please subscribe to continue using this model.",
  },
};

describe("上游错误归一（纯函数）", () => {
  it("解析 OpenAI/Anthropic/中转站三种错误体形态", () => {
    const free = parseUpstreamError(429, JSON.stringify(FREE_LIMIT_BODY));
    expect(free.type).toBe("FreeUsageLimitError");
    expect(free.message).toContain("Free usage limit");

    const anthropic = parseUpstreamError(
      403,
      JSON.stringify({ type: "error", error: { type: "permission_error", message: "subscription required" } }),
    );
    expect(anthropic.type).toBe("permission_error");
    expect(anthropic.message).toContain("subscription");

    const plain = parseUpstreamError(500, "bad gateway");
    expect(plain.message).toBe("bad gateway");
  });

  it("额度/余额/订阅/鉴权/模型类 → 可行动提示；普通限流不误判", () => {
    const hints = {
      free: classifyFatalUpstreamError(parseUpstreamError(429, JSON.stringify(FREE_LIMIT_BODY))),
      funds: classifyFatalUpstreamError(parseUpstreamError(402, JSON.stringify({ error: { message: "Insufficient account funds" } }))),
      sub: classifyFatalUpstreamError(
        parseUpstreamError(403, JSON.stringify({ error: { message: "An active OpenCode Go subscription is required" } })),
      ),
      key: classifyFatalUpstreamError(parseUpstreamError(401, JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } }))),
      model: classifyFatalUpstreamError(parseUpstreamError(404, JSON.stringify({ error: { message: "The model does not exist" } }))),
    };
    expect(hints.free).toContain("额度");
    expect(hints.funds).toContain("余额");
    expect(hints.sub).toContain("订阅");
    expect(hints.key).toContain("API Key");
    expect(hints.model).toContain("模型");
    // 普通限流（rate_limit_error）不是「额度用尽」：必须留给重试逻辑
    expect(
      classifyFatalUpstreamError(parseUpstreamError(429, JSON.stringify({ error: { type: "rate_limit_error", message: "too many requests" } }))),
    ).toBeNull();
  });

  it("retry-after 解析与人类可读时长", () => {
    const header = (value: string | null) => ({ get: (name: string) => (name === "retry-after" ? value : null) });
    expect(parseRetryAfterMs(header("62231"))).toBe(62_231_000);
    expect(parseRetryAfterMs(header("2"))).toBe(2000);
    expect(parseRetryAfterMs(header(null))).toBeUndefined();
    expect(parseRetryAfterMs(header("soon"))).toBeUndefined();
    expect(humanizeWait(62_231_000)).toContain("小时");
  });
});

describe("OpenAI 兼容端：不可重试错误立即失败", () => {
  it("429 FreeUsageLimitError + retry-after 62231 → 一次请求、立即 error、不 sleep", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(FREE_LIMIT_BODY, 429, { "retry-after": "62231" });
    }) as typeof fetch;

    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "free-model" });
    const started = Date.now();
    const chunks = await collect(client.invoke({ messages: [{ role: "user", content: "hi" }] }));

    expect(calls).toBe(1); // 不重试
    expect(Date.now() - started).toBeLessThan(500); // 不 sleep
    const error = chunks.find((chunk) => chunk.kind === "error");
    expect(error).toBeTruthy();
    expect((error as { message: string }).message).toContain("额度");
    expect((error as { message: string }).message).toContain("HTTP 429");
    expect(chunks.some((chunk) => chunk.kind === "text")).toBe(false);
  }, 10_000);

  it("402 余额不足 / 403 需要订阅 → 立即 error，不重试", async () => {
    for (const [status, body, keyword] of [
      [402, { error: { message: "Insufficient account funds" } }, "余额"],
      [403, { error: { message: "An active OpenCode Go subscription is required" } }, "订阅"],
    ] as const) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return jsonResponse(body, status);
      }) as typeof fetch;
      const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
      const chunks = await collect(client.invoke({ messages: [{ role: "user", content: "hi" }] }));
      expect(calls).toBe(1);
      const error = chunks.find((chunk) => chunk.kind === "error") as { message: string } | undefined;
      expect(error?.message).toContain(keyword);
    }
  }, 10_000);

  it("普通 429 + retry-after 很小 → 重试一次后成功", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ error: { type: "rate_limit_error", message: "too many requests" } }, 429, { "retry-after": "0.2" });
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"恢复了"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch;

    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
    const chunks = await collect(client.invoke({ messages: [{ role: "user", content: "hi" }] }));

    expect(calls).toBe(2);
    expect(chunks.some((chunk) => chunk.kind === "text")).toBe(true);
    expect(chunks.some((chunk) => chunk.kind === "error")).toBe(false);
  }, 10_000);

  it("普通 429 但 retry-after 很大 → 立即 error（提示约 X 后可重试），不重试", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ error: { type: "rate_limit_error", message: "too many requests" } }, 429, { "retry-after": "3600" });
    }) as typeof fetch;

    const client = createOpenAiClient({ baseUrl: "http://x/v1", model: "m" });
    const started = Date.now();
    const chunks = await collect(client.invoke({ messages: [{ role: "user", content: "hi" }] }));

    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(500);
    const error = chunks.find((chunk) => chunk.kind === "error") as { message: string } | undefined;
    expect(error?.message).toContain("限流");
    expect(error?.message).toContain("小时");
  }, 10_000);
});

describe("Anthropic 端：不可重试错误立即失败", () => {
  it("429 FreeUsageLimitError → 一次请求、立即 error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ type: "error", error: { type: "FreeUsageLimitError", message: "Free usage limit reached" } }, 429, {
        "retry-after": "62231",
      });
    }) as typeof fetch;

    const client = createAnthropicClient({ baseUrl: "http://x", apiKey: "k", model: "m" });
    const started = Date.now();
    const chunks = await collect(client.invoke({ messages: [{ role: "user", content: "hi" }] }));

    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(500);
    const error = chunks.find((chunk) => chunk.kind === "error") as { message: string } | undefined;
    expect(error?.message).toContain("额度");
  }, 10_000);
});
