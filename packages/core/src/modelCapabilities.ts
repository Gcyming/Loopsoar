/**
 * 模型能力推断（离线内置表 + 上游元数据合并）。
 *
 * 背景（用户 2026-11-09 需求）：供应商面板只有"上下文/输出/视觉/思考"四项，
 * 且上游 /models 未返回元数据时这些字段全空 —— 用户无从知道模型到底能干什么。
 * 参考 slime 的 `shared/gen/model-capabilities.ts`（33 个供应商 / 148 条模型正则），
 * 并按用户提供的《NVIDIA NIM 模型池参数大全》（2026-10-07，官方模型卡）更新 NIM 数据。
 *
 * 合并策略（与 slime 一致）：**上游 /models 返回的元数据优先**；上游没给（大多数官方 API
 * 只返回模型清单，不含 context/vision 等）→ 回退本模块内置表；两者都没有 → 保持未知（不编造）。
 *
 * 本模块是纯逻辑（零 node 依赖），数据在 `modelCapabilities.data.ts`（AUTO-GENERATED）。
 */
import {
  NIM_MODELS,
  NON_CHAT_MODEL_RE,
  VENDOR_CAPABILITIES,
  type NimModelCapability,
  type VendorCapabilities,
  type VendorModelCapability,
} from "./modelCapabilities.data.js";

export type InputModality = "text" | "image" | "audio" | "video";

/** 模型能力（与 providers 配置里的 ProviderModel 字段一一对应）。 */
export interface ModelCapabilities {
  /** 上下文窗口（tokens）。 */
  contextWindow?: number;
  /** 最大输出（tokens）。 */
  maxOutput?: number;
  /** 是否支持图片输入（`inputModalities` 含 image 的便捷布尔位，UI 常用）。 */
  vision?: boolean;
  /** 是否支持思考 / reasoning。 */
  thinking?: boolean;
  /** 推理等级（升序；UI 用于下拉选项）。 */
  thinkingEfforts?: string[];
  /** 输入模态（text/image/audio/video）。 */
  inputModalities?: InputModality[];
  /** 是否支持函数/工具调用。 */
  functionCalling?: boolean;
  /** 是否支持结构化输出（JSON Schema / response_format）。 */
  structuredOutput?: boolean;
}

export interface CapabilityInferenceOptions {
  /** 供应商名（用户配置里的 provider 字段）。 */
  provider?: string;
  /** 供应商 baseUrl（用于识别 NIM 等官方端点）。 */
  baseUrl?: string;
}

export interface InferredCapabilities extends ModelCapabilities {
  /** 命中的内置表来源（诊断用）：nim-catalog / vendor-table / none。 */
  source: "nim-catalog" | "vendor-table" | "none";
  /** 命中的供应商 key（vendor-table 时）。 */
  vendor?: string;
  /** 是否非对话模型（embedding/rerank/图像/音频/视频生成）。 */
  nonChat?: boolean;
}

/** NVIDIA NIM 端点识别（官方免费端点 / build.nvidia.com 预览）。 */
export function isNimEndpoint(options: CapabilityInferenceOptions = {}): boolean {
  const provider = String(options.provider ?? "").toLowerCase();
  const baseUrl = String(options.baseUrl ?? "").toLowerCase();
  return (
    /(^|[-_/])nim($|[-_/])/.test(provider) ||
    /nvidia/.test(provider) ||
    /integrate\.api\.nvidia\.com|build\.nvidia\.com|nvidia\.com\/nim/.test(baseUrl)
  );
}

/** 模型 id 归一：小写、去 `vendor/` 前缀、去 ollama 风格 tag 后缀（`:latest`）。 */
function normalizeModelId(modelId: string): string {
  const raw = String(modelId ?? "").trim().toLowerCase();
  if (!raw) return "";
  const tail = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return tail.replace(/:latest$/, "");
}

/** 非对话模型：不参与思考/工具能力推断（避免 agnes-image 被当成会思考的聊天模型）。 */
export function isNonChatModel(modelId: string): boolean {
  return NON_CHAT_MODEL_RE.test(normalizeModelId(modelId));
}

const nimById = new Map<string, NimModelCapability>(NIM_MODELS.map((m) => [m.id.toLowerCase(), m]));

/** 在 NIM 官方模型池里查模型规格（先精确、再按后缀取名，兼容 `vendor/` 前缀）。 */
export function findNimModelCapability(modelId: string): NimModelCapability | undefined {
  const id = normalizeModelId(modelId);
  if (!id) return undefined;
  const exact = nimById.get(id);
  if (exact) return exact;
  // NIM 的 model id 常带命名空间（如 meta/llama-3.2-11b-vision-instruct）→ 后缀匹配
  for (const [key, value] of nimById) {
    if (id === key || id.endsWith(`/${key}`) || id.endsWith(`-${key}`)) return value;
  }
  return undefined;
}

function nimCapabilities(hit: NimModelCapability): ModelCapabilities {
  const modalities = hit.inputModalities.filter(
    (m): m is InputModality => m === "text" || m === "image" || m === "audio" || m === "video",
  );
  return {
    contextWindow: hit.context,
    ...(hit.maxOutput !== undefined ? { maxOutput: hit.maxOutput } : {}),
    inputModalities: modalities,
    vision: modalities.includes("image"),
    ...(hit.reasoning !== undefined
      ? { thinking: hit.reasoning, ...(hit.reasoning ? { thinkingEfforts: ["low", "medium", "high"] } : {}) }
      : {}),
    ...(hit.functionCalling !== undefined ? { functionCalling: hit.functionCalling } : {}),
    ...(hit.structuredOutput !== undefined ? { structuredOutput: hit.structuredOutput } : {}),
  };
}

/** 内置家族正则编译缓存（数据维护错误时跳过该条，不影响其它匹配）。 */
const vendorRegexCache = new WeakMap<VendorModelCapability, RegExp | null>();
function vendorRegex(model: VendorModelCapability): RegExp | null {
  if (vendorRegexCache.has(model)) return vendorRegexCache.get(model) ?? null;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(model.match, "i");
  } catch {
    compiled = null;
  }
  vendorRegexCache.set(model, compiled);
  return compiled;
}

/** 在 slime 的能力表里按模型 id 推断（首个命中即返回，表内顺序 = 精确条目在前、家族兜底在后）。 */
export function findVendorCapability(
  modelId: string,
): { vendor: VendorCapabilities; model: VendorModelCapability } | undefined {
  const id = normalizeModelId(modelId);
  if (!id) return undefined;
  for (const vendor of VENDOR_CAPABILITIES) {
    for (const model of vendor.models) {
      const re = vendorRegex(model);
      if (re && re.test(id)) return { vendor, model };
    }
  }
  return undefined;
}

/**
 * 推断模型能力（内置表兜底）。
 *
 * 顺序：NVIDIA NIM 官方目录（用户提供的最新数据）→ slime 家族表 → 未知（返回空能力）。
 * 非对话模型（embedding/rerank/图像/音频/视频生成）直接返回 `nonChat: true`，不推断思考/工具。
 */
export function inferModelCapabilities(
  modelId: string,
  options: CapabilityInferenceOptions = {},
): InferredCapabilities {
  const id = String(modelId ?? "").trim();
  if (!id) return { source: "none" };

  if (isNimEndpoint(options)) {
    const nim = findNimModelCapability(id);
    if (nim) return { ...nimCapabilities(nim), source: "nim-catalog" };
  }

  if (isNonChatModel(id)) return { source: "none", nonChat: true };

  const hit = findVendorCapability(id);
  if (!hit) return { source: "none" };
  const { vendor, model } = hit;
  const capabilities: InferredCapabilities = {
    source: "vendor-table",
    vendor: vendor.key,
    thinking: model.thinking,
    ...(model.efforts && model.efforts.length > 0 ? { thinkingEfforts: [...model.efforts] } : {}),
    ...(model.context ?? vendor.context) !== undefined
      ? { contextWindow: (model.context ?? vendor.context) as number }
      : {},
    ...(model.maxOut ?? vendor.maxOut) !== undefined
      ? { maxOutput: (model.maxOut ?? vendor.maxOut) as number }
      : {},
  };
  return capabilities;
}

/** 从上游 /models 返回项里解析能力字段（兼容 OpenRouter / new-api / one-api 等常见命名）。 */
export function parseUpstreamCapabilities(raw: Record<string, unknown>): ModelCapabilities {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  const contextWindow =
    num(raw.context_length) ??
    num(raw.context_window) ??
    num(raw.max_context_length) ??
    num(raw.context_size) ??
    num((raw.top_provider as { context_length?: unknown } | undefined)?.context_length) ??
    num((raw.model_info as { context_length?: unknown } | undefined)?.context_length);
  const maxOutput =
    num(raw.max_output) ??
    num(raw.max_output_tokens) ??
    num(raw.max_completion_tokens) ??
    num(raw.max_tokens) ??
    num((raw.top_provider as { max_completion_tokens?: unknown } | undefined)?.max_completion_tokens);
  const modalitiesRaw = Array.isArray(raw.input_modalities)
    ? raw.input_modalities
    : Array.isArray((raw.architecture as { input_modalities?: unknown } | undefined)?.input_modalities)
      ? ((raw.architecture as { input_modalities?: unknown[] }).input_modalities as unknown[])
      : [];
  const inputModalities = modalitiesRaw
    .filter((m): m is InputModality => m === "text" || m === "image" || m === "audio" || m === "video")
    .slice(0, 4);
  const reasoning = raw.reasoning as { supported_efforts?: unknown } | undefined;
  const effortsRaw = Array.isArray(raw.thinking_efforts)
    ? raw.thinking_efforts
    : Array.isArray(reasoning?.supported_efforts)
      ? (reasoning!.supported_efforts as unknown[])
      : undefined;
  const thinkingEfforts = effortsRaw
    ?.filter((x): x is string => typeof x === "string")
    .slice(0, 10);
  const vision =
    raw.vision === true ||
    raw.supports_vision === true ||
    inputModalities.includes("image");
  const thinking =
    raw.thinking === true || Boolean(reasoning) || (thinkingEfforts?.length ?? 0) > 0;
  const functionCalling =
    raw.supports_function_calling === true ||
    raw.supports_tool_calling === true ||
    raw.function_calling === true ||
    raw.tool_call === true;
  const structuredOutput =
    raw.supports_structured_output === true ||
    raw.structured_output === true ||
    raw.response_format === true;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    ...(inputModalities.length > 0 ? { inputModalities } : {}),
    ...(vision ? { vision: true } : {}),
    ...(thinking ? { thinking: true } : {}),
    ...(thinkingEfforts && thinkingEfforts.length > 0 ? { thinkingEfforts } : {}),
    ...(functionCalling ? { functionCalling: true } : {}),
    ...(structuredOutput ? { structuredOutput: true } : {}),
  };
}

/** 模型配置最终形态（id + 能力）。 */
export interface ModelSpec extends ModelCapabilities {
  id: string;
}

/**
 * 合并上游元数据与内置推断：**上游优先**；上游缺失的字段用内置表补全。
 * 这是「供应商面板信息完整」的唯一入口（settings 的 /models 探测、providers.json 保存都走它）。
 */
export function enrichModelSpec(
  raw: Record<string, unknown>,
  options: CapabilityInferenceOptions = {},
): ModelSpec {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return { id: "" };
  const upstream = parseUpstreamCapabilities(raw);
  const inferred = inferModelCapabilities(id, options);
  // 只取能力字段：source/vendor/nonChat 是诊断信息，绝不写进 provider 配置
  const { source: _source, vendor: _vendor, nonChat: _nonChat, ...inferredCaps } = inferred;
  void _source;
  void _vendor;
  void _nonChat;
  const merged: ModelCapabilities = { ...inferredCaps, ...upstream };
  // vision 便捷位：上游没给但内置表说有图片输入 → 补上（UI 的"图片"列才有值）
  if (merged.vision === undefined && merged.inputModalities?.includes("image")) merged.vision = true;
  // 有 vision 但模态没写全 → 至少补 text+image（否则 UI 显示"无模态"但支持图片，自相矛盾）
  if (merged.vision === true && !merged.inputModalities) merged.inputModalities = ["text", "image"];
  return { id, ...merged };
}
