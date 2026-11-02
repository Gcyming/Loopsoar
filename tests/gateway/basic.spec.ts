/**
 * gateway 冒烟：/healthz、非流式 completion、Bearer 鉴权（app.inject，不监听端口）。
 * runner 用 fake 注入：gateway 包只做协议适配，Agent 运行时由 shell/gatewayRuntime 注入。
 */
import { describe, expect, it } from "vitest";
import { buildApp, type GatewayChatRunner } from "../../packages/gateway/src/app.ts";

function fakeRunner(): GatewayChatRunner {
  return {
    models: () => [{ id: "loopsoar-default" }],
    async complete(request, sink) {
      const ctx = { id: "chatcmpl-test", created: 1_700_000_000, model: request.model ?? "loopsoar-default" };
      sink({
        id: ctx.id,
        object: "chat.completion.chunk",
        created: ctx.created,
        model: ctx.model,
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      });
      return {
        id: ctx.id,
        created: ctx.created,
        model: ctx.model,
        status: "done",
        reason: "",
        finalText: "hi",
        toolCalls: [],
        usage: { totalTokens: 1 },
      };
    },
  };
}

describe("gateway 冒烟", () => {
  it("/healthz 返回 healthy", async () => {
    const app = await buildApp({ runner: fakeRunner() });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("healthy");
    await app.close();
  });

  it("非流式 completion 返回 OpenAI 形状", async () => {
    const app = await buildApp({ runner: fakeRunner() });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "loopsoar-default", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.role).toBe("assistant");
    await app.close();
  });

  it("Bearer 强制时无令牌 → 401", async () => {
    const app = await buildApp({ runner: fakeRunner(), requireToken: true, gatewayToken: "secret-token" });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
