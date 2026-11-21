/**
 * 日志脱敏（发布门：崩溃日志/诊断里不能出现明文密钥）。
 *
 * 口径：
 *   · 字段名像密钥（apiKey/token/secret/password/authorization/cookie…）→ 整个值替换为 [redacted]；
 *   · 字符串里夹带的密钥形态（sk-…、Bearer …、apiKey=…）→ 只替换密钥片段，保留其余可读信息；
 *   · 只做「输出前脱敏」，不改内存里的真实值。
 *
 * 为什么放在主进程而不是日志模块里：crash.log、console.error、审计三处都要用同一口径，
 * 单一实现避免某条路径漏脱敏。
 */

/** 字段名命中即整值替换（大小写与 -/_ 归一）。 */
const SECRET_FIELD =
  /^(api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|passwd|authorization|cookie|set-cookie|proxy-authorization)$/i;

const INLINE_PATTERNS: Array<[RegExp, string]> = [
  // OpenAI / Anthropic / 常见中转：sk-xxxx
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]"],
  // Authorization: Bearer xxx
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  // apiKey=xxx / "token": "xxx" / password: xxx
  [/(api[-_]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^"'\s,}]{6,}/gi, "$1$2[redacted]"],
];

/** 字符串级脱敏：保留上下文，只抹掉密钥形态。 */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of INLINE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** JSON.stringify 的 replacer：可直接传给 JSON.stringify(detail, crashLogReplacer)。 */
export function crashLogReplacer(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    if (SECRET_FIELD.test(key)) return "[redacted]";
    return redactText(value);
  }
  return value;
}

/** 深度脱敏（console 输出用；不改变原对象）。 */
export function redactDeep<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value, crashLogReplacer)) as T;
  } catch {
    // 循环引用/不可序列化：退回字符串级脱敏
    return redactText(String(value)) as unknown as T;
  }
}
