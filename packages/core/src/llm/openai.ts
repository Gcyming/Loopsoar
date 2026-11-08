/**
 * OpenAI 兼容流式客户端（§2 T2）。
 * 为什么手写而不引 SDK：核心要保持零重依赖；SSE 解析约 200 行即可，
 * 且必须支持 deepseek 的 reasoning_content / prompt_cache_hit_tokens 归一，
 * 通用 SDK 反而要额外垫片。
 * 重试纪律：未产出任何 chunk 前可重试（网络错误/429/5xx），已开始流式输出后不重试
 * （避免重复内容）；Retry-After 截断到 60s。
 */
import type { LlmChunk, LlmClient, LlmRequest } from "./index.js";
import {
  classifyFatalUpstreamError,
  humanizeWait,
  MAX_429_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfterMs,
  parseUpstreamError,
} from "./upstreamError.js";

export interface OpenAiClientOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** 总超时（默认 300s）。 */
  timeoutMs?: number;
  /** 首包超时（默认 120s，收到响应头即清零）。 */
  firstByteTimeoutMs?: number;
  /** 最大重试次数（默认 3）。 */
  maxRetries?: number;
  /** 自定义请求头（会在默认头之后合并，可用于代理鉴权/UA）。 */
  headers?: Record<string, string>;
  /** 每次 HTTP 请求前解析请求头（用于 {{sessionId}} 等模板变量；静态 headers 之后合并）。 */
  resolveHeaders?: () => Record<string, string>;
}

export interface NormalizedUsage {
  prompt: number;
  completion: number;
  reasoning?: number;
  cacheRead: number;
}

/** usage 归一：OpenAI 的 prompt_tokens_details.cached_tokens 与 deepseek 的 prompt_cache_hit_tokens 都映射到 cacheRead。 */
/** 把服务端的原始错误体变成可读一句话（优先 error.message；截断 300 字）。 */
function friendlyHttpError(body: string): string {
  return parseUpstreamError(0, body).message;
}

export function normalizeUsage(raw: {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
}): NormalizedUsage {
  return {
    prompt: raw.prompt_tokens ?? 0,
    completion: raw.completion_tokens ?? 0,
    reasoning: raw.completion_tokens_details?.reasoning_tokens,
    cacheRead:
      raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0,
  };
}

/** 可重试错误（限流/5xx/网络）；携带建议等待时间与最多重试次数（429 只允许 1~2 次）。 */
class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
    /** 本次请求内最多重试次数（缺省用客户端 maxRetries）。 */
    readonly maxAttempts?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const DEFAULT_RETRY_BACKOFF = [1000, 3000, 7000];

function safeParseArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

export function createOpenAiClient(opts: OpenAiClientOptions): LlmClient {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const maxRetries = opts.maxRetries ?? 3;
  const totalTimeoutMs = opts.timeoutMs ?? 300_000;
  const firstByteTimeoutMs = opts.firstByteTimeoutMs ?? 120_000;

  async function* invokeOnce(req: LlmRequest): AsyncGenerator<LlmChunk> {
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), totalTimeoutMs);
    const firstByteTimer = setTimeout(() => controller.abort(), firstByteTimeoutMs);
    // 外部中止（用户点「停止」/会话取消）必须穿透到在途 fetch。
    // 只靠调用方轮询中止标志不够：上游卡住（迟迟没有 chunk）时，停止要等到首字节超时（120s）
    // 才会生效 —— 用户看到的是「点了没反应，还一直显示思考中」。超时与外部中止共用一个 controller。
    const onExternalAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // 默认标识本客户端（多数服务商要求可识别的 UA；自定义 headers 可覆盖）
          "User-Agent": "Loopsoar/1.0",
          ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          ...(opts.headers ?? {}),
          ...(opts.resolveHeaders?.() ?? {}),
        },
        body: JSON.stringify({
          model: opts.model,
          messages: req.messages.map((m) => {
            if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
              return {
                role: "assistant",
                content: m.content,
                tool_calls: m.tool_calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                })),
              };
            }
            if (m.role === "tool") {
              return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
            }
            return { role: m.role, content: m.content };
          }),
          stream: true,
          ...(req.tools && req.tools.length > 0
            ? {
                tools: req.tools.map((t) => ({
                  type: "function" as const,
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(firstByteTimer);

      if (!res.ok) {
        const bodyText = (await res.text()).slice(0, 800);
        const info = parseUpstreamError(res.status, bodyText);
        // 额度/余额/订阅/鉴权/模型类错误：重试必然继续失败 → 立即失败并给可行动提示。
        // 典型真实故障：opencode-zen 免费模型 HTTP 429 FreeUsageLimitError + retry-after≈17h，
        // 旧实现按 429 重试（每次等 60s × 3 次）→ 用户看到「思考中」持续数分钟。
        const fatal = classifyFatalUpstreamError(info);
        if (fatal) {
          yield { kind: "error", message: `${fatal}（HTTP ${res.status}：${info.message}）` };
          return;
        }
        if (RETRYABLE_STATUS.has(res.status)) {
          const retryAfterMs = parseRetryAfterMs(res.headers);
          if (res.status === 429) {
            // 普通限流：只有「很快就会恢复」才值得在本次请求内等；retry-after 很大/缺失 → 立即报错
            if (retryAfterMs === undefined || retryAfterMs > MAX_RETRY_AFTER_MS) {
              const waitHint =
                retryAfterMs !== undefined
                  ? `上游限流，约 ${humanizeWait(retryAfterMs)} 后可重试`
                  : "上游限流且未提供 retry-after，请稍后手动重试";
              yield { kind: "error", message: `${waitHint}（HTTP 429：${info.message}）` };
              return;
            }
            throw new RetryableError(`HTTP ${res.status}: ${info.message}`, retryAfterMs, MAX_429_RETRIES);
          }
          const capped = retryAfterMs !== undefined ? Math.min(retryAfterMs, 60_000) : undefined;
          throw new RetryableError(`HTTP ${res.status}: ${info.message}`, capped ?? 1000);
        }
        yield { kind: "error", message: `HTTP ${res.status}: ${friendlyHttpError(bodyText)}` };
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      // 非流式兜底：服务端没按 stream 返回时，转成一次性 text/tool_call + done
      if (!res.body || contentType.includes("application/json")) {
        const data = (await res.json()) as {
          choices?: {
            message?: { content?: string; reasoning_content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
            finish_reason?: string;
          }[];
          usage?: { total_tokens?: number };
        };
        const choice = data.choices?.[0] ?? {};
        const msg = choice.message ?? {};
        if (msg.reasoning_content) yield { kind: "reasoning", text: msg.reasoning_content };
        if (msg.content) yield { kind: "text", text: msg.content };
        for (const tc of msg.tool_calls ?? []) {
          yield {
            kind: "tool_call",
            toolCall: {
              id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
              name: tc.function?.name ?? "",
              args: safeParseArgs(tc.function?.arguments),
            },
          };
        }
        if (data.usage?.total_tokens) yield { kind: "usage", tokens: data.usage.total_tokens };
        yield choice.finish_reason ? { kind: "done", finishReason: choice.finish_reason } : { kind: "done" };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let usageTokens: number | undefined;
      let finishReason: string | undefined;
      let buffer = "";

      const flushToolCalls = function* (): Generator<LlmChunk> {
        for (const cur of toolCalls.values()) {
          if (!cur.name) continue;
          yield {
            kind: "tool_call",
            toolCall: {
              id: cur.id || `call_${Math.random().toString(36).slice(2, 10)}`,
              name: cur.name,
              args: safeParseArgs(cur.args),
            },
          };
        }
        if (usageTokens !== undefined) yield { kind: "usage", tokens: usageTokens };
        yield finishReason ? { kind: "done", finishReason } : { kind: "done" };
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIndex: number;
        while ((nlIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nlIndex).trim();
          buffer = buffer.slice(nlIndex + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            yield* flushToolCalls();
            return;
          }
          let obj: {
            choices?: {
              delta?: { content?: string; reasoning_content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
              finish_reason?: string | null;
            }[];
            usage?: { total_tokens?: number };
          };
          try {
            obj = JSON.parse(payload);
          } catch {
            continue; // 半行/心跳注释：跳过
          }
          const choice = obj.choices?.[0];
          const delta = choice?.delta ?? {};
          if (delta.reasoning_content) yield { kind: "reasoning", text: delta.reasoning_content };
          if (delta.content) yield { kind: "text", text: delta.content };
          for (const tc of delta.tool_calls ?? []) {
            const key = tc.index ?? 0;
            const cur = toolCalls.get(key) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolCalls.set(key, cur);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (obj.usage?.total_tokens !== undefined) usageTokens = obj.usage.total_tokens;
        }
      }
      // 没有收到 [DONE] 的流正常结束：flush 残余
      yield* flushToolCalls();
    } finally {
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
      req.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  return {
    invoke(req: LlmRequest): AsyncIterable<LlmChunk> {
      return (async function* (): AsyncGenerator<LlmChunk> {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          let emitted = false;
          try {
            for await (const chunk of invokeOnce(req)) {
              emitted = true;
              yield chunk;
            }
            return;
          } catch (err) {
            // 用户主动停止：把 AbortError 原样上抛（tool_loop 归一为 aborted），
            // 绝不能重试、也不能转成 error chunk（UI 会当成红色失败并继续显示思考中）。
            if (req.signal?.aborted) throw err;
            if (emitted) throw err; // 已开始输出：不重试，避免重复内容
            const retryable = err instanceof RetryableError;
            // 429 自带更严的重试上限（Lead 要求最多 1~2 次），避免长等待刷屏
            const retryLimit = retryable && err.maxAttempts !== undefined ? Math.min(maxRetries, err.maxAttempts) : maxRetries;
            if (!retryable || attempt >= retryLimit) {
              yield {
                kind: "error",
                message: `LLM 调用失败（重试 ${attempt} 次后放弃）：${err instanceof Error ? err.message : String(err)}`,
              };
              return;
            }
            const waitMs = err.retryAfterMs || DEFAULT_RETRY_BACKOFF[Math.min(attempt, DEFAULT_RETRY_BACKOFF.length - 1)];
            // 退避等待也要可中止：否则停止后还要空等 1~7s 才轮到下一次（或下一次 invokeOnce）观察信号
            await new Promise<void>((resolve) => {
              const done = (): void => {
                clearTimeout(timer);
                req.signal?.removeEventListener("abort", done);
                resolve();
              };
              const timer = setTimeout(done, waitMs);
              req.signal?.addEventListener("abort", done, { once: true });
            });
            if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
          }
        }
      })();
    },
  };
}
