// §5 services 包 / ChatService 流式编排（T3 真接线）
// 流程：buildSystemSegments → runToolLoop（真引擎：四闸/心跳/转向）→ 每轮声称核验 → 事件归一
// 权限：InternalToolExecutor 内做 sandbox.checkPermission；confirm/deny 走 PermRequestBus（挂起 + 超时按拒绝）
// 设计：services 不 import electron；全部能力经注入（llm/platform/registry/sandbox）。
import type { LlmClient } from "loopsoar-core/llm";
import type { LoopsoarPlatform } from "loopsoar-core/platform";
import { buildSystemSegments } from "loopsoar-core/session";
import {
  runToolLoop,
  type ToolCall,
  type ToolLoopOutcome,
} from "loopsoar-core/tool_loop";
import { auditClaims, type ClaimFinding } from "loopsoar-core/claims";
import { SteerBus } from "loopsoar-core/steerBus";
import type { ToolRegistry } from "loopsoar-core/tools/registry";
import type { SandboxManager, PermissionKind } from "loopsoar-core/sandbox";
import {
  decisionFor,
  categoryForToolPermissions,
  type Permissions,
} from "loopsoar-core/permissions";
import { StreamChunkBatcher } from "./events.js";
import type { ChunkBatch, ChunkItem } from "./events.js";

/** Agent 身份（身份铁律的稳定段来源）。 */
export interface ChatAgent {
  name: string;
  role: string;
}

/** 事件类型（与 core LoopEvent.type 对齐；shell 按此映射到 chat:stream:<type>）。 */
export type ChatEventType =
  | "chunk"
  | "reasoning"
  | "tool"
  | "progress"
  | "done"
  | "error"
  | "heartbeat";

export interface ChatServiceOptions {
  /** 未注入时 stream 返回可读错误（不崩溃）——装配层负责注入。 */
  llm?: LlmClient;
  platform?: LoopsoarPlatform;
  registry?: ToolRegistry;
  sandbox?: SandboxManager;
  /** Agent 工具白名单（undefined=全部；[]=全禁；非空=仅名单内；先于沙箱判定）。 */
  toolAllowlist?: string[];
  /** 规则文件注入（AGENTS.md 合并文本）；每次 stream 时调用，保存规则后即时生效。 */
  getSystemRules?: () => string;
  /** 记忆召回注入（按用户消息取相关记忆，放进 volatile 段）。 */
  getMemoryFor?: (userText: string) => string;
  /** 权限策略（设置 · 权限）；每次工具调用前读取，保存后即时生效。 */
  permissionPolicy?: () => Permissions;
  /** 惰性获取 LLM 客户端（设置面板保存供应商后立即生效，无需重启）。 */
  getLlm?: () => LlmClient | undefined;
  /** 按模式解析工具白名单（plan=只读，build=默认 Agent 白名单）。 */
  getToolAllowlist?: (mode?: "build" | "plan") => string[] | undefined;
  /** 权限确认请求回调（壳层推送到渲染层弹窗）。 */
  onPermissionRequest?: (request: PermissionRequestEvent) => void;
  agent?: ChatAgent;
  /** 权限确认超时（默认 300s，超时按拒绝）。 */
  permTimeoutMs?: number;
}

export interface ChatInput {
  message: string;
  sessionId?: string;
  /** build=允许执行工具；plan=只读规划。 */
  mode?: "build" | "plan";
}

/** 权限确认请求（浮层 UI 据此弹窗；requestId 用于 resolvePermission 结算）。 */
export interface PermissionRequestEvent {
  requestId: string;
  toolName: string;
  target?: string;
  kind?: string;
}

export interface ChatStreamResult {
  status: LoopRunStatus;
  reason: string;
  finalText: string;
  usage: { rounds: number; toolCalls: number; totalTokens: number; wallClockMs: number };
  chunks: ChunkBatch[];
  /** 声称核验发现（仅列出 exists=false 的可疑声称）。 */
  claims: ClaimFinding[];
}

type LoopRunStatus = ToolLoopOutcome["status"];

/**
 * 权限请求总线：挂起式确认。
 * 为什么挂起：confirm 语义就是「等用户点」；超时按 deny 是 fail-closed 的必然选择。
 */
export class PermRequestBus {
  private pending = new Map<
    string,
    {
      resolve: (r: { choice: "allow-once" | "allow-session" | "deny"; customReason?: string }) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private timeoutMs = 300_000) {}

  request(decision: { requestId: string; toolName: string; target?: string }): Promise<{
    choice: "allow-once" | "allow-session" | "deny";
    customReason?: string;
  }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(decision.requestId);
        resolve({ choice: "deny", customReason: `确认超时（${this.timeoutMs}ms），按拒绝结算` });
      }, this.timeoutMs);
      this.pending.set(decision.requestId, { resolve, timer });
    });
  }

  /** 结算某请求（由 shell 的 perm:respond 调用）。 */
  resolve(requestId: string, choice: "allow-once" | "allow-session" | "deny", customReason?: string): boolean {
    const req = this.pending.get(requestId);
    if (!req) return false;
    clearTimeout(req.timer);
    this.pending.delete(requestId);
    req.resolve({ choice, customReason });
    return true;
  }

  /** 清理全部挂起请求（会话终止/应用退出）。 */
  clearAll(): void {
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.resolve({ choice: "deny", customReason: "会话终止，按拒绝结算" });
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

/** 由工具权限声明推导沙箱 kind（终端/网络优先，写次之，其余读）。 */
function kindOfTool(permissions: Record<string, unknown> | undefined): PermissionKind {
  if (!permissions) return "read";
  if (permissions.terminal) return "terminal";
  if (permissions.network) return "network";
  if (permissions.write) return "write";
  return "read";
}

/** 工具执行器：权限判定 → 执行（allow）/ 挂起确认（confirm）/ 拒绝（deny）。 */
export class InternalToolExecutor {
  constructor(
    private opts: {
      registry?: ToolRegistry;
      sandbox?: SandboxManager;
      /** Agent 工具白名单：执行器第一道闸（fail-closed，先于沙箱）。 */
      toolAllowlist?: string[];
      /** 权限策略（类别默认决策）：第二道闸，先于沙箱。 */
      permissionPolicy?: () => Permissions;
      /** 确认请求回调（弹窗 UI）。 */
      onPermissionRequest?: (request: PermissionRequestEvent) => void;
      permBus: PermRequestBus;
      platform?: LoopsoarPlatform;
      agentId: string;
      sessionId: string;
    },
  ) {}

  async invoke(toolCall: ToolCall): Promise<{ ok: boolean; content: string; error?: string }> {
    const { registry, sandbox, permBus, toolAllowlist } = this.opts;
    // Agent 权限先于沙箱判定：不同 Agent 的能力边界在这里收敛（不允许「白名单外的工具先跑到沙箱再被兜底」）
    if (toolAllowlist !== undefined && !toolAllowlist.includes(toolCall.name)) {
      return {
        ok: false,
        content: `[错误] Agent 权限未包含工具 ${toolCall.name}（白名单拦截）`,
        error: "agent-tool-denied",
      };
    }
    if (!registry || !sandbox) {
      // 装配不完整 → fail-closed（不猜权限）
      return { ok: false, content: "[错误] 工具执行器未装配（registry/sandbox 缺失）", error: "not-assembled" };
    }
    const tool = registry.get(toolCall.name);
    const kind = kindOfTool(tool?.permissions as Record<string, unknown> | undefined);

    // 第二道闸：用户权限策略（按类别）。allow 直接放行（沙箱硬规则仍会兜底 deny）；
    // confirm 走确认总线；deny 直接拒绝。
    const policy = this.opts.permissionPolicy?.();
    const category = categoryForToolPermissions(tool?.permissions as Record<string, unknown> | undefined);
    const policyDecision = policy ? decisionFor(policy, category) : null;
    if (policyDecision === "deny") {
      return { ok: false, content: `[错误] 权限设置拒绝该类别工具（${category}）`, error: "policy-denied" };
    }
    const target = typeof (toolCall.args as { path?: unknown })?.path === "string"
      ? String((toolCall.args as { path?: unknown }).path)
      : undefined;

    const decision = sandbox.checkPermission({
      agentId: this.opts.agentId,
      toolName: toolCall.name,
      target,
      kind,
    });

    if (decision.action === "deny") {
      return { ok: false, content: `[错误] 权限拒绝：${decision.reason}`, error: decision.reason };
    }
    // 沙箱要确认，或策略要求确认 → 统一走一次确认（策略 allow 时跳过沙箱的 confirm）
    if (decision.action === "confirm" && policyDecision !== "allow") {
      const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // 推送到渲染层弹窗（用户点允许/拒绝 → perm:respond → resolvePermission）
      this.opts.onPermissionRequest?.({ requestId, toolName: toolCall.name, target, kind });
      const result = await permBus.request({ requestId, toolName: toolCall.name, target });
      if (result.choice === "deny") {
        return { ok: false, content: `[错误] 确认被拒绝：${result.customReason ?? "用户拒绝"}`, error: "denied" };
      }
      if (result.choice === "allow-session") sandbox.approveToolForSession(this.opts.agentId, toolCall.name);
    }
    if (!tool) {
      return { ok: false, content: `[错误] 未知工具 ${toolCall.name}（不在注册表）`, error: "unknown-tool" };
    }
    const result = await tool.execute({
      agentId: this.opts.agentId,
      sessionId: this.opts.sessionId,
      platform: this.opts.platform as never,
      params: toolCall.args,
    });
    return { ok: result.ok, content: result.content, error: result.error };
  }
}

/**
 * ChatService：流式编排核心。
 * 事件以 ChunkItem 形式交给 sink（meta.type = chunk/reasoning/tool/progress/done/error/heartbeat），
 * shell 层据此映射到 chat:stream:<type> 推送；batcher 负责 40ms/24000 字合批。
 */
export class ChatService {
  private permBus: PermRequestBus;
  private aborts = new Map<string, AbortController>();

  constructor(private opts: ChatServiceOptions = {}) {
    this.permBus = new PermRequestBus(opts.permTimeoutMs ?? 300_000);
  }

  /** 供 shell 的 perm:respond 调用。 */
  resolvePermission(requestId: string, choice: "allow-once" | "allow-session" | "deny", customReason?: string): boolean {
    return this.permBus.resolve(requestId, choice, customReason);
  }

  /** 停止某会话的进行中流（abort 后工具轮以 aborted 收束）。 */
  stop(sessionId: string): boolean {
    const controller = this.aborts.get(sessionId);
    if (!controller) return false;
    controller.abort();
    this.aborts.delete(sessionId);
    return true;
  }

  /** 主入口：流式对话。 */
  async stream(input: ChatInput, sink?: (item: ChunkItem) => void): Promise<ChatStreamResult> {
    const { platform, registry, sandbox, agent } = this.opts;
    // 惰性 LLM：设置面板保存供应商后可立即生效（无需重启）
    const llm = this.opts.getLlm?.() ?? this.opts.llm;
    const sessionId = input.sessionId ?? `sess-${Date.now()}`;
    const chunks: ChunkBatch[] = [];
    const batcher = new StreamChunkBatcher((batch) => {
      chunks.push(batch);
      if (sink) for (const c of batch.chunks) sink(c);
    });

    const emit = (type: ChatEventType, data: unknown): void => {
      // chunk/reasoning 的 LoopEvent.data 形如 { text }：取纯文本推出（否则 UI 会显示 JSON 片段）
      let content: string;
      if (type === "chunk" || type === "reasoning") {
        const text = (data as { text?: unknown } | null)?.text;
        content = typeof text === "string" ? text : typeof data === "string" ? data : JSON.stringify(data);
      } else {
        content = typeof data === "string" ? data : JSON.stringify(data);
      }
      batcher.push({ content, meta: { type } });
    };

    if (!llm) {
      const reason = "LLM 未配置：装配层未注入 LlmClient（P1 接线）";
      emit("error", { message: reason });
      batcher.flushNow();
      batcher.close();
      return {
        status: "error",
        reason,
        finalText: "",
        usage: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
        chunks,
        claims: [],
      };
    }

    // 稳定/易变分段：stable 进 system，volatile 挂末段 user（保 KV 前缀缓存，ADR/前期准备铁律）
    const segments = buildSystemSegments({
      name: agent?.name ?? "Loopsoar",
      role: agent?.role ?? "本地 AI Agent",
      volatile: "",
    });
    // 规则文件（AGENTS.md）作为稳定段的补充：每次调用重新取，设置面板保存后即时生效
    const rulesText = this.opts.getSystemRules?.() ?? "";
    const stableContent = rulesText.trim()
      ? `${segments.stable}\n\n${rulesText}`
      : segments.stable;
    const messages = [
      { role: "system" as const, content: stableContent },
      { role: "user" as const, content: `${input.message}\n\n${segments.volatile}` },
    ];

    const controller = new AbortController();
    this.aborts.set(sessionId, controller);

    const resolvedAllowlist = this.opts.getToolAllowlist?.(input.mode) ?? this.opts.toolAllowlist;
    const executor = new InternalToolExecutor({
      registry,
      sandbox,
      toolAllowlist: resolvedAllowlist,
      onPermissionRequest: this.opts.onPermissionRequest,
      permissionPolicy: this.opts.permissionPolicy,
      permBus: this.permBus,
      platform,
      agentId: agent?.name ?? "loopsoar",
      sessionId,
    });

    let outcome: LoopRunStatus = "error";
    let reason = "引擎未运行";
    let finalText = "";
    let usage = { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 };
    let claims: ClaimFinding[] = [];

    try {
      const toolList = registry
        ? registry.toolSchemas().map((s) => ({
            name: s.function.name,
            description: s.function.description,
            parameters: s.function.parameters,
          }))
        : [];

      const loopOutcome = await runToolLoop({
        llm,
        tools: () => toolList,
        executeTool: executor,
        limits: {},
        budget: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
        sink: (event) => {
          // LoopEvent → ChatEventType（type 同名，data 原样传递）
          emit(event.type as ChatEventType, event.data);
        },
        steers: new SteerBus(),
        signal: controller.signal,
      });

      outcome = loopOutcome.status;
      reason = loopOutcome.reason;
      finalText = loopOutcome.finalText;
      usage = loopOutcome.usage;

      // 声称核验：只报告「声称存在但实际不存在」的可疑项
      if (platform && finalText) {
        try {
          const findings = await auditClaims(finalText, (p) => platform.fs.exists(p));
          claims = findings.filter((f) => f.verified && !f.exists && f.reason !== "跳过 URL/域名残片");
        } catch (err) {
          emit("progress", { note: `声称核验异常（已跳过）：${err instanceof Error ? err.message : String(err)}` });
        }
      }
    } catch (err) {
      reason = `编排异常：${err instanceof Error ? err.message : String(err)}`;
      emit("error", { message: reason });
    } finally {
      this.aborts.delete(sessionId);
      emit("done", { status: outcome, reason, finalText, usage, claims });
      batcher.flushNow();
      batcher.close();
    }

    return { status: outcome, reason, finalText, usage, chunks, claims };
  }

  /** 当前挂起确认数（界面状态条/测试用）。 */
  pendingPermissionCount(): number {
    return this.permBus.size;
  }
}
