// §5 services 包 / gateway 转换层（OpenAI 兼容形状）
// 说明：将 ChatService 的内部流式输出转换为 OpenAI /v1/chat/completions 兼容格式；
// gateway 包调用本文件进行请求/响应转换。
// 未定义细节选最简实现（直接 JSON 序列化，无额外协议压缩）。

/** OpenAI 兼容请求体（简化） */
export interface OpenAIChatCompletionRequest {
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

/** OpenAI 兼容响应（非流式） */
export interface OpenAIChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** OpenAI 兼容流式数据块（SSE 事件格式） */
export interface OpenAIStreamChunk {
  id?: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { content?: string; role?: string };
    finish_reason: string | null;
  }>;
}

/** 流式块类型（内部到外部映射） */
export interface StreamChunkMapping {
  id?: string;
  model: string;
  created: number;
  deltaContent: string;
  deltaRole?: string;
  finishReason?: string | null;
}

/**
 * 转换函数：将内部流式事件转换为 OpenAI 兼容 SSE 数据块
 */
export function convertToOpenAIStreamChunk(
  chunk: { kind: string; data: unknown; ts: number },
  modelName = "loopsoar-default",
): OpenAIStreamChunk | null {
  if (chunk.kind === "chunk" || chunk.kind === "text" || chunk.kind === "done") {
    const content = typeof chunk.data === "string" ? chunk.data : JSON.stringify(chunk.data);
    const finishReason = chunk.kind === "done" ? "stop" : null;
    return {
      id: `cmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: chunk.ts,
      model: modelName,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: finishReason,
        },
      ],
    };
  }
  // 其他事件（heartbeat、reasoning、tool、progress、error）可映射为 delta 或跳过
  if (chunk.kind === "reasoning") {
    return {
      id: `cmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: chunk.ts,
      model: modelName,
      choices: [{ index: 0, delta: { content: "" }, finish_reason: null }],
    };
  }
  if (chunk.kind === "heartbeat") {
    return null; // 心跳不向外暴露
  }
  if (chunk.kind === "tool") {
    // 工具调用映射到 delta 内容（简化：直接序列化）
    return {
      id: `cmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: chunk.ts,
      model: modelName,
      choices: [{ index: 0, delta: { content: JSON.stringify(chunk.data) }, finish_reason: null }],
    };
  }
  return null;
}

/**
 * 转换函数：将 ChatService 结果转换为非流式 OpenAI 完成响应
 */
export function convertToOpenAINonStream(
  result: { status: string; reason: string; finalText: string; usage?: { rounds: number; toolCalls: number; totalTokens: number; wallClockMs: number } },
  modelName = "loopsoar-default",
): OpenAIChatCompletionResponse {
  const totalTokens = result.usage?.totalTokens || 0;
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Date.now(),
    model: modelName,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.finalText || result.reason },
        finish_reason: result.status === "done" ? "stop" : result.status,
      },
    ],
    usage: {
      prompt_tokens: Math.floor(totalTokens * 0.3),
      completion_tokens: Math.ceil(totalTokens * 0.7),
      total_tokens: totalTokens,
    },
  };
}

/**
 * 转换函数：构建请求解析器（简单解析，不依赖外部解析库）
 */
export function parseChatRequest(bodyText: string): OpenAIChatCompletionRequest {
  try {
    const parsed = JSON.parse(bodyText);
    return {
      model: parsed.model || "loopsoar-default",
      messages: Array.isArray(parsed.messages) ? parsed.messages : [{ role: "user", content: parsed.prompt || parsed.message || "" }],
      stream: !!parsed.stream,
      temperature: parsed.temperature,
      max_tokens: parsed.max_tokens,
    };
  } catch {
    // 解析失败时返回最简请求
    return {
      model: "loopsoar-default",
      messages: [{ role: "user", content: bodyText }],
      stream: false,
    };
  }
}
