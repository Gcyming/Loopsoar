/**
 * MCP 反向能力接线：roots（告诉服务器工作区在哪）与 sampling（服务器借客户端模型补全）。
 *
 * 为什么单独一层：mcpHost 只管协议，不认识「当前工作区怎么解析」「模型从哪来」；
 * 这两个依赖落在装配层，用一个函数注入，避免 index.ts 继续膨胀。
 */
import type { LlmClient, LlmMessage } from "loopsoar-core/llm";
import type { McpHost, McpSamplingRequest } from "./mcpHost.js";

export function wireMcpBridge(
  mcp: McpHost,
  deps: { roots: (sessionId?: string) => string[]; getLlm: () => LlmClient | undefined },
): void {
  mcp.setRootsProvider(deps.roots);
  mcp.setSampler(async (request: McpSamplingRequest): Promise<string> => {
    const llm = deps.getLlm();
    if (!llm) throw new Error("没有可用的模型，无法响应 MCP sampling 请求");
    const messages = request.messages
      .map((message): LlmMessage => {
        const role = message.role === "assistant" || message.role === "system" ? message.role : "user";
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        return { role, content: text };
      })
      .filter((message) => String(message.content).trim().length > 0);
    if (messages.length === 0) throw new Error("sampling 请求没有可用的文本消息");
    let text = "";
    for await (const chunk of llm.invoke({
      messages,
      ...(typeof request.maxTokens === "number" ? { maxTokens: request.maxTokens } : {}),
    })) {
      if (chunk.kind === "text") text += chunk.text;
    }
    if (!text.trim()) throw new Error("模型没有返回文本");
    return text;
  });
}
