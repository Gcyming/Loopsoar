/**
 * Provider 配置模型：校验 / 归一 / 密钥可用性。
 * 这是「真 LLM 闭环」的配置层——配置非法或密钥缺失时给出可读原因，绝不让装配点猜。
 */
import { describe, expect, it } from "vitest";
import {
  validateProviderConfig,
  resolveApiKeyFromEnv,
  providerUsability,
  ProviderConfigSchema,
} from "../../packages/core/src/provider.ts";

describe("Provider 配置校验", () => {
  it("合法配置通过并归一（去空格、去尾斜杠）", () => {
    const cfg = validateProviderConfig({
      provider: "  deepseek ",
      baseUrl: "https://api.deepseek.com/v1/",
      model: " deepseek-chat ",
    });
    expect(cfg).toEqual({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    });
  });

  it("非法 baseUrl → 可读错误（指明字段）", () => {
    expect(() =>
      validateProviderConfig({ provider: "x", baseUrl: "不是URL", model: "m" }),
    ).toThrow(/baseUrl/);
  });

  it("缺 model / provider → 报错", () => {
    expect(() => validateProviderConfig({ provider: "x", baseUrl: "https://a.b/v1", model: "" })).toThrow();
    expect(() => validateProviderConfig({ provider: "", baseUrl: "https://a.b/v1", model: "m" })).toThrow();
  });

  it("schema 可直接用于契约侧校验（与 contracts 的 SettingsProviderSchema 同形）", () => {
    expect(ProviderConfigSchema.safeParse({ provider: "p", baseUrl: "http://127.0.0.1:19211/v1", model: "m" }).success).toBe(true);
  });
});

describe("密钥与可用性", () => {
  it("LOOPSOAR_API_KEY 优先于 OPENAI_API_KEY", () => {
    expect(resolveApiKeyFromEnv({ LOOPSOAR_API_KEY: "a", OPENAI_API_KEY: "b" })).toBe("a");
    expect(resolveApiKeyFromEnv({ OPENAI_API_KEY: "b" })).toBe("b");
    expect(resolveApiKeyFromEnv({})).toBe("");
  });

  it("未配置 / 缺密钥 / 可用 三态", () => {
    const cfg = validateProviderConfig({ provider: "p", baseUrl: "https://a.b/v1", model: "m" });
    expect(providerUsability(null, "").usable).toBe(false);
    expect(providerUsability(null, "").reason).toMatch(/尚未配置/);
    expect(providerUsability(cfg, "").usable).toBe(false);
    expect(providerUsability(cfg, "").reason).toMatch(/API Key/);
    expect(providerUsability(cfg, "sk-x").usable).toBe(true);
  });
});
