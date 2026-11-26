/**
 * OpenAI 兼容流式客户端（§2 T2）。
 * 为什么手写而不引 SDK：核心要保持零重依赖；SSE 解析约 200 行即可，
 * 且必须支持 deepseek 的 reasoning_content / prompt_cache_hit_tokens 归一，
 * 通用 SDK 反而要额外垫片。
 * 重试纪律：未产出任何 chunk 前可重试（网络错误/429/5xx），已开始流式输出后不重试
 * （避免重复内容）；Retry-After 截断到 60s。
 */
import type { LlmChunk, LlmClient, LlmMessage, LlmRequest } from "./index.js";
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
  /**
   * 硬性总超时（毫秒；默认 0 = 不启用）。
   * 为什么不默认启用：固定总超时会在「模型仍在正常流式输出」时把连接掐断，
   * 导致长回复被截断（用户 m02515 要求根除截断）。防止挂死改用 idleTimeoutMs。
   */
  timeoutMs?: number;
  /**
   * 空闲超时（毫秒，默认 120000）：超过该时长没有收到任何新数据才判定上游卡死。
   * 每收到一个 chunk 都会重置，所以正常的长时间流式输出不会被误杀。
   */
  idleTimeoutMs?: number;
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

function toOpenAiContent(content: LlmMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: `data:${part.mime};base64,${part.base64}` } },
  );
}

function textContent(content: LlmMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function createOpenAiClient(opts: OpenAiClientOptions): LlmClient {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const maxRetries = opts.maxRetries ?? 3;
  const hardTimeoutMs = opts.timeoutMs ?? 0;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const firstByteTimeoutMs = opts.firstByteTimeoutMs ?? 120_000;

  async function* invokeOnce(req: LlmRequest): AsyncGenerator<LlmChunk> {
    const controller = new AbortController();
    // 超时语义：首包超时只用于「连不上/没有响应头」；空闲超时用于「流中途卡死」；
    // 硬总超时默认关闭（它会截断正常的长输出）。三者都 abort 同一个 controller，
    // 但要分别记录原因，才能给用户/上层一个可读的「为什么断了」。
    let firstByteTimedOut = false;
    let idleTimedOut = false;
    let totalTimedOut = false;
    const firstByteTimer = setTimeout(() => {
      firstByteTimedOut = true;
      controller.abort();
    }, firstByteTimeoutMs);
    let idleTimer: NodeJS.Timeout | null = null;
    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const totalTimer = hardTimeoutMs > 0 ? setTimeout(() => {
      totalTimedOut = true;
      controller.abort();
    }, hardTimeoutMs) : null;
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
                content: toOpenAiContent(m.content),
                tool_calls: m.tool_calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                })),
              };
            }
            if (m.role === "tool") {
              return { role: "tool", tool_call_id: m.tool_call_id, content: textContent(m.content) };
            }
            return { role: m.role, content: toOpenAiContent(m.content) };
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
            // retry-after 很大：额度类限流，重试只会让用户空等 → 立即报错。
            if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
              yield {
                kind: "error",
                message: `上游限流，约 ${humanizeWait(retryAfterMs)} 后可重试（HTTP 429：${info.message}）`,
              };
              return;
            }
            // 普通过载 429 常常不带 retry-after（"The inference service is overloaded"）：
            // 旧实现直接报「请稍后手动重试」，用户频繁手动重发。这里用短退避自动重试 2 次。
            throw new RetryableError(
              `HTTP ${res.status}: ${info.message}`,
              retryAfterMs ?? 800,
              MAX_429_RETRIES,
            );
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
          usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
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
        if (data.usage?.total_tokens) {
          yield {
            kind: "usage",
            tokens: data.usage.total_tokens,
            ...(data.usage.prompt_tokens !== undefined ? { inputTokens: data.usage.prompt_tokens } : {}),
            ...(data.usage.completion_tokens !== undefined ? { outputTokens: data.usage.completion_tokens } : {}),
          };
        }
        yield choice.finish_reason ? { kind: "done", finishReason: choice.finish_reason } : { kind: "done" };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let usageTokens: number | undefined;
      let usageInput: number | undefined;
      let usageOutput: number | undefined;
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
        if (usageTokens !== undefined) {
          yield {
            kind: "usage",
            tokens: usageTokens,
            ...(usageInput !== undefined ? { inputTokens: usageInput } : {}),
            ...(usageOutput !== undefined ? { outputTokens: usageOutput } : {}),
          };
        }
        yield finishReason ? { kind: "done", finishReason } : { kind: "done" };
      };

      /**
       * 处理一行 SSE。返回 true 表示遇到 [DONE]。
       * 抽成单函数是为了让「流结束时的残留 buffer」走完全相同的解析路径：
       * 很多上游最后一帧不带尾换行/不带 [DONE]，旧实现会直接丢掉最后一行 →
       * 用户看到的正文结尾被静默截断（m02515 要求根除）。
       */
      const handleLine = function* (line: string): Generator<LlmChunk, boolean> {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return false;
        const payload = trimmed.slice(5).trim();
        if (!payload) return false;
        if (payload === "[DONE]") return true;
        let obj: {
          choices?: {
            delta?: { content?: string; reasoning_content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
            finish_reason?: string | null;
          }[];
          usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
          /** 部分上游在 HTTP 200 的 SSE 里返回错误对象（流内错误）。 */
          error?: { message?: string; type?: string } | string;
        };
        try {
          obj = JSON.parse(payload);
        } catch {
          return false; // 半行/心跳注释：跳过
        }
        // 流内错误：旧实现会把它当"没有 choices 的心跳"忽略掉，最后表现为「模型没有返回内容」，
        // 用户无法知道是上游出错（也是一种"静默截断"）。这里显式转成 error chunk。
        if (obj.error) {
          const msg = typeof obj.error === "string" ? obj.error : (obj.error.message ?? JSON.stringify(obj.error));
          yield { kind: "error", message: `上游流内错误：${msg}` };
          return false;
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
        if (obj.usage?.total_tokens !== undefined) {
          usageTokens = obj.usage.total_tokens;
          usageInput = obj.usage.prompt_tokens;
          usageOutput = obj.usage.completion_tokens;
        }
        return false;
      };

      try {
        for (;;) {
          // 每轮读取前重置空闲计时器：只有「连续 N 秒没有任何数据」才判定卡死，
          // 正常的长输出（哪怕 5 分钟）不会因为总时长被砍断。
          armIdleTimer();
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nlIndex: number;
          while ((nlIndex = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nlIndex);
            buffer = buffer.slice(nlIndex + 1);
            if (yield* handleLine(line)) {
              yield* flushToolCalls();
              return;
            }
          }
        }
      } catch (err) {
        // 用户主动停止：原样上抛（tool_loop 归一 aborted，不当作错误）
        if (req.signal?.aborted) throw err;
        if (idleTimedOut) {
          yield {
            kind: "error",
            message: `上游空闲超时：${Math.round(idleTimeoutMs / 1000)}s 未收到任何新数据（已输出内容已保留）`,
          };
          return;
        }
        if (firstByteTimedOut) {
          yield {
            kind: "error",
            message: `上游首包超时：${Math.round(firstByteTimeoutMs / 1000)}s 未返回响应数据（已输出内容已保留）`,
          };
          return;
        }
        if (totalTimedOut) {
          yield {
            kind: "error",
            message: `请求超过硬超时 ${Math.round(hardTimeoutMs / 1000)}s（已输出内容已保留）`,
          };
          return;
        }
        throw err;
      }
      // 流正常结束但没有 [DONE] / 最后一帧没有尾换行：把残留字节与残留行全部吃掉再收尾。
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) {
        if (yield* handleLine(line)) break;
      }
      yield* flushToolCalls();
    } finally {
      clearTimeout(firstByteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
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
            // fetch failed / ECONNRESET 等网络错误不是 RetryableError，但它们是瞬时的：
            // 之前直接放弃成「重试 0 次后失败」，长任务里看着就像模型莫名截断。
            const errText = err instanceof Error
              ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}`
              : String(err);
            const networkRetryable = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network/i.test(errText);
            const retryErr = err instanceof RetryableError ? err : null;
            const retryable = retryErr !== null || networkRetryable;
            // 429 自带更严的重试上限（Lead 要求最多 1~2 次），避免长等待刷屏
            const retryLimit = retryErr && retryErr.maxAttempts !== undefined ? Math.min(maxRetries, retryErr.maxAttempts) : maxRetries;
            if (!retryable || attempt >= retryLimit) {
              yield {
                kind: "error",
                message: `LLM 调用失败（重试 ${attempt} 次后放弃）：${err instanceof Error ? err.message : String(err)}`,
              };
              return;
            }
            const waitMs = retryErr?.retryAfterMs || DEFAULT_RETRY_BACKOFF[Math.min(attempt, DEFAULT_RETRY_BACKOFF.length - 1)];
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
