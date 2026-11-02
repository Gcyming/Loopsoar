/**
 * 多供应商降级链（shell 装配层）：把 core/router 的 ModelRouter 接到聊天用 LlmClient。
 *
 * 为什么需要：单供应商故障（限流/5xx/网络抖动）不应让整轮对话失败。
 * 语义（fail-closed + 不重复正文）：
 *   · 按 ModelRouter.fallbackChain 优先级顺序尝试目标；
 *   · 只有在「尚未向调用方产出任何 chunk」之前发生的可重试错误（网络/超时/5xx/429）
 *     才 markCooldown 并切下一个目标；已开始输出后出错直接报错，绝不重放（避免正文重复）；
 *   · 不可重试错误（4xx 鉴权/参数等）立即报错，不浪费其它供应商；
 *   · 全部失败时输出一条聚合 error，附每个目标的失败原因（tool_loop 会把它当 fatal 终止本轮）。
 *
 * 装配注意：冷却状态保存在 ModelRouter 上。若壳层按会话重建客户端（每次 stream 一次），
 * 必须复用同一个 router 实例，否则冷却失效（见导出 createModelRouterForTargets；供应商变更后重建 router 即可）。
 */
import { ModelRouter, type ModelPoolEntry } from "loopsoar-core/router";
import type { LlmChunk, LlmClient, LlmRequest } from "loopsoar-core/llm";

/** 一个可降级目标：身份 + 路由元数据 + 惰性构建的 LlmClient。 */
export interface FallbackLlmTarget {
  /** 稳定 id（与 ModelRouter 池条目对应；冷却按 id 记录）。 */
  id: string;
  /** 展示用供应商名（错误文案/日志）。 */
  provider: string;
  /** 模型名（错误文案/日志）。 */
  model: string;
  /** 数字越大优先级越高（与 ModelRouter 语义一致）。 */
  priority: number;
  /** 可胜任的角色标签（至少包含默认角色 "chat"，否则走兜底全量尝试）。 */
  roles: string[];
  /** 惰性构建真实客户端（首次尝试该目标时才构造；构造异常按失败处理）。 */
  build: () => LlmClient;
}

export interface FallbackLlmOptions {
  targets: FallbackLlmTarget[];
  /** 路由/冷却池；不传则按 targets 自建（仅适合单实例长期持有）。 */
  router?: ModelRouter;
  /** 时间源（测试注入；默认 Date.now）。 */
  now?: () => number;
  /** 可重试失败后的冷却时长（默认 30s）。 */
  cooldownMs?: number;
  /** 本次请求的角色标签（默认 "chat"；ChatService 目前只有 chat 场景）。 */
  roles?: string | string[];
  /** 可重试判定注入（测试/特殊供应商用；默认见 isRetryableLlmError）。 */
  isRetryable?: (message: string) => boolean;
}

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_ROLES = "chat";

/**
 * 可重试错误判定：网络/超时/5xx/429/408。
 * 只在「尚未产出任何 chunk」时用于决定是否降级；文案匹配是对 LlmClient 契约的兼容
 * （core 的 openai/anthropic 客户端以 `HTTP xxx: ...` 或「请求超时」等文本作为 error chunk）。
 */
export function isRetryableLlmError(message: string): boolean {
  const text = String(message ?? "");
  if (!text) return false;
  if (/HTTP\s*(?:5\d\d|429|408)\b/i.test(text)) return true;
  return /fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|timed?\s*out|timeout|请求超时|超时|网络|连接失败|连接被拒|服务不可用|overloaded/i.test(
    text,
  );
}

/** 用 targets 构建 ModelRouter 池（供壳层持久化冷却状态；供应商变更后重建即可）。 */
export function createModelRouterForTargets(targets: FallbackLlmTarget[]): ModelRouter {
  return new ModelRouter(targets.map(toPoolEntry));
}

function toPoolEntry(target: FallbackLlmTarget): ModelPoolEntry {
  return {
    id: target.id,
    provider: target.provider,
    priority: target.priority,
    roles: [...target.roles],
    cooldownUntilMs: 0,
  };
}

/** 把 targets 中不在 router 池里的条目补进去（不覆盖既有条目，避免重置冷却）。 */
function ensureRouterHasTargets(router: ModelRouter, targets: FallbackLlmTarget[], roleList: string[]): void {
  if (targets.length === 0) return;
  const probeRoles = [...new Set([...roleList, ...targets.flatMap((target) => target.roles)])];
  const known = new Set(router.fallbackChain(probeRoles, Number.POSITIVE_INFINITY).map((entry) => entry.id));
  for (const target of targets) {
    if (!known.has(target.id)) router.upsert(toPoolEntry(target));
  }
}

function labelOf(target: FallbackLlmTarget): string {
  return `${target.provider}/${target.model}`;
}

function sortedByPriority(targets: FallbackLlmTarget[]): FallbackLlmTarget[] {
  return [...targets].sort((a, b) => b.priority - a.priority);
}

/**
 * 创建降级链客户端。
 * 返回的 LlmClient.invoke 每次请求独立走一遍降级链（多轮工具对话的每一轮都会重新选择）。
 */
export function createFallbackLlmClient(opts: FallbackLlmOptions): LlmClient {
  const targets = opts.targets ?? [];
  const now = opts.now ?? (() => Date.now());
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const roleList = Array.isArray(opts.roles) ? opts.roles : [opts.roles ?? DEFAULT_ROLES];
  const retryable = opts.isRetryable ?? isRetryableLlmError;
  const router = opts.router ?? createModelRouterForTargets(targets);
  // 外部 router 可能来自「客户端构造之前」的供应商快照：把缺失的目标补进池子，
  // 否则新增供应商会因为不在池里而永远不被尝试（已存在的条目不动，冷却状态保留）。
  ensureRouterHasTargets(router, targets, roleList);
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const clientCache = new Map<string, LlmClient>();

  const clientFor = (target: FallbackLlmTarget): LlmClient => {
    const cached = clientCache.get(target.id);
    if (cached) return cached;
    const client = target.build();
    clientCache.set(target.id, client);
    return client;
  };

  /** 按 router 选出本次请求的尝试顺序；全冷却时返回空数组（不发起任何调用）。 */
  const selectChain = (nowMs: number): { chain: FallbackLlmTarget[]; allCooling: boolean } => {
    const ordered: FallbackLlmTarget[] = [];
    for (const entry of router.fallbackChain(roleList, nowMs)) {
      const target = targetById.get(entry.id);
      if (target) ordered.push(target);
    }
    if (ordered.length > 0) return { chain: ordered, allCooling: false };
    // 角色标签不匹配（Router 池与 targets 配置漂移）时兜底：按优先级尝试全部，
    // 否则「只配置了一个模型但 roles 未写 chat」会让所有对话直接失败（可观测性差且难排查）。
    const anyRoleMatch = targets.some((target) => roleList.some((role) => target.roles.includes(role)));
    if (!anyRoleMatch) return { chain: sortedByPriority(targets), allCooling: false };
    return { chain: [], allCooling: true };
  };

  return {
    async *invoke(req: LlmRequest): AsyncGenerator<LlmChunk> {
      if (targets.length === 0) {
        yield { kind: "error", message: "没有可用的模型供应商（请先在设置 → 模型服务中配置）" };
        return;
      }
      const { chain, allCooling } = selectChain(now());
      if (allCooling) {
        const names = sortedByPriority(targets).map(labelOf).join("、");
        yield { kind: "error", message: `所有模型均在冷却中（${Math.ceil(cooldownMs / 1000)}s 后恢复），暂不发起调用：${names}` };
        return;
      }

      const failures: { label: string; reason: string }[] = [];
      for (const target of chain) {
        if (req.signal?.aborted) {
          yield { kind: "error", message: "请求已取消" };
          return;
        }

        let client: LlmClient;
        try {
          client = clientFor(target);
        } catch (err) {
          failures.push({ label: labelOf(target), reason: `客户端构建失败：${err instanceof Error ? err.message : String(err)}` });
          continue;
        }

        let emittedBeforeError = 0;
        let streamError: string | null = null;
        try {
          for await (const chunk of client.invoke(req)) {
            if (chunk.kind === "error") {
              streamError = chunk.message || "LLM 流返回未知错误";
              break;
            }
            emittedBeforeError += 1;
            yield chunk;
          }
        } catch (err) {
          streamError = err instanceof Error ? err.message : String(err);
        }

        // 正常结束（目标自己会产出 done）：直接返回，不再尝试后续供应商
        if (streamError === null) return;

        // 已向调用方输出过 chunk：绝不切换（否则正文重复），把中断原因交给上层处理
        if (emittedBeforeError > 0) {
          yield {
            kind: "error",
            message: `模型输出中断（${labelOf(target)}）：${streamError}；已停止降级以避免重复正文`,
          };
          return;
        }

        if (req.signal?.aborted) {
          yield { kind: "error", message: "请求已取消" };
          return;
        }

        if (!retryable(streamError)) {
          yield { kind: "error", message: `${labelOf(target)} 调用失败（不可重试，已停止降级）：${streamError}` };
          return;
        }

        // 可重试且尚未输出：标记冷却，切下一个目标
        router.markCooldown(target.id, cooldownMs, now());
        failures.push({ label: labelOf(target), reason: streamError });
      }

      const detail = failures.map((item) => `- ${item.label}：${item.reason}`).join("\n");
      yield {
        kind: "error",
        message: `所有模型均调用失败（已尝试 ${failures.length} 个）：\n${detail}`,
      };
    },
  };
}
