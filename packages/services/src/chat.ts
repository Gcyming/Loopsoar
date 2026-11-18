// §5 services 包 / ChatService 流式编排（T3 真接线）
// 流程：buildSystemSegments → runToolLoop（真引擎：四闸/心跳/转向）→ 每轮声称核验 → 事件归一
// 权限：InternalToolExecutor 内做 类别策略 → 敏感步骤写死确认 → sandbox.checkPermission；
//       confirm/deny 走 PermRequestBus（挂起 + 超时按拒绝）
// 设计：services 不 import electron；全部能力经注入（llm/platform/registry/sandbox）。
import type { LlmClient } from "loopsoar-core/llm";
import type { LoopsoarPlatform } from "loopsoar-core/platform";
import { buildSystemSegments } from "loopsoar-core/session";
import { currentWallClockLine, withWallClockPrefix } from "loopsoar-core/messageTime";
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

/** 事件类型（与 core LoopEvent.type 对齐；shell 按此映射到 chat:stream:<type>，steer 走专用事件）。 */
export type ChatEventType =
  | "chunk"
  | "reasoning"
  | "tool"
  | "tool_start"
  | "steer"
  | "progress"
  | "done"
  | "error"
  | "heartbeat";

/** 引导投递结果（与契约 ChatSteerResultSchema 对齐）。 */
export interface SteerDeliveryResult {
  accepted: boolean;
  steerId: string;
  reason?: "no-running" | "full" | "empty" | "duplicate";
}

/**
 * Agent-Loop 注入签名：入参与 runToolLoop 一致（含事件 sink），额外带 sessionId 供 loop
 * 运行时/安全模式回退使用；壳层用 LoopRegistry 包装成该签名（见 shell/loopRuntime.ts）。
 */
export type ChatLoopRunner = (input: ToolLoopOpts & { sessionId: string }) => Promise<ToolLoopOutcome>;

export interface ToolGuardInput {
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
  kind?: string;
  target?: string;
  workspaceRoot?: string;
}

export interface ToolGuardOutput {
  action: "allow" | "deny";
  reason?: string;
}

export type ToolGuardHook = (input: ToolGuardInput) => ToolGuardOutput | null | undefined;

export interface ChatServiceOptions {
  /** 未注入时 stream 返回可读错误（不崩溃）——装配层负责注入。 */
  llm?: LlmClient;
  platform?: LoopsoarPlatform;
  registry?: ToolRegistry;
  sandbox?: SandboxManager;
  /** Agent 工具白名单（undefined=全部；[]=全禁；非空=仅名单内；先于沙箱判定）。 */
  toolAllowlist?: string[];
  /** 规则文件注入（AGENTS.md 合并文本）；每次 stream 时调用，保存规则后即时生效。 */
  getSystemRules?: (sessionId?: string) => string;
  /** 规则守卫：工具执行前调用；返回 deny 时直接拒绝（规则编译成权限边界）。 */
  guardToolCall?: ToolGuardHook;
  /** 记忆召回注入（按用户消息取相关记忆，放进 volatile 段）。 */
  getMemoryFor?: (userText: string, sessionId?: string) => string;
  /** 每次工具调用（E-M1）：用于记录 tool/session 使用事件，不改变循环行为。 */
  onToolCall?: (toolName: string, sessionId: string) => void;
  /** 每次工具结果（成功/失败）：用于把失败证据写进记忆；不改变循环行为。 */
  onToolResult?: (input: {
    toolName: string;
    sessionId: string;
    ok: boolean;
    error?: string;
    args?: Record<string, unknown>;
  }) => void;
  /** 技能注入（与扩展/MCP 隔离：仅 SKILL.md 文本，不提供工具）。 */
  getSkillPrompt?: (userText: string) => string;
  /** 扩展声明式指令（仅已启用扩展）；放 volatile 段，不提供工具/代码执行。 */
  getExtensionPrompt?: (sessionId?: string) => string;
  /** 权限策略（设置 · 权限）；每次工具调用前读取，保存后即时生效。 */
  permissionPolicy?: () => Permissions;
  /** 当前会话的工作根目录（工作区 / worktree）；作为每次工具权限判定的作用域根（不修改沙箱全局根）。 */
  resolveWorkspaceRoot?: (sessionId?: string) => string | undefined;
  /** 惰性获取 LLM 客户端（设置面板保存供应商后立即生效，无需重启）。 */
  getLlm?: (sessionId?: string) => LlmClient | undefined;
  /**
   * 按模式 + 会话解析工具白名单（plan=只读，build=默认 Agent 白名单）。
   * 为什么要 sessionId：会话级开关（如「浏览器控制」关闭）只能按会话收窄工具面；
   * 返回值同时用于模型可见面（registry.toolSchemas）与执行闸，undefined 才表示「全部可见」。
   */
  getToolAllowlist?: (mode?: "build" | "plan", sessionId?: string) => string[] | undefined;
  /** 当前模型上下文窗口（tokens）；用于历史自动压缩预算（缺省 6 万字符）。 */
  getContextWindow?: () => number | undefined;
  /** Agent 循环上限（设置 · 通用可调；缺省使用 core 默认）。 */
  getAgentLimits?: () => {
    maxRounds?: number;
    maxToolCalls?: number;
    repeatToolWarnAt?: number;
    repeatToolStopAt?: number;
  };
  /** 会话历史（持久化消息，按时间正序）；缺省则单轮对话。 */
  getHistory?: (sessionId: string) => { role: "user" | "assistant"; content: string; ts?: number }[];
  /**
   * 读取图片附件（当前用户轮的 `【附件】<path>`）：返回 base64 供多模态消息使用。
   * 由壳层注入（扩展名白名单 + 6MB 上限在 imageRead 内）；services 不直接碰 fs。
   */
  readImageAttachment?: (path: string) => { mime: string; base64: string } | null;
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
  getHistory?: (sessionId: string) => { role: "user" | "assistant"; content: string; ts?: number }[];
  /** 内部取消信号（子代理超时等）；不来自 IPC，避免渲染层注入。 */
  signal?: AbortSignal;
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

/**
 * 由工具权限声明推导**沙箱** kind（终端优先，browser/网络并列其次，写再次，其余读）。
 *
 * 为什么 browser 映射成 network：沙箱的 PermissionKind 只有 read/write/terminal/network 四档，
 * 与 L0–L5 形式化分级一一对应（tests/core/permissionLevels.spec.ts 有等式断言），不为策略概念扩档。
 * 浏览器动作在沙箱层就是 L4 网络访问；「浏览器操作」是更细的**策略**档，由
 * categoryForToolPermissions 判定 —— 即「策略按 browser 档、沙箱按 network 级」，两层各管各的。
 */
function kindOfTool(permissions: Record<string, unknown> | undefined): PermissionKind {
  if (!permissions) return "read";
  if (permissions.terminal) return "terminal";
  if (permissions.browser) return "network";
  if (permissions.network) return "network";
  if (permissions.write) return "write";
  return "read";
}

/**
 * 解析「模型可见工具面」（装配层用的纯函数；抽出来是为了脱离 electron 单测）。
 *
 * 规则：
 *   · exclude 为空 → 原样返回 base（undefined 仍表示「全部可见」）；
 *   · base === undefined（= 全部可见）→ 以 allNames（注册表名字全集）为基剔除。
 *     这里绝不能直接返回 undefined：那会把被剔除的工具又放回模型可见面（审计 P0-1 的同一个坑）；
 *   · base 非 undefined → 从 base 中剔除。
 */
export function resolveToolSurface(options: {
  base: readonly string[] | undefined;
  allNames: readonly string[];
  exclude: readonly string[];
}): string[] | undefined {
  const { base, allNames, exclude } = options;
  if (exclude.length === 0) return base === undefined ? undefined : [...base];
  const drop = new Set(exclude);
  if (base === undefined) return allNames.filter((name) => !drop.has(name));
  return base.filter((name) => !drop.has(name));
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
      /** 规则守卫（按会话解析当前规则并编译）。 */
      guardToolCall?: ToolGuardHook;
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
    // 沙箱 target 按类别取不同参数：文件类看 path，终端类看 command（危险命令硬规则），
    // 网络/浏览器类不传（SSRF 由 net 层逐跳钉扎、浏览器走 browserRequestGuard）。
    // 旧实现只认 args.path → terminal_run 的命令串与 browser_* 的 url 全部取不到，
    // 越界判定与「危险命令」硬规则对真实调用空转（八步决策链②③形同注释）。
    const argOf = (key: string): string | undefined => {
      const value = (toolCall.args as Record<string, unknown> | undefined)?.[key];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };
    const target =
      kind === "terminal"
        ? (argOf("command") ?? argOf("cmd"))
        : kind === "write" || kind === "read"
          ? argOf("path")
          : undefined;

    // 敏感步骤闸（登录 / 支付 / 不可撤销）：位置在「类别策略」之后、「沙箱」之前。
    // 为什么在这：类别策略是长期授权，而敏感动作必须每次单独确认；deny 仍然优先（下一段先返回），
    // 敏感判定只把「allow / 跳过确认」升级成 confirm，绝不把 deny 降级成 confirm。
    // **这条依赖不许删**：browser 档默认 allow（会话「浏览器控制」开关=显式授权），
    // 下面这行 forceSensitiveConfirm 是 browser=allow 之后唯一还拦着「登录/支付/不可撤销」的闸门；
    // 删了它就等于 browser=allow 全放开。它也不受「本次会话总是允许」影响（allow-session 对敏感步骤降级为 allow-once）。
    const sensitive = classifySensitiveStep({ toolName: toolCall.name, params: toolCall.args });
    const forceSensitiveConfirm = sensitive.sensitive && (this.opts.sensitiveAlwaysConfirm?.() ?? true);

    // 按会话解析工作根：作为「本次判定」的作用域（不修改沙箱全局根）
    // —— 并发/后台会话各自用自己的根判定，不会互相把沙箱根改串。
    const sessionRoot = this.opts.resolveWorkspaceRoot?.(this.opts.sessionId);
    const decision = sandbox.checkPermission(
      {
        agentId: this.opts.agentId,
        sessionId: this.opts.sessionId,
        toolName: toolCall.name,
        target,
        kind,
      },
      sessionRoot ? { workspaceRoot: sessionRoot } : undefined,
    );

    if (decision.action === "deny") {
      return { ok: false, content: `[错误] 权限拒绝：${decision.reason}`, error: decision.reason };
    }
    // 规则守卫：沙箱明确拒绝已经返回；这里拦截「规则禁止但权限允许」的动作。
    const ruleGuard = this.opts.guardToolCall?.({
      toolName: toolCall.name,
      args: (toolCall.args ?? {}) as Record<string, unknown>,
      sessionId: this.opts.sessionId,
      kind,
      target,
      workspaceRoot: sessionRoot,
    });
    if (ruleGuard?.action === "deny") {
      return { ok: false, content: `[错误] 规则禁止：${ruleGuard.reason ?? "被规则拦截"}`, error: "rule-denied" };
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
        sandbox.approveToolForSession(this.opts.agentId, toolCall.name, this.opts.sessionId);
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
function imageAttachmentParts(
  text: string,
  read: ((path: string) => { mime: string; base64: string } | null) | undefined,
): { type: "image"; mime: string; base64: string }[] {
  if (!read) return [];
  const parts: { type: "image"; mime: string; base64: string }[] = [];
  const re = /【附件】([^\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const path = match[1]?.trim();
    if (!path) continue;
    const image = read(path);
    if (image) parts.push({ type: "image", mime: image.mime, base64: image.base64 });
  }
  return parts;
}

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

  /**
   * 子代理作用域运行（P1-5 第一步）：复用同一套 LLM/平台/规则/沙箱，但：
   *   · 工具面强制收窄到调用方给的 allowlist（只读工具）；
   *   · 历史隔离（不继承父会话，避免子代理被父上下文带偏）；
   *   · 独立 ChatService 实例，不污染父会话的 steer/abort 映射。
   * 只供壳层内部使用，不暴露 IPC。
   */
  async runScoped(input: ChatInput, allowlist: string[], signal?: AbortSignal): Promise<ChatStreamResult> {
    const scoped = new ChatService({
      ...this.opts,
      toolAllowlist: allowlist,
      getToolAllowlist: () => allowlist,
      getHistory: () => [],
    });
    return scoped.stream({ ...input, signal });
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

    // 最近一段流是正文还是推理：边界 flush 时按它决定先后，避免把交错的两种流顺序倒过来。
    let lastStreamKind: "chunk" | "reasoning" | null = null;
    const emit = (type: ChatEventType, data: unknown): void => {
      // chunk/reasoning 的 LoopEvent.data 形如 { text }：取纯文本推出（否则 UI 会显示 JSON 片段）
      let content: string;
      if (type === "chunk" || type === "reasoning") {
        const text = (data as { text?: unknown } | null)?.text;
        const raw = typeof text === "string" ? text : typeof data === "string" ? data : JSON.stringify(data);
        content = filterEnabled ? (type === "chunk" ? textFilter.push(raw) : reasoningFilter.push(raw)) : raw;
        // 过滤后为空 = 本批全在跨 chunk 缓冲里：先不推空内容，收尾 flush 时再补（避免 UI 出现空块）
        if (filterEnabled && content.length === 0) return;
        lastStreamKind = type;
      } else {
        // 非流式事件（工具/进度/警告）是这一小段输出结束的边界：
        // 先把正文/推理过滤器里的跨 chunk 尾巴推出去，否则它会迟到——被拼到下一个工具之后，
        // 表现为「思考内容东一句西一句、每段开头缺前半句」（用户 m03384 的截图）。
        if (filterEnabled && type !== "heartbeat") {
          // 按「最近一段流」的先后 flush：交错输出时不能把正文尾巴插到推理前面。
          const flushReasoning = (): void => {
            const tail = reasoningFilter.flush();
            if (tail) batcher.push({ content: tail, meta: { type: "reasoning" } });
          };
          const flushText = (): void => {
            const tail = textFilter.flush();
            if (tail) batcher.push({ content: tail, meta: { type: "chunk" } });
          };
          if (lastStreamKind === "chunk") {
            flushText();
            flushReasoning();
          } else {
            flushReasoning();
            flushText();
          }
          lastStreamKind = null;
        }
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
    const rulesText = this.opts.getSystemRules?.(sessionId) ?? "";
    const stableContent = rulesText.trim()
      ? `${segments.stable}\n\n${rulesText}`
      : segments.stable;
    // 记忆召回 + 技能注入：都放 volatile 段（不进稳定前缀，避免破坏 KV 缓存）
    const memoryText = this.opts.getMemoryFor?.(input.message, sessionId) ?? "";
    const skillText = this.opts.getSkillPrompt?.(input.message) ?? "";
    const extensionText = this.opts.getExtensionPrompt?.(sessionId) ?? "";
    // 当前墙钟时间放 volatile 段（每轮刷新、不进 stable 前缀，不破坏 KV 缓存）
    const requestNow = Date.now();
    const volatileContent = [currentWallClockLine(requestNow), segments.volatile, memoryText, skillText, extensionText]
      .filter((t) => t.trim())
      .join("\n\n");
    // 历史消息加模型可见时间戳（确定性前缀，同一历史每轮生成一致 → KV 前缀缓存不受影响）
    const rawHistory = (this.opts.getHistory?.(sessionId) ?? []).map((m) => ({
      role: m.role,
      content: withWallClockPrefix(m.content, m.ts),
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
      // 穷尽压缩策略仍超预算：明确提示，避免上游静默截断提示词后模型「忘事/答非所问」，
      // 用户却以为是回复被截断（m02515：所有截断都要可见、可定位）。
      if (compression.stillOverBudget) {
        emit("progress", {
          note: `历史仍超出模型上下文预算（压缩后 ${compression.afterChars} 字符），上游可能截断提示词；建议 /compact 压缩或新建会话`,
          contextOverBudget: true,
        });
      }
    }
    const userText = `${withWallClockPrefix(input.message, requestNow)}\n\n${volatileContent}`;
    const imageParts = imageAttachmentParts(input.message, this.opts.readImageAttachment);
    const messages = [
      { role: "system" as const, content: stableContent },
      ...compression.messages,
      {
        role: "user" as const,
        content: imageParts.length > 0
          ? [{ type: "text" as const, text: userText }, ...imageParts]
          : userText,
      },
    ];

    const controller = new AbortController();
    // signal 只接受真正的 AbortSignal（来自子代理超时）；IPC 传入的普通对象直接忽略，
    // 避免渲染层伪造 { signal: {} } 让 addEventListener 抛错。
    if (input.signal && typeof input.signal.addEventListener === "function") {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    this.aborts.set(sessionId, controller);
    const steers = new SteerBus();
    this.steerBuses.set(sessionId, steers);

    // 工具面只解析一次：模型可见面（toolSchemas）与执行闸共用同一份名单，
    // 否则会出现「模型看不见却仍可被调用」或反之（审计 P0-1）。
    const resolvedAllowlist =
      this.opts.getToolAllowlist?.(input.mode, sessionId) ?? this.opts.toolAllowlist;
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
      guardToolCall: this.opts.guardToolCall,
    });

    let outcome: LoopRunStatus = "error";
    let reason = "引擎未运行";
    let finalText = "";
    let usage = { rounds: 0, toolCalls: 0, totalTokens: 0, wallClockMs: 0 };
    let claims: ClaimFinding[] = [];

    try {
      // 白名单收窄模型可见面：undefined=全部工具，否则只广播名单内的工具（P0-1）
      const toolList = registry
        ? registry.toolSchemas(resolvedAllowlist).map((s) => ({
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
          // 工具循环收尾时会 emit("done")，但 ChatService 在 finally 里还会发一次权威 done
          //（带输出过滤后的 finalText / claims）。这里也映射会让渲染层收到两次 done：
          // 第二次 done 到达时上一条已结算，收尾批次里迟到的 chunk 会被当成**新消息** →
          // 界面上多出一条幽灵回复，且它的空时间线会把真实时间线覆盖掉。done 只认 finally 那次。
          if (event.type === "done") return;
          // LoopEvent → ChatEventType（type 同名，data 原样传递）
          emit(event.type as ChatEventType, event.data);
      if (event.type === "tool_start") {
        const data = event.data as { toolName?: string } | undefined;
        if (data?.toolName) this.opts.onToolCall?.(data.toolName, sessionId);
      }
      if (event.type === "tool") {
        const data = event.data as {
          toolName?: string;
          args?: Record<string, unknown>;
          result?: { ok?: boolean; error?: string };
        } | undefined;
        if (data?.toolName && data.result) {
          this.opts.onToolResult?.({
            toolName: data.toolName,
            sessionId,
            ok: data.result.ok === true,
            ...(data.result.error ? { error: data.result.error } : {}),
            ...(data.args ? { args: data.args } : {}),
          });
        }
      }
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
      if (process.env.LOOPSOAR_LOOP_DEBUG) {
        console.log("[LOOP] outcome", {
          status: loopOutcome.status,
          reason: loopOutcome.reason,
          finalTextLen: loopOutcome.finalText.length,
          rounds: loopOutcome.usage?.rounds,
          toolCalls: loopOutcome.usage?.toolCalls,
          totalTokens: loopOutcome.usage?.totalTokens,
          wallClockMs: loopOutcome.usage?.wallClockMs,
        });
      }

      outcome = loopOutcome.status;
      // aborted 的底层原因文案（"外部中止信号触发…"）对用户无意义：主动停止是用户动作，
      // 统一改成「已停止」，让 done 事件 / 中断横幅给出人读原因。
      reason = loopOutcome.status === "aborted" ? "用户已停止本轮生成" : loopOutcome.reason;
      finalText = loopOutcome.finalText;
      // 输出过滤（身份边界）：finalText 整体再过滤一次（流式过滤可能因分批而漏边，这里是最终防线）
      if (filterEnabled && finalText) finalText = applyOutputFilter(finalText);
      // 空正文兜底：任何非正常收束都必须给出可读原因（配合 UI 的中断横幅，避免"莫名空白"）
      if (!finalText.trim()) {
        finalText =
          outcome === "done"
            ? "（模型没有返回文本内容）"
            : outcome === "aborted"
              ? "（已停止）"
              : `（任务未完成：${reason}）`;
      }
      usage = loopOutcome.usage;

      // 声称核验：只报告「声称存在但实际不存在」的可疑项。
      // 用户已停止时跳过：核验要为每个声称做文件存在性 IO，会拖慢进入 done 收尾（UI 要等 done 才收敛）。
      if (platform && finalText && outcome !== "aborted") {
        try {
          const findings = await auditClaims(finalText, (p) => platform.fs.exists(p));
          claims = findings.filter((f) => f.verified && !f.exists && f.reason !== "跳过 URL/域名残片");
        } catch (err) {
          emit("progress", { note: `声称核验异常（已跳过）：${err instanceof Error ? err.message : String(err)}` });
        }
      }
    } catch (err) {
      // 中止引发的中断（例如收尾阶段被 abort 打断的 IO）也按 aborted 收束，不当成编排异常
      if (controller.signal.aborted) {
        outcome = "aborted";
        reason = "用户已停止本轮生成";
        if (!finalText.trim()) finalText = "（已停止）";
      } else {
        reason = `编排异常：${err instanceof Error ? err.message : String(err)}`;
        emit("error", reason);
      }
    } finally {
      // 只清理「本次流」的控制器：同一会话可能已经开始了新流（停止后的排队续发），
      // 老流收尾不能把新流的控制器删掉 —— 否则新流再点停止会返回 false、永远停不下来。
      if (this.aborts.get(sessionId) === controller) this.aborts.delete(sessionId);
      // 收尾：把流式过滤器里跨 chunk 缓冲的尾部（<20 字符）补发，否则最后一段正文会丢
      if (filterEnabled) {
        const textTail = textFilter.flush();
        if (textTail) batcher.push({ content: textTail, meta: { type: "chunk" } });
        const reasoningTail = reasoningFilter.flush();
        if (reasoningTail) batcher.push({ content: reasoningTail, meta: { type: "reasoning" } });
      }
      // 先把已缓冲的增量全部推出，再推 done：否则 UI 会先收到 done、随后才收到迟到 chunk
      //（那条 chunk 会在 activeId 已清空后新建一条幽灵消息）。
      batcher.flushNow();
      emit("done", { status: outcome, reason, finalText, usage, claims });
      batcher.close();
    }

    return { status: outcome, reason, finalText, usage, chunks, claims };
  }

  /**
   * 投递一条运行中引导：进入该会话的 SteerBus，模型在下一个轮次边界注入。
   * 返回结构化结果供 UI 区分「已投递」/「排队等下一轮」（no-running/full 保留待发卡）。
   */
  steer(sessionId: string | undefined, text: string, steerId?: string): SteerDeliveryResult {
    const trimmed = text.trim();
    const id = steerId?.trim() || `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!trimmed) return { accepted: false, steerId: id, reason: "empty" };
    // 未指定会话时：若只有一个运行中的会话，默认投给它（UI 通常只有一个活动流）
    const fallbackId = this.steerBuses.size === 1 ? [...this.steerBuses.keys()][0] : undefined;
    const target = sessionId && this.steerBuses.has(sessionId) ? sessionId : (fallbackId ?? "");
    const bus = target ? this.steerBuses.get(target) : undefined;
    if (!bus) return { accepted: false, steerId: id, reason: "no-running" };
    const result = bus.push({ id, text: trimmed, kind: "user", createdAt: Date.now() });
    if (result === "full") return { accepted: false, steerId: id, reason: "full" };
    return { accepted: true, steerId: id };
  }

  /** 撤销一条尚未注入的引导（待发卡的「修改 / 撤销删除」）；返回是否确实撤销。 */
  steerCancel(sessionId: string | undefined, steerId: string): boolean {
    const fallbackId = this.steerBuses.size === 1 ? [...this.steerBuses.keys()][0] : undefined;
    const target = sessionId && this.steerBuses.has(sessionId) ? sessionId : (fallbackId ?? "");
    const bus = target ? this.steerBuses.get(target) : undefined;
    if (!bus || !steerId.trim()) return false;
    return bus.take(steerId) !== undefined;
  }

  /** 当前挂起确认数（界面状态条/测试用）。 */
  pendingPermissionCount(): number {
    return this.permBus.size;
  }
}
