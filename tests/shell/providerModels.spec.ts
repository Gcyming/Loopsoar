/**
 * 模型目录端点解析：
 *   · 普通 OpenAI 兼容网关 = `<baseUrl>/models`（baseUrl 以 /v1 结尾时）；
 *   · OpenCode Console 的推理与模型目录分属不同前缀（2026-11 实测）：
 *       Go 订阅  https://opencode.ai/inference/go/openai/v1 → https://opencode.ai/inference/go/v1/models
 *       按量付费 https://opencode.ai/inference/openai/v1      → https://opencode.ai/inference/v1/models
 *     旧实现直接拼 /models 会 404，导致「获取模型列表与能力」对 OpenCode 不可用。
 */
import { describe, expect, it } from "vitest";
import { resolveModelsUrl } from "../../packages/shell/src/main/providerModels.ts";

describe("供应商模型目录端点", () => {
  it("OpenCode Go / 按量付费：目录在推理根下，而不是 /openai/v1 下", () => {
    expect(resolveModelsUrl("https://opencode.ai/inference/go/openai/v1", false)).toBe(
      "https://opencode.ai/inference/go/v1/models",
    );
    expect(resolveModelsUrl("https://opencode.ai/inference/openai/v1", false)).toBe(
      "https://opencode.ai/inference/v1/models",
    );
    expect(resolveModelsUrl("https://opencode.ai/inference/go/openai/v1/", false)).toBe(
      "https://opencode.ai/inference/go/v1/models",
    );
  });

  it("普通 OpenAI / Anthropic 兼容网关沿用原有规则", () => {
    expect(resolveModelsUrl("https://api.deepseek.com/v1", false)).toBe("https://api.deepseek.com/v1/models");
    expect(resolveModelsUrl("https://example.com", false)).toBe("https://example.com/v1/models");
    expect(resolveModelsUrl("https://api.anthropic.com", true)).toBe("https://api.anthropic.com/v1/models");
    expect(resolveModelsUrl("https://api.anthropic.com/v1", true)).toBe("https://api.anthropic.com/v1/models");
  });
});
