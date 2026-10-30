/**
 * MCP 客户端宿主（壳层，stdio 传输）：与扩展、技能完全隔离。
 *
 * 生命周期（见 docs/architecture/lifecycle.md）：
 *   握手：spawn → initialize(5s，换行帧；超时切 Content-Length 帧重试一次) → notifications/initialized
 *   注册：能力门控（仅 capabilities 声明的能力才请求）→ tools/list → 工具名 mcp__srv__tool
 *        → 冲突确定性加 _N → 原子替换旧工具集 → tools/list_changed 通知触发刷新
 *   调用：单次 8s 超时（只 reject 该请求，不断连接）→ 错误分为 RPC/传输/超时
 *   清理：注销工具（含后缀变体）→ Windows taskkill /T /F 杀进程树 → resolve pending → 回 idle
 *   自愈：非预期退出 → 1s/2s/4s 退避重连，最多 3 次 → error 等人工
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "loopsoar-core/tools/registry";
import {
  MCP_PROTOCOL_VERSION,
  McpFrameDecoder,
  McpServerConfigSchema,
  bindMcpTools,
  describeMcpError,
  encodeHeaderFrame,
  hasCapability,
  mcpToolName,
  sanitizeMcpEnv,
  uniqueToolName,
  type JsonRpcMessage,
  type McpServerConfig,
  type McpServerState,
  type McpToolBinding,
} from "loopsoar-core/mcp";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface HttpState {
  url: string;
  headers: Record<string, string>;
  sessionId?: string;
}

interface Connection {
  config: McpServerConfig;
  /** HTTP 传输状态（stdio 时缺省）。 */
  http?: HttpState;
  state: McpServerState;
  error?: string;
  tools: McpToolBinding[];
  child?: ChildProcessWithoutNullStreams;
  decoder: McpFrameDecoder;
  framing: "newline" | "header";
  nextId: number;
  pending: Map<number, PendingCall>;
  stderrRing: string[];
  capabilities: unknown;
  refreshing?: Promise<void>;
  refreshQueued?: boolean;
  reconnectTimer?: NodeJS.Timeout;
  reconnectAttempts: number;
  manualClose: boolean;
}

export interface McpServerInfo {
  id: string;
  name: string;
  /** stdio | http */
  transport: "stdio" | "http";
  command: string;
  args: string[];
  /** HTTP 端点（stdio 时为空） */
  url?: string;
  enabled: boolean;
  state: McpServerState;
  tools: string[];
  capabilities: string[];
  stderr: string[];
  error?: string;
}

const CONNECT_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 8000;
const STDERR_RING = 20;
const RECONNECT_MAX = 3;

export class McpHost {
  private connections = new Map<string, Connection>();

  constructor(
    private configFile: string,
    private registry: ToolRegistry,
    private onUpdate: () => void,
  ) {}

  /* ─────────────────────────── 配置 ─────────────────────────── */

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

  /* ─────────────────────────── 查询 ─────────────────────────── */

  list(): McpServerInfo[] {
    return this.readConfig().map((cfg) => {
      const id = cfg.id ?? cfg.name;
      const conn = this.connections.get(id);
      return {
        id,
        name: cfg.name,
        transport: cfg.transport ?? (cfg.url ? "http" : "stdio"),
        command: cfg.command ?? "",
        args: cfg.args ?? [],
        url: cfg.url,
        enabled: cfg.enabled ?? true,
        state: conn?.state ?? "idle",
        tools: conn?.tools.map((t) => t.registryName) ?? [],
        capabilities: capabilityList(conn?.capabilities),
        stderr: conn ? [...conn.stderrRing] : [],
        error: conn?.error,
      };
    });
  }

  add(input: McpServerConfig): McpServerInfo {
    // 统一校验（transport 与 command/url 的匹配由 core schema 的 superRefine 决定）
    const parsed = McpServerConfigSchema.parse(input);
    const list = this.readConfig();
    const ids = list.map((c) => c.id ?? "");
    const id = input.id && !ids.includes(input.id) ? input.id : this.slug(input.name, ids);
    const cfg: McpServerConfig = { ...parsed, id };
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

  /* ─────────────────────────── 工具注册 ─────────────────────────── */

  private dropTools(serverId: string): void {
    const prefix = `mcp__${serverId.replace(/[^a-zA-Z0-9_]/g, "_")}__`;
    for (const tool of this.registry.list()) {
      if (tool.name.startsWith(prefix)) this.registry.unregister(tool.name);
    }
  }

  private registerTools(serverId: string, bindings: McpToolBinding[]): void {
    const registered: string[] = [];
    try {
      for (const binding of bindings) {
        const finalName = uniqueToolName(binding.registryName, (name) => this.registry.has(name));
        this.registry.register({
          name: finalName,
          description: binding.description,
          // 权限 fail-closed：只读工具按 read，其余按 network（仍走沙箱与确认）
          permissions: binding.readOnly ? { read: true } : { network: true },
          schema: z.record(z.unknown()),
          execute: async (ctx): Promise<ToolResult> => this.executeTool(serverId, binding.toolName, ctx.params),
        });
        registered.push(finalName);
      }
    } catch (err) {
      // 注册失败回滚，保持旧工具集不变（原子性）
      for (const name of registered) this.registry.unregister(name);
      throw err;
    }
  }

  private async executeTool(serverId: string, toolName: string, args: unknown): Promise<ToolResult> {
    try {
      const result = (await this.callTool(serverId, toolName, args ?? {})) as {
        content?: { type?: string; text?: string }[];
        isError?: boolean;
      };
      const texts = (result?.content ?? [])
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      return { ok: !result?.isError, content: texts.length > 0 ? texts.join("\n") : JSON.stringify(result ?? {}) };
    } catch (err) {
      return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** 拉取 tools/list 并原子替换工具集（能力门控 + 并发去重）。 */
  private refreshTools(serverId: string, conn: Connection): Promise<void> {
    // 刷新进行中又收到 list_changed：排队，待本次结束后再刷一次（不能丢通知）
    if (conn.refreshing) {
      conn.refreshQueued = true;
      return conn.refreshing;
    }
    conn.refreshing = (async () => {
      if (!hasCapability(conn.capabilities, "tools")) {
        this.dropTools(serverId);
        conn.tools = [];
        return;
      }
      const listed = await this.request(conn, "tools/list", {});
      const bindings = bindMcpTools(serverId, listed);
      this.dropTools(serverId);
      this.registerTools(serverId, bindings);
      conn.tools = bindings;
    })().finally(() => {
      conn.refreshing = undefined;
      this.onUpdate();
      if (conn.refreshQueued) {
        conn.refreshQueued = false;
        void this.refreshTools(serverId, conn).catch((err) => {
          conn.stderrRing.push(`刷新工具失败：${err instanceof Error ? err.message : String(err)}`);
          this.onUpdate();
        });
      }
    });
    return conn.refreshing;
  }

  /* ─────────────────────────── 传输 ─────────────────────────── */

  private sendRaw(conn: Connection, payload: unknown): void {
    if (!conn.child) throw new Error("MCP 进程未启动");
    const text = conn.framing === "header" ? encodeHeaderFrame(payload) : `${JSON.stringify(payload)}\n`;
    conn.child.stdin.write(text);
  }

  private request(conn: Connection, method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (conn.http) return this.httpRpc(conn, method, params, timeoutMs);
    if (!conn.child) return Promise.reject(new Error(describeMcpError("transport", "进程未启动")));
    const id = ++conn.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(describeMcpError("timeout", method)));
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      try {
        this.sendRaw(conn, { jsonrpc: "2.0", id, method, params });
      } catch (err) {
        conn.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(describeMcpError("transport", err instanceof Error ? err.message : String(err))));
      }
    });
  }

  private notify(conn: Connection, method: string, params?: unknown): void {
    if (conn.http) {
      void this.httpNotify(conn, method, params);
      return;
    }
    try {
      this.sendRaw(conn, { jsonrpc: "2.0", method, params });
    } catch {
      // 通知失败不影响调用
    }
  }

  /* ───────────── Streamable HTTP 传输（POST JSON-RPC，兼容 SSE 响应） ───────────── */

  private httpHeaders(conn: Connection): Record<string, string> {
    const http = conn.http!;
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(http.sessionId ? { "mcp-session-id": http.sessionId } : {}),
      ...http.headers,
    };
  }

  private async httpRpc(conn: Connection, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const http = conn.http!;
    if (!http.url) throw new Error(describeMcpError("transport", "HTTP 端点未配置"));
    const id = ++conn.nextId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(http.url, {
        method: "POST",
        headers: this.httpHeaders(conn),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      const sessionId = res.headers.get("mcp-session-id");
      if (sessionId) http.sessionId = sessionId;
      if (!res.ok) throw new Error(describeMcpError("rpc", `HTTP ${res.status}`));
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf("\n\n");
          while (sep >= 0) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of rawEvent.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              let msg: JsonRpcMessage;
              try {
                msg = JSON.parse(payload) as JsonRpcMessage;
              } catch {
                continue;
              }
              if (msg.id === id) {
                if (msg.error) throw new Error(describeMcpError("rpc", `${msg.error.code} ${msg.error.message}`));
                return msg.result;
              }
            }
            sep = buffer.indexOf("\n\n");
          }
        }
        throw new Error(describeMcpError("transport", "SSE 响应结束但未收到结果"));
      }
      const data = (await res.json()) as JsonRpcMessage;
      if (data.error) throw new Error(describeMcpError("rpc", `${data.error.code} ${data.error.message}`));
      return data.result;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(describeMcpError("timeout", method));
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  private async httpNotify(conn: Connection, method: string, params?: unknown): Promise<void> {
    const http = conn.http!;
    if (!http.url) return;
    try {
      const res = await fetch(http.url, {
        method: "POST",
        headers: this.httpHeaders(conn),
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      });
      const sessionId = res.headers.get("mcp-session-id");
      if (sessionId) http.sessionId = sessionId;
      await res.body?.cancel();
    } catch {
      // 通知失败不影响调用
    }
  }

  private handleMessage(serverId: string, conn: Connection, msg: JsonRpcMessage): void {
    if (typeof msg.id === "number" && conn.pending.has(msg.id)) {
      const pending = conn.pending.get(msg.id)!;
      conn.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(describeMcpError("rpc", `${msg.error.code} ${msg.error.message}`)));
      else pending.resolve(msg.result);
      return;
    }
    if (typeof msg.id === "number" && msg.method) {
      if (msg.method === "ping") {
        try {
          this.sendRaw(conn, { jsonrpc: "2.0", id: msg.id, result: {} });
        } catch {
          // 忽略
        }
      } else {
        try {
          this.sendRaw(conn, {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `method not found: ${msg.method}` },
          });
        } catch {
          // 忽略
        }
      }
      return;
    }
    if (msg.method === "notifications/tools/list_changed") {
      void this.refreshTools(serverId, conn).catch((err) => {
        conn.stderrRing.push(`刷新工具失败：${err instanceof Error ? err.message : String(err)}`);
        this.onUpdate();
      });
      return;
    }
    if (msg.method?.startsWith("notifications/")) {
      const text = JSON.stringify(msg.params ?? {}).slice(0, 200);
      conn.stderrRing.push(`通知 ${msg.method}：${text}`);
      if (conn.stderrRing.length > STDERR_RING) conn.stderrRing.shift();
    }
  }

  /* ─────────────────────────── 生命周期 ─────────────────────────── */

  async connect(id: string, opts: { auto?: boolean } = {}): Promise<McpServerInfo | null> {
    const cfg = this.readConfig().find((c) => (c.id ?? c.name) === id);
    if (!cfg) return null;
    const existing = this.connections.get(id);
    if (existing?.state === "ready" || existing?.state === "connecting") {
      return this.list().find((s) => s.id === id) ?? null;
    }

    this.teardown(id);
    const conn: Connection = {
      config: cfg,
      state: "connecting",
      tools: [],
      decoder: new McpFrameDecoder(),
      framing: "newline",
      nextId: 0,
      pending: new Map(),
      stderrRing: [],
      capabilities: null,
      reconnectAttempts: opts.auto ? (existing?.reconnectAttempts ?? 0) : 0,
      manualClose: false,
    };
    this.connections.set(id, conn);
    this.onUpdate();

    const transport = cfg.transport ?? (cfg.url ? "http" : "stdio");
    if (transport === "http") {
      conn.http = { url: cfg.url ?? "", headers: cfg.headers ?? {} };
    }
    try {
      if (conn.http) {
        const init = (await this.request(conn, "initialize", this.initParams(), CONNECT_TIMEOUT_MS)) as {
          capabilities?: unknown;
        };
        conn.capabilities = init.capabilities ?? null;
      } else {
        this.spawnProcess(id, conn);
        try {
          const init = (await this.request(conn, "initialize", this.initParams(), CONNECT_TIMEOUT_MS)) as {
            capabilities?: unknown;
          };
          conn.capabilities = init.capabilities ?? null;
        } catch (firstErr) {
          // 帧格式探测失败：切 Content-Length 帧重试一次（slime "flip framing" 教训）
          conn.framing = "header";
          conn.decoder = new McpFrameDecoder();
          this.killProcess(conn);
          this.spawnProcess(id, conn);
          const init = (await this.request(conn, "initialize", this.initParams(), CONNECT_TIMEOUT_MS)) as {
            capabilities?: unknown;
          };
          conn.capabilities = init.capabilities ?? null;
          conn.stderrRing.push(
            `握手已切换 Content-Length 帧重试成功（${firstErr instanceof Error ? firstErr.message : String(firstErr)}）`,
          );
        }
      }
      this.notify(conn, "notifications/initialized", {});
      await this.refreshTools(id, conn);
      conn.state = "ready";
      conn.error = undefined;
      this.onUpdate();
    } catch (err) {
      conn.state = "error";
      conn.error = err instanceof Error ? err.message : String(err);
      conn.stderrRing.push(conn.error);
      this.dropTools(id);
      this.killProcess(conn);
      this.onUpdate();
    }
    return this.list().find((s) => s.id === id) ?? null;
  }

  private initParams(): Record<string, unknown> {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "loopsoar", version: "0.0.0" },
    };
  }

  private spawnProcess(serverId: string, conn: Connection): void {
    const cfg = conn.config;
    const command = cfg.command ?? "";
    if (!command) throw new Error(describeMcpError("transport", "stdio 传输缺少启动命令"));
    const needsShell =
      process.platform === "win32" && /^(npx|npm|pnpm|yarn|bun|uvx|uv|cmd|powershell)$/i.test(command);
    const child = spawn(command, cfg.args ?? [], {
      env: sanitizeMcpEnv(process.env, cfg.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: needsShell,
    }) as ChildProcessWithoutNullStreams;
    conn.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const msg of conn.decoder.push(chunk)) this.handleMessage(serverId, conn, msg);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        conn.stderrRing.push(text.slice(0, 300));
        if (conn.stderrRing.length > STDERR_RING) conn.stderrRing.shift();
      }
      this.onUpdate();
    });
    child.on("error", (err) => {
      conn.state = "error";
      conn.error = describeMcpError("transport", err.message);
      this.onUpdate();
    });
    child.on("exit", (code) => {
      if (conn.manualClose) return;
      const wasReady = conn.state === "ready";
      conn.state = "error";
      conn.error = describeMcpError("transport", `进程退出（code=${code ?? "?"}）`);
      this.dropTools(serverId);
      this.onUpdate();
      if (wasReady) this.scheduleReconnect(serverId, conn);
    });
  }

  private scheduleReconnect(serverId: string, conn: Connection): void {
    if (conn.reconnectTimer) return;
    if (conn.reconnectAttempts >= RECONNECT_MAX) {
      conn.error = `${conn.error ?? "连接失败"}；已重试 ${RECONNECT_MAX} 次，请手动重连`;
      this.onUpdate();
      return;
    }
    const delay = 1000 * 2 ** conn.reconnectAttempts;
    conn.reconnectAttempts += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = undefined;
      void this.connect(serverId, { auto: true });
    }, delay);
    conn.reconnectTimer.unref?.();
    this.onUpdate();
  }

  private killProcess(conn: Connection): void {
    const child = conn.child;
    conn.child = undefined;
    if (!child) return;
    if (process.platform === "win32" && child.pid) {
      // 关键：npx/uvx 的孙进程会持有管道 → 必须杀进程树（slime 的孤儿进程教训）
      try {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
      } catch {
        // 回退 kill
      }
    }
    try {
      child.kill();
    } catch {
      // 已退出
    }
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(describeMcpError("transport", "连接已关闭")));
    }
    conn.pending.clear();
  }

  private teardown(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    conn.manualClose = true;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = undefined;
    }
    this.dropTools(id);
    this.killProcess(conn);
    this.connections.delete(id);
  }

  private async callTool(serverId: string, toolName: string, args: unknown): Promise<unknown> {
    let conn = this.connections.get(serverId);
    if (!conn || conn.state !== "ready") {
      await this.connect(serverId);
      conn = this.connections.get(serverId);
    }
    if (!conn || conn.state !== "ready") throw new Error(conn?.error ?? `MCP 服务器不可用：${serverId}`);
    return this.request(conn, "tools/call", { name: toolName, arguments: args ?? {} });
  }

  disconnect(id: string): boolean {
    if (!this.connections.has(id)) return false;
    this.teardown(id);
    this.onUpdate();
    return true;
  }

  shutdown(): void {
    for (const id of [...this.connections.keys()]) this.teardown(id);
    this.onUpdate();
  }
}

function capabilityList(capabilities: unknown): string[] {
  const caps = capabilities as Record<string, unknown> | null | undefined;
  if (!caps || typeof caps !== "object") return [];
  return Object.keys(caps);
}
