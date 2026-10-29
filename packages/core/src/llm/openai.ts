/**
 * OpenAI 兼容流式客户端（§2 T2）。
 * 为什么手写而不引 SDK：核心要保持零重依赖；SSE 解析约 200 行即可，
 * 且必须支持 deepseek 的 reasoning_content / prompt_cache_hit_tokens 归一，
 * 通用 SDK 反而要额外垫片。
 * 重试纪律：未产出任何 chunk 前可重试（网络错误/429/5xx），已开始流式输出后不重试
 * （避免重复内容）；Retry-After 截断到 60s。
 */
import type { LlmChunk, LlmClient, LlmRequest } from "./index.js";

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
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | unknown; message?: unknown };
    const nested = typeof parsed?.error === "object" && parsed.error ? (parsed.error as { message?: unknown }).message : undefined;
    const raw = typeof nested === "string" ? nested : typeof parsed?.message === "string" ? parsed.message : undefined;
    if (raw) return raw.slice(0, 300);
  } catch {
    // 非 JSON
  }
  return body.slice(0, 300);
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

/** 可重试错误（429/5xx/网络）；携带建议等待时间。 */
class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
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

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          messages: req.messages,
          stream: true,
          ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(firstByteTimer);

      if (!res.ok) {
        const bodyText = (await res.text()).slice(0, 300);
        if (RETRYABLE_STATUS.has(res.status)) {
          const retryAfter = Number(res.headers.get("retry-after")) * 1000;
          throw new RetryableError(`HTTP ${res.status}: ${friendlyHttpError(bodyText)}`, Math.min(isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1000, 60_000));
        }
        yield { kind: "error", message: `HTTP ${res.status}: ${friendlyHttpError(bodyText)}` };
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      // 非流式兜底：服务端没按 stream 返回时，转成一次性 text/tool_call + done
      if (!res.body || contentType.includes("application/json")) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string; reasoning_content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
          usage?: { total_tokens?: number };
        };
        const msg = data.choices?.[0]?.message ?? {};
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
        yield { kind: "done" };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let usageTokens: number | undefined;
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
        yield { kind: "done" };
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
            choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
            usage?: { total_tokens?: number };
          };
          try {
            obj = JSON.parse(payload);
          } catch {
            continue; // 半行/心跳注释：跳过
          }
          const delta = obj.choices?.[0]?.delta ?? {};
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
          if (obj.usage?.total_tokens !== undefined) usageTokens = obj.usage.total_tokens;
        }
      }
      // 没有收到 [DONE] 的流正常结束：flush 残余
      yield* flushToolCalls();
    } finally {
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
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
            if (emitted) throw err; // 已开始输出：不重试，避免重复内容
            const retryable = err instanceof RetryableError;
            if (!retryable || attempt >= maxRetries) {
              yield {
                kind: "error",
                message: `LLM 调用失败（重试 ${attempt} 次后放弃）：${err instanceof Error ? err.message : String(err)}`,
              };
              return;
            }
            const waitMs = err.retryAfterMs || DEFAULT_RETRY_BACKOFF[Math.min(attempt, DEFAULT_RETRY_BACKOFF.length - 1)];
            await new Promise((r) => setTimeout(r, waitMs));
          }
        }
      })();
    },
  };
}
