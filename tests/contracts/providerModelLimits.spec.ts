/**
 * 供应商模型 token 上限回归：上游常见 1,048,576（二进制百万），
 * 不能再用 1,000,000 的旧上限拒绝保存；同时仍要拦住明显异常值。
 */
import { describe, expect, it } from "vitest";
import { PROVIDER_MODEL_TOKEN_LIMIT, ProviderModelSchema, ProviderItemSchema } from "../../packages/contracts/src/validators.ts";

const model = (maxOutput: number, contextWindow?: number) => ({
  id: "test-model",
  maxOutput,
  ...(contextWindow === undefined ? {} : { contextWindow }),
});

describe("ProviderModelSchema token 上限", () => {
  it("接受 1,048,576 这类二进制百万输出上限", () => {
    expect(ProviderModelSchema.safeParse(model(1_048_576)).success).toBe(true);
    expect(ProviderModelSchema.safeParse(model(1_048_576, 1_048_576)).success).toBe(true);
  });

  it("接受到 10,000,000 的边界", () => {
    expect(PROVIDER_MODEL_TOKEN_LIMIT).toBe(10_000_000);
    expect(ProviderModelSchema.safeParse(model(10_000_000, 10_000_000)).success).toBe(true);
  });

  it("拒绝超过 10,000,000 的输出上限", () => {
    const result = ProviderModelSchema.safeParse(model(10_000_001));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["maxOutput"]);
    }
  });

  it("供应商整体载荷可以携带 1,048,576 的模型配置", () => {
    const result = ProviderItemSchema.safeParse({
      provider: "test",
      baseUrl: "https://example.com/v1",
      model: "test-model",
      models: [model(1_048_576, 1_048_576)],
    });
    expect(result.success).toBe(true);
  });
});
