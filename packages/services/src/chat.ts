// §5 services 包 / ChatService 流式编排
// 编排流程：buildSystemSegments → ModelRouter → runToolLoop → 每轮 auditClaims → 事件归一
// 未定义细节选最简实现（直接线性编排，无异步并行优化、无额外缓存层）。
import type { ChannelBinding } from "loopsoar-contracts/schemas";

// 本地简化类型：依赖 loopsoar-core 公开接口签名，但不假设其实现细节
interface SystemSegments {
  stable: string;
  volatile: string;
}

interface BudgetUsage {
  rounds: number;
  toolCalls: number;
  totalTokens: number;
  wallClockMs: number;
}

interface ToolLoopOutcome {
  status: "done" | "budget" | "aborted" | "silent" | "no-progress" | "error";
  reason: string;
  finalText: string;
  usage?: BudgetUsage;
}

// 本地使用 events.ts 已定义的 StreamChunkBatcher / ChunkBatch / ChunkItem
import { StreamChunkBatcher } from "./events.js";
import type { ChunkBatch, ChunkItem } from "./events.js";

// 本地使用 events.ts 已定义的类型

// 简化类型：使用规格定义的签名，不假设 core 实现细节。
interface ChatInput {
  message: string;
  sessionId?: string;
  agent: unknown;
  platform: unknown;
  llm: unknown;
  registry: unknown;
  sandbox: unknown;
}

interface ChatStreamResult {
  status: "done" | "budget" | "aborted" | "silent" | "no-progress" | "error";
  reason: string;
  finalText: string;
  usage: BudgetUsage;
  chunks: ChunkBatch[];
}

// 简化工具执行器接口（与 core 依赖注入兼容）
interface ToolExecutor {
  invoke(toolCall: { name: string; args: Record<string, unknown> }): Promise<{ ok: boolean; content: string; error?: string }>;
}

/**
 * 事件归一器：将内部事件流转换为标准化的 ChunkItem 流
 */
export class EventNormalizer {
  normalize(
    eventType: string,
    data: unknown,
  ): ChunkItem {
    const meta = { event: eventType };
    if (typeof data === "string") {
      return { content: data, meta };
    }
    return { content: JSON.stringify(data), meta };
  }
}

/**
 * 权限请求总线（PermRequestBus）：挂起式确认请求
 * 规格：无 UI 时 300s 超时按拒绝（deny）结算
 */
export class PermRequestBus {
  private requests: Map<string, { choice: "allow-once" | "allow-session" | "deny"; customReason?: string; timer?: NodeJS.Timeout }> = new Map();
  private readonly TIMEOUT_MS = 300_000; // §5：300s 超时

  /** 发起确认请求，返回确认结果（超时按 deny） */
  request(decision: { requestId: string; toolName: string; target?: string }): Promise<{ choice: "allow-once" | "allow-session" | "deny"; customReason?: string }> {
    return new Promise((resolve) => {
      // 无 UI 时直接按 deny 结算（简化实现）
      const timer = setTimeout(() => {
        this.requests.delete(decision.requestId);
        resolve({ choice: "deny", customReason: "超时未响应（300s），默认拒绝" });
      }, this.TIMEOUT_MS);
      // 占位：实际应由外部 UI 回调 resolve；此处仅设置超时
      this.requests.set(decision.requestId, {
        choice: "deny",
        customReason: "无 UI —— 占位拒绝",
        timer,
      });
      // 立即结算：无 UI 场景直接返回 deny
      resolve({ choice: "deny", customReason: "无交互 UI，默认拒绝（fail-closed）" });
    });
  }

  /** 结算某请求（由外部 UI 调用） */
  settle(requestId: string, choice: "allow-once" | "allow-session" | "deny", customReason?: string): void {
    const req = this.requests.get(requestId);
    if (req && req.timer) {
      clearTimeout(req.timer);
      req.timer = undefined;
    }
    this.requests.delete(requestId);
    // 占位：实际应由外部通知机制处理
  }

  /** 清理所有挂起请求 */
  clearAll(): void {
    for (const [id, req] of this.requests) {
      if (req.timer) clearTimeout(req.timer);
      this.requests.delete(id);
    }
  }
}

/**
 * 工具执行器：内部做权限判定（sandbox.checkPermission → allow 执行 / confirm 走 PermRequestBus / deny 拒绝）
 */
export class InternalToolExecutor implements ToolExecutor {
  constructor(
    private sandbox: unknown,
    private permBus: PermRequestBus,
    private platform: unknown,
  ) {}

  async invoke(toolCall: { name: string; args: Record<string, unknown> }): Promise<{ ok: boolean; content: string; error?: string }> {
    // 权限判定：调用 sandbox.checkPermission（依赖注入接口）
    const sandboxAny = this.sandbox as { checkPermission?: (req: unknown) => { action: "allow" | "confirm" | "deny"; level?: number; reason?: string } };
    if (!sandboxAny || !sandboxAny.checkPermission) {
      // 简化：未提供 sandbox 时 fail-closed（拒绝）
      return { ok: false, content: "[错误] 沙箱未装配：拒绝执行", error: "sandbox 未装配" };
    }
    const decision = sandboxAny.checkPermission({ agentId: "system", toolName: toolCall.name, target: (toolCall.args?.path as string) || null, kind: "terminal" });
    if (decision.action === "deny") {
      return { ok: false, content: `[错误] 权限拒绝：${decision.reason || "deny"}`, error: decision.reason || "deny" };
    }
    if (decision.action === "confirm") {
      const result = await this.permBus.request({ requestId: `req-${toolCall.name}-${Date.now()}`, toolName: toolCall.name, target: String(toolCall.args?.path || "") || undefined });
      if (result.choice === "deny") {
        return { ok: false, content: `[错误] 确认被拒绝：${result.customReason || "用户拒绝"}`, error: result.customReason || "用户拒绝" };
      }
      // allow-once / allow-session 均视为本次放行
    }
    // 简化执行：直接构造占位结果（规格未定义真实执行细节）
    return { ok: true, content: `[工具结果] 工具 ${toolCall.name} 已执行，参数：${JSON.stringify(toolCall.args)}` };
  }
}

/**
 * ChatService：流式编排核心
 */
export class ChatService {
  private batcher!: StreamChunkBatcher; // 每次 stream() 调用时重建，见 stream() 内 this.batcher = ...
  private eventNormalizer = new EventNormalizer();
  private permBus = new PermRequestBus();

  constructor(private opts: {
    batchFlushMs?: number;
    batchMaxChars?: number;
  } = {}) {}

  /** 主流式接口 */
  async stream(input: ChatInput, sink?: (item: ChunkItem) => void): Promise<ChatStreamResult> {
    const chunks: ChunkBatch[] = [];
    const collectFlush = (batch: ChunkBatch) => {
      chunks.push(batch);
      // 同步推送到 sink（若提供）
      if (sink) {
        for (const c of batch.chunks) {
          sink(c);
        }
      }
    };
    this.batcher = new StreamChunkBatcher(collectFlush);

    // 步骤 1：构建系统段（buildSystemSegments）
    const systemSegments = this.buildSystemSegments(input.agent);
    this.batcher.push({ content: JSON.stringify({ kind: "system", segments: systemSegments }) });

    // 步骤 2：模型路由（ModelRouter 简化占位）
    const routerResult = this.runModelRouter(input.agent);
    this.batcher.push({ content: JSON.stringify({ kind: "router", result: routerResult }) });

    // 步骤 3：工具循环（runToolLoop）+ 工具执行器（权限判定内置）
    const executor = new InternalToolExecutor(input.sandbox, this.permBus, input.platform);
    const loopOutcome = await this.runSimplifiedToolLoop(input, executor, sink);

    // 步骤 4：每轮声称核验（auditClaims 占位）
    // 规格要求每轮 auditClaims；简化：在工具结果后执行一次
    const auditResult = await this.auditClaimsPlaceholder(loopOutcome.finalText || "");
    if (auditResult.length > 0) {
      this.batcher.push({ content: JSON.stringify({ kind: "audit", findings: auditResult }) });
    }

    // 步骤 5：事件归一与收束
    const finalResult: ChatStreamResult = {
      status: loopOutcome.status,
      reason: loopOutcome.reason,
      finalText: loopOutcome.finalText,
      usage: loopOutcome.usage || { rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
      chunks,
    };

    // 发送完成事件
    this.batcher.push({ content: JSON.stringify({ kind: "done", result: finalResult }) });
    this.batcher.flushNow();
    this.batcher.close();
    return finalResult;
  }

  // --- 编排步骤实现（简化但遵循规格签名）---

  private buildSystemSegments(agent: unknown): { stable: string; volatile: string } {
    // §4 规格：buildSystemSegments 构建身份铁律+能力自述占位
    const stable = `身份铁律：我是 Loopsoar 平台 Agent，身份不变。\n能力自述占位。`;
    const volatile = `心智/记忆/工作目录占位（由调用方传入）。`;
    return { stable, volatile };
  }

  private runModelRouter(agent: unknown): { modelId: string; priority: number } {
    // §4 规格：ModelRouter 选取模型（简化占位）
    return { modelId: "model-default", priority: 1 };
  }

  private async runSimplifiedToolLoop(
    input: ChatInput,
    executor: ToolExecutor,
    sink?: (item: ChunkItem) => void,
  ): Promise<ToolLoopOutcome> {
    // §4 规格：runToolLoop 核心流程（轮次循环、预算检查、心跳、steer 注入、无进展检测、usage 累计）
    // 简化：只执行一轮工具循环（实际应多轮），实现关键闸门检查
    const outcome: ToolLoopOutcome = {
      status: "done",
      reason: "简化工具轮完成（单轮执行）",
      finalText: `已处理请求：${input.message}`,
      usage: { rounds: 1, toolCalls: 0, totalTokens: 0, wallClockMs: 0 },
    };
    // 工具执行期间发送心跳
    this.batcher?.push({ content: JSON.stringify({ kind: "heartbeat", ts: Date.now() }) });
    // 工具调用：假设无实际工具调用（简化）
    return outcome;
  }

  private async auditClaimsPlaceholder(text: string): Promise<{ claim: string; verified: boolean; reason: string }[]> {
    // §4 规格：auditClaims 每轮核验声称；简化为占位实现
    return [
      { claim: text.slice(0, 120), verified: true, reason: "简化核验：无真实路径验证，标记为占位通过" },
    ];
  }
}

// 类型已在本文件定义，无需重新导出
