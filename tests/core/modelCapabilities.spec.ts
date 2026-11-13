/**
 * 模型能力推断（供应商信息补全）：
 *   · NVIDIA NIM 数据以用户提供的官方模型池文档为准（2026-10-07）；
 *   · 其他模型回退 slime 的家族能力表（33 供应商 / 148 条）；
 *   · 上游 /models 元数据优先，缺失字段用内置表补全（不覆盖显式值）；
 *   · 非对话模型（embedding/rerank/图像/音频/视频）不推断思考/工具能力。
 */
import { describe, expect, it } from "vitest";
import {
  describeCapabilitySources,
  enrichModelSpec,
  findNimModelCapability,
  inferModelCapabilities,
  isNimEndpoint,
  isNonChatModel,
  parseUpstreamCapabilities,
  type ModelSpec,
} from "../../packages/core/src/modelCapabilities.ts";
import { MODEL_CAPABILITIES_META } from "../../packages/core/src/modelCapabilities.data.ts";

const NIM = { provider: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1" } as const;

describe("OpenCode Console /models 能力解析", () => {
  // 2026-11 实测行（/inference/go/v1/models）：能力数据在 limit/modalities/capabilities 三个对象里。
  const row = {
    id: "deepseek-v4.1-flash",
    limit: { context: 1_000_000, output: 384_000 },
    modalities: { input: ["text", "image/jpeg", "image/png", "video/mp4"] },
    capabilities: {
      tools: { supported: true },
      reasoning: { supported: true, effort: ["low", "high", "max"] },
      structured_output: true,
    },
  };

  it("解析 limit.context / limit.output / MIME 模态 / tools / reasoning.effort", () => {
    const caps = parseUpstreamCapabilities(row);
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutput).toBe(384_000);
    expect(caps.inputModalities).toEqual(["text", "image", "video"]);
    expect(caps.vision).toBe(true);
    expect(caps.functionCalling).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.thinking).toBe(true);
    expect(caps.thinkingEfforts).toEqual(["low", "high", "max"]);
  });

  it("能力来源诊断把这些字段标为上游提供（刷新列表能覆盖内置推断）", () => {
    const meta = describeCapabilitySources(row);
    expect(meta.upstreamFields).toContain("contextWindow");
    expect(meta.upstreamFields).toContain("maxOutput");
    expect(meta.upstreamFields).toContain("vision");
    expect(meta.upstreamFields).toContain("functionCalling");
    expect(meta.upstreamFields).toContain("structuredOutput");
  });
});

describe("NIM 端点识别与官方模型池", () => {
  it("识别 NVIDIA NIM 端点（provider / baseUrl 两种来源）", () => {
    expect(isNimEndpoint({ provider: "nvidia" })).toBe(true);
    expect(isNimEndpoint({ provider: "nvidia-nim" })).toBe(true);
    expect(isNimEndpoint({ baseUrl: "https://integrate.api.nvidia.com/v1" })).toBe(true);
    expect(isNimEndpoint({ provider: "agnes", baseUrl: "https://api.agnes-ai.cn/v1" })).toBe(false);
  });

  it("deepseek-v4.1-flash：1M 上下文 / 262144 输出 / 图片输入 / 工具+结构化+推理", () => {
    const caps = inferModelCapabilities("deepseek-v4.1-flash", NIM);
    expect(caps.source).toBe("nim-catalog");
    expect(caps.contextWindow).toBe(1_048_576);
    expect(caps.maxOutput).toBe(262_144);
    expect(caps.vision).toBe(true);
    expect(caps.inputModalities).toContain("image");
    expect(caps.functionCalling).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.thinking).toBe(true);
  });

  it("gemma-4-31b-it：262K 上下文 / 示例输出 1024 / 视频输入", () => {
    const caps = inferModelCapabilities("gemma-4-31b-it", NIM);
    expect(caps.contextWindow).toBe(262_144);
    expect(caps.maxOutput).toBe(1024);
    expect(caps.inputModalities).toEqual(expect.arrayContaining(["text", "image", "video"]));
  });

  it("kimi-k3 / gpt-oss-20b / nemotron-3-ultra 的官方规格", () => {
    const kimi = inferModelCapabilities("kimi-k3", NIM);
    expect(kimi.contextWindow).toBe(1_048_576);
    expect(kimi.maxOutput).toBe(16_384);
    expect(kimi.vision).toBe(true);

    const oss = inferModelCapabilities("gpt-oss-20b", NIM);
    expect(oss.contextWindow).toBe(131_072);
    expect(oss.maxOutput).toBe(4096);
    expect(oss.vision).toBe(false);
    expect(oss.functionCalling).toBe(true);
    expect(oss.structuredOutput).toBe(true);

    const ultra = inferModelCapabilities("nemotron-3-ultra-550b-a55b", NIM);
    expect(ultra.contextWindow).toBe(1_048_576);
    expect(ultra.maxOutput).toBe(16_384);
    expect(ultra.vision).toBe(false);
  });

  it("omni 模型支持音频/视频输入；命名空间 id（meta/…）也能命中", () => {
    const omni = inferModelCapabilities("nemotron-3-nano-omni-30b-a3b-reasoning", NIM);
    expect(omni.inputModalities).toEqual(expect.arrayContaining(["audio", "video", "image", "text"]));

    const namespaced = inferModelCapabilities("meta/llama-3.2-11b-vision-instruct", NIM);
    expect(namespaced.contextWindow).toBe(131_072);
    expect(namespaced.vision).toBe(true);
    expect(namespaced.functionCalling).toBe(false);
  });

  it("NIM 目录未收录的模型回退 slime 家族表（不是直接空白）", () => {
    const caps = inferModelCapabilities("gpt-5.2", NIM);
    expect(caps.source).toBe("vendor-table");
    expect(caps.contextWindow).toBeGreaterThan(0);
  });

  it("查找 NIM 规格：精确 + 后缀匹配", () => {
    expect(findNimModelCapability("glm-5-3")?.context).toBe(1_048_576);
    expect(findNimModelCapability("nvidia/nemotron-3-super-120b-a12b")?.context).toBe(1_048_576);
    expect(findNimModelCapability("no-such-model")).toBeUndefined();
  });
});

describe("slime 家族表兜底（非 NIM 端点）", () => {
  it("deepseek-v4.1-flash 在 agnes 端点走家族表，仍能得到上下文/思考能力", () => {
    const caps = inferModelCapabilities("deepseek-v4.1-flash", {
      provider: "agnes",
      baseUrl: "https://api.agnes-ai.cn/v1",
    });
    expect(caps.source).toBe("vendor-table");
    expect(caps.contextWindow).toBeGreaterThan(0);
    expect(caps.thinking).toBe(true);
  });

  it("未知模型保持未知（不编造能力）", () => {
    const caps = inferModelCapabilities("totally-unknown-model-xyz", { provider: "custom" });
    expect(caps.source).toBe("none");
    expect(caps.contextWindow).toBeUndefined();
    expect(caps.thinking).toBeUndefined();
  });

  it("非对话模型不推断思考/工具能力", () => {
    expect(isNonChatModel("text-embedding-3-large")).toBe(true);
    expect(isNonChatModel("agnes-image")).toBe(true);
    const caps = inferModelCapabilities("text-embedding-3-large", {});
    expect(caps.nonChat).toBe(true);
    expect(caps.thinking).toBeUndefined();
  });
});

describe("上游 /models 元数据合并（上游优先，内置表补全）", () => {
  it("parseUpstreamCapabilities 兼容常见字段命名", () => {
    const caps = parseUpstreamCapabilities({
      id: "model-a",
      context_length: 128_000,
      max_output_tokens: 8192,
      architecture: { input_modalities: ["text", "image"] },
      reasoning: { supported_efforts: ["low", "high"] },
      supports_function_calling: true,
      structured_output: true,
    });
    expect(caps.contextWindow).toBe(128_000);
    expect(caps.maxOutput).toBe(8192);
    expect(caps.vision).toBe(true);
    expect(caps.inputModalities).toEqual(["text", "image"]);
    expect(caps.thinking).toBe(true);
    expect(caps.thinkingEfforts).toEqual(["low", "high"]);
    expect(caps.functionCalling).toBe(true);
    expect(caps.structuredOutput).toBe(true);
  });

  it("上游显式值优先：内置表只补上游缺失字段", () => {
    const spec = enrichModelSpec(
      { id: "gpt-5.2", context_length: 999_999, max_output_tokens: 321 },
      {},
    ) as ModelSpec;
    expect(spec.id).toBe("gpt-5.2");
    expect(spec.contextWindow).toBe(999_999);
    expect(spec.maxOutput).toBe(321);
    // 上游没给 thinking/efforts → 内置表补上
    expect(spec.thinking).toBe(true);
    expect(spec.thinkingEfforts?.length).toBeGreaterThan(0);
  });

  it("NIM 模型在上游不返回元数据时也能补全（用户面板信息完整）", () => {
    const spec = enrichModelSpec({ id: "deepseek-v4.1-flash" }, NIM) as ModelSpec;
    expect(spec.contextWindow).toBe(1_048_576);
    expect(spec.maxOutput).toBe(262_144);
    expect(spec.vision).toBe(true);
    expect(spec.functionCalling).toBe(true);
    expect(spec.structuredOutput).toBe(true);
  });

  it("完全未知的模型只返回 id（不写诊断字段进配置）", () => {
    const spec = enrichModelSpec({ id: "some-random-model" }, {}) as ModelSpec & Record<string, unknown>;
    expect(spec.id).toBe("some-random-model");
    expect(spec.contextWindow).toBeUndefined();
    expect(spec).not.toHaveProperty("source");
    expect(spec).not.toHaveProperty("vendor");
    expect(spec).not.toHaveProperty("nonChat");
  });
});

describe("数据表守卫", () => {
  it("生成数据与来源一致（slime 33 供应商/148 模型 + NIM 23 模型）", () => {
    expect(MODEL_CAPABILITIES_META.slimeVendors).toBe(33);
    expect(MODEL_CAPABILITIES_META.slimeModels).toBe(148);
    expect(MODEL_CAPABILITIES_META.nimModels).toBe(23);
    expect(MODEL_CAPABILITIES_META.sources.join(" ")).toContain("NVIDIA_NIM");
  });
});

describe("describeCapabilitySources（拉列表时的能力来源诊断）", () => {
  it("上游行带能力字段时标记为 upstreamFields，其余来自内置推断", () => {
    const raw = {
      id: "kimi-k3",
      context_length: 1048576,
      max_completion_tokens: 16384,
      architecture: { input_modalities: ["text", "image"] },
      supports_function_calling: true,
    };
    const meta = describeCapabilitySources(raw, NIM);
    expect(meta.upstreamFields).toEqual(expect.arrayContaining(["contextWindow", "maxOutput", "inputModalities", "functionCalling"]));
    expect(meta.inferredCaps.contextWindow).toBe(1048576);
    expect(meta.inferredCaps.thinking).toBe(true);
  });

  it("上游只返回 id 时 upstreamFields 为空、inferredCaps 提供内置值（供 UI 判定是否手填）", () => {
    const meta = describeCapabilitySources({ id: "agnes-3.0-flash" }, { provider: "agnes", baseUrl: "https://api.agnes-ai.cn/v1" });
    expect(meta.upstreamFields).toEqual([]);
    expect(meta.inferredCaps.contextWindow).toBe(512000);
    expect(meta.inferredCaps.maxOutput).toBe(65536);
  });

  it("未知模型既不标记上游也不编造内置值", () => {
    const meta = describeCapabilitySources({ id: "totally-unknown-model-xyz" }, { provider: "x", baseUrl: "https://x.test/v1" });
    expect(meta.upstreamFields).toEqual([]);
    expect(meta.inferredCaps).toEqual({});
  });
});
