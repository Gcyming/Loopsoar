/**
 * OpenAI 兼容服务（packages/gateway/src/app.ts）：
 * 鉴权 / 非流式 / SSE 流式 chunk 形状 / 错误形状 / models / healthz / session 头透传。
 * 全部 app.inject，不监听端口、不联网；runner 用 fake 精确控制输出。
 */
import { describe, expect, it } from "vitest";
import {
  buildApp,
  type GatewayChatRunner,
  type GatewayChatRequest,
  type OpenAiStreamChunk,
} from "../../packages/gateway/src/app.ts";

interface RunnerOptions {
  models?: { id: string; owned_by?: string }[];
  finalText?: string;
  status?: string;
  reason?: string;
  totalTokens?: number;
  toolCalls?: { id: string; name: string; args: unknown }[];
  streamTexts?: string[];
  throwError?: Error;
}

interface FakeRunner {
  runner: GatewayChatRunner;
  calls: GatewayChatRequest[];
}

function makeRunner(options: RunnerOptions = {}): FakeRunner {
  const calls: GatewayChatRequest[] = [];
  const runner: GatewayChatRunner = {
    models: () => options.models ?? [{ id: "loopsoar-default", owned_by: "loopsoar" }],
    async complete(request, sink) {
      calls.push(request);
      if (options.throwError) throw options.throwError;
      const ctx = { id: "chatcmpl-test", created: 1_700_000_000, model: request.model ?? "loopsoar-default" };
      const status = options.status ?? "done";
      if (request.stream === true) {
        sink({
          id: ctx.id,
          object: "chat.completion.chunk",
          created: ctx.created,
          model: ctx.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        });
        for (const text of options.streamTexts ?? ["你", "好"]) {
          const chunk: OpenAiStreamChunk = {
            id: ctx.id,
            object: "chat.completion.chunk",
            created: ctx.created,
            model: ctx.model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          };
          sink(chunk);
        }
        sink({
          id: ctx.id,
          object: "chat.completion.chunk",
          created: ctx.created,
          model: ctx.model,
          choices: [{ index: 0, delta: {}, finish_reason: status === "budget" ? "length" : "stop" }],
        });
      }
      return {
        id: ctx.id,
        created: ctx.created,
        model: ctx.model,
        status,
        reason: options.reason ?? "",
        finalText: options.finalText ?? "你好",
        toolCalls: options.toolCalls ?? [],
        usage: { totalTokens: options.totalTokens ?? 7 },
      };
    },
  };
  return { runner, calls };
}

/** 解析 SSE 响应体：返回 data 行 JSON 与是否收到 [DONE]。 */
function parseSse(body: string): { chunks: Record<string, unknown>[]; done: boolean } {
  const chunks: Record<string, unknown>[] = [];
  let done = false;
  for (const event of body.split("\n\n")) {
    const line = event.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    chunks.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return { chunks, done };
}

const CHAT_BODY = { model: "loopsoar-default", messages: [{ role: "user", content: "你好" }] };

describe("gateway · 鉴权与错误形状", () => {
  it("无令牌 → 401 OpenAI 错误形状；正确令牌 → 200", async () => {
    const app = await buildApp({
      runner: makeRunner().runner,
      requireToken: true,
      gatewayToken: "secret-token",
    });
    const unauthorized = await app.inject({ method: "GET", url: "/v1/models" });
    expect(unauthorized.statusCode).toBe(401);
    const body = unauthorized.json() as { error: { message: string; type: string; code: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("invalid_api_key");
    expect(body.error.message).toContain("未授权");

    const authorized = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(authorized.statusCode).toBe(200);
    await app.close();
  });

  it("非法请求体 → 400 OpenAI 错误形状（messages 缺失/内容非字符串）", async () => {
    const app = await buildApp({ runner: makeRunner().runner });
    const missing = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: {} });
    expect(missing.statusCode).toBe(400);
    const missingBody = missing.json() as { error: { message: string; type: string } };
    expect(missingBody.error.type).toBe("invalid_request_error");
    expect(missingBody.error.message).toContain("messages");

    const multimodal = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    });
    expect(multimodal.statusCode).toBe(400);
    expect((multimodal.json() as { error: { message: string } }).error.message).toContain("content");
    await app.close();
  });

  it("未知路由 → 404 OpenAI 错误形状", async () => {
    const app = await buildApp({ runner: makeRunner().runner });
    const res = await app.inject({ method: "GET", url: "/v1/unknown" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toContain("未知接口");
    await app.close();
  });
});

describe("gateway · models / healthz", () => {
  it("GET /v1/models 来自注入的模型列表", async () => {
    const { runner } = makeRunner({ models: [{ id: "loopsoar-default" }, { id: "gpt-x", owned_by: "openai" }] });
    const app = await buildApp({ runner });
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { object: string; data: { id: string; object: string; owned_by: string }[] };
    expect(body.object).toBe("list");
    expect(body.data.map((item) => item.id)).toEqual(["loopsoar-default", "gpt-x"]);
    expect(body.data[0].object).toBe("model");
    expect(body.data[1].owned_by).toBe("openai");
    await app.close();
  });

  it("GET /healthz 含模型数量", async () => {
    const app = await buildApp({ runner: makeRunner({ models: [{ id: "a" }, { id: "b" }] }).runner });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string; models: number }).models).toBe(2);
    await app.close();
  });
});

describe("gateway · 非流式 completion", () => {
  it("返回 chat.completion（含 usage/ finish_reason）", async () => {
    const app = await buildApp({ runner: makeRunner({ finalText: "最终回答", totalTokens: 9 }).runner });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: CHAT_BODY });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      object: string;
      model: string;
      choices: { message: { role: string; content: string }; finish_reason: string }[];
      usage: { total_tokens: number };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.id).toBe("chatcmpl-test");
    expect(body.model).toBe("loopsoar-default");
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "最终回答" });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(9);
    await app.close();
  });

  it("tool_calls 透传（message.tool_calls + finish_reason=tool_calls）", async () => {
    const app = await buildApp({
      runner: makeRunner({
        finalText: "",
        toolCalls: [{ id: "call-1", name: "file_read", args: { path: "a.txt" } }],
      }).runner,
    });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: CHAT_BODY });
    const body = res.json() as {
      choices: {
        message: { content: string | null; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[] };
        finish_reason: string;
      }[];
    };
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.tool_calls?.[0]).toEqual({
      id: "call-1",
      type: "function",
      function: { name: "file_read", arguments: JSON.stringify({ path: "a.txt" }) },
    });
    await app.close();
  });

  it("runner 报错 → 500 server_error 错误形状", async () => {
    const app = await buildApp({ runner: makeRunner({ status: "error", reason: "LLM 未配置" }).runner });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: CHAT_BODY });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { message: string; type: string } };
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toContain("LLM 未配置");
    await app.close();
  });
});

describe("gateway · SSE 流式 completion", () => {
  it("chunk 数组 + data:[DONE]：role → content → finish_reason", async () => {
    const app = await buildApp({ runner: makeRunner({ streamTexts: ["你", "好"] }).runner });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { ...CHAT_BODY, stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const { chunks, done } = parseSse(res.body);
    expect(done).toBe(true);
    expect(chunks.length).toBe(4);
    for (const chunk of chunks) {
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.id).toBe("chatcmpl-test");
    }
    const first = chunks[0] as { choices: { delta: { role?: string }; finish_reason: string | null }[] };
    expect(first.choices[0].delta.role).toBe("assistant");
    expect(first.choices[0].finish_reason).toBeNull();
    const content = chunks
      .map((chunk) => ((chunk as { choices: { delta: { content?: string } }[] }).choices[0].delta.content ?? ""))
      .join("");
    expect(content).toBe("你好");
    const last = chunks[chunks.length - 1] as { choices: { finish_reason: string }[] };
    expect(last.choices[0].finish_reason).toBe("stop");
    // 默认不推送 usage chunk
    expect(chunks.some((chunk) => "usage" in chunk)).toBe(false);
    await app.close();
  });

  it("stream_options.include_usage → 末尾 usage chunk（choices 为空）", async () => {
    const app = await buildApp({ runner: makeRunner({ totalTokens: 11 }).runner });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { ...CHAT_BODY, stream: true, stream_options: { include_usage: true } },
    });
    const { chunks, done } = parseSse(res.body);
    expect(done).toBe(true);
    const usageChunk = chunks.find((chunk) => "usage" in chunk) as
      | { choices: unknown[]; usage: { total_tokens: number } }
      | undefined;
    expect(usageChunk).toBeTruthy();
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage.total_tokens).toBe(11);
    await app.close();
  });

  it("runner 报错 → SSE 错误体 + [DONE]（不抛断连接）", async () => {
    const app = await buildApp({ runner: makeRunner({ status: "error", reason: "Agent 崩溃" }).runner });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { ...CHAT_BODY, stream: true },
    });
    expect(res.statusCode).toBe(200);
    const { chunks, done } = parseSse(res.body);
    expect(done).toBe(true);
    const errorChunk = chunks.find((chunk) => "error" in chunk) as { error: { message: string } } | undefined;
    expect(errorChunk?.error.message).toContain("Agent 崩溃");
    await app.close();
  });

  it("runner 抛异常 → SSE 错误体 + [DONE]", async () => {
    const app = await buildApp({ runner: makeRunner({ throwError: new Error("boom") }).runner });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { ...CHAT_BODY, stream: true },
    });
    const { chunks, done } = parseSse(res.body);
    expect(done).toBe(true);
    const errorChunk = chunks.find((chunk) => "error" in chunk) as { error: { message: string } } | undefined;
    expect(errorChunk?.error.message).toContain("boom");
    await app.close();
  });
});

describe("gateway · 会话头透传", () => {
  it("x-loopsoar-session 原样传给 runner，缺省不传", async () => {
    const { runner, calls } = makeRunner();
    const app = await buildApp({ runner });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-loopsoar-session": "sess-abc" },
      payload: CHAT_BODY,
    });
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: CHAT_BODY });
    expect(calls[0].sessionId).toBe("sess-abc");
    expect(calls[1].sessionId).toBeUndefined();
    await app.close();
  });
});
