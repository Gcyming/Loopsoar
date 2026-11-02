/**
 * 多供应商降级链（packages/shell/src/main/routerLlm.ts）：
 * 首个目标可重试失败降级、流中失败不重放、全部失败聚合文案、冷却后跳过、优先级顺序。
 * 用脚本化假 LlmClient，不联网、不启子进程。
 */
import { describe, expect, it } from "vitest";
import type { LlmChunk, LlmClient, LlmRequest } from "../../packages/core/src/llm/index.ts";
import { createModelRouterForTargets, createFallbackLlmClient, isRetryableLlmError, type FallbackLlmTarget } from "../../packages/shell/src/main/routerLlm.ts";

const REQ: LlmRequest = { messages: [{ role: "user", content: "hi" }] };

/** 顺序收集流式 chunk（断言用）。 */
async function collect(client: LlmClient, req: LlmRequest = REQ): Promise<LlmChunk[]> {
  const chunks: LlmChunk[] = [];
  for await (const chunk of client.invoke(req)) chunks.push(chunk);
  return chunks;
}

interface TargetProbe {
  target: FallbackLlmTarget;
  invocations: () => number;
  builds: () => number;
}

/**
 * 脚本化目标：每次 invoke 依次取一个脚本（用完后重复最后一个）。
 * 单独统计 build/invoke 次数，验证惰性构建与冷却跳过。
 */
function scriptedTarget(opts: {
  id: string;
  priority: number;
  provider?: string;
  model?: string;
  roles?: string[];
  scripts: LlmChunk[][];
  order?: string[];
}): TargetProbe {
  let builds = 0;
  let invocations = 0;
  let cursor = 0;
  const target: FallbackLlmTarget = {
    id: opts.id,
    provider: opts.provider ?? "openai",
    model: opts.model ?? `model-${opts.id}`,
    priority: opts.priority,
    roles: opts.roles ?? ["chat"],
    build: () => {
      builds += 1;
      return {
        async *invoke(_req: LlmRequest): AsyncGenerator<LlmChunk> {
          invocations += 1;
          opts.order?.push(opts.id);
          const script = opts.scripts[Math.min(cursor, opts.scripts.length - 1)] ?? [{ kind: "done" as const }];
          cursor += 1;
          for (const chunk of script) yield chunk;
        },
      };
    },
  };
  return { target, invocations: () => invocations, builds: () => builds };
}

/** 抛异常的目标（模拟 fetch 失败等未转成 error chunk 的情况）。 */
function throwingTarget(opts: {
  id: string;
  priority: number;
  provider?: string;
  model?: string;
  message: string;
  beforeChunks?: LlmChunk[];
}): TargetProbe {
  let invocations = 0;
  const target: FallbackLlmTarget = {
    id: opts.id,
    provider: opts.provider ?? "openai",
    model: opts.model ?? `model-${opts.id}`,
    priority: opts.priority,
    roles: ["chat"],
    build: () => ({
      async *invoke(_req: LlmRequest): AsyncGenerator<LlmChunk> {
        invocations += 1;
        for (const chunk of opts.beforeChunks ?? []) yield chunk;
        throw new Error(opts.message);
      },
    }),
  };
  return { target, invocations: () => invocations, builds: () => 1 };
}

const OK_SCRIPT: LlmChunk[] = [
  { kind: "text", text: "hello" },
  { kind: "done" },
];

describe("routerLlm · 可重试判定", () => {
  it.each([
    ["HTTP 500: upstream error", true],
    ["HTTP 503: overloaded", true],
    ["HTTP 429: rate limited", true],
    ["HTTP 408: timeout", true],
    ["fetch failed", true],
    ["请求超时", true],
    ["socket hang up", true],
    ["ECONNREFUSED", true],
    ["HTTP 401: unauthorized", false],
    ["HTTP 400: bad request", false],
    ["HTTP 404: not found", false],
    ["上下文超长", false],
    ["", false],
  ])("isRetryableLlmError(%s) → %s", (message, expected) => {
    expect(isRetryableLlmError(message)).toBe(expected);
  });
});

describe("routerLlm · 降级行为", () => {
  it("首个目标可重试失败 → markCooldown 并降级到第二个成功", async () => {
    const a = scriptedTarget({ id: "a", priority: 100, provider: "openai", model: "gpt-a", scripts: [[{ kind: "error", message: "HTTP 500: a-down" }]] });
    const b = scriptedTarget({ id: "b", priority: 10, provider: "anthropic", model: "claude-b", scripts: [OK_SCRIPT] });
    const router = createModelRouterForTargets([a.target, b.target]);
    const client = createFallbackLlmClient({ targets: [a.target, b.target], router, now: () => 1_000 });

    const chunks = await collect(client);
    expect(chunks).toEqual([
      { kind: "text", text: "hello" },
      { kind: "done" },
    ]);
    expect(a.invocations()).toBe(1);
    expect(b.invocations()).toBe(1);
    // 失败目标进入冷却：降级链里只剩 b；冷却到期后 a 回来
    expect(router.fallbackChain("chat", 1_000).map((entry) => entry.id)).toEqual(["b"]);
    expect(router.fallbackChain("chat", 1_000 + 30_000).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("已输出内容后失败 → 不切换目标、直接报错（避免重复正文）", async () => {
    const a = scriptedTarget({
      id: "a",
      priority: 100,
      scripts: [[{ kind: "text", text: "部分正文" }, { kind: "error", message: "HTTP 500: mid-stream" }]],
    });
    const b = scriptedTarget({ id: "b", priority: 10, scripts: [OK_SCRIPT] });
    const client = createFallbackLlmClient({ targets: [a.target, b.target] });

    const chunks = await collect(client);
    expect(chunks[0]).toEqual({ kind: "text", text: "部分正文" });
    expect(chunks).toHaveLength(2);
    expect(chunks[1].kind).toBe("error");
    const message = (chunks[1] as { kind: "error"; message: string }).message;
    expect(message).toContain("输出中断");
    expect(message).toContain("已停止降级");
    expect(b.invocations()).toBe(0);
  });

  it("流开始时抛异常（未输出任何 chunk）→ 也按可重试降级", async () => {
    const a = throwingTarget({ id: "a", priority: 100, message: "fetch failed" });
    const b = scriptedTarget({ id: "b", priority: 10, scripts: [OK_SCRIPT] });
    const client = createFallbackLlmClient({ targets: [a.target, b.target] });
    const chunks = await collect(client);
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["text", "done"]);
    expect(b.invocations()).toBe(1);
  });

  it("全部目标失败 → 一条聚合错误，附每个目标失败原因", async () => {
    const a = scriptedTarget({ id: "a", priority: 100, provider: "openai", model: "gpt-a", scripts: [[{ kind: "error", message: "HTTP 500: a-down" }]] });
    const b = scriptedTarget({ id: "b", priority: 10, provider: "anthropic", model: "claude-b", scripts: [[{ kind: "error", message: "HTTP 429: b-limited" }]] });
    const client = createFallbackLlmClient({ targets: [a.target, b.target] });

    const chunks = await collect(client);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe("error");
    const message = (chunks[0] as { kind: "error"; message: string }).message;
    expect(message).toContain("所有模型均调用失败");
    expect(message).toContain("openai/gpt-a");
    expect(message).toContain("HTTP 500: a-down");
    expect(message).toContain("anthropic/claude-b");
    expect(message).toContain("HTTP 429: b-limited");
    expect(a.invocations()).toBe(1);
    expect(b.invocations()).toBe(1);
  });

  it("不可重试错误（401）→ 立即报错，不浪费其它供应商", async () => {
    const a = scriptedTarget({ id: "a", priority: 100, scripts: [[{ kind: "error", message: "HTTP 401: unauthorized" }]] });
    const b = scriptedTarget({ id: "b", priority: 10, scripts: [OK_SCRIPT] });
    const client = createFallbackLlmClient({ targets: [a.target, b.target] });

    const chunks = await collect(client);
    expect(chunks).toHaveLength(1);
    const message = (chunks[0] as { kind: "error"; message: string }).message;
    expect(message).toContain("不可重试");
    expect(message).toContain("HTTP 401");
    expect(b.invocations()).toBe(0);
  });

  it("优先级降序尝试（priority 大者先；失败后依次降级）", async () => {
    const order: string[] = [];
    const high = scriptedTarget({ id: "high", priority: 300, scripts: [[{ kind: "error", message: "HTTP 502: bad gateway" }]], order });
    const mid = scriptedTarget({ id: "mid", priority: 200, scripts: [[{ kind: "error", message: "HTTP 503: unavailable" }]], order });
    const low = scriptedTarget({ id: "low", priority: 100, scripts: [OK_SCRIPT], order });
    const client = createFallbackLlmClient({ targets: [mid.target, low.target, high.target] });

    const chunks = await collect(client);
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["text", "done"]);
    expect(order).toEqual(["high", "mid", "low"]);
  });
});

describe("routerLlm · 冷却", () => {
  it("冷却后跳过：同一 router 的后续请求直接走下一个目标；到期后重新尝试", async () => {
    let clock = 1_000;
    const a = scriptedTarget({ id: "a", priority: 100, scripts: [[{ kind: "error", message: "HTTP 500: down" }]] });
    const b = scriptedTarget({ id: "b", priority: 10, scripts: [OK_SCRIPT] });
    const router = createModelRouterForTargets([a.target, b.target]);
    const client = createFallbackLlmClient({ targets: [a.target, b.target], router, now: () => clock });

    const first = await collect(client);
    expect(first.map((chunk) => chunk.kind)).toEqual(["text", "done"]);
    expect(a.invocations()).toBe(1);

    // 冷却期内：a 被跳过，不再发起调用
    clock += 1_000;
    const second = await collect(client);
    expect(second.map((chunk) => chunk.kind)).toEqual(["text", "done"]);
    expect(a.invocations()).toBe(1);
    expect(b.invocations()).toBe(2);

    // 冷却到期：a 重新进入降级链（仍失败 → 再次切到 b）
    clock += 30_001;
    const third = await collect(client);
    expect(third.map((chunk) => chunk.kind)).toEqual(["text", "done"]);
    expect(a.invocations()).toBe(2);
  });

  it("全部目标都在冷却 → 不发起调用，返回可读错误", async () => {
    const a = scriptedTarget({ id: "a", priority: 100, scripts: [[{ kind: "error", message: "HTTP 500: down" }]] });
    const b = scriptedTarget({ id: "b", priority: 10, scripts: [[{ kind: "error", message: "HTTP 500: down2" }]] });
    const client = createFallbackLlmClient({ targets: [a.target, b.target] });

    await collect(client); // 首轮把两个都打入冷却
    expect(a.invocations()).toBe(1);
    expect(b.invocations()).toBe(1);

    const chunks = await collect(client);
    expect(chunks).toHaveLength(1);
    const message = (chunks[0] as { kind: "error"; message: string }).message;
    expect(message).toContain("冷却");
    expect(a.invocations()).toBe(1);
    expect(b.invocations()).toBe(1);
  });

  it("外部 router 的既有冷却在首次请求就生效", async () => {
    const a = scriptedTarget({ id: "a", priority: 100, scripts: [OK_SCRIPT] });
    const b = scriptedTarget({ id: "b", priority: 10, scripts: [OK_SCRIPT] });
    const router = createModelRouterForTargets([a.target, b.target]);
    router.markCooldown("a", 30_000, Date.now());
    const client = createFallbackLlmClient({ targets: [a.target, b.target], router });

    const chunks = await collect(client);
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["text", "done"]);
    expect(a.invocations()).toBe(0);
    expect(b.invocations()).toBe(1);
  });
});

describe("routerLlm · 边界", () => {
  it("目标为空 → 可读错误（不抛异常）", async () => {
    const client = createFallbackLlmClient({ targets: [] });
    const chunks = await collect(client);
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { kind: "error"; message: string }).message).toContain("没有可用的模型供应商");
  });

  it("build 惰性且每个目标只构建一次（多轮复用）", async () => {
    const a = scriptedTarget({ id: "a", priority: 100, scripts: [OK_SCRIPT] });
    const client = createFallbackLlmClient({ targets: [a.target] });
    await collect(client);
    await collect(client);
    expect(a.builds()).toBe(1);
    expect(a.invocations()).toBe(2);
  });

  it("请求已取消 → 不调用任何目标，返回可读错误", async () => {
    const a = scriptedTarget({ id: "a", priority: 100, scripts: [OK_SCRIPT] });
    const client = createFallbackLlmClient({ targets: [a.target] });
    const controller = new AbortController();
    controller.abort();
    const chunks = await collect(client, { ...REQ, signal: controller.signal });
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { kind: "error"; message: string }).message).toContain("取消");
    expect(a.invocations()).toBe(0);
  });

  it("roles 与目标标签不匹配时兜底尝试全部（避免单模型配置直接不可用）", async () => {
    const a = scriptedTarget({ id: "a", priority: 100, roles: ["coding"], scripts: [OK_SCRIPT] });
    const client = createFallbackLlmClient({ targets: [a.target], roles: "chat" });
    const chunks = await collect(client);
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["text", "done"]);
    expect(a.invocations()).toBe(1);
  });
});
