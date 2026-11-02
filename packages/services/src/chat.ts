// §5 services 包 / ChatService 流式编排（T3 真接线）
// 流程：buildSystemSegments → runToolLoop（真引擎：四闸/心跳/转向）→ 每轮声称核验 → 事件归一
// 权限：InternalToolExecutor 内做 类别策略 → 敏感步骤写死确认 → sandbox.checkPermission；
//       confirm/deny 走 PermRequestBus（挂起 + 超时按拒绝）
// 设计：services 不 import electron；全部能力经注入（llm/platform/registry/sandbox）。
import type { LlmClient } from "loopsoar-core/llm";
import type { LoopsoarPlatform } from "loopsoar-core/platform";
import { buildSystemSegments } from "loopsoar-core/session";
import {
  runToolLoop,
  type ToolCall,
  type ToolLoopOpts,
  type ToolLoopOutcome,
} from "loopsoar-core/tool_loop";
import { auditClaims, type ClaimFinding } from "loopsoar-core/claims";
import { applyOutputFilter, createStreamFilter } from "loopsoar-core/filter";
import type { LoopEvent } from "loopsoar-core/events";
import { SteerBus } from "loopsoar-core/steerBus";
import { compressConversation, historyBudgetChars } from "loopsoar-core/contextCompress";
import type { ToolRegistry } from "loopsoar-core/tools/registry";
import type { SandboxManager, PermissionKind } from "loopsoar-core/sandbox";
import {
  decisionFor,
  categoryForToolPermissions,
  type Permissions,
} from "loopsoar-core/permissions";
import { classifySensitiveStep } from "loopsoar-core/sensitiveSteps";
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
  | "tool_start"
  | "progress"
  | "done"
  | "error"
  | "heartbeat";

/**
 * Agent-Loop 注入签名：入参与 runToolLoop 一致（含事件 sink），额外带 sessionId 供 loop
 * 运行时/安全模式回退使用；壳层用 LoopRegistry 包装成该签名（见 shell/loopRuntime.ts）。
 */
export type ChatLoopRunner = (input: ToolLoopOpts & { sessionId: string }) => Promise<ToolLoopOutcome>;

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
  /** 技能注入（与扩展/MCP 隔离：仅 SKILL.md 文本，不提供工具）。 */
  getSkillPrompt?: (userText: string) => string;
  /** 权限策略（设置 · 权限）；每次工具调用前读取，保存后即时生效。 */
  permissionPolicy?: () => Permissions;
  /** 当前会话的工作根目录（工作区 / worktree）；作为每次工具权限判定的作用域根（不修改沙箱全局根）。 */
  resolveWorkspaceRoot?: (sessionId?: string) => string | undefined;
  /** 惰性获取 LLM 客户端（设置面板保存供应商后立即生效，无需重启）。 */
  getLlm?: (sessionId?: string) => LlmClient | undefined;
  /** 按模式解析工具白名单（plan=只读，build=默认 Agent 白名单）。 */
  getToolAllowlist?: (mode?: "build" | "plan") => string[] | undefined;
  /** 当前模型上下文窗口（tokens）；用于历史自动压缩预算（缺省 12 万字符）。 */
  getContextWindow?: () => number | undefined;
  /** Agent 循环上限（设置 · 通用可调；缺省使用 core 默认）。 */
  getAgentLimits?: () => {
    maxRounds?: number;
    maxToolCalls?: number;
    repeatToolWarnAt?: number;
    repeatToolStopAt?: number;
  };
  /** 会话历史（持久化消息，按时间正序）；缺省则单轮对话。 */
  getHistory?: (sessionId: string) => { role: "user" | "assistant"; content: string }[];
  /** 权限确认请求回调（壳层推送到渲染层弹窗）。 */
  onPermissionRequest?: (request: PermissionRequestEvent) => void;
  agent?: ChatAgent;
  /** 权限确认超时（默认 300s，超时按拒绝）。 */
  permTimeoutMs?: number;
  /**
   * 敏感步骤（登录 / 支付 / 不可撤销操作）是否**写死确认**：默认 true。
   * 为什么是「写死」：类别策略（设置·权限）是长期授权，这类动作一旦误触发不可撤销，
   * 必须每次单独确认，不能被 allow 或「本次会话总是允许」绕过。
   * 返回 false 仅用于调试/兼容旧行为；生产装配应保持默认值。
   */
  sensitiveAlwaysConfirm?: () => boolean;
  /**
   * Agent-Loop 运行器（shell 注入 LoopRegistry.run）：有则替代直接 runToolLoop，
   * 让「可插拔 loop + 安全模式回退」生效；缺省退回内置 runToolLoop（行为不变）。
   */
  runLoop?: ChatLoopRunner;
  /**
   * 输出过滤（身份边界，默认 true）：chunk 文本跨 chunk 掩码模型自称，finalText 整体再过滤一次。
   * 关闭仅用于调试/内部对比，生产应保持开启。
   */
  filterOutput?: boolean;
}

export interface ChatInput {
  message: string;
  sessionId?: string;
  /** build=允许执行工具；plan=只读规划。 */
  mode?: "build" | "plan";
  /** 推理等级（模型声明支持时透传给厂商）。 */
  reasoningEffort?: string;
  /** 会话历史（持久化消息）；缺省则退化为单轮。 */
  getHistory?: (sessionId: string) => { role: "user" | "assistant"; content: string }[];
}

/** 权限确认请求（浮层 UI 据此弹窗；requestId 用于 resolvePermission 结算）。 */
export interface PermissionRequestEvent {
  requestId: string;
  toolName: string;
  target?: string;
  kind?: string;
  /** 敏感步骤类别（login/payment/irreversible）；普通确认缺省。 */
  category?: string;
  /** 人读原因（敏感步骤时为「敏感步骤：登录/账号（…）」）；普通确认缺省。 */
  reason?: string;
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

  request(decision: { requestId: string; toolName: string; target?: string; reason?: string }): Promise<{
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
      /** 当前会话的工作根目录（工作区/ worktree）；作为本次权限判定的作用域根（不回写沙箱全局根）。 */
      resolveWorkspaceRoot?: (sessionId?: string) => string | undefined;
      /** 敏感步骤写死确认开关（默认 true；仅调试/兼容旧行为可关）。 */
      sensitiveAlwaysConfirm?: () => boolean;
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

    // 敏感步骤闸（登录 / 支付 / 不可撤销）：位置在「类别策略」之后、「沙箱」之前。
    // 为什么在这：类别策略是长期授权，而敏感动作必须每次单独确认；deny 仍然优先（下一段先返回），
    // 敏感判定只把「allow / 跳过确认」升级成 confirm，绝不把 deny 降级成 confirm。
    const sensitive = classifySensitiveStep({ toolName: toolCall.name, params: toolCall.args });
    const forceSensitiveConfirm = sensitive.sensitive && (this.opts.sensitiveAlwaysConfirm?.() ?? true);

    // 按会话解析工作根：作为「本次判定」的作用域（不修改沙箱全局根）
    // —— 并发/后台会话各自用自己的根判定，不会互相把沙箱根改串。
    const sessionRoot = this.opts.resolveWorkspaceRoot?.(this.opts.sessionId);
    const decision = sandbox.checkPermission(
      {
        agentId: this.opts.agentId,
        toolName: toolCall.name,
        target,
        kind,
      },
      sessionRoot ? { workspaceRoot: sessionRoot } : undefined,
    );

    if (decision.action === "deny") {
      return { ok: false, content: `[错误] 权限拒绝：${decision.reason}`, error: decision.reason };
    }
    // 需要确认的三种来源：①敏感步骤写死确认（策略 allow 也要问）②沙箱 confirm（策略非 allow 时）③策略 confirm
    const needsConfirm = forceSensitiveConfirm || (decision.action === "confirm" && policyDecision !== "allow");
    if (needsConfirm) {
      const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const reason = forceSensitiveConfirm ? sensitive.reason : undefined;
      // 推送到渲染层弹窗（用户点允许/拒绝 → perm:respond → resolvePermission）
      this.opts.onPermissionRequest?.({
        requestId,
        toolName: toolCall.name,
        target,
        kind,
        ...(sensitive.sensitive && sensitive.category ? { category: sensitive.category } : {}),
        ...(reason ? { reason } : {}),
      });
      const result = await permBus.request({ requestId, toolName: toolCall.name, target, reason });
      if (result.choice === "deny") {
        return {
          ok: false,
          content: `[错误] 确认被拒绝：${result.customReason ?? "用户拒绝"}${reason ? `（${reason}）` : ""}`,
          error: "denied",
        };
      }
      // 敏感步骤**不写会话白名单**：allow-session 对敏感动作降级为 allow-once，下一次仍须单独确认。
      if (result.choice === "allow-session" && !forceSensitiveConfirm) {
        sandbox.approveToolForSession(this.opts.agentId, toolCall.name);
      }
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
  /** sessionId → 当前运行中的转向总线（steer 注入用） */
  private steerBuses = new Map<string, SteerBus>();
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
      this.steerBuses.delete(sessionId);
    return true;
  }

  /** 主入口：流式对话。 */
  async stream(input: ChatInput, sink?: (item: ChunkItem) => void): Promise<ChatStreamResult> {
    const { platform, registry, sandbox, agent } = this.opts;
    // 惰性 LLM：设置面板保存供应商后可立即生效（无需重启）
    const sessionId = input.sessionId ?? `sess-${Date.now()}`;
    // 传入 sessionId：供应商请求头模板里的 {{sessionId}} 按当前会话渲染
    const llm = this.opts.getLlm?.(sessionId) ?? this.opts.llm;
    const chunks: ChunkBatch[] = [];
    const batcher = new StreamChunkBatcher((batch) => {
      chunks.push(batch);
      if (sink) for (const c of batch.chunks) sink(c);
    });
    // 输出过滤（身份边界）：正文与推理各一条流式过滤器（两条流交错，不能共用缓冲）。
    // 默认开启；createStreamFilter 会保留尾部 20 字符等待跨 chunk 匹配完成。
    const filterEnabled = this.opts.filterOutput !== false;
    const textFilter = createStreamFilter();
    const reasoningFilter = createStreamFilter();

    const emit = (type: ChatEventType, data: unknown): void => {
      // chunk/reasoning 的 LoopEvent.data 形如 { text }：取纯文本推出（否则 UI 会显示 JSON 片段）
      let content: string;
      if (type === "chunk" || type === "reasoning") {
        const text = (data as { text?: unknown } | null)?.text;
        const raw = typeof text === "string" ? text : typeof data === "string" ? data : JSON.stringify(data);
        content = filterEnabled ? (type === "chunk" ? textFilter.push(raw) : reasoningFilter.push(raw)) : raw;
        // 过滤后为空 = 本批全在跨 chunk 缓冲里：先不推空内容，收尾 flush 时再补（避免 UI 出现空块）
        if (filterEnabled && content.length === 0) return;
      } else {
        content = typeof data === "string" ? data : JSON.stringify(data);
      }
      batcher.push({ content, meta: { type } });
    };

    if (!llm) {
      const reason = "LLM 未配置：请在「设置 · 供应商」填写配置，并设置环境变量 LOOPSOAR_API_KEY 后重启";
      emit("error", reason);
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
    // 记忆召回 + 技能注入：都放 volatile 段（不进稳定前缀，避免破坏 KV 缓存）
    const memoryText = this.opts.getMemoryFor?.(input.message) ?? "";
    const skillText = this.opts.getSkillPrompt?.(input.message) ?? "";
    const volatileContent = [segments.volatile, memoryText, skillText].filter((t) => t.trim()).join("\n\n");
    const rawHistory = (this.opts.getHistory?.(sessionId) ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    // 上下文自动压缩：超预算时把早期消息压成确定性摘要（不额外请求模型，避免"失忆截断"）
    const compression = compressConversation(rawHistory, {
      budgetChars: historyBudgetChars(this.opts.getContextWindow?.()),
    });
    if (compression.compressed) {
      emit("progress", {
        note: compression.summary,
        compressed: true,
        dropped: compression.droppedCount,
        beforeChars: compression.beforeChars,
        afterChars: compression.afterChars,
      });
    }
    const messages = [
      { role: "system" as const, content: stableContent },
      ...compression.messages,
      { role: "user" as const, content: `${input.message}\n\n${volatileContent}` },
    ];

    const controller = new AbortController();
    this.aborts.set(sessionId, controller);
    const steers = new SteerBus();
    this.steerBuses.set(sessionId, steers);

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
      resolveWorkspaceRoot: this.opts.resolveWorkspaceRoot,
      sensitiveAlwaysConfirm: this.opts.sensitiveAlwaysConfirm,
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

      const agentLimits = this.opts.getAgentLimits?.() ?? {};

      // 每轮声称核验：可疑声称（「已保存/已生成…」但文件不存在）且整段没用过工具 → ok=false，
      // tool_loop 会注入强制工具轮逼模型实际核实。为什么用 usedAnyTool 门控：已经用过工具说明
      // 模型有动手能力，避免对「工具执行后自然语言总结」的误伤（存在性仍由最终核验兜底）。
      const verifyRound = platform
        ? async (info: { round: number; finalText: string; usedAnyTool: boolean }): Promise<{ ok: boolean; note?: string }> => {
            try {
              const findings = await auditClaims(info.finalText, (p) => platform.fs.exists(p));
              const suspicious = findings.filter(
                (f) => f.verified && !f.exists && f.reason !== "跳过 URL/域名残片",
              );
              if (suspicious.length === 0 || info.usedAnyTool) return { ok: true };
              const paths = suspicious
                .slice(0, 3)
                .map((f) => f.path)
                .join("、");
              return { ok: false, note: `第 ${info.round} 轮声称的文件不存在：${paths}` };
            } catch (err) {
              emit("progress", {
                note: `声称核验异常（本轮已跳过）：${err instanceof Error ? err.message : String(err)}`,
              });
              return { ok: true };
            }
          }
        : undefined;

      const loopInput = {
        llm,
        tools: () => toolList,
        executeTool: executor,
        limits: {
          maxRounds: agentLimits.maxRounds,
          maxToolCalls: agentLimits.maxToolCalls,
        },
        repeatToolWarnAt: agentLimits.repeatToolWarnAt,
        repeatToolStopAt: agentLimits.repeatToolStopAt,
        budget: { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
        sink: (event: LoopEvent) => {
          // LoopEvent → ChatEventType（type 同名，data 原样传递）
          emit(event.type as ChatEventType, event.data);
        },
        messages,
        reasoningEffort: input.reasoningEffort,
        steers,
        signal: controller.signal,
        verifyRound,
      } satisfies ToolLoopOpts;
      // Agent-Loop 注入（ADR-0010）：有 runner 走 LoopRegistry（可插拔 + 安全回退），否则内置循环
      const loopOutcome = this.opts.runLoop
        ? await this.opts.runLoop({ ...loopInput, sessionId })
        : await runToolLoop(loopInput);

      outcome = loopOutcome.status;
      reason = loopOutcome.reason;
      finalText = loopOutcome.finalText;
      // 输出过滤（身份边界）：finalText 整体再过滤一次（流式过滤可能因分批而漏边，这里是最终防线）
      if (filterEnabled && finalText) finalText = applyOutputFilter(finalText);
      // 空正文兜底：任何非正常收束都必须给出可读原因（配合 UI 的中断横幅，避免"莫名空白"）
      if (!finalText.trim()) {
        finalText = outcome === "done" ? "（模型没有返回文本内容）" : `（任务未完成：${reason}）`;
      }
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
      emit("error", reason);
    } finally {
      this.aborts.delete(sessionId);
      // 收尾：把流式过滤器里跨 chunk 缓冲的尾部（<20 字符）补发，否则最后一段正文会丢
      if (filterEnabled) {
        const textTail = textFilter.flush();
        if (textTail) batcher.push({ content: textTail, meta: { type: "chunk" } });
        const reasoningTail = reasoningFilter.flush();
        if (reasoningTail) batcher.push({ content: reasoningTail, meta: { type: "reasoning" } });
      }
      emit("done", { status: outcome, reason, finalText, usage, claims });
      batcher.flushNow();
      batcher.close();
    }

    return { status: outcome, reason, finalText, usage, chunks, claims };
  }

  /** 注入转向提示：运行中在下一轮边界生效；无运行中会话返回 false。 */
  steer(sessionId: string | undefined, text: string): boolean {
    // 未指定会话时：若只有一个运行中的会话，默认注入到它（UI 通常只有一个活动流）
    const fallbackId = this.steerBuses.size === 1 ? [...this.steerBuses.keys()][0] : undefined;
    const id = sessionId && this.steerBuses.has(sessionId) ? sessionId : (fallbackId ?? "");
    const bus = id ? this.steerBuses.get(id) : undefined;
    if (!bus || !text.trim()) return false;
    bus.push(text.trim());
    return true;
  }

  /** 当前挂起确认数（界面状态条/测试用）。 */
  pendingPermissionCount(): number {
    return this.permBus.size;
  }
}
