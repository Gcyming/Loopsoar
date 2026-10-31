/**
 * 供应商内置请求头默认值（壳层纯逻辑）：
 * 有些服务商不是"可选优化"，而是没有特定头就直接 400/403（如 OpenCode Go 缺少
 * x-opencode-session 会拒绝请求）。这里把已知必需头做成默认值，用户自定义请求头可覆盖。
 *
 * 只放"必需且通用"的头；供应商专属业务参数仍走用户模板，避免把特例写死到 LLM 核心。
 */

/** 判断是否 OpenCode Go（官方推理网关路径）。 */
export function isOpenCodeGo(provider: string, baseUrl: string): boolean {
  return /(^|\/\/)opencode\.ai\/inference\/go/i.test(baseUrl) || /^opencode-?go$/i.test(provider.trim());
}

/**
 * 合并默认请求头与用户请求头（用户优先）。
 * 返回的仍是模板串（x-opencode-session 的 {{sessionId}} 由渲染层按会话替换）。
 */
export function withProviderDefaults(
  provider: string,
  baseUrl: string,
  userHeaders?: Record<string, string>,
): Record<string, string> {
  const defaults: Record<string, string> = {};
  if (isOpenCodeGo(provider, baseUrl)) {
    defaults["User-Agent"] = "Loopsoar/1.0";
    defaults["x-opencode-session"] = "{{sessionId}}";
  }
  return { ...defaults, ...(userHeaders ?? {}) };
}
