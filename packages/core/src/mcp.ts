/**
 * MCP（Model Context Protocol）模型 —— 与「扩展」「技能」严格隔离的独立子系统。
 *
 * 隔离边界：
 *   - 扩展 = 本地可执行插件（我们自己的清单格式，工具由扩展入口注册）；
 *   - 技能 = SKILL.md 纯文本提示词，不提供工具；
 *   - MCP  = 外部进程/服务通过标准 JSON-RPC 协议暴露工具，我们只做客户端。
 *
 * 本文件是纯逻辑：JSON-RPC 编解码（换行 + Content-Length 双帧自动探测）、
 * 配置校验、能力门控、工具命名/冲突、环境白名单、错误分类。
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
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 编码为一行 JSON（换行帧）。 */
export function encodeRpc(request: { jsonrpc: "2.0"; id: number; method: string; params?: unknown }): string {
  return `${JSON.stringify(request)}\n`;
}

/** UTF-8 字节长度（core 不依赖 Node Buffer）。 */
function byteLen(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 按 UTF-8 字节数切字符串（避免多字节字符与 Content-Length 错位）。 */
function sliceByBytes(text: string, maxBytes: number): { head: string; rest: string } {
  let bytes = 0;
  let index = 0;
  for (const ch of text) {
    const size = byteLen(ch);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += ch.length;
  }
  return { head: text.slice(0, index), rest: text.slice(index) };
}

/** 编码为 LSP 风格 Content-Length 帧（部分实现使用）。 */
export function encodeHeaderFrame(payload: unknown): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${byteLen(body)}\r\n\r\n${body}`;
}

/**
 * 自动探测帧格式的解码器：
 *  - 换行 JSON：大多数 MCP stdio 实现；
 *  - Content-Length：LSP 风格实现（slime 的 "flip framing" 教训）。
 * 首次收到数据时判断（以 `Content-Length:` 开头 → header 帧），之后固定。
 */
export class McpFrameDecoder {
  mode: "newline" | "header" | "unknown" = "unknown";
  private buffer = "";

  push(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const out: JsonRpcMessage[] = [];
    if (this.mode === "unknown") {
      const head = this.buffer.replace(/^\uFEFF/, "");
      if (!head) return out;
      if (/^Content-Length:/i.test(head)) this.mode = "header";
      else if (head.trimStart().startsWith("{") || head.trimStart().startsWith("[")) this.mode = "newline";
      else if (head.includes("\n")) this.mode = "newline";
      else return out; // 等待更多数据
    }
    if (this.mode === "header") {
      for (;;) {
        const sep = this.buffer.indexOf("\r\n\r\n");
        const sep2 = this.buffer.indexOf("\n\n");
        const breakAt = sep >= 0 ? sep : sep2;
        if (breakAt < 0) break;
        const headerEnd = breakAt + (sep >= 0 ? 4 : 2);
        const header = this.buffer.slice(0, breakAt);
        const lenMatch = /Content-Length:\s*(\d+)/i.exec(header);
        if (!lenMatch) {
          // 坏帧头：丢弃到下一帧
          this.buffer = this.buffer.slice(headerEnd);
          continue;
        }
        const len = Number(lenMatch[1]);
        const bodyStart = headerEnd;
        const remainder = this.buffer.slice(bodyStart);
        if (byteLen(remainder) < len) break; // 半包
        const { head: body, rest } = sliceByBytes(remainder, len);
        this.buffer = rest;
        const parsed = tryParse(body);
        if (parsed) out.push(parsed);
      }
      return out;
    }
    // newline
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.startsWith("{")) {
        const parsed = tryParse(line);
        if (parsed) out.push(parsed);
      }
      idx = this.buffer.indexOf("\n");
    }
    return out;
  }
}

function tryParse(text: string): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(text) as JsonRpcMessage;
    if (parsed && typeof parsed === "object" && "jsonrpc" in parsed) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** 能力门控：initialize 返回的 capabilities 是否声明某能力。 */
export function hasCapability(capabilities: unknown, key: "tools" | "resources" | "prompts"): boolean {
  const caps = capabilities as Record<string, unknown> | null | undefined;
  return Boolean(caps && typeof caps === "object" && key in caps);
}

/** MCP 工具名 → 注册表工具名（加服务器前缀，避免与内置/扩展工具冲突）。 */
export function mcpToolName(serverId: string, toolName: string): string {
  const safeServer = serverId.replace(/[^a-zA-Z0-9_]/g, "_");
  const safeTool = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp__${safeServer}__${safeTool}`;
}

/** 冲突时确定性加后缀（借鉴 slime 的 `改用 'xxx_N'`，但必须是确定性的）。 */
export function uniqueToolName(base: string, exists: (name: string) => boolean): string {
  if (!exists(base)) return base;
  let n = 2;
  while (exists(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

export interface McpToolBinding {
  serverId: string;
  toolName: string;
  registryName: string;
  description: string;
  inputSchema?: unknown;
  readOnly: boolean;
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
      readOnly: tool.annotations?.readOnlyHint === true,
    });
  }
  return out;
}

/** 环境变量白名单（防泄漏 API Key 给第三方 MCP 进程；其余仅来自配置显式 env）。 */
export const MCP_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "OS",
  "LANG",
  "LC_ALL",
  "SHELL",
  "TERM",
];

export function sanitizeMcpEnv(
  source: Record<string, string | undefined>,
  explicit?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of MCP_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") out[key] = value;
  }
  for (const [key, value] of Object.entries(explicit ?? {})) out[key] = value;
  return out;
}

/** 错误分类：区分 RPC 错误 / 超时 / 传输失败，返回可直接展示的文案。 */
export function describeMcpError(kind: "timeout" | "transport" | "rpc", detail?: string): string {
  if (kind === "timeout") return `MCP 请求超时${detail ? `：${detail}` : ""}`;
  if (kind === "rpc") return `MCP RPC 错误${detail ? `：${detail}` : ""}`;
  return `MCP 传输失败${detail ? `：${detail}` : ""}`;
}
