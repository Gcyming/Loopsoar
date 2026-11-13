/**
 * 供应商「获取模型列表」端点解析（壳层纯逻辑）。
 *
 * 为什么单独成文件：多数 OpenAI 兼容网关的模型目录就在 baseUrl 下（`<baseUrl>/models`），
 * 但 OpenCode Console 的推理与模型目录分属不同前缀：
 *   · 按量付费推理：https://opencode.ai/inference/openai/v1/chat/completions → 目录 /inference/v1/models
 *   · Go 订阅推理：  https://opencode.ai/inference/go/openai/v1/chat/completions → 目录 /inference/go/v1/models
 * 直接拼 `<baseUrl>/models` 会 404（2026-11 实测），面板上「获取模型列表与能力」对 OpenCode 不可用。
 */

/** 判断 OpenCode 官方域名（含 zen/go 历史路径）。 */
export function isOpenCodeHost(baseUrl: string): boolean {
  try {
    return /(^|\.)opencode\.ai$/i.test(new URL(baseUrl).hostname);
  } catch {
    return /opencode\.ai/i.test(baseUrl);
  }
}

/**
 * 计算模型目录（/models）端点。
 * @param baseUrl 供应商 baseUrl（聊天端点前缀）
 * @param isAnthropic 是否 Anthropic 协议（模型目录路径相同，仅保留参数便于其他网关扩展）
 */
export function resolveModelsUrl(baseUrl: string, isAnthropic: boolean): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (isOpenCodeHost(base)) {
    try {
      const url = new URL(base);
      // 去掉推理协议段：/inference/go/openai/v1 → /inference/go；/inference/anthropic/v1 → /inference
      const prefix = url.pathname
        .replace(/\/(openai|anthropic|google)(\/v1(?:beta)?)?\/?$/i, "")
        .replace(/\/+$/, "");
      return `${url.origin}${prefix}/v1/models`;
    } catch {
      // 非法 URL：交给调用方兜底拼接
    }
  }
  return isAnthropic
    ? `${base.replace(/\/v1$/, "")}/v1/models`
    : /\/v1$/.test(base)
      ? `${base}/models`
      : `${base}/v1/models`;
}
