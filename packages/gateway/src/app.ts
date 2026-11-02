/**
 * gateway 应用：OpenAI 兼容的本地 Agent 网关（Fastify）。
 *
 * 定位：把 Loopsoar 的 headless Agent 运行时（shell/gatewayRuntime.ts）暴露为标准 OpenAI Chat
 * Completions 接口，让外部客户端（其他 IDE/SDK/Agent 框架）用既有 OpenAI 协议接入本机 Agent。
 *
 * 安全默认：
 *   · 只监听 127.0.0.1（项目隔离端口 19210，避开 slime 的 19000/19110）；
 *   · `LOOPSOAR_GATEWAY_TOKEN` 非空即强制 Bearer（所有路由，含 /healthz），401 为 OpenAI 错误形状；
 *   · 不做任意 URL 代理：请求只进本机 Agent 运行时。
 *
 * 本文件只做「HTTP 协议 ↔ runner 接口」的适配：SSE 事件到 OpenAI chunk 的映射由 runner 实现
 * （shell/gatewayRuntime.ts 负责 ChatService 事件 → OpenAI chunk，便于用 fake chat 单测映射）。
 */
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";

/* ────────────────────────────── OpenAI 兼容类型 ────────────────────────────── */

/** 模型清单项（GET /v1/models）。 */
export interface GatewayModelInfo {
  id: string;
  owned_by?: string;
  created?: number;
}

/** 请求消息（content 只支持字符串；数组形态的多模态内容由上层客户端自行降级）。 */
export interface GatewayChatMessage {
  role: string;
  content: string;
}

/** POST /v1/chat/completions 归一化后的请求。 */
export interface GatewayChatRequest {
  model?: string;
  messages: GatewayChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  stream_options?: { include_usage?: boolean };
  /** 会话复用 id（由 gateway 从 `x-loopsoar-session` 头解析；缺省则每次请求新会话）。 */
  sessionId?: string;
  /** 客户端断开时中止（gateway 会 abort，runtime 转成 ChatService.stop）。 */
  signal?: AbortSignal;
}

/** OpenAI usage（headless 只统计 totalTokens，无法拆分 prompt/completion，按 total 对齐）。 */
export interface GatewayUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** 工具调用增量（流式 delta.tool_calls / 非流式 message.tool_calls）。 */
export interface GatewayToolCallDelta {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI 流式 chunk（SSE data 行的 JSON）。 */
export interface OpenAiStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: GatewayToolCallDelta[];
    };
    finish_reason: string | null;
  }>;
  usage?: GatewayUsage | null;
}

/** runner 完成后返回的聚合结果（非流式响应用；流式也用它决定 error/usage 收尾）。 */
export interface GatewayCompletionOutcome {
  id: string;
  created: number;
  model: string;
  /** ChatService 的收束状态：done | budget | aborted | silent | no-progress | error */
  status: string;
  reason: string;
  finalText: string;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  usage: { totalTokens: number };
}

/**
 * 网关注入的聊天运行时（shell 实现）。
 * 为什么是接口而不是直接依赖 ChatService：gateway 包不能 import shell（依赖方向），
 * 且测试可用 fake runner 精确断言 SSE/JSON 形状。
 */
export interface GatewayChatRunner {
  /** 执行一次对话；流式 chunk 通过 sink 实时输出（映射已在 runner 内完成）。 */
  complete(request: GatewayChatRequest, sink: (chunk: OpenAiStreamChunk) => void): Promise<GatewayCompletionOutcome>;
  /** GET /v1/models 的数据源。 */
  models(): GatewayModelInfo[];
}

export interface GatewayOptions {
  port?: number;
  /** 是否强制 Bearer（缺省由 startServer 依据 token 环境变量决定；buildApp 缺省 false）。 */
  requireToken?: boolean;
  gatewayToken?: string;
  /** 聊天运行时（必填；domain/runtime 装配时注入）。 */
  runner: GatewayChatRunner;
  /** 未指定 model 时的回退名。 */
  defaultModel?: string;
  /** 生成 id 的函数（测试可注入固定值）。 */
  generateId?: () => string;
  /** 当前时间（秒；测试可注入）。 */
  nowSeconds?: () => number;
}

const DEFAULT_MODEL = "loopsoar-default";

/* ────────────────────────────── 错误形状 ────────────────────────────── */

/** OpenAI 风格错误体：{ error: { message, type, param, code } }。 */
export function openAiError(
  message: string,
  type: "invalid_request_error" | "server_error" = "invalid_request_error",
  code: string | null = null,
): { error: { message: string; type: string; param: null; code: string | null } } {
  return { error: { message, type, param: null, code } };
}

/** 终结原因映射（OpenAI finish_reason 枚举的可用子集）。 */
export function finishReasonForStatus(status: string): string {
  if (status === "budget") return "length";
  return "stop";
}

/** Bearer 鉴权钩子：requireToken 且令牌匹配才放行；失败返回 OpenAI 401 形状。 */
export function createBearerMiddleware(requireToken: boolean, expectedToken?: string) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!requireToken || !expectedToken) return;
    const authHeader = request.headers.authorization ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token !== expectedToken) {
      await reply.code(401).send(openAiError("未授权：Bearer 令牌无效或缺失", "invalid_request_error", "invalid_api_key"));
    }
  };
}

/* ────────────────────────────── 请求解析 ────────────────────────────── */

/** 把 HTTP body 归一化成 GatewayChatRequest；非法返回可读错误。 */
function parseChatRequest(body: unknown): { ok: true; request: GatewayChatRequest } | { ok: false; message: string } {
  if (!body || typeof body !== "object") return { ok: false, message: "请求体必须是 JSON 对象" };
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return { ok: false, message: "messages 必须是非空数组" };
  }
  const messages: GatewayChatMessage[] = [];
  for (const [index, item] of raw.messages.entries()) {
    if (!item || typeof item !== "object") return { ok: false, message: `messages[${index}] 不是对象` };
    const message = item as Record<string, unknown>;
    if (typeof message.role !== "string" || !message.role) {
      return { ok: false, message: `messages[${index}].role 必须是字符串` };
    }
    // content 允许 null（assistant 只带 tool_calls 时）；统一按空串处理，避免把对象 JSON 化污染上下文
    const content = typeof message.content === "string" ? message.content : message.content == null ? "" : null;
    if (content === null) return { ok: false, message: `messages[${index}].content 必须是字符串（暂不支持多模态数组）` };
    messages.push({ role: message.role, content });
  }
  const streamOptions = raw.stream_options;
  return {
    ok: true,
    request: {
      model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined,
      messages,
      stream: raw.stream === true,
      max_tokens: typeof raw.max_tokens === "number" ? raw.max_tokens : undefined,
      temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
      stream_options:
        streamOptions && typeof streamOptions === "object"
          ? { include_usage: (streamOptions as { include_usage?: unknown }).include_usage === true }
          : undefined,
    },
  };
}

function usageOf(totalTokens: number): GatewayUsage {
  const total = Math.max(0, Math.floor(totalTokens || 0));
  return { prompt_tokens: 0, completion_tokens: total, total_tokens: total };
}

/** 非流式响应体（OpenAI chat.completion）。 */
function buildNonStreamResponse(outcome: GatewayCompletionOutcome, fallbackModel: string) {
  const hasToolCalls = outcome.toolCalls.length > 0;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: hasToolCalls && !outcome.finalText ? null : outcome.finalText,
  };
  if (hasToolCalls) {
    message.tool_calls = outcome.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    }));
  }
  return {
    id: outcome.id,
    object: "chat.completion",
    created: outcome.created,
    model: outcome.model || fallbackModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: hasToolCalls ? "tool_calls" : finishReasonForStatus(outcome.status),
      },
    ],
    usage: usageOf(outcome.usage.totalTokens),
  };
}

/* ────────────────────────────── 应用装配 ────────────────────────────── */

/** 构建 Fastify 应用实例（不启动监听；测试用 app.inject）。 */
export async function buildApp(options: GatewayOptions): Promise<FastifyInstance> {
  if (!options.runner) throw new Error("gateway 缺少 runner：请注入 GatewayChatRunner");
  const runner = options.runner;
  const defaultModel = options.defaultModel || DEFAULT_MODEL;
  const generateId = options.generateId ?? (() => `chatcmpl-${Math.random().toString(36).slice(2, 12)}`);
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // 统一错误体：Fastify 默认的 {statusCode,error,message} 对 OpenAI 客户端不友好
  app.setErrorHandler((error, _request, reply) => {
    const err = error as { message?: string; statusCode?: number };
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    const message = err.message || "未知错误";
    void reply.code(status).send(openAiError(status >= 500 ? `网关内部错误：${message}` : message, status >= 500 ? "server_error" : "invalid_request_error"));
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send(openAiError("未知接口（OpenAI 兼容路由：/v1/chat/completions、/v1/models、/healthz）"));
  });
  app.addHook("preHandler", createBearerMiddleware(!!options.requireToken, options.gatewayToken));

  app.get("/healthz", async () => ({
    status: "healthy",
    timestamp: new Date().toISOString(),
    models: runner.models().length,
  }));

  app.get("/v1/models", async () => ({
    object: "list",
    data: runner.models().map((model) => ({
      id: model.id,
      object: "model",
      created: model.created ?? nowSeconds(),
      owned_by: model.owned_by ?? "loopsoar",
    })),
  }));

  app.post("/v1/chat/completions", async (request, reply) => {
    const parsed = parseChatRequest(request.body);
    if (!parsed.ok) return reply.code(400).send(openAiError(parsed.message));
    const chatRequest = parsed.request;
    const model = chatRequest.model || runner.models()[0]?.id || defaultModel;

    // 会话复用：显式 header 优先（OpenAI 客户端可通过自定义头保持多轮上下文）
    const sessionHeader = request.headers["x-loopsoar-session"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    chatRequest.sessionId = String(sessionId ?? "").trim() || undefined;

    // 客户端断开 → abort，避免 Agent 在没人接收的情况下继续跑工具
    const controller = new AbortController();
    chatRequest.signal = controller.signal;
    const onClose = (): void => controller.abort();
    request.raw.once("close", onClose);

    if (chatRequest.stream !== true) {
      try {
        const outcome = await runner.complete(chatRequest, () => {});
        request.raw.off("close", onClose);
        if (outcome.status === "error") {
          return reply.code(500).send(openAiError(outcome.reason || "Agent 运行失败", "server_error"));
        }
        return buildNonStreamResponse({ ...outcome, model: outcome.model || model }, model);
      } catch (err) {
        request.raw.off("close", onClose);
        throw err;
      }
    }

    // ── SSE 流式：先 hijack 再写 raw，避免 Fastify 再发默认响应 ──
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let finished = false;
    const writeData = (payload: unknown): void => {
      if (finished) return;
      raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      request.raw.off("close", onClose);
      raw.write("data: [DONE]\n\n");
      raw.end();
    };

    try {
      const outcome = await runner.complete(chatRequest, writeData);
      if (outcome.status === "error") {
        writeData(openAiError(outcome.reason || "Agent 运行失败", "server_error"));
      }
      if (chatRequest.stream_options?.include_usage) {
        writeData({
          id: outcome.id,
          object: "chat.completion.chunk",
          created: outcome.created,
          model: outcome.model || model,
          choices: [],
          usage: usageOf(outcome.usage.totalTokens),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeData(openAiError(`Agent 运行异常：${message}`, "server_error"));
    } finally {
      finish();
    }
    return reply;
  });

  return app;
}

/** 启动监听（默认 127.0.0.1:19210；项目隔离端口）。 */
export async function startServer(options: GatewayOptions): Promise<{ app: FastifyInstance; url: string }> {
  const port = options.port ?? Number(process.env.LOOPSOAR_GATEWAY_PORT || "19210");
  const tokenEnv = process.env.LOOPSOAR_GATEWAY_TOKEN || "";
  const requireToken = options.requireToken ?? tokenEnv.length > 0;
  const gatewayToken = options.gatewayToken || tokenEnv;
  const app = await buildApp({ ...options, requireToken, gatewayToken });
  await app.listen({ port, host: "127.0.0.1" });
  return { app, url: `http://127.0.0.1:${port}` };
}
