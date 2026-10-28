/**
 * LLM 客户端抽象（§4.1 llm）
 * LlmClient 提供统一的流式调用接口（invoke 返回 AsyncIterable<LlmChunk>）；
 * LlmRequest 包含消息、工具、最大 Token、中止信号；
 * LlmChunk 定义七种输出块类型（text/reasoning/tool_call/usage/done/error）；
 * MockLlmClient 提供脚本化回复队列，供测试使用。
 * 为什么：统一抽象让 tool_loop 不依赖任何具体 LLM 提供商，MockLlmClient 让测试可完全脱离真实网络和模型服务运行。
 */

// LLM 消息：标准化的消息格式，与工具执行上下文兼容。
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

// LLM 请求：包含对话上下文、可用工具清单、最大 Token 限制、中止信号。
export interface LlmRequest {
  messages: LlmMessage[];
  tools?: readonly { name: string; description: string; parameters: unknown }[];
  maxTokens?: number;
  signal?: AbortSignal;
}

// LLM 流式输出块：每种 kind 对应不同的语义处理路径（文本、推理、工具调用、使用量、完成、错误）。
export type LlmChunk =
  | { kind: "text"; text: string; tokens?: number }
  | { kind: "reasoning"; text: string; tokens?: number }
  | {
      kind: "tool_call";
      toolCall: { id: string; name: string; args: unknown };
      tokens?: number;
    }
  | { kind: "usage"; tokens: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

// LLM 客户端接口：流式调用，返回异步可迭代的 Chunk 队列。
export interface LlmClient {
  invoke(req: LlmRequest): AsyncIterable<LlmChunk>;
}

// Mock LLM 客户端：脚本化回复队列，供测试和演示使用。
// 按顺序返回预设 Chunk 序列，每次 invoke 消耗一个脚本（无脚本时默认返回 done）。
export class MockLlmClient implements LlmClient {
  private scripts: LlmChunk[][] = [];
  private scriptIndex = 0;

  /**
   * 添加一个脚本：一轮对话的 Chunk 序列（如 [text, tool_call, text, done]）。
   */
  addScript(chunks: LlmChunk[]): void {
    this.scripts.push(chunks);
  }

  async *invoke(_req: LlmRequest): AsyncIterable<LlmChunk> {
    if (this.scriptIndex >= this.scripts.length) {
      yield { kind: "done" };
      return;
    }
    const chunks = this.scripts[this.scriptIndex++];
    for (const chunk of chunks) {
      yield chunk;
    }
  }
}

export { createOpenAiClient, normalizeUsage } from "./openai.js";
export type { OpenAiClientOptions, NormalizedUsage } from "./openai.js";
