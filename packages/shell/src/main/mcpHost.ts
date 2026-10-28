/**
 * MCP 客户端宿主（壳层，stdio 传输）：与扩展、技能完全隔离。
 *
 * 流程：spawn 子进程 → initialize 握手 → notifications/initialized → tools/list
 *      → 每个工具按 `mcp__<server>__<tool>` 注册进 ToolRegistry（执行时 tools/call）。
 * 配置：<dataDir>/mcp.json，[{ id, name, command, args, env, enabled }]
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolRegistry } from "loopsoar-core/tools/registry";
import {
  MCP_PROTOCOL_VERSION,
  JsonRpcLineDecoder,
  McpServerConfigSchema,
  bindMcpTools,
  encodeRpc,
  type JsonRpcResponse,
  type McpServerConfig,
  type McpServerState,
  type McpToolBinding,
} from "loopsoar-core/mcp";
import type { ToolResult } from "loopsoar-core/tools/registry";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  config: McpServerConfig;
  state: McpServerState;
  error?: string;
  tools: McpToolBinding[];
  child?: ChildProcessWithoutNullStreams;
  decoder: JsonRpcLineDecoder;
  nextId: number;
  pending: Map<number, PendingCall>;
}

export interface McpServerInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  state: McpServerState;
  tools: string[];
  error?: string;
}

const CALL_TIMEOUT_MS = 8000;

export class McpHost {
  private connections = new Map<string, Connection>();

  constructor(
    private configFile: string,
    private registry: ToolRegistry,
    private onUpdate: () => void,
  ) {}

  private readConfig(): McpServerConfig[] {
    try {
      if (!fs.existsSync(this.configFile)) return [];
      const raw = JSON.parse(fs.readFileSync(this.configFile, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .map((item) => {
          try {
            return McpServerConfigSchema.parse(item);
          } catch {
            return null;
          }
        })
        .filter((x): x is McpServerConfig => x !== null);
    } catch {
      return [];
    }
  }

  private writeConfig(list: McpServerConfig[]): void {
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    fs.writeFileSync(this.configFile, JSON.stringify(list, null, 2), "utf8");
  }

  private slug(name: string, existing: string[]): string {
    const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp";
    if (!existing.includes(base)) return base;
    let n = 2;
    while (existing.includes(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  list(): McpServerInfo[] {
    const configs = this.readConfig();
    return configs.map((cfg) => {
      const id = cfg.id ?? cfg.name;
      const conn = this.connections.get(id);
      return {
        id,
        name: cfg.name,
        command: cfg.command,
        args: cfg.args ?? [],
        enabled: cfg.enabled ?? true,
        state: conn?.state ?? "idle",
        tools: conn?.tools.map((t) => t.registryName) ?? [],
        error: conn?.error,
      };
    });
  }

  add(input: McpServerConfig): McpServerInfo {
    const list = this.readConfig();
    const ids = list.map((c) => c.id ?? "");
    const id = input.id && !ids.includes(input.id) ? input.id : this.slug(input.name, ids);
    const cfg: McpServerConfig = { ...input, id };
    const at = list.findIndex((c) => (c.id ?? "") === id);
    if (at >= 0) list[at] = cfg;
    else list.push(cfg);
    this.writeConfig(list);
    this.onUpdate();
    return this.list().find((s) => s.id === id)!;
  }

  remove(id: string): boolean {
    this.disconnect(id);
    const list = this.readConfig();
    const next = list.filter((c) => (c.id ?? c.name) !== id);
    if (next.length === list.length) return false;
    this.writeConfig(next);
    this.onUpdate();
    return true;
  }

  private send(conn: Connection, method: string, params?: unknown): Promise<unknown> {
    const id = ++conn.nextId;
    if (!conn.child) return Promise.reject(new Error("MCP 进程未启动"));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`MCP 请求超时（${method}）`));
      }, CALL_TIMEOUT_MS);
      conn.pending.set(id, { resolve, reject, timer });
      conn.child!.stdin.write(encodeRpc({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async connect(id: string): Promise<McpServerInfo | null> {
    const cfg = this.readConfig().find((c) => (c.id ?? c.name) === id);
    if (!cfg) return null;
    this.disconnect(id);
    const conn: Connection = {
      config: cfg,
      state: "connecting",
      tools: [],
      decoder: new JsonRpcLineDecoder(),
      nextId: 0,
      pending: new Map(),
    };
    this.connections.set(id, conn);
    this.onUpdate();
    try {
      // Windows：npx/npm 等 .cmd 包装器需要 shell；node/绝对路径直接 spawn（避免空格被 shell 拆坏）
      const needsShell =
        process.platform === "win32" && /^(npx|npm|pnpm|yarn|bun|uvx|uv|cmd|powershell)$/i.test(cfg.command);
      const child = spawn(cfg.command, cfg.args ?? [], {
        env: { ...process.env, ...(cfg.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        shell: needsShell,
      }) as ChildProcessWithoutNullStreams;
      conn.child = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        for (const msg of conn.decoder.push(chunk)) this.handleMessage(id, conn, msg);
      });
      child.stderr.on("data", (chunk: string) => {
        const text = String(chunk).trim();
        if (text) console.warn(`[MCP:${id}] ${text.slice(0, 300)}`);
      });
      child.on("exit", (code) => {
        conn.state = "error";
        conn.error = `MCP 进程退出（code=${code ?? "?"}）`;
        this.dropTools(id);
        this.onUpdate();
      });

      await this.send(conn, "initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "loopsoar", version: "0.0.0" },
      });
      conn.child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listed = await this.send(conn, "tools/list", {});
      const bindings = bindMcpTools(id, listed);
      this.dropTools(id);
      for (const binding of bindings) this.registerTool(id, binding);
      conn.tools = bindings;
      conn.state = "ready";
      conn.error = undefined;
      this.onUpdate();
      return this.list().find((s) => s.id === id)!;
    } catch (err) {
      conn.state = "error";
      conn.error = err instanceof Error ? err.message : String(err);
      this.dropTools(id);
      this.onUpdate();
      return this.list().find((s) => s.id === id)!;
    }
  }

  private handleMessage(serverId: string, conn: Connection, msg: JsonRpcResponse): void {
    if (msg.id !== null && conn.pending.has(msg.id)) {
      const pending = conn.pending.get(msg.id)!;
      conn.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else pending.resolve(msg.result);
      return;
    }
    // 服务器 → 客户端请求：只支持 ping，其余忽略
    const req = msg as unknown as { method?: string; id?: number | null };
    if (req.method === "ping" && req.id !== null && conn.child) {
      conn.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n");
    }
    void serverId;
  }

  private dropTools(serverId: string): void {
    for (const tool of this.registry.list()) {
      if (tool.name.startsWith(`mcp__${serverId.replace(/[^a-zA-Z0-9_]/g, "_")}__`)) {
        this.registry.unregister(tool.name);
      }
    }
  }

  private registerTool(serverId: string, binding: McpToolBinding): void {
    this.registry.register({
      name: binding.registryName,
      description: binding.description,
      // MCP 工具默认按网络能力处理（可能访问外部服务）；沙箱/确认流程照常生效
      permissions: { network: true },
      schema: z.record(z.unknown()),
      execute: async (ctx): Promise<ToolResult> => {
        try {
          const result = (await this.callTool(serverId, binding.toolName, ctx.params ?? {})) as {
            content?: { type?: string; text?: string }[];
            isError?: boolean;
          };
          const texts = (result?.content ?? [])
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string);
          return {
            ok: !result?.isError,
            content: texts.length > 0 ? texts.join("\n") : JSON.stringify(result ?? {}),
          };
        } catch (err) {
          return { ok: false, content: `[错误] MCP 调用失败：${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });
  }

  private async callTool(serverId: string, toolName: string, args: unknown): Promise<unknown> {
    const conn = this.connections.get(serverId) ?? (await this.connect(serverId), this.connections.get(serverId));
    if (!conn || conn.state !== "ready") throw new Error(`MCP 服务器不可用：${serverId}`);
    return this.send(conn, "tools/call", { name: toolName, arguments: args ?? {} });
  }

  disconnect(id: string): boolean {
    const conn = this.connections.get(id);
    if (!conn) return false;
    this.dropTools(id);
    try {
      conn.child?.kill();
    } catch {
      // 已退出
    }
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP 连接已断开"));
    }
    conn.pending.clear();
    this.connections.delete(id);
    this.onUpdate();
    return true;
  }

  shutdown(): void {
    for (const id of [...this.connections.keys()]) this.disconnect(id);
  }
}
