/**
 * gateway 应用实现：Fastify 服务器（§6）。
 * 端口 LOOPSOAR_GATEWAY_PORT（默认 19110）；Bearer 中间件占位
 * （LOOPSOAR_GATEWAY_TOKEN 为空则不强制）。
 * /v1/chat/completions 当前为占位响应；P1 接入 services 的 OpenAI 兼容转换层
 * （services/src/gateway.ts），把 ChatService.stream 事件流转成 OpenAI 形状。
 */
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";

export interface GatewayOptions {
  port?: number;
  requireToken?: boolean;
  gatewayToken?: string;
}

/** Bearer 认证中间件占位：令牌为空时不强制。 */
export function createBearerMiddleware(requireToken: boolean, expectedToken?: string) {
  return async function authHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!requireToken || !expectedToken) return;
    const authHeader = request.headers.authorization ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (token !== expectedToken) {
      return reply.code(401).send({ error: "未授权：Bearer 令牌无效或缺失" });
    }
  };
}

/** 构建 Fastify 应用实例（不启动监听；便于测试用 app.inject）。 */
export async function buildApp(options: GatewayOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  app.addHook("preHandler", createBearerMiddleware(!!options.requireToken, options.gatewayToken));

  app.get("/healthz", async () => ({
    status: "healthy",
    timestamp: new Date().toISOString(),
  }));

  app.post("/v1/chat/completions", async (request, reply) => {
    const body = (request.body ?? {}) as {
      stream?: boolean;
      model?: string;
      messages?: unknown[];
    };
    // P1：接入 services 的 OpenAI 兼容转换（services/src/gateway.ts）
    const finalText = "已接收请求（gateway 占位：P1 接入 ChatService 转换层）";
    if (body.stream === true) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      reply.raw.write(
        `data: ${JSON.stringify({
          id: "cmpl-loopsoar",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? "loopsoar-default",
          choices: [{ index: 0, delta: { content: finalText }, finish_reason: "stop" }],
        })}\n\n`,
      );
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return;
    }
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "loopsoar-default",
      choices: [
        { index: 0, message: { role: "assistant", content: finalText }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  });

  return app;
}

/** 启动监听（node dist/main.js）。 */
export async function startServer(
  options: GatewayOptions = {},
): Promise<{ app: FastifyInstance; url: string }> {
  // 项目隔离：默认端口与 slime（19000/19110）错开，避免同机并行运行时互相串扰
  const port = options.port ?? Number(process.env.LOOPSOAR_GATEWAY_PORT || "19210");
  const tokenEnv = process.env.LOOPSOAR_GATEWAY_TOKEN || "";
  const requireToken = options.requireToken ?? tokenEnv.length > 0;
  const gatewayToken = options.gatewayToken || tokenEnv;
  const app = await buildApp({ port, requireToken, gatewayToken });
  await app.listen({ port, host: "127.0.0.1" });
  return { app, url: `http://127.0.0.1:${port}` };
}
