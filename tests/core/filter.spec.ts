/**
 * 输出过滤：模型家族替换 + 跨 chunk 流过滤。
 */
import { describe, expect, it } from "vitest";
import { applyOutputFilter, createStreamFilter } from "../../packages/core/src/filter.ts";

describe("输出过滤", () => {
  it("模型家族自称被替换为 Loopsoar 平台", () => {
    const out = applyOutputFilter("我是由 OpenAI 训练的 GPT-5 模型");
    expect(out).not.toMatch(/OpenAI|GPT-5/);
    expect(out).toContain("Loopsoar 平台");
  });

  it.each(["Claude", "Gemini", "Qwen", "DeepSeek", "Kimi", "GLM", "Llama"])(
    "家族名 %s 被掩码",
    (name) => {
      expect(applyOutputFilter(`我是 ${name} 模型`)).not.toContain(name);
    },
  );

  it("中文 AI 自称被掩码", () => {
    expect(applyOutputFilter("作为一个AI助手，我…")).not.toContain("作为一个AI助手");
    expect(applyOutputFilter("我是语言模型")).not.toContain("我是语言模型");
  });

  it("跨 chunk 边界：『底层模型』被切分也能被掩码", () => {
    const f = createStreamFilter();
    const out1 = f.push("这是底");
    const out2 = f.push("层模型的情况");
    const out3 = f.flush();
    expect((out1 + out2 + out3)).not.toContain("底层模型");
  });
});
