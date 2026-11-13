/**
 * 上游 HTTP 错误归一（额度 / 鉴权 / 订阅类「不可重试」错误的快速失败）。
 *
 * 为什么单独成文件：OpenAI 兼容端与 Anthropic 端的错误体结构不同，但「额度用尽、余额不足、
 * 需要订阅、Key 无效」这几类必须**立即失败并给出可行动提示**——把它们当 429 重试会让用户
 * 对着「思考中」空等几分钟（opencode-zen 免费模型 429 + retry-after≈17h 的真实故障）。
 */

/** 上游错误归一结果（type/code 可能缺省；message 永远是可读摘要）。 */
export interface UpstreamErrorInfo {
  status: number;
  /** 错误类型（如 FreeUsageLimitError / rate_limit_error / authentication_error）。 */
  type?: string;
  /** 错误码（部分代理把 machine code 放这里）。 */
  code?: string;
  /** 归一后的 message（优先服务端原话；缺省为响应体摘要）。 */
  message: string;
  /** 原始响应体（截断；用于展示/排查）。 */
  raw: string;
}

/** 429 在「本次请求内」最多等多久才值得重试（超过则立即报错让用户决策）。 */
export const MAX_RETRY_AFTER_MS = 15_000;
/** 429 最多重试次数（Lead 要求 1~2 次；上游额度类已在上游分类里直接失败）。 */
export const MAX_429_RETRIES = 2;

/** 把上游错误体解析成结构化信息（OpenAI / Anthropic / 常见中转站三种形态）。 */
export function parseUpstreamError(status: number, body: string): UpstreamErrorInfo {
  const raw = String(body ?? "").slice(0, 800);
  let type: string | undefined;
  let code: string | undefined;
  let message: string | undefined;

  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
    return undefined;
  };

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const errObj = (parsed.error && typeof parsed.error === "object" ? parsed.error : null) as Record<string, unknown> | null;
    type = pick(errObj?.type) ?? pick(parsed.type);
    code = pick(errObj?.code) ?? pick(parsed.code);
    message = pick(errObj?.message) ?? pick(parsed.message) ?? pick(parsed.detail);
  } catch {
    // 非 JSON：保留原文
  }

  // 过滤掉「type 只是 http/error 这种无信息量」的值
  if (type && /^(error|http|api_error)$/i.test(type)) type = undefined;
  return {
    status,
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    message: (message ?? raw).slice(0, 300) || `HTTP ${status}`,
    raw,
  };
}

/** 不可重试的额度/鉴权/订阅/模型类错误 → 中文可行动提示；可重试（普通限流/5xx）返回 null。 */
export function classifyFatalUpstreamError(info: UpstreamErrorInfo): string | null {
  const text = `${info.type ?? ""} ${info.code ?? ""} ${info.message} ${info.raw}`.toLowerCase();
  const has = (re: RegExp): boolean => re.test(text);

  // OpenCode 免费额度（429 FreeUsageLimitError；官方文案含 "free models work in OpenCode…subscribe to OpenCode Go"）
  if (has(/free models work in opencode|subscribe to opencode go to keep going/)) {
    return "OpenCode 免费额度已用尽：请等待额度重置，或订阅 OpenCode Go（opencode.ai/go）后使用 Go 模型";
  }
  // ① 额度 / 余额 / 订阅（含 env 免费模型耗尽；这类重试必然继续失败）
  if (has(/freeusage|free usage|usage limit|usage_limit|quota|insufficient_quota|exceeded your current quota/)) {
    return "上游额度已用尽（免费额度或账户额度）：请等待额度重置/充值，或切换其它供应商与模型";
  }
  // OpenCode 计费账户区分：Go 订阅额度与按量付费（Zen）余额是两个账户；同名模型走错端点常见 402
  if (has(/insufficient account funds/)) {
    return "OpenCode 按量付费余额不足（Go 订阅额度与按量付费余额是两个账户）：有 Go 订阅请把活动供应商切到 opencode-go（https://opencode.ai/inference/go/openai/v1）；否则需在 opencode.ai 控制台充值";
  }
  if (has(/insufficient|balance|余额|credit|funds|payment required|billing|arrears/)) {
    return "上游账户余额不足：请充值或切换其它供应商";
  }
  // OpenCode 专项（2026-11 实测三类 403/400；比通用「订阅/地区」提示更具体，必须排在它们前面）
  if (has(/missing x-opencode-session|missingsessionid/)) {
    return "OpenCode Go 要求请求头 x-opencode-session：请保留内置默认请求头（设置 · 供应商 → 请求头里的 x-opencode-session: {{sessionId}}），不要删除";
  }
  if (has(/opencode go subscription is required|subscription is required to use go models|active opencode go subscription/)) {
    return "该 API Key 所在工作区没有有效的 OpenCode Go 订阅：请在 opencode.ai/go 订阅，并使用订阅所在工作区的 Key；Go 供应商地址应为 https://opencode.ai/inference/go/openai/v1";
  }
  if (has(/model access is disabled/)) {
    return "该 API Key 是 Go 订阅 Key，不能用于按量付费端点：请把活动供应商切到 opencode-go（https://opencode.ai/inference/go/openai/v1）；按量付费需在 Console 充值并使用 /inference/openai/v1";
  }
  if (has(/not available in your (country|region)|regionerror|unsupported_country|country_not_supported/)) {
    return "该模型在当前地区不可用（OpenCode 免费/贡献者模型有地区限制，或控制台 Settings › Privacy 的 Regions 未放开）：请改用其他模型，或调整控制台区域设置";
  }
  if (has(/only available from within opencode|free[- ]tier (chat )?models/)) {
    return "该模型是 OpenCode 免费模型，官方文档说明第三方客户端会 403：请改用付费模型，或订阅 OpenCode Go 后使用 Go 模型";
  }
  if (has(/subscription|not subscribed|plan required|upgrade|membership/)) {
    return "当前供应商需要有效订阅（或套餐不含该模型）：请订阅/升级套餐，或切换供应商";
  }
  // ② 鉴权 / 权限
  if (has(/invalid_api_key|invalid api key|api key|authentication|unauthorized|unauthenticated|token expired|鉴权/)) {
    return "上游鉴权失败（API Key 无效或已过期）：请在「设置 · 供应商」更新 Key";
  }
  if (info.status === 401) {
    return "上游鉴权失败（HTTP 401）：请在「设置 · 供应商」检查 Key";
  }
  if (has(/permission_error|permission denied|forbidden|access denied|region|country/)) {
    return "上游拒绝访问（权限不足/地区限制）：请检查账号权限，或切换供应商";
  }
  // ③ 模型不存在
  if (has(/model_not_found|does not exist|no such model|unknown model|invalid model/)) {
    return "上游不存在该模型：请在「设置 · 供应商」切换可用模型";
  }
  return null;
}

/** 解析 retry-after 响应头（秒，允许小数）→ 毫秒；缺失/非法返回 undefined。 */
export function parseRetryAfterMs(headers: { get(name: string): string | null }): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1000);
}

/** 毫秒 → 人读等待时长（429 提示用）。 */
export function humanizeWait(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}
