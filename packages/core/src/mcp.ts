/**
 * MCP（Model Context Protocol）模型 —— 与「扩展」「技能」严格隔离的独立子系统。
 *
 * 隔离边界：
 *   - 扩展 = 本地可执行插件（我们自己的清单格式，工具由扩展入口注册）；
 *   - 技能 = SKILL.md 纯文本提示词，不提供工具；
 *   - MCP  = 外部进程/服务通过标准 JSON-RPC 协议暴露工具，我们只做客户端。
 *
 * 本文件是纯逻辑：JSON-RPC 编解码 + 配置校验 + 工具命名/参数映射。
 * 真正的子进程/HTTP 传输在壳层（shell/mcpHost.ts），不进 core。
 */
import { z } from "zod";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const McpServerConfigSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  /** 启动命令（stdio 传输），如 "npx" / "node"。 */
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).max(50).optional(),
  env: z.record(z.string().max(2000)).optional(),
  enabled: z.boolean().optional(),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export type McpServerState = "idle" | "connecting" | "ready" | "error";

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 编码为一行 JSON（stdio 传输按行分帧）。 */
export function encodeRpc(request: JsonRpcRequest): string {
  return `${JSON.stringify(request)}\n`;
}

/** 按行解析；容忍不完整行（缓存残片），坏行忽略。 */
export class JsonRpcLineDecoder {
  private buffer = "";

  push(chunk: string): JsonRpcResponse[] {
    this.buffer += chunk;
    const out: JsonRpcResponse[] = [];
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (parsed && typeof parsed === "object" && "jsonrpc" in parsed) out.push(parsed);
        } catch {
          // 非 JSON 行（服务器日志）忽略
        }
      }
      idx = this.buffer.indexOf("\n");
    }
    return out;
  }
}

/** MCP 工具名 → 注册表工具名（加服务器前缀，避免与内置/扩展工具冲突）。 */
export function mcpToolName(serverId: string, toolName: string): string {
  const safeServer = serverId.replace(/[^a-zA-Z0-9_]/g, "_");
  const safeTool = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp__${safeServer}__${safeTool}`;
}

export interface McpToolBinding {
  serverId: string;
  toolName: string;
  registryName: string;
  description: string;
  inputSchema?: unknown;
}

/** tools/list 结果 → 注册绑定列表（纯函数，便于单测）。 */
export function bindMcpTools(serverId: string, listed: unknown): McpToolBinding[] {
  const tools = (listed as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return [];
  const out: McpToolBinding[] = [];
  for (const raw of tools) {
    const tool = raw as Partial<McpToolDescriptor>;
    if (!tool || typeof tool.name !== "string" || tool.name.length === 0) continue;
    out.push({
      serverId,
      toolName: tool.name,
      registryName: mcpToolName(serverId, tool.name),
      description: typeof tool.description === "string" ? tool.description : `MCP 工具：${tool.name}`,
      inputSchema: tool.inputSchema,
    });
  }
  return out;
}
