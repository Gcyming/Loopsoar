/**
 * mcp 域：MCP 服务器配置与连接管理（stdio JSON-RPC）。
 * 与 extensions、skills 独立：配置文件 mcp.json、独立通道前缀 mcp:*。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { McpHost } from "../mcpHost.js";

export interface McpDeps extends TrustedIpcDeps {
  mcp?: McpHost;
  push?: (event: string, payload: unknown) => void;
  /** 配置文件路径（UI 展示用）。 */
  mcpConfigPath?: string;
}

export function registerMcpDomain(deps: McpDeps): void {
  handleTrusted(deps, "mcp:list", () => ({
    servers: deps.mcp?.list() ?? [],
    configPath: deps.mcpConfigPath ?? "",
  }));

  handleTrusted(deps, "mcp:add", (payload) => {
    const p = payload as { id?: string; name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean };
    if (!deps.mcp) throw new Error("MCP 客户端未装配");
    const server = deps.mcp.add(p);
    deps.push?.("mcp:updated", { action: "add", server });
    return { server, servers: deps.mcp.list() };
  });

  handleTrusted(deps, "mcp:remove", (payload) => {
    const p = payload as { id: string };
    const removed = deps.mcp?.remove(p.id) ?? false;
    deps.push?.("mcp:updated", { action: "remove", id: p.id, removed });
    return { removed, servers: deps.mcp?.list() ?? [] };
  });

  handleTrusted(deps, "mcp:connect", async (payload) => {
    const p = payload as { id: string };
    if (!deps.mcp) throw new Error("MCP 客户端未装配");
    const server = await deps.mcp.connect(p.id);
    deps.push?.("mcp:updated", { action: "connect", server });
    return { server, servers: deps.mcp.list() };
  });

  handleTrusted(deps, "mcp:disconnect", (payload) => {
    const p = payload as { id: string };
    const ok = deps.mcp?.disconnect(p.id) ?? false;
    deps.push?.("mcp:updated", { action: "disconnect", id: p.id });
    return { ok, servers: deps.mcp?.list() ?? [] };
  });
}
