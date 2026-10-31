/**
 * 供应商内置请求头默认值：OpenCode Go 必须带 x-opencode-session / UA，用户自定义可覆盖。
 */
import { describe, expect, it } from "vitest";
import { isOpenCodeGo, withProviderDefaults } from "../../packages/shell/src/main/providerDefaults.ts";

describe("供应商内置请求头", () => {
  it("识别 OpenCode Go（按 baseUrl 或 provider 名）", () => {
    expect(isOpenCodeGo("custom", "https://opencode.ai/inference/go/openai/v1")).toBe(true);
    expect(isOpenCodeGo("opencode-go", "https://example.com/v1")).toBe(true);
    expect(isOpenCodeGo("deepseek", "https://api.deepseek.com/v1")).toBe(false);
  });

  it("自动补 x-opencode-session/User-Agent，且用户值优先", () => {
    const defaults = withProviderDefaults("opencode-go", "https://opencode.ai/inference/go/openai/v1");
    expect(defaults["x-opencode-session"]).toBe("{{sessionId}}");
    expect(defaults["User-Agent"]).toBe("Loopsoar/1.0");

    const merged = withProviderDefaults("opencode-go", "https://opencode.ai/inference/go/openai/v1", {
      "x-opencode-session": "custom-session",
      "x-extra": "1",
    });
    expect(merged["x-opencode-session"]).toBe("custom-session");
    expect(merged["x-extra"]).toBe("1");
  });

  it("普通供应商不注入任何默认头", () => {
    expect(withProviderDefaults("deepseek", "https://api.deepseek.com/v1")).toEqual({});
  });
});
