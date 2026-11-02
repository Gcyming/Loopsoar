/**
 * zod → JSON Schema 子集转换器（P2-1：让内置工具参数真实可用）。
 *
 * 背景：内置工具用 zod 声明参数，但 `ToolRegistry.toolSchemas()` 此前整体忽略 schema，
 * 模型收到的 `function.parameters` 恒为 `{type:"object", properties:{}}`——参数名、类型、必填
 * 全靠模型猜，工具调用失败/传错参数是必然结果。本模块把 zod 结构翻译成 OpenAI
 * function.parameters 兼容的 JSON Schema。
 *
 * 设计约束（为什么这样写）：
 *  - **零运行时依赖**：只读 zod 实例的 `_def` 运行时结构（typeName / checks / shape / getter…），
 *    不 import zod 运行时代码（下方 `import type` 编译后被擦除），因此不新增依赖、不破坏 web 端；
 *  - **绝不抛错**：未知或畸形 schema 一律降级为 `{type:"object"}` 并记录 warning；
 *    调用方（ToolRegistry）再套一层 fail-closed 回退，保证一轮对话不会因坏 schema 崩溃；
 *  - **工具参数语义**：根必须是 object，`additionalProperties` 恒 false（不鼓励模型塞未声明字段），
 *    `required` 只由 `ZodOptional` / `ZodDefault` 决定（`ZodNullable` 仍是必填——必须显式给 null）；
 *  - **只输出稳定关键字**：不输出 `$schema`、`title` 等元信息，避免上游把注解当校验。
 *
 * 支持：ZodObject / ZodString(min,max,length,regex,email,url,uuid,datetime,date,time,ip) /
 * ZodNumber(int,min,max,multipleOf) / ZodBoolean / ZodEnum / ZodLiteral / ZodArray /
 * ZodOptional / ZodDefault / ZodNullable / ZodUnion / ZodRecord / ZodLazy。
 * 额外兼容 ZodEffects（`.refine()/.transform()/.preprocess()` 包裹）：按**输入侧**结构展开
 * （JSON Schema 描述的是入参形状，refine/transform 属于校验与出参变换，不影响形状）。
 * 其余类型（ZodTuple / ZodMap / ZodSet / ZodIntersection / ZodNativeEnum / ZodAny / ZodUnknown …）
 * → 降级 `{type:"object"}` + warning。
 */
import type { ZodTypeAny } from "zod";

/** JSON Schema 类型（本转换器只产出这几种）。 */
export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/** 工具参数用 JSON Schema 子集：只声明本转换器会产出的关键字。 */
export interface JsonSchema {
  type?: JsonSchemaType;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  anyOf?: JsonSchema[];
  description?: string;
}

/** 降级记录：哪条路径上的哪个 zod 类型被降级、为什么（供诊断与测试断言）。 */
export interface JsonSchemaWarning {
  /** 属性路径，如 `$.path`；根为 `$`。 */
  path: string;
  /** zod 的 `_def.typeName`（不可读时为 "unknown"）。 */
  typeName: string;
  reason: string;
}

export interface ZodToJsonSchemaResult {
  schema: JsonSchema;
  warnings: JsonSchemaWarning[];
}

/** 空工具参数（fail-closed 兜底，也是 OpenAI function.parameters 的合法最小形状）。 */
export const EMPTY_TOOL_PARAMETERS: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** 递归深度上限：防 zod 递归/恶意 schema 把转换器打爆（超出即降级）。 */
const MAX_DEPTH = 32;

/** zod 运行时 `_def` 的形状（只声明本模块读取的字段，运行时逐项校验）。 */
interface ZodCheckLike {
  kind?: unknown;
  value?: unknown;
  inclusive?: unknown;
  regex?: unknown;
  version?: unknown;
}

interface ZodDefLike {
  typeName?: string;
  description?: string;
  checks?: ZodCheckLike[];
  values?: string[];
  value?: unknown;
  type?: ZodTypeAny;
  innerType?: ZodTypeAny;
  options?: ZodTypeAny[];
  keyType?: ZodTypeAny;
  valueType?: ZodTypeAny;
  getter?: () => ZodTypeAny;
  schema?: ZodTypeAny;
  shape?: (() => Record<string, ZodTypeAny>) | Record<string, ZodTypeAny>;
  minLength?: { value?: number } | null;
  maxLength?: { value?: number } | null;
  exactLength?: { value?: number } | null;
}

interface ConvertContext {
  warnings: JsonSchemaWarning[];
  /** 正在展开的 lazy 目标（检测递归引用，避免无限展开）。 */
  lazyStack: Set<object>;
}

/** 读取 `_def`；非 zod 对象/取值抛错一律返回 null（由调用方降级）。 */
function readDef(schema: unknown): ZodDefLike | null {
  if (!schema || (typeof schema !== "object" && typeof schema !== "function")) return null;
  try {
    const def = (schema as { _def?: unknown })._def;
    return def !== null && typeof def === "object" ? (def as ZodDefLike) : null;
  } catch {
    return null;
  }
}

function isZodLike(value: unknown): value is ZodTypeAny {
  return typeof value === "object" && value !== null;
}

function warn(ctx: ConvertContext, path: string, typeName: string, reason: string): void {
  ctx.warnings.push({ path, typeName, reason });
}

/** 统一降级出口：`{type:"object"}` + warning（规格要求的"未知降级"形状）。 */
function fallbackObject(ctx: ConvertContext, path: string, typeName: string, reason: string): JsonSchema {
  warn(ctx, path, typeName, reason);
  return { type: "object" };
}

function readLengthValue(raw: { value?: number } | null | undefined): number | null {
  if (!raw || typeof raw.value !== "number" || !Number.isFinite(raw.value)) return null;
  return raw.value;
}

function readShape(
  def: ZodDefLike,
  path: string,
  ctx: ConvertContext,
): Record<string, ZodTypeAny> {
  const raw = def.shape;
  if (typeof raw === "function") {
    try {
      const shape = (raw as () => Record<string, ZodTypeAny>)();
      if (shape && typeof shape === "object") return shape;
      warn(ctx, path, "ZodObject", "shape() 未返回对象，properties 置空");
      return {};
    } catch (err) {
      warn(ctx, path, "ZodObject", `shape() 抛错（已置空 properties）：${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }
  if (raw && typeof raw === "object") return raw;
  warn(ctx, path, "ZodObject", "缺少 shape，properties 置空");
  return {};
}

/**
 * 是否必填：Optional / Default 视为非必填；Nullable / Effects 递归看内层
 * （`z.string().optional().nullable()` 也必须是非必填）。
 */
function isRequiredSchema(schema: ZodTypeAny, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  const def = readDef(schema);
  const typeName = typeof def?.typeName === "string" ? def.typeName : "unknown";
  if (typeName === "ZodOptional" || typeName === "ZodDefault") return false;
  if (typeName === "ZodNullable" || typeName === "ZodEffects") {
    const inner = isZodLike(def?.innerType) ? def.innerType : isZodLike(def?.schema) ? def.schema : null;
    return inner ? isRequiredSchema(inner, depth + 1) : true;
  }
  return true;
}

/** ZodString：min/max/length 取最严格值，regex → pattern，常见格式 → format。 */
function convertString(def: ZodDefLike): JsonSchema {
  const node: JsonSchema = { type: "string" };
  let minLength: number | null = null;
  let maxLength: number | null = null;
  const checks = Array.isArray(def.checks) ? def.checks : [];
  for (const check of checks) {
    const kind = typeof check?.kind === "string" ? check.kind : "";
    const value = typeof check?.value === "number" ? check.value : null;
    switch (kind) {
      case "min":
        if (value !== null) minLength = minLength === null ? value : Math.max(minLength, value);
        break;
      case "max":
        if (value !== null) maxLength = maxLength === null ? value : Math.min(maxLength, value);
        break;
      case "length":
        if (value !== null) {
          minLength = value;
          maxLength = value;
        }
        break;
      case "regex": {
        const regex = check?.regex;
        if (regex instanceof RegExp) node.pattern = regex.source;
        break;
      }
      case "email":
        node.format = "email";
        break;
      case "url":
        node.format = "uri";
        break;
      case "uuid":
        node.format = "uuid";
        break;
      case "datetime":
        node.format = "date-time";
        break;
      case "date":
        node.format = "date";
        break;
      case "time":
        node.format = "time";
        break;
      case "ip":
        node.format = check?.version === "v4" ? "ipv4" : check?.version === "v6" ? "ipv6" : "ip";
        break;
      default:
        // trim/toLowerCase/toUpperCase/includes/startsWith/endsWith/base64/emoji/nanoid/cuid…：
        // 属于取值规范化或软约束，不影响入参形状，忽略（宁少不滥）。
        break;
    }
  }
  if (minLength !== null) node.minLength = minLength;
  if (maxLength !== null) node.maxLength = maxLength;
  return node;
}

/** ZodNumber：int → integer；min/max 区分 inclusive（gt/lt → exclusiveMinimum/Maximum）。 */
function convertNumber(def: ZodDefLike): JsonSchema {
  const node: JsonSchema = { type: "number" };
  const checks = Array.isArray(def.checks) ? def.checks : [];
  let minimum: number | null = null;
  let maximum: number | null = null;
  let exclusiveMinimum: number | null = null;
  let exclusiveMaximum: number | null = null;
  for (const check of checks) {
    const kind = typeof check?.kind === "string" ? check.kind : "";
    const value = typeof check?.value === "number" ? check.value : null;
    if (kind === "int") {
      node.type = "integer";
      continue;
    }
    if (value === null) continue;
    const inclusive = check?.inclusive !== false;
    if (kind === "min") {
      if (inclusive) minimum = minimum === null ? value : Math.max(minimum, value);
      else exclusiveMinimum = exclusiveMinimum === null ? value : Math.max(exclusiveMinimum, value);
    } else if (kind === "max") {
      if (inclusive) maximum = maximum === null ? value : Math.min(maximum, value);
      else exclusiveMaximum = exclusiveMaximum === null ? value : Math.min(exclusiveMaximum, value);
    } else if (kind === "multipleOf") {
      node.multipleOf = value;
    }
  }
  if (minimum !== null) node.minimum = minimum;
  if (maximum !== null) node.maximum = maximum;
  if (exclusiveMinimum !== null) node.exclusiveMinimum = exclusiveMinimum;
  if (exclusiveMaximum !== null) node.exclusiveMaximum = exclusiveMaximum;
  return node;
}

function convertObject(def: ZodDefLike, path: string, depth: number, ctx: ConvertContext): JsonSchema {
  const shape = readShape(def, path, ctx);
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    const childPath = path === "$" ? key : `${path}.${key}`;
    properties[key] = convertNode(child, childPath, depth + 1, ctx);
    if (isRequiredSchema(child)) required.push(key);
  }
  const node: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) node.required = required;
  return node;
}

function convertArray(def: ZodDefLike, path: string, depth: number, ctx: ConvertContext): JsonSchema {
  const itemSchema = isZodLike(def.type) ? def.type : null;
  const node: JsonSchema = {
    type: "array",
    items: itemSchema
      ? convertNode(itemSchema, `${path}[]`, depth + 1, ctx)
      : fallbackObject(ctx, `${path}[]`, "ZodArray", "缺少元素 schema，items 降级为 {type:\"object\"}"),
  };
  const exact = readLengthValue(def.exactLength);
  const min = readLengthValue(def.minLength);
  const max = readLengthValue(def.maxLength);
  if (exact !== null) {
    node.minItems = exact;
    node.maxItems = exact;
  } else {
    if (min !== null) node.minItems = min;
    if (max !== null) node.maxItems = max;
  }
  return node;
}

function convertUnion(def: ZodDefLike, path: string, depth: number, ctx: ConvertContext): JsonSchema {
  const options = Array.isArray(def.options) ? def.options.filter(isZodLike) : [];
  if (options.length === 0) {
    return fallbackObject(ctx, path, "ZodUnion", "union 无可用选项，已降级为 {type:\"object\"}");
  }
  return {
    anyOf: options.map((option, index) => convertNode(option, `${path}|${index + 1}`, depth + 1, ctx)),
  };
}

function convertRecord(def: ZodDefLike, path: string, depth: number, ctx: ConvertContext): JsonSchema {
  const valueSchema = isZodLike(def.valueType) ? def.valueType : null;
  return {
    type: "object",
    additionalProperties: valueSchema
      ? convertNode(valueSchema, `${path}.*`, depth + 1, ctx)
      : true,
  };
}

function convertLazy(
  schema: ZodTypeAny,
  def: ZodDefLike,
  path: string,
  depth: number,
  ctx: ConvertContext,
): JsonSchema {
  // 递归检测以「lazy 实例」为键：`const Node = z.lazy(() => z.object({ children: z.array(Node) }))`
  // 的 getter 每次会新建对象，只有记住 lazy 实例本身才能识别自引用。
  if (ctx.lazyStack.has(schema)) {
    return fallbackObject(ctx, path, "ZodLazy", "检测到递归引用，已截断为 {type:\"object\"}");
  }
  let target: ZodTypeAny | null = null;
  try {
    target = typeof def.getter === "function" ? (def.getter as () => ZodTypeAny)() : null;
  } catch (err) {
    warn(ctx, path, "ZodLazy", `getter() 抛错：${err instanceof Error ? err.message : String(err)}`);
    return { type: "object" };
  }
  if (!isZodLike(target)) {
    return fallbackObject(ctx, path, "ZodLazy", "getter() 未返回 schema，已降级为 {type:\"object\"}");
  }
  ctx.lazyStack.add(schema);
  try {
    return convertNode(target, path, depth + 1, ctx);
  } finally {
    ctx.lazyStack.delete(schema);
  }
}

/** 按 typeName 分派（未知类型统一走 fallbackObject + warning）。 */
function convertByType(
  schema: ZodTypeAny,
  def: ZodDefLike,
  typeName: string,
  path: string,
  depth: number,
  ctx: ConvertContext,
): JsonSchema {
  switch (typeName) {
    case "ZodObject":
      return convertObject(def, path, depth, ctx);
    case "ZodString":
      return convertString(def);
    case "ZodNumber":
      return convertNumber(def);
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum": {
      const values = Array.isArray(def.values) ? def.values.filter((v): v is string => typeof v === "string") : [];
      if (values.length === 0) {
        return fallbackObject(ctx, path, "ZodEnum", "enum 值为空或非字符串，已降级为 {type:\"object\"}");
      }
      return { type: "string", enum: [...values] };
    }
    case "ZodLiteral": {
      const value = def.value;
      // 单值用 enum 表达：语义等价且各家 OpenAI 兼容端点都支持（const 是 draft-07 才有）。
      const node: JsonSchema = { enum: [value] };
      if (typeof value === "string") node.type = "string";
      else if (typeof value === "number") node.type = "number";
      else if (typeof value === "boolean") node.type = "boolean";
      else if (value === null) node.type = "null";
      else warn(ctx, path, "ZodLiteral", "literal 值非原始类型，仅输出 enum");
      return node;
    }
    case "ZodArray":
      return convertArray(def, path, depth, ctx);
    case "ZodOptional":
    case "ZodDefault": {
      // 可空/默认值只影响 required 判定（由父级 isRequiredSchema 处理），这里展开内层形状。
      const inner = isZodLike(def.innerType) ? def.innerType : null;
      return inner
        ? convertNode(inner, path, depth + 1, ctx)
        : fallbackObject(ctx, path, typeName, "缺少 innerType，已降级为 {type:\"object\"}");
    }
    case "ZodNullable": {
      const inner = isZodLike(def.innerType) ? def.innerType : null;
      if (!inner) return fallbackObject(ctx, path, "ZodNullable", "缺少 innerType，已降级为 {type:\"object\"}");
      return { anyOf: [convertNode(inner, path, depth + 1, ctx), { type: "null" }] };
    }
    case "ZodUnion":
      return convertUnion(def, path, depth, ctx);
    case "ZodRecord":
      return convertRecord(def, path, depth, ctx);
    case "ZodLazy":
      return convertLazy(schema, def, path, depth, ctx);
    case "ZodEffects": {
      // refine/transform/preprocess：入参形状 = 被包裹 schema 的形状。
      const inner = isZodLike(def.schema) ? def.schema : null;
      return inner
        ? convertNode(inner, path, depth + 1, ctx)
        : fallbackObject(ctx, path, "ZodEffects", "缺少 schema，已降级为 {type:\"object\"}");
    }
    default:
      return fallbackObject(ctx, path, typeName, `不支持的 zod 类型 ${typeName}，已降级为 {type:"object"}`);
  }
}

/** 单节点转换（内部递归入口）：深度保护 → 读 `_def` → 分派 → 附加 description。 */
function convertNode(schema: ZodTypeAny, path: string, depth: number, ctx: ConvertContext): JsonSchema {
  if (depth > MAX_DEPTH) {
    return fallbackObject(ctx, path, "depth", `嵌套超过 ${MAX_DEPTH} 层，已降级为 {type:"object"}`);
  }
  const def = readDef(schema);
  if (!def) {
    return fallbackObject(ctx, path, "unknown", "不是可识别的 zod schema（缺少 _def），已降级为 {type:\"object\"}");
  }
  const typeName = typeof def.typeName === "string" ? def.typeName : "unknown";
  const node = convertByType(schema, def, typeName, path, depth, ctx);
  if (typeof def.description === "string" && def.description.trim() && node.description === undefined) {
    node.description = def.description.trim();
  }
  return node;
}

/**
 * zod → JSON Schema（工具参数语义）。
 *
 * 根 schema 必须是 object（OpenAI `function.parameters` 要求）；非 object 根一律降级为空 object
 * 并记 warning——宁可让模型看不到参数，也不发一个不合法的 parameters 给上游。
 *
 * @param schema 工具参数的 zod schema
 * @param options.rootPath 根路径（warning 里的路径前缀，默认 `$`）
 */
export function zodToJsonSchema(
  schema: ZodTypeAny,
  options: { rootPath?: string } = {},
): ZodToJsonSchemaResult {
  const ctx: ConvertContext = { warnings: [], lazyStack: new Set<object>() };
  const rootPath = options.rootPath ?? "$";
  const converted = convertNode(schema, rootPath, 0, ctx);

  if (converted.type !== "object") {
    warn(
      ctx,
      rootPath,
      "root",
      `根 schema 类型为 ${converted.type ?? "未知"}，function.parameters 要求 object，已降级为空 object`,
    );
    return { schema: { type: "object", properties: {}, additionalProperties: false }, warnings: ctx.warnings };
  }

  const root: JsonSchema = {
    type: "object",
    properties: converted.properties ?? {},
    ...(converted.required && converted.required.length > 0 ? { required: converted.required } : {}),
    additionalProperties: false,
  };
  if (converted.description) root.description = converted.description;
  return { schema: root, warnings: ctx.warnings };
}

/** 便捷包装：只要 schema，不要 warnings（调用方自行承担降级静默）。 */
export function zodToToolParameters(schema: ZodTypeAny): JsonSchema {
  return zodToJsonSchema(schema).schema;
}
