/**
 * 生成 packages/core/src/modelCapabilities.data.ts（模型能力内置表）。
 *
 * 数据源：
 *   1) slime 的 MODEL_CAPABILITIES（shared/gen/model-capabilities.ts）—— 通过
 *      scripts/data/slime-model-capabilities.json 快照（用 scripts/_dump-slime-caps.ts 抽取）。
 *      只取能力/上下文/输出/端点/思考协议，不搬定价。
 *   2) NVIDIA NIM 官方模型池参数文档（2026-10-07 整理，101 个模型；本脚本取其中
 *      有官方模型卡规格的对话/多模态模型）。用户明确：NIM 信息以该文档为准，
 *      slime 的 NIM 数据略旧。
 *
 * 为什么生成而不是手写：148 个家族正则 + 29 个 NIM 模型手抄必漂移；
 * 生成后 `pnpm test` 的守卫测试会校验数据文件与快照一致。
 *
 * 用法：node scripts/gen-model-capabilities.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, "..");

const slime = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "scripts/data/slime-model-capabilities.json"), "utf8"),
);

/**
 * NVIDIA NIM 模型池（chat / multimodal），来自用户提供的
 * `NVIDIA_NIM_模型池参数大全.md`（2026-10-07，build.nvidia.com 官方模型卡）。
 *   context: 上下文（tokens，官方模型卡规范值）
 *   maxOutput: 官方示例代码里的 max_tokens（示例值，实际上限可能更高；缺失=未公布）
 *   inputModalities: 官方 Input 模态
 *   functionCalling / structuredOutput / reasoning: 官方 Capabilities
 */
const NIM_MODELS = [
  { id: "deepseek-v4.1-flash", publisher: "DeepSeek AI", context: 1048576, maxOutput: 262144, inputModalities: ["text", "image"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "diffusiongemma-26b-a4b-it", publisher: "Google", context: 262144, inputModalities: ["text", "image", "video"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "gemma-4-31b-it", publisher: "Google", context: 262144, maxOutput: 1024, inputModalities: ["text", "image", "video"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "glm-5-3", publisher: "Z.ai", context: 1048576, inputModalities: ["text"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "glm-5-3-flash", publisher: "Z.ai", context: 1048576, inputModalities: ["text", "image"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "gpt-oss-20b", publisher: "OpenAI", context: 131072, maxOutput: 4096, inputModalities: ["text"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "ising-calibration-1-35b-a3b", publisher: "NVIDIA", context: 262144, inputModalities: ["image", "text"], functionCalling: false, structuredOutput: false, reasoning: true },
  { id: "ising-calibration-1.5-31b", publisher: "NVIDIA", context: 262144, inputModalities: ["image", "text"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "kimi-k3", publisher: "Moonshot AI", context: 1048576, maxOutput: 16384, inputModalities: ["text", "image"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "laguna-xs-2.1", publisher: "Poolside", context: 262144, inputModalities: ["text"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "llama-3.1-nemoguard-8b-content-safety", publisher: "NVIDIA", context: 131072, inputModalities: ["text"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "llama-3.1-nemoguard-8b-topic-control", publisher: "NVIDIA", context: 131072, inputModalities: ["text"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "llama-3.1-nemotron-safety-guard-8b-v3", publisher: "NVIDIA", context: 8192, inputModalities: ["text"], functionCalling: false, structuredOutput: false, reasoning: true },
  { id: "llama-3.2-11b-vision-instruct", publisher: "Meta", context: 131072, inputModalities: ["text", "image"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "llama-3.2-90b-vision-instruct", publisher: "Meta", context: 131072, inputModalities: ["text", "image"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "llama-guard-4-12b", publisher: "Meta", context: 163840, inputModalities: ["text", "image"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "muse-glimmer-30b", publisher: "Meta", context: 131072, inputModalities: ["text", "image"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "nemotron-3-nano-omni-30b-a3b-reasoning", publisher: "NVIDIA", context: 262144, inputModalities: ["video", "audio", "image", "text"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "nemotron-3-super-120b-a12b", publisher: "NVIDIA", context: 1048576, inputModalities: ["text"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "nemotron-3-ultra-550b-a55b", publisher: "NVIDIA", context: 1048576, maxOutput: 16384, inputModalities: ["text"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "nemotron-3.5-content-safety", publisher: "NVIDIA", context: 131072, inputModalities: ["text", "image"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "nemotron-3.5-lightning-30b-a3b", publisher: "NVIDIA", context: 1048576, inputModalities: ["text"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "paligemma", publisher: "Google", context: 8192, inputModalities: ["text", "image"], functionCalling: false, structuredOutput: false, reasoning: false },
];

const json = (value) => JSON.stringify(value);
const lines = [];
lines.push("/**");
lines.push(" * 模型能力内置表（AUTO-GENERATED，勿手改）。");
lines.push(" *");
lines.push(" * 生成：node scripts/gen-model-capabilities.mjs");
lines.push(" * 数据源：");
lines.push(" *   1) slime shared/gen/model-capabilities.ts（能力/上下文/输出/端点/思考协议，不含定价）");
lines.push(" *   2) NVIDIA NIM 模型池参数大全（2026-10-07，用户提供；NIM 数据以此为准，slime 的 NIM 略旧）");
lines.push(" */");
lines.push("");
lines.push("export interface VendorModelCapability {");
lines.push("  /** 模型 ID 匹配正则（不区分大小写）；精确 id 条目在前，家族兜底在后。 */");
lines.push("  match: string;");
lines.push("  thinking: boolean;");
lines.push("  efforts?: string[];");
lines.push("  context?: number;");
lines.push("  maxOut?: number;");
lines.push("  endpoint?: string;");
lines.push("  thinkingParam?: string;");
lines.push("}");
lines.push("");
lines.push("export interface VendorCapabilities {");
lines.push("  key: string;");
lines.push("  label: string;");
lines.push("  context?: number;");
lines.push("  maxOut?: number;");
lines.push("  models: VendorModelCapability[];");
lines.push("}");
lines.push("");
lines.push("export interface NimModelCapability {");
lines.push("  id: string;");
lines.push("  publisher: string;");
lines.push("  context: number;");
lines.push("  /** 官方示例 max_tokens（示例值，实际上限可能更高）。 */");
lines.push("  maxOutput?: number;");
lines.push("  inputModalities: Array<'text' | 'image' | 'audio' | 'video'>;");
lines.push("  functionCalling?: boolean;");
lines.push("  structuredOutput?: boolean;");
lines.push("  reasoning?: boolean;");
lines.push("}");
lines.push("");
lines.push("/** 非对话模型（embedding/rerank/图像/音频/视频生成）：不参与思考/工具能力推断。 */");
lines.push("export const NON_CHAT_MODEL_RE =");
lines.push(
  "  /(embedding|rerank|re-?rank|moderation|tts|text-to-speech|speech|asr|whisper|transcrib|dall-?e|stable-?diffusion|sdxl|flux|midjourney|sora|imagen|image|video|audio)/i;",
);
lines.push("");
lines.push("export const VENDOR_CAPABILITIES: VendorCapabilities[] = [");
for (const vendor of slime) {
  lines.push("  {");
  lines.push(`    key: ${json(vendor.key)},`);
  lines.push(`    label: ${json(vendor.label)},`);
  if (vendor.context !== undefined) lines.push(`    context: ${vendor.context},`);
  if (vendor.maxOut !== undefined) lines.push(`    maxOut: ${vendor.maxOut},`);
  lines.push("    models: [");
  for (const model of vendor.models) {
    const parts = [`match: ${json(model.match)}`, `thinking: ${model.thinking}`];
    if (model.efforts) parts.push(`efforts: ${json(model.efforts)}`);
    if (model.context !== undefined) parts.push(`context: ${model.context}`);
    if (model.maxOut !== undefined) parts.push(`maxOut: ${model.maxOut}`);
    if (model.endpoint) parts.push(`endpoint: ${json(model.endpoint)}`);
    if (model.thinkingParam) parts.push(`thinkingParam: ${json(model.thinkingParam)}`);
    lines.push(`      { ${parts.join(", ")} },`);
  }
  lines.push("    ],");
  lines.push("  },");
}
lines.push("];");
lines.push("");
lines.push("/** NVIDIA NIM 官方模型池（build.nvidia.com 模型卡规格；2026-10-07 整理）。 */");
lines.push("export const NIM_MODELS: NimModelCapability[] = [");
for (const model of NIM_MODELS) {
  const parts = [
    `id: ${json(model.id)}`,
    `publisher: ${json(model.publisher)}`,
    `context: ${model.context}`,
    `inputModalities: ${json(model.inputModalities)}`,
  ];
  if (model.maxOutput !== undefined) parts.push(`maxOutput: ${model.maxOutput}`);
  if (model.functionCalling !== undefined) parts.push(`functionCalling: ${model.functionCalling}`);
  if (model.structuredOutput !== undefined) parts.push(`structuredOutput: ${model.structuredOutput}`);
  if (model.reasoning !== undefined) parts.push(`reasoning: ${model.reasoning}`);
  lines.push(`  { ${parts.join(", ")} },`);
}
lines.push("];");
lines.push("");
lines.push("export const MODEL_CAPABILITIES_META = {");
lines.push('  slimeVendors: ' + slime.length + ",");
lines.push(
  "  slimeModels: " + slime.reduce((n, v) => n + v.models.length, 0) + ",",
);
lines.push("  nimModels: " + NIM_MODELS.length + ",");
lines.push('  sources: ["slime shared/gen/model-capabilities.ts", "NVIDIA_NIM_模型池参数大全.md (2026-10-07)"],');
lines.push("} as const;");
lines.push("");

const outPath = path.join(repoRoot, "packages/core/src/modelCapabilities.data.ts");
fs.writeFileSync(outPath, lines.join("\n"));
console.log(
  "generated",
  outPath,
  `vendors=${slime.length}`,
  `models=${slime.reduce((n, v) => n + v.models.length, 0)}`,
  `nim=${NIM_MODELS.length}`,
);
