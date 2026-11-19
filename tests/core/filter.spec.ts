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

  it("URL 与代码块/行内代码不被身份掩码破坏", () => {
    const text = [
      "链接 https://api.openai.com/v1/models 保留。",
      "说明 OpenAI 的身份。",
      "`OpenAI` 行内代码保留。",
      "```ts",
      "const provider = \"OpenAI\";",
      "```",
    ].join("\n");
    const out = applyOutputFilter(text);
    expect(out).toContain("https://api.openai.com/v1/models");
    expect(out).toContain("`OpenAI`");
    expect(out).toContain('const provider = "OpenAI";');
    expect(out).toContain("Loopsoar 平台 的身份");
  });

  it("流式过滤保持围栏代码块原样、只掩码块外正文", () => {
    const f = createStreamFilter();
    const out =
      f.push("```ts\nconst provider = \"OpenAI\";\n```\n") +
      f.push("我是 OpenAI 模型\n") +
      f.flush();
    expect(out).toContain('const provider = "OpenAI";');
    expect(out).toContain("Loopsoar 平台");
    expect(out).not.toContain("我是 OpenAI");
  });
});
