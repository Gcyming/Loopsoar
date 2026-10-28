/**
 * gateway 冒烟：/healthz 与非流式 completion。
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../../packages/gateway/src/app.ts";

describe("gateway 冒烟", () => {
  it("/healthz 返回 healthy", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("healthy");
  });

  it("非流式 completion 返回 OpenAI 形状", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "loopsoar-default", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.role).toBe("assistant");
  });

  it("Bearer 强制时无令牌 → 401", async () => {
    const app = await buildApp({ requireToken: true, gatewayToken: "secret-token" });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(401);
  });
});
