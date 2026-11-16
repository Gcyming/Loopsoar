/**
 * Anthropic Messages API 客户端（/v1/messages，SSE 流式）。
 *
 * 平台适配目标（对齐 slime 的多端点设计）：
 *   - OpenAI 兼容：/chat/completions（openai.ts）
 *   - Anthropic：/messages（本文件，x-api-key + anthropic-version）
 *   - 自动推断：baseUrl 含 anthropic/claude → Anthropic，否则 OpenAI
 *
 * 限制说明：LlmMessage 没有 tool_call_id，因此工具结果以文本块回填（降级但可用）；
 * 纯文本对话、系统提示、工具调用声明、推理（thinking）均完整支持。
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

export interface AnthropicClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 硬性总超时（毫秒；默认 0 = 不启用）。
   * 固定总超时会掐断「仍在正常流式输出」的长回复 → 截断（用户 m02515）。防挂死改用 idleTimeoutMs。
   */
  timeoutMs?: number;
  /** 空闲超时（毫秒，默认 120000）：连续该时长没有新数据才判定上游卡死。每收到数据即重置。 */
  idleTimeoutMs?: number;
  /** 首包超时（默认 120s，收到响应头即清零）。 */
  firstByteTimeoutMs?: number;
  maxRetries?: number;
  /** 自定义请求头（会在默认头之后合并）。 */
  headers?: Record<string, string>;
  /** 每次 HTTP 请求前解析请求头（模板变量；在静态 headers 之后合并）。 */
  resolveHeaders?: () => Record<string, string>;
}

/**
 * 把 Anthropic 的 stop_reason 映射成与 OpenAI 一致的 finishReason 语义：
 * "max_tokens" 表示被输出上限截断（等价 finish_reason="length"），tool_loop 据此自动续写。
 */
function anthropicFinishReason(stopReason: string): string {
  return stopReason === "max_tokens" ? "length" : stopReason;
}

function effortToBudget(effort: string): number {
  const map: Record<string, number> = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384 };
  return map[effort.toLowerCase()] ?? 4096;
}

/** 可重试的上游 HTTP 错误（429/529/5xx）；retryAfterMs 缺省时按退避序列等待。 */
class RetryableHttpError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    readonly maxAttempts = 2,
  ) {
    super(message);
    this.name = "RetryableHttpError";
  }
}

function toAnthropicMessages(messages: LlmMessage[]): { system: string; messages: { role: "user" | "assistant"; content: unknown[] }[] } {
  const systemParts: string[] = [];
  const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: msg.tool_call_id ?? "unknown", content: msg.content }],
      });
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      out.push({
        role: "assistant",
        content: [
          ...(msg.content ? [{ type: "text", text: msg.content }] : []),
          ...msg.tool_calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} })),
        ],
      });
      continue;
    }
    out.push({ role: msg.role, content: [{ type: "text", text: msg.content }] });
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

export function createAnthropicClient(opts: AnthropicClientOptions): LlmClient {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, "")}/messages`;
  const hardTimeoutMs = opts.timeoutMs ?? 0;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const firstByteTimeoutMs = opts.firstByteTimeoutMs ?? 120_000;
  const maxRetries = opts.maxRetries ?? 2;

  async function* invokeOnce(req: LlmRequest): AsyncGenerator<LlmChunk> {
    const controller = new AbortController();
    // 超时语义：首包超时管「连不上/没有响应头」；空闲超时管「流中途卡死」；
    // 硬总超时默认关闭（它会截断正常的长输出）。三者分别记录原因，便于可读报错。
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
    // 外部中止（用户点「停止」/会话取消）必须穿透到在途 fetch，否则上游卡住时
    // 停止要等到首字节超时（120s）才生效，UI 一直停在「思考中」。
    const onExternalAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      const { system, messages } = toAnthropicMessages(req.messages);
      const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: req.maxTokens ?? 4096,
        messages,
        stream: true,
        ...(system ? { system } : {}),
        ...(req.tools && req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters ?? { type: "object", properties: {} },
              })),
            }
          : {}),
        ...(req.reasoningEffort
          ? { thinking: { type: "enabled", budget_tokens: effortToBudget(req.reasoningEffort) } }
          : {}),
      };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "User-Agent": "Loopsoar/1.0",
          ...(opts.headers ?? {}),
          ...(opts.resolveHeaders?.() ?? {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // 已拿到响应头：首包计时结束；后面由「空闲计时器」接管（每次读到数据重置）。
      clearTimeout(firstByteTimer);
      if (!res.ok) {
        const bodyText = (await res.text()).slice(0, 800);
        const info = parseUpstreamError(res.status, bodyText);
        // 额度/余额/订阅/鉴权/模型类错误：重试必然继续失败 → 立即失败并给可行动提示
        const fatal = classifyFatalUpstreamError(info);
        if (fatal) {
          yield { kind: "error", message: `${fatal}（HTTP ${res.status}：${info.message}）` };
          yield { kind: "done" };
          return;
        }
        if (res.status === 429 || res.status === 529) {
          const retryAfterMs = parseRetryAfterMs(res.headers);
          if (res.status === 429) {
            // 普通限流：只有「很快就会恢复」才在本次请求内重试；retry-after 很大/缺失 → 立即报错
            if (retryAfterMs === undefined || retryAfterMs > MAX_RETRY_AFTER_MS) {
              const waitHint =
                retryAfterMs !== undefined
                  ? `上游限流，约 ${humanizeWait(retryAfterMs)} 后可重试`
                  : "上游限流且未提供 retry-after，请稍后手动重试";
              yield { kind: "error", message: `${waitHint}（HTTP 429：${info.message}）` };
              yield { kind: "done" };
              return;
            }
            throw new RetryableHttpError(`HTTP 429: ${info.message}`, retryAfterMs, MAX_429_RETRIES);
          }
          // 529 overloaded / 5xx：按退避重试（有 retry-after 则遵守，截断到 60s）
          throw new RetryableHttpError(
            `HTTP ${res.status}: ${info.message}`,
            retryAfterMs !== undefined ? Math.min(retryAfterMs, 60_000) : undefined,
          );
        }
        yield { kind: "error", message: `HTTP ${res.status}: ${info.message}` };
        yield { kind: "done" };
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      // 非流式兜底
      if (!res.body || contentType.includes("application/json")) {
        const data = (await res.json()) as {
          content?: { type?: string; text?: string; id?: string; name?: string; input?: unknown }[];
          usage?: { input_tokens?: number; output_tokens?: number };
          stop_reason?: string;
        };
        for (const block of data.content ?? []) {
          if (block.type === "text" && block.text) yield { kind: "text", text: block.text };
          else if (block.type === "tool_use")
            yield { kind: "tool_call", toolCall: { id: block.id ?? `call-${Date.now()}`, name: block.name ?? "", args: block.input ?? {} } };
        }
        const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);
        if (tokens) yield { kind: "usage", tokens };
        yield { kind: "done", ...(data.stop_reason ? { finishReason: anthropicFinishReason(data.stop_reason) } : {}) };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | undefined;
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

      const handleEvent = function* (data: string): Generator<LlmChunk> {
        let evt: {
          type?: string;
          index?: number;
          content_block?: { type?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          error?: { message?: string };
        };
        try {
          evt = JSON.parse(data);
        } catch {
          return;
        }
        switch (evt.type) {
          case "message_start":
            // Anthropic 的 prompt token 只在 message_start.message.usage.input_tokens 里出现，
            // 旧实现只累加 output_tokens → 长上下文永远不会触发 Token 闸（可无限突破预算）。
            inputTokens = evt.message?.usage?.input_tokens ?? 0;
            break;
          case "content_block_start":
            if (evt.content_block?.type === "tool_use" && typeof evt.index === "number") {
              toolBlocks.set(evt.index, { id: evt.content_block.id ?? `call-${evt.index}`, name: evt.content_block.name ?? "", json: "" });
            }
            break;
          case "content_block_delta":
            if (evt.delta?.type === "text_delta" && evt.delta.text) yield { kind: "text", text: evt.delta.text };
            else if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) yield { kind: "reasoning", text: evt.delta.thinking };
            else if (evt.delta?.type === "input_json_delta" && typeof evt.index === "number") {
              const block = toolBlocks.get(evt.index);
              if (block) block.json += evt.delta.partial_json ?? "";
            }
            break;
          case "content_block_stop":
            if (typeof evt.index === "number" && toolBlocks.has(evt.index)) {
              const block = toolBlocks.get(evt.index)!;
              toolBlocks.delete(evt.index);
              let args: unknown = {};
              try {
                args = block.json ? JSON.parse(block.json) : {};
              } catch {
                args = { _raw: block.json };
              }
              yield { kind: "tool_call", toolCall: { id: block.id, name: block.name, args } };
            }
            break;
          case "message_delta":
            outputTokens += evt.usage?.output_tokens ?? 0;
            if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
            break;
          case "message_stop":
            done = true;
            break;
          case "error":
            yield { kind: "error", message: `Anthropic 错误：${evt.error?.message ?? "未知"}` };
            done = true;
            break;
          default:
            break;
        }
      };

      /**
       * 解析一个完整 SSE 事件块。兼容 \n\n 与 \r\n\r\n 事件分隔：
       * 旧实现只认 "\n\n"，CRLF 上游（如某些代理/网关）会整段不解析 → 看起来像「模型没输出」。
       */
      const emitEvent = function* (rawEvent: string): Generator<LlmChunk> {
        for (const rawLine of rawEvent.split("\n")) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          yield* handleEvent(data);
          if (done) return;
        }
      };
      /** 从 buffer 中尽量多地取出已完成的事件（\n\n 或 \r\n\r\n 分隔，取最早出现的那个）。 */
      const drainEvents = function* (): Generator<LlmChunk> {
        for (;;) {
          const crlf = buffer.indexOf("\r\n\r\n");
          const lf = buffer.indexOf("\n\n");
          let sep = -1;
          let sepLen = 0;
          if (crlf >= 0 && (lf < 0 || crlf < lf)) {
            sep = crlf;
            sepLen = 4;
          } else if (lf >= 0) {
            sep = lf;
            sepLen = 2;
          }
          if (sep < 0) return;
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + sepLen);
          yield* emitEvent(rawEvent);
          if (done) return;
        }
      };

      try {
        while (!done) {
          // 每次读取前重置空闲计时器：只有「连续 N 秒没数据」才判卡死，正常长输出不会被砍断。
          armIdleTimer();
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          buffer += decoder.decode(value, { stream: true });
          yield* drainEvents();
        }
        // 流结束：先把解码器里最后几个字节吐出来，再把没有尾分隔符的最后一个事件解析掉。
        // 旧实现直接丢弃残留 buffer → 最后一帧 text_delta / message_delta 会静默丢失（截断）。
        buffer += decoder.decode();
        yield* drainEvents();
        if (!done && buffer.trim()) {
          const trailing = buffer;
          buffer = "";
          yield* emitEvent(trailing);
        }
        const totalTokens = inputTokens + outputTokens;
        if (totalTokens > 0) yield { kind: "usage", tokens: totalTokens };
        yield stopReason ? { kind: "done", finishReason: anthropicFinishReason(stopReason) } : { kind: "done" };
      } catch (err) {
        // 用户主动停止：把 AbortError 上抛（tool_loop 归一为 aborted），不伪装成「请求超时」错误块
        if (req.signal?.aborted) throw err;
        if (idleTimedOut) {
          yield {
            kind: "error",
            message: `上游空闲超时：${Math.round(idleTimeoutMs / 1000)}s 未收到任何新数据（已输出内容已保留）`,
          };
          yield { kind: "done" };
          return;
        }
        if (firstByteTimedOut) {
          yield {
            kind: "error",
            message: `上游首包超时：${Math.round(firstByteTimeoutMs / 1000)}s 未返回响应数据（已输出内容已保留）`,
          };
          yield { kind: "done" };
          return;
        }
        if (totalTimedOut) {
          yield { kind: "error", message: `请求超过硬超时 ${Math.round(hardTimeoutMs / 1000)}s（已输出内容已保留）` };
          yield { kind: "done" };
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        yield { kind: "error", message };
        yield { kind: "done" };
      } finally {
        clearTimeout(firstByteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (totalTimer) clearTimeout(totalTimer);
        req.signal?.removeEventListener("abort", onExternalAbort);
      }
    } catch (err) {
      // fetch / 响应处理阶段的异常：原样上抛给 invoke 的重试逻辑（已产出内容由调用方保留）
      throw err;
    } finally {
      clearTimeout(firstByteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      req.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /** 可中止的退避等待（用户停止后不必空等 1s/2s/3s）。 */
  function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  return {
    invoke(req: LlmRequest): AsyncIterable<LlmChunk> {
      const self = {
        async *[Symbol.asyncIterator](): AsyncGenerator<LlmChunk> {
          for (let attempt = 0; ; attempt += 1) {
            // 已中止：直接以 AbortError 结束（不发起新请求、不重试）
            if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            try {
              for await (const chunk of invokeOnce(req)) yield chunk;
              return;
            } catch (err) {
              // 用户主动停止：AbortError 原样上抛（tool_loop 归一 aborted）
              if (req.signal?.aborted) throw err;
              // 不可重试错误（非 RetryableHttpError）直接上抛，交给 tool_loop 归一为 error
              if (!(err instanceof RetryableHttpError)) throw err;
              const limit = Math.max(0, Math.min(maxRetries, err.maxAttempts));
              if (attempt >= limit) {
                yield { kind: "error", message: `上游错误（重试 ${attempt} 次后放弃）：${err.message}` };
                return;
              }
              await sleepWithAbort(err.retryAfterMs ?? 1000 * (attempt + 1), req.signal);
              if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            }
          }
        },
      };
      return self;
    },
  };
}

/** 根据 baseUrl 推断端点协议（auto 模式）。 */
export function inferApiFormat(baseUrl: string): "openai" | "anthropic" {
  return /anthropic|claude/i.test(baseUrl) ? "anthropic" : "openai";
}
