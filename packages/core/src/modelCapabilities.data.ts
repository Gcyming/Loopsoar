/**
 * 模型能力内置表（AUTO-GENERATED，勿手改）。
 *
 * 生成：node scripts/gen-model-capabilities.mjs
 * 数据源：
 *   1) slime shared/gen/model-capabilities.ts（能力/上下文/输出/端点/思考协议，不含定价）
 *   2) NVIDIA NIM 模型池参数大全（2026-10-07，用户提供；NIM 数据以此为准，slime 的 NIM 略旧）
 */

export interface VendorModelCapability {
  /** 模型 ID 匹配正则（不区分大小写）；精确 id 条目在前，家族兜底在后。 */
  match: string;
  thinking: boolean;
  efforts?: string[];
  context?: number;
  maxOut?: number;
  endpoint?: string;
  thinkingParam?: string;
}

export interface VendorCapabilities {
  key: string;
  label: string;
  context?: number;
  maxOut?: number;
  models: VendorModelCapability[];
}

export interface NimModelCapability {
  id: string;
  publisher: string;
  context: number;
  /** 官方示例 max_tokens（示例值，实际上限可能更高）。 */
  maxOutput?: number;
  inputModalities: Array<'text' | 'image' | 'audio' | 'video'>;
  functionCalling?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
}

/** 非对话模型（embedding/rerank/图像/音频/视频生成）：不参与思考/工具能力推断。 */
export const NON_CHAT_MODEL_RE =
  /(embedding|rerank|re-?rank|moderation|tts|text-to-speech|speech|asr|whisper|transcrib|dall-?e|stable-?diffusion|sdxl|flux|midjourney|sora|imagen|image|video|audio)/i;

export const VENDOR_CAPABILITIES: VendorCapabilities[] = [
  {
    key: "openai",
    label: "OpenAI（GPT-5 / o 系列）",
    context: 1000000,
    maxOut: 128000,
    models: [
      { match: "^gpt[-_]?6[-_.]?astra$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.6[-_.]?cyber$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.5[-_.]?cyber$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.6[-_.]?sol$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.6[-_.]?terra$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.6[-_.]?luna$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.5[-_.]?pro$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.5$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.4[-_.]?pro$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.4[-_.]?mini$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.4[-_.]?nano$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.4$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.3[-_.]?codex$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.2[-_.]?pro$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.2$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5\\.1$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5[-_.]?mini$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5[-_.]?nano$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5[-_.]?pro$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5[-_.]?search[-_.]?api$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^gpt[-_]?5$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^chat[-_]?latest$", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "^o1[-_.]?pro$", thinking: true, efforts: ["low","medium","high"] },
      { match: "^o1$", thinking: true, efforts: ["low","medium","high"] },
      { match: "^o3[-_.]?pro$", thinking: true, efforts: ["low","medium","high"] },
      { match: "^o3[-_.]?mini$", thinking: true, efforts: ["low","medium","high"] },
      { match: "^o3$", thinking: true, efforts: ["low","medium","high"] },
      { match: "^o4[-_.]?mini$", thinking: true, efforts: ["low","medium","high"] },
      { match: "^gpt[-_]?4\\.1[-_.]?nano$", thinking: false, context: 1000000, maxOut: 32768 },
      { match: "^gpt[-_]?4\\.1[-_.]?mini$", thinking: false, context: 1000000, maxOut: 32768 },
      { match: "^gpt[-_]?4\\.1$", thinking: false, context: 1000000, maxOut: 32768 },
      { match: "gpt[-_]?[5-9]", thinking: true, efforts: ["minimal","low","medium","high","xhigh","max"], endpoint: "responses" },
      { match: "(^|[^a-z0-9])o[1-9]([^a-z0-9]|$)", thinking: true, efforts: ["low","medium","high"] },
      { match: "^gpt[-_]4o[-_]2024[-_]0?5[-_]13", thinking: false, context: 128000, maxOut: 4096 },
      { match: "^gpt[-_]4o[-_]?mini", thinking: false, context: 128000, maxOut: 16384 },
      { match: "^gpt[-_]4o", thinking: false, context: 128000, maxOut: 16384 },
      { match: "^gpt[-_]4[-_]?turbo", thinking: false, context: 128000, maxOut: 4096 },
      { match: "gpt[-_]4o[-_]2024[-_]0?5[-_]13", thinking: false, context: 128000, maxOut: 4096 },
      { match: "gpt[-_]4o[-_]?mini", thinking: false, context: 128000, maxOut: 16384 },
      { match: "gpt[-_]4o", thinking: false, context: 128000, maxOut: 16384 },
      { match: "gpt[-_]4[-_]?turbo", thinking: false, context: 128000, maxOut: 4096 },
      { match: "^gpt[-_]?3\\.5[-_]?turbo[-_.]?0?125$", thinking: false, context: 16385 },
      { match: "^gpt[-_]?3\\.5[-_]?turbo[-_.]?1106$", thinking: false, context: 16385 },
      { match: "^gpt[-_]?3\\.5[-_]?turbo[-_.]?instruct$", thinking: false, context: 4096 },
      { match: "^gpt[-_]?3\\.5[-_]?turbo$", thinking: false, context: 16385 },
    ],
  },
  {
    key: "claude",
    label: "Anthropic Claude",
    context: 200000,
    maxOut: 64000,
    models: [
      { match: "claude.*opus[-_.](4[-_.][5-9]|[5-9])([-_.]|$)", thinking: true, efforts: ["low","medium","high","xhigh","max"], context: 1048576, maxOut: 128000, endpoint: "anthropic" },
      { match: "claude.*opus", thinking: true, efforts: ["low","medium","high","xhigh","max"], context: 200000, maxOut: 32000, endpoint: "anthropic" },
      { match: "claude.*sonnet[-_.]([5-9]|[1-9]\\d)([-_.]|$)", thinking: true, efforts: ["low","medium","high","xhigh","max"], context: 1048576, maxOut: 128000, endpoint: "anthropic" },
      { match: "claude.*sonnet", thinking: true, efforts: ["low","medium","high","xhigh","max"], context: 1048576, maxOut: 64000, endpoint: "anthropic" },
      { match: "claude.*haiku[-_.]([4-9]|[1-9]\\d)([-_.]|$)", thinking: true, efforts: ["low","medium","high"], context: 200000, maxOut: 64000, endpoint: "anthropic" },
      { match: "claude[-_.]3[-_.]haiku", thinking: true, efforts: ["low","medium","high"], context: 200000, maxOut: 4096, endpoint: "anthropic" },
      { match: "claude.*haiku", thinking: true, efforts: ["low","medium","high"], context: 200000, maxOut: 8192, endpoint: "anthropic" },
      { match: "claude", thinking: true, efforts: ["low","medium","high"], endpoint: "anthropic" },
    ],
  },
  {
    key: "gemini",
    label: "Google Gemini",
    context: 1048576,
    maxOut: 65536,
    models: [
      { match: "gemini[-_.]?2[._]?5[-_.]?flash[-_.]?lite", thinking: true, efforts: ["minimal","low","medium","high"], endpoint: "google" },
      { match: "gemini[-_.]?2[._]?5[-_.]?flash", thinking: true, efforts: ["minimal","low","medium","high"], endpoint: "google" },
      { match: "gemini[-_.]?2[._]?5[-_.]?pro", thinking: true, efforts: ["minimal","low","medium","high"], endpoint: "google" },
      { match: "gemini[-_.]?3[._]?5[-_.]?flash[-_.]?lite", thinking: true, efforts: ["minimal","low","medium","high"], endpoint: "google" },
      { match: "gemini[-_.]?3[._]?1[-_.]?flash[-_.]?lite", thinking: true, efforts: ["minimal","low","medium","high"], endpoint: "google" },
      { match: "gemini[-_.]?3[._]?5[-_.]?flash", thinking: true, efforts: ["minimal","low","medium","high"], endpoint: "google" },
      { match: "gemini[-_.]?3[._]?[6-9][-_.]?flash", thinking: true, efforts: ["minimal","low","medium","high"], endpoint: "google" },
      { match: "gemini[-_.]?3[-_.]?flash", thinking: true, efforts: ["minimal","low","medium","high"], endpoint: "google" },
      { match: "gemini[-_.]?3(\\.[0-9]+)?[-_.]?pro", thinking: true, efforts: ["minimal","low","medium","high"], endpoint: "google" },
      { match: "gemini", thinking: true, efforts: ["minimal","low","medium","high"], endpoint: "google" },
    ],
  },
  {
    key: "grok",
    label: "xAI Grok",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "grok", thinking: true, efforts: ["low","medium","high","xhigh"] },
    ],
  },
  {
    key: "mistral",
    label: "Mistral（含 Mixtral）",
    context: 131072,
    maxOut: 32768,
    models: [
      { match: "mistral|mixtral", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "cohere",
    label: "Cohere Command",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "cohere|command", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "amazon",
    label: "Amazon Nova / Titan",
    context: 200000,
    maxOut: 65536,
    models: [
      { match: "amazon|nova[-_.]|titan", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "llama",
    label: "Meta Llama",
    context: 131072,
    maxOut: 32768,
    models: [
      { match: "llama", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "gemma",
    label: "Google Gemma（开源）",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "gemma", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "gpt-oss",
    label: "OpenAI gpt-oss（开源）",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "gpt[-_]?oss", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "nemotron",
    label: "NVIDIA Nemotron",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "nemotron", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "granite",
    label: "IBM Granite",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "granite", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "phi",
    label: "Microsoft Phi",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "phi[-_]?[0-9]", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "deepseek",
    label: "DeepSeek（V4.1 Flash / V4 Pro）",
    context: 1048576,
    maxOut: 393216,
    models: [
      { match: "^deepseek[-_.]?v4[-_.]?pro", thinking: true, efforts: ["low","high","max"] },
      { match: "^deepseek[-_.]?flash", thinking: true, efforts: ["low","high","max"] },
      { match: "^deepseek[-_.]?v4[-_.]?1[-_.]?flash", thinking: true, efforts: ["low","high","max"] },
      { match: "^deepseek[-_.]?chat", thinking: true, efforts: ["low","high","max"] },
      { match: "^deepseek[-_.]?reasoner", thinking: true, efforts: ["low","high","max"] },
      { match: "deepseek.*pro", thinking: true, efforts: ["low","high","max"] },
      { match: "deepseek[-_.]?v?4[-_.]?1|deepseek[-_.]?flash|deepseek[-_.]?chat|deepseek[-_.]?reasoner|deepseek[-_.]?v?[23]|deepseek[-_.]?r1", thinking: true, efforts: ["low","high","max"] },
      { match: "deepseek", thinking: true, efforts: ["low","high","max"] },
    ],
  },
  {
    key: "qwen",
    label: "通义千问 Qwen",
    context: 131072,
    maxOut: 32768,
    models: [
      { match: "^qwen3\\.8-max", thinking: true, efforts: ["low","medium","xhigh"], thinkingParam: "enable_thinking" },
      { match: "^qwen3\\.8-flash", thinking: true, efforts: ["low","medium","xhigh"], thinkingParam: "enable_thinking" },
      { match: "^qwen3\\.8-27b", thinking: true, efforts: ["low","medium","xhigh"], thinkingParam: "enable_thinking" },
      { match: "^qwen3\\.7-plus", thinking: true, efforts: ["low","medium","xhigh"], thinkingParam: "enable_thinking" },
      { match: "qwen", thinking: true, efforts: ["low","medium","xhigh"], thinkingParam: "enable_thinking" },
    ],
  },
  {
    key: "glm",
    label: "智谱 GLM",
    context: 128000,
    maxOut: 16384,
    models: [
      { match: "glm[-_.]4[-_.]?flash([-_.]|$)", thinking: true, efforts: ["low","medium","high"], context: 200000, maxOut: 128000 },
      { match: "glm[-_.]4[-_.]6v[-_.]?flash([-_.]|$)", thinking: true, efforts: ["low","medium","high"] },
      { match: "glm[-_.]4[-_.]7[-_.]?flash([-_.]|$)", thinking: true, efforts: ["low","medium","high"], context: 200000, maxOut: 128000 },
      { match: "glm[-_.]4[-_.]5[-_.]?flash([-_.]|$)", thinking: true, efforts: ["low","medium","high"], context: 131072, maxOut: 98304 },
      { match: "glm[-_.]4[-_.]6v[-_.]?flashx", thinking: true, efforts: ["low","medium","high"] },
      { match: "glm[-_.]4[-_.]6v", thinking: true, efforts: ["low","medium","high"] },
      { match: "glm[-_.]4[-_.]5v", thinking: true, efforts: ["low","medium","high"] },
      { match: "glm[-_.]5v[-_.]?turbo", thinking: true, efforts: ["low","medium","high"] },
      { match: "glm[-_.]4[-_.]7[-_.]?flashx", thinking: true, efforts: ["low","medium","high"], context: 200000, maxOut: 128000 },
      { match: "glm[-_.]4[-_.]7", thinking: true, efforts: ["low","medium","high"] },
      { match: "glm[-_.]4[-_.]5[-_.]?air", thinking: true, efforts: ["low","medium","high"] },
      { match: "glm[-_.]5[-_.]3[-_.]?flash", thinking: true, efforts: ["low","medium","high"], context: 1048576, maxOut: 128000 },
      { match: "glm[-_.]5[-_.]3", thinking: true, efforts: ["low","medium","high"], context: 1048576, maxOut: 128000 },
      { match: "glm[-_.]5[-_.]2", thinking: true, efforts: ["low","medium","high"], context: 1048576, maxOut: 128000 },
      { match: "glm[-_.]5[-_.]1", thinking: true, efforts: ["low","medium","high"], context: 200000, maxOut: 128000 },
      { match: "glm[-_.]5[-_.]?turbo", thinking: true, efforts: ["low","medium","high"] },
      { match: "glm[-_.]5", thinking: true, efforts: ["low","medium","high"] },
      { match: "glm[-_.]4", thinking: true, efforts: ["low","medium","high"] },
      { match: "glm", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "kimi",
    label: "Moonshot Kimi",
    context: 262144,
    maxOut: 65536,
    models: [
      { match: "^kimi[-_.]?k3", thinking: true, efforts: ["low","high","max"] },
      { match: "^kimi[-_.]?k2\\.7[-_.]?code", thinking: true, efforts: ["low","high","max"] },
      { match: "^kimi[-_.]?k2\\.6", thinking: true, efforts: ["low","high","max"] },
      { match: "^kimi[-_.]?k2\\.5", thinking: true, efforts: ["low","high","max"] },
      { match: "^moonshot[-_.]?v1", thinking: true, efforts: ["low","high","max"] },
      { match: "kimi", thinking: true, efforts: ["low","high","max"] },
    ],
  },
  {
    key: "minimax",
    label: "MiniMax（M 系 / abab）",
    context: 1000000,
    maxOut: 65536,
    models: [
      { match: "^minimax[-_.]?m3", thinking: true, efforts: ["low","medium","high"] },
      { match: "^minimax[-_.]?m2\\.7[-_.]?highspeed", thinking: true, efforts: ["low","medium","high"] },
      { match: "^minimax[-_.]?m2\\.7", thinking: true, efforts: ["low","medium","high"] },
      { match: "^minimax[-_.]?m2\\.5[-_.]?highspeed", thinking: true, efforts: ["low","medium","high"] },
      { match: "^minimax[-_.]?m2\\.5", thinking: true, efforts: ["low","medium","high"] },
      { match: "^minimax[-_.]?m2(\\.1)?", thinking: true, efforts: ["low","medium","high"] },
      { match: "minimax|abab", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "doubao",
    label: "字节豆包 Doubao",
    context: 262144,
    maxOut: 65536,
    models: [
      { match: "^doubao[-_.]?seed[-_.]?2\\.1[-_.]?pro", thinking: true, efforts: ["low","medium","high"], thinkingParam: "thinking" },
      { match: "^doubao[-_.]?seed[-_.]?2\\.1[-_.]?turbo", thinking: true, efforts: ["low","medium","high"], thinkingParam: "thinking" },
      { match: "^doubao[-_.]?seed[-_.]?evolving", thinking: true, efforts: ["low","medium","high"], thinkingParam: "thinking" },
      { match: "doubao", thinking: true, efforts: ["low","medium","high"], thinkingParam: "thinking" },
    ],
  },
  {
    key: "hunyuan",
    label: "腾讯混元 Hunyuan",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "^hunyuan[-_.]?turbos", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
      { match: "^hunyuan[-_.]?t1", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
      { match: "^hunyuan[-_.]?a13b", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
      { match: "^hunyuan[-_.]?pro", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
      { match: "hunyuan", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "ernie",
    label: "百度文心 Ernie",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "^ernie[-_.]?5\\.1", thinking: true, efforts: ["low","medium","high"] },
      { match: "^ernie[-_.]?5\\.0", thinking: true, efforts: ["low","medium","high"] },
      { match: "^ernie[-_.]?x1", thinking: true, efforts: ["low","medium","high"] },
      { match: "^ernie[-_.]?4\\.5[-_.]?turbo[-_.]?vl", thinking: true, efforts: ["low","medium","high"] },
      { match: "^ernie[-_.]?4\\.5[-_.]?turbo", thinking: true, efforts: ["low","medium","high"] },
      { match: "^ernie[-_.]?4\\.5[-_.]?8k", thinking: true, efforts: ["low","medium","high"] },
      { match: "ernie", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "baichuan",
    label: "百川 Baichuan",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "baichuan", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "sensechat",
    label: "商汤 SenseChat / SenseNova",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "sensechat|sensenova", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "yi",
    label: "零一万物 Yi",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "yi[-_.]", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "minicpm",
    label: "面壁 MiniCPM",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "minicpm", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "skywork",
    label: "昆仑万维 Skywork",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "skywork", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "step",
    label: "阶跃星辰 Step",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "step[-_]", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "muse",
    label: "Muse Spark",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "muse", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "spark",
    label: "讯飞星火 Spark",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "spark[-_.]", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "agnes",
    label: "Agnes（自研 SILAM）",
    context: 512000,
    maxOut: 65536,
    models: [
      { match: "agnes.*pro.*beta", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
      { match: "agnes.*pro", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
      { match: "agnes", thinking: true, efforts: ["low","medium","high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "note",
    label: "点点笔记 / 小红书（dots）",
    context: 512000,
    maxOut: 65536,
    models: [
      { match: "(^|[^a-z])dot[-_.]?s?(\\d|[^a-z]|$)", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "mimo",
    label: "小米 MiMo",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "mimo", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
  {
    key: "ling",
    label: "Ling",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "ling[-_]?\\d", thinking: true, efforts: ["low","medium","high"] },
    ],
  },
];

/** NVIDIA NIM 官方模型池（build.nvidia.com 模型卡规格；2026-10-07 整理）。 */
export const NIM_MODELS: NimModelCapability[] = [
  { id: "deepseek-v4.1-flash", publisher: "DeepSeek AI", context: 1048576, inputModalities: ["text","image"], maxOutput: 262144, functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "diffusiongemma-26b-a4b-it", publisher: "Google", context: 262144, inputModalities: ["text","image","video"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "gemma-4-31b-it", publisher: "Google", context: 262144, inputModalities: ["text","image","video"], maxOutput: 1024, functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "glm-5-3", publisher: "Z.ai", context: 1048576, inputModalities: ["text"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "glm-5-3-flash", publisher: "Z.ai", context: 1048576, inputModalities: ["text","image"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "gpt-oss-20b", publisher: "OpenAI", context: 131072, inputModalities: ["text"], maxOutput: 4096, functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "ising-calibration-1-35b-a3b", publisher: "NVIDIA", context: 262144, inputModalities: ["image","text"], functionCalling: false, structuredOutput: false, reasoning: true },
  { id: "ising-calibration-1.5-31b", publisher: "NVIDIA", context: 262144, inputModalities: ["image","text"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "kimi-k3", publisher: "Moonshot AI", context: 1048576, inputModalities: ["text","image"], maxOutput: 16384, functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "laguna-xs-2.1", publisher: "Poolside", context: 262144, inputModalities: ["text"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "llama-3.1-nemoguard-8b-content-safety", publisher: "NVIDIA", context: 131072, inputModalities: ["text"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "llama-3.1-nemoguard-8b-topic-control", publisher: "NVIDIA", context: 131072, inputModalities: ["text"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "llama-3.1-nemotron-safety-guard-8b-v3", publisher: "NVIDIA", context: 8192, inputModalities: ["text"], functionCalling: false, structuredOutput: false, reasoning: true },
  { id: "llama-3.2-11b-vision-instruct", publisher: "Meta", context: 131072, inputModalities: ["text","image"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "llama-3.2-90b-vision-instruct", publisher: "Meta", context: 131072, inputModalities: ["text","image"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "llama-guard-4-12b", publisher: "Meta", context: 163840, inputModalities: ["text","image"], functionCalling: false, structuredOutput: false, reasoning: false },
  { id: "muse-glimmer-30b", publisher: "Meta", context: 131072, inputModalities: ["text","image"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "nemotron-3-nano-omni-30b-a3b-reasoning", publisher: "NVIDIA", context: 262144, inputModalities: ["video","audio","image","text"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "nemotron-3-super-120b-a12b", publisher: "NVIDIA", context: 1048576, inputModalities: ["text"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "nemotron-3-ultra-550b-a55b", publisher: "NVIDIA", context: 1048576, inputModalities: ["text"], maxOutput: 16384, functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "nemotron-3.5-content-safety", publisher: "NVIDIA", context: 131072, inputModalities: ["text","image"], functionCalling: true, structuredOutput: false, reasoning: true },
  { id: "nemotron-3.5-lightning-30b-a3b", publisher: "NVIDIA", context: 1048576, inputModalities: ["text"], functionCalling: true, structuredOutput: true, reasoning: true },
  { id: "paligemma", publisher: "Google", context: 8192, inputModalities: ["text","image"], functionCalling: false, structuredOutput: false, reasoning: false },
];

export const MODEL_CAPABILITIES_META = {
  slimeVendors: 33,
  slimeModels: 148,
  nimModels: 23,
  sources: ["slime shared/gen/model-capabilities.ts", "NVIDIA_NIM_模型池参数大全.md (2026-10-07)"],
} as const;
