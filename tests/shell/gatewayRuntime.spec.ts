/**
 * Gateway headless 运行时（packages/shell/src/main/gatewayRuntime.ts）：
 * ChatService 事件 → OpenAI chunk 映射、x-loopsoar-session 会话复用、模型清单、token 状态、dispose。
 * 用注入的 fake chat（不联网、不起 Electron）；映射函数做纯函数单测。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createGatewayRuntime,
  mapChatEventToOpenAiChunk,
  type GatewayChatLike,
  type SseMappingState,
} from "../../packages/shell/src/main/gatewayRuntime.ts";
import type { ChatInput, ChatStreamResult } from "../../packages/services/src/chat.ts";
import type { ChunkItem } from "../../packages/services/src/events.ts";
import type { OpenAiStreamChunk } from "../../packages/gateway/src/app.ts";

let roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

const CTX = { id: "chatcmpl-test", model: "loopsoar-default", created: 1_700_000_000 };

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

/* ────────────────────────── 纯映射函数 ────────────────────────── */

describe("gatewayRuntime · ChatService 事件 → OpenAI chunk 映射", () => {
  const state = (): SseMappingState => ({ toolCalls: [] });

  it("chunk/reasoning → delta.content", () => {
    const text = mapChatEventToOpenAiChunk({ content: "正文", meta: { type: "chunk" } }, CTX, state());
    expect(text).toMatchObject({
      object: "chat.completion.chunk",
      id: "chatcmpl-test",
      choices: [{ index: 0, delta: { content: "正文" }, finish_reason: null }],
    });
    const reasoning = mapChatEventToOpenAiChunk({ content: "思考", meta: { type: "reasoning" } }, CTX, state());
    expect((reasoning as OpenAiStreamChunk).choices[0].delta.content).toBe("思考");
  });

  it("tool_start → delta.tool_calls（index 递增、arguments JSON 串），并聚合到 state", () => {
    const mapping = state();
    const first = mapChatEventToOpenAiChunk(
      {
        content: JSON.stringify({ toolCallId: "call-1", toolName: "file_read", args: { path: "a.txt" } }),
        meta: { type: "tool_start" },
      },
      CTX,
      mapping,
    ) as OpenAiStreamChunk;
    expect(first.choices[0].delta.tool_calls?.[0]).toEqual({
      index: 0,
      id: "call-1",
      type: "function",
      function: { name: "file_read", arguments: JSON.stringify({ path: "a.txt" }) },
    });
    expect(mapping.toolCalls).toEqual([{ id: "call-1", name: "file_read", args: { path: "a.txt" } }]);

    const second = mapChatEventToOpenAiChunk(
      { content: JSON.stringify({ toolCallId: "call-2", toolName: "terminal_run", args: { command: "ls" } }), meta: { type: "tool_start" } },
      CTX,
      mapping,
    ) as OpenAiStreamChunk;
    expect(second.choices[0].delta.tool_calls?.[0].index).toBe(1);
    expect(mapping.toolCalls).toHaveLength(2);
  });

  it("done → 终止 chunk（budget→length，其余 stop）；error 状态不映射", () => {
    const done = mapChatEventToOpenAiChunk(
      { content: JSON.stringify({ status: "done", reason: "", finalText: "ok" }), meta: { type: "done" } },
      CTX,
      state(),
    ) as OpenAiStreamChunk;
    expect(done.choices[0].finish_reason).toBe("stop");

    const budget = mapChatEventToOpenAiChunk(
      { content: JSON.stringify({ status: "budget" }), meta: { type: "done" } },
      CTX,
      state(),
    ) as OpenAiStreamChunk;
    expect(budget.choices[0].finish_reason).toBe("length");

    expect(mapChatEventToOpenAiChunk({ content: JSON.stringify({ status: "error" }), meta: { type: "done" } }, CTX, state())).toBeNull();
  });

  it("tool 结果/progress/heartbeat/error 事件不映射（协议无对应位置）", () => {
    for (const type of ["tool", "progress", "heartbeat", "error"]) {
      expect(mapChatEventToOpenAiChunk({ content: "x", meta: { type } }, CTX, state()), type).toBeNull();
    }
    // 非法 JSON 的 tool_start 直接忽略（不把脏数据塞进 tool_calls）
    expect(mapChatEventToOpenAiChunk({ content: "not-json", meta: { type: "tool_start" } }, CTX, state())).toBeNull();
  });
});

/* ────────────────────────── 运行时（fake chat） ────────────────────────── */

interface FakeChatProbe {
  chat: GatewayChatLike;
  inputs: ChatInput[];
  histories: { role: "user" | "assistant"; content: string }[][];
  stops: string[];
}

function makeFakeChat(): FakeChatProbe {
  const inputs: ChatInput[] = [];
  const histories: { role: "user" | "assistant"; content: string }[][] = [];
  const stops: string[] = [];
  const result: ChatStreamResult = {
    status: "done",
    reason: "",
    finalText: "最终回答",
    usage: { rounds: 1, toolCalls: 1, totalTokens: 9, wallClockMs: 5 },
    chunks: [],
    claims: [],
  };
  const chat: GatewayChatLike = {
    async stream(input: ChatInput, sink?: (item: ChunkItem) => void): Promise<ChatStreamResult> {
      inputs.push(input);
      // 快照历史（运行时可能在本次流结束后才把本轮 user/assistant 追加进同一数组）
      histories.push([...(input.getHistory?.(input.sessionId ?? "none") ?? [])]);
      sink?.({ content: "部分", meta: { type: "chunk" } });
      sink?.({
        content: JSON.stringify({ toolCallId: "call-1", toolName: "file_read", args: { path: "a.txt" } }),
        meta: { type: "tool_start" },
      });
      sink?.({ content: "回答", meta: { type: "chunk" } });
      sink?.({
        content: JSON.stringify({ status: "done", reason: "", finalText: "最终回答", usage: result.usage, claims: [] }),
        meta: { type: "done" },
      });
      return result;
    },
    stop(sessionId: string): boolean {
      stops.push(sessionId);
      return true;
    },
  };
  return { chat, inputs, histories, stops };
}

async function makeRuntime(extra: Record<string, unknown> = {}) {
  const dataDir = tempDir("loopsoar-gw-data-");
  const configDir = tempDir("loopsoar-gw-config-");
  const probe = makeFakeChat();
  const runtime = await createGatewayRuntime({
    dataDir,
    configDir,
    chat: probe.chat,
    env: {},
    ...extra,
  });
  return { runtime, probe, dataDir, configDir };
}

const CHAT_BODY = { model: "loopsoar-default", messages: [{ role: "user", content: "你好" }] };

describe("gatewayRuntime · SSE 端到端（fake chat）", () => {
  it("流式：role → content → tool_calls → finish；会话历史落库", async () => {
    const { runtime } = await makeRuntime();
    const res = await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-loopsoar-session": "sess-1" },
      payload: { ...CHAT_BODY, stream: true },
    });
    expect(res.statusCode).toBe(200);
    const { chunks, done } = parseSse(res.body);
    expect(done).toBe(true);

    const first = chunks[0] as { choices: { delta: { role?: string }; finish_reason: string | null }[] };
    expect(first.choices[0].delta.role).toBe("assistant");

    const text = chunks
      .map((chunk) => (chunk as { choices: { delta: { content?: string } }[] }).choices[0].delta.content ?? "")
      .join("");
    expect(text).toContain("部分");
    expect(text).toContain("回答");

    const toolChunk = chunks.find((chunk) => {
      const delta = (chunk as { choices: { delta: { tool_calls?: unknown[] } }[] }).choices[0]?.delta;
      return Array.isArray(delta?.tool_calls);
    }) as { choices: { delta: { tool_calls: { function: { name: string } }[] } }[] } | undefined;
    expect(toolChunk?.choices[0].delta.tool_calls[0].function.name).toBe("file_read");

    const last = chunks[chunks.length - 1] as { choices: { finish_reason: string }[] };
    expect(last.choices[0].finish_reason).toBe("stop");

    // 会话复用：同一个 id 的会话被创建，历史包含 user+assistant
    expect(runtime.sessions.size).toBe(1);
    const session = runtime.sessions.get("sess-1");
    expect(session?.history).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "最终回答" },
    ]);
    await runtime.dispose();
  });

  it("x-loopsoar-session 复用多轮历史（第二次请求能取到第一次的上下文）", async () => {
    const { runtime, probe } = await makeRuntime();
    await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-loopsoar-session": "sess-2" },
      payload: { messages: [{ role: "user", content: "第一问" }] },
    });
    await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-loopsoar-session": "sess-2" },
      payload: { messages: [{ role: "user", content: "第二问" }] },
    });
    expect(probe.inputs.map((input) => input.message)).toEqual(["第一问", "第二问"]);
    // 第二次请求时 ChatService 拿到的历史 = 第一轮 user+assistant
    expect(probe.histories[1]).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "最终回答" },
    ]);
    expect(runtime.sessions.size).toBe(1);
    expect(runtime.sessions.get("sess-2")?.history).toHaveLength(4);
    await runtime.dispose();
  });

  it("无会话头：用请求体前序消息作为历史，每次请求独立会话", async () => {
    const { runtime, probe } = await makeRuntime();
    await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        messages: [
          { role: "system", content: "系统提示" },
          { role: "user", content: "上一问" },
          { role: "assistant", content: "上一答" },
          { role: "user", content: "当前问" },
        ],
      },
    });
    expect(probe.inputs[0].message).toBe("当前问");
    expect(probe.histories[0]).toEqual([
      { role: "user", content: "上一问" },
      { role: "assistant", content: "上一答" },
    ]);
    await runtime.dispose();
  });

  it("非流式：tool_calls 透传 + usage；finish_reason=tool_calls", async () => {
    const { runtime } = await makeRuntime();
    const res = await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-loopsoar-session": "sess-3" },
      payload: CHAT_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      choices: { message: { tool_calls?: { function: { name: string } }[]; content: string | null }; finish_reason: string }[];
      usage: { total_tokens: number };
    };
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls?.[0].function.name).toBe("file_read");
    expect(body.usage.total_tokens).toBe(9);
    await runtime.dispose();
  });

  it("dispose：中止所有会话并关闭 app", async () => {
    const { runtime, probe } = await makeRuntime();
    await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-loopsoar-session": "sess-4" },
      payload: CHAT_BODY,
    });
    await runtime.dispose();
    expect(probe.stops).toContain("sess-4");
    expect(runtime.sessions.size).toBe(0);
  });
});

describe("gatewayRuntime · 模型与令牌", () => {
  it("models 来自 providers.json（默认模型 + 已探测模型去重）", async () => {
    const dataDir = tempDir("loopsoar-gw-data-");
    const configDir = tempDir("loopsoar-gw-config-");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "providers.json"),
      JSON.stringify({
        activeId: "p1",
        items: [
          { id: "p1", provider: "openai", baseUrl: "https://api.example.com/v1", model: "gpt-a", models: [{ id: "gpt-a" }, { id: "gpt-b" }] },
          { id: "p2", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-c" },
        ],
      }),
      "utf8",
    );
    const probe = makeFakeChat();
    const runtime = await createGatewayRuntime({ dataDir, configDir, chat: probe.chat, env: {} });
    const models = runtime.models();
    expect(models.map((item) => item.id)).toEqual(["gpt-a", "gpt-b", "claude-c"]);
    expect(models[0].owned_by).toBe("openai");

    const res = await runtime.app.inject({ method: "GET", url: "/v1/models" });
    const body = res.json() as { data: { id: string }[] };
    expect(body.data.map((item) => item.id)).toEqual(["gpt-a", "gpt-b", "claude-c"]);
    await runtime.dispose();
  });

  it("无供应商配置 → 回退 loopsoar-default", async () => {
    const { runtime } = await makeRuntime();
    expect(runtime.models()).toEqual([{ id: "loopsoar-default", owned_by: "loopsoar" }]);
    await runtime.dispose();
  });

  it("LOOPSOAR_GATEWAY_TOKEN 非空 → tokenRequired=true 且请求需 Bearer", async () => {
    const { runtime } = await makeRuntime({ env: { LOOPSOAR_GATEWAY_TOKEN: "secret" } });
    expect(runtime.tokenRequired).toBe(true);
    const denied = await runtime.app.inject({ method: "GET", url: "/healthz" });
    expect(denied.statusCode).toBe(401);
    const allowed = await runtime.app.inject({
      method: "GET",
      url: "/healthz",
      headers: { authorization: "Bearer secret" },
    });
    expect(allowed.statusCode).toBe(200);
    await runtime.dispose();
  });
});

describe("gatewayRuntime · 真实 headless 装配（无 LLM 配置）", () => {
  it("未配置供应商时返回可读 500（不崩溃）", async () => {
    const dataDir = tempDir("loopsoar-gw-real-");
    const configDir = tempDir("loopsoar-gw-real-cfg-");
    const runtime = await createGatewayRuntime({ dataDir, configDir, env: {} });
    try {
      const res = await runtime.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(500);
      const body = res.json() as { error: { message: string; type: string } };
      expect(body.error.type).toBe("server_error");
      expect(body.error.message).toContain("LLM");
    } finally {
      await runtime.dispose();
    }
  });
});
