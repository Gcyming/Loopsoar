/**
 * chat 域补充：/compact —— 真实上下文压缩（预览 + 可选写回持久化）。
 *
 * 为什么单独成文件：chat.ts 已承担流式对话/会话生命周期/记忆汇总/历史读取，
 * /compact 是一条独立的「读持久化 → 纯逻辑压缩 → 写回」流程，塞进 chat 域
 * 会把该文件变成上帝文件；通道仍归 chat 域（`chat:compact`），只是注册函数分开。
 *
 * 语义（与 ChatService 的自动压缩共用同一份纯逻辑 core/contextCompress）：
 *   1. 读取目标会话的持久化消息（SessionStore.loadMessages；缺省 = 当前会话）；
 *   2. 预算 = 按当前模型 contextWindow 的 55% 反推字符数（按这批消息自己的 token/字符比换算）；
 *   3. 未超预算 → compressed=false，什么都不改（apply 也安全）；
 *   4. 超预算 → 保留最近 14 条原文，更早的消息压成确定性摘要（每条 240 字符），
 *      不额外调用模型（多一次请求 = 多一次失败/延迟/费用）；
 *   5. apply=false（默认）：只返回统计 + 预览，**不落盘、不推送**；
 *      apply=true：把「合成摘要消息（role=assistant，compacted=true）+ 最近 N 条」
 *      写回 SessionStore.replaceMessages，并 push `chat:compacted` 事件；
 *   6. 任何失败返回 { ok:false, error }（可读中文原因），不把裸错误抛给渲染层；
 *   7. 可选 isBusy：会话正在生成时拒绝压缩（避免与流结束时的 append 竞态）。
 */
import {
  budgetCharsForTokenTarget,
  compressConversation,
  messageChars,
  type CompactableMessage,
} from "loopsoar-core/contextCompress";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { PersistedMessage, SessionStore } from "../sessionStore.js";

export interface CompactDeps extends TrustedIpcDeps {
  sessions: SessionStore;
  push(event: string, payload: unknown): void;
  /** 当前活跃模型的上下文窗口（tokens）；缺省回退 core 默认预算（120K 字符）。 */
  getContextWindow?: () => number | undefined;
  /** 会话是否正在生成（可选）；返回 true 时拒绝压缩，避免与落盘写竞态。 */
  isBusy?: (sessionId: string) => boolean;
}

/** 压缩前后的规模统计（messages=消息条数，chars=消息文本字符数，不含 timeline）。 */
export interface CompactStats {
  messages: number;
  chars: number;
}

/** 预览消息（只用于 UI 展示；文本截断，非完整内容）。 */
export interface CompactMessagePreview {
  role: "user" | "assistant";
  text: string;
  compacted?: boolean;
}

export interface CompactResult {
  ok: boolean;
  /** 可读失败原因（ok=false 时必有）。 */
  error?: string;
  sessionId?: string;
  /** 是否真的触发了压缩（未超预算 / 消息过少 → false）。 */
  compressed: boolean;
  /** 是否已写回持久化（apply=false 或未触发压缩 → false）。 */
  applied: boolean;
  before: CompactStats;
  after: CompactStats;
  /** 被摘要掉的早期消息条数。 */
  dropped: number;
  /** 1 - after.chars / before.chars（保留 4 位小数）；before.chars=0 → 0。 */
  savedRatio: number;
  /** 压缩摘要（未压缩时为空串）；apply 时同内容已写入会话。 */
  summary?: string;
  /** 仅预览模式（apply=false）返回：写回后的消息列表（文本截断 200 字）。 */
  preview?: CompactMessagePreview[];
}

/** 预览模式每条消息最多回传的字符数（避免把整段历史再塞回渲染层）。 */
const PREVIEW_TEXT_LIMIT = 200;
/** 预览最多回传的消息条数（够 UI 展示「摘要 + 最近几条」即可）。 */
const PREVIEW_MAX_MESSAGES = 24;
/** 落盘摘要消息的固定前缀：UI/后续压缩可据此识别合成消息。 */
export const COMPACT_NOTE_PREFIX = "## 早期对话摘要（系统自动压缩）";

function emptyStats(): CompactStats {
  return { messages: 0, chars: 0 };
}

/** 失败结果工厂：统一形状，避免各分支漏字段。 */
function failure(error: string, sessionId?: string): CompactResult {
  return {
    ok: false,
    error,
    ...(sessionId ? { sessionId } : {}),
    compressed: false,
    applied: false,
    before: emptyStats(),
    after: emptyStats(),
    dropped: 0,
    savedRatio: 0,
  };
}

/** 持久化消息 → 压缩器消息：只取角色与文本（timeline 不参与预算）。 */
function toCompactable(messages: PersistedMessage[]): CompactableMessage[] {
  return messages.map((message) => ({
    role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: message.text,
  }));
}

/** 字符统计：只算文本（与 compressConversation 的预算口径一致）。 */
function charsOf(messages: Array<{ role: CompactableMessage["role"]; text: string }>): number {
  return messages.reduce(
    (sum, message) => sum + messageChars({ role: message.role, content: message.text }),
    0,
  );
}

/**
 * 把压缩器输出映射回持久化消息：
 *   - 压缩器产出的 system 摘要 → 一条合成 assistant 消息（持久化层没有 system 角色，
 *     用 assistant 是为了让后续历史重建时它是「模型自己说过的话」，不会被当成新的用户指令）；
 *   - 保留的最近消息按原顺序取原对象（timeline/provider/model 原样保留）。
 */
function toPersistedMessages(
  compressed: CompactableMessage[],
  originals: PersistedMessage[],
  now: number,
): { messages: PersistedMessage[]; summary: string } {
  const systemMessages = compressed.filter((message) => message.role === "system");
  const kept = compressed.filter((message) => message.role !== "system");
  const summary = systemMessages.map((message) => message.content).join("\n\n");
  const tail = originals.slice(Math.max(0, originals.length - kept.length));
  const messages: PersistedMessage[] = [];
  if (summary.trim()) messages.push({ role: "assistant", text: summary, ts: now, compacted: true });
  messages.push(...tail);
  return { messages, summary };
}

/**
 * 执行一次压缩（导出供单测与后续「自动压缩写回」复用；IPC 包装见 registerCompactDomain）。
 * 纯流程：读 → 算 → （可选）写 → 推事件；不做 IPC 校验（由 handleTrusted 包装器负责）。
 */
export function runCompact(
  deps: CompactDeps,
  request: { sessionId?: string; apply?: boolean } = {},
): CompactResult {
  const apply = request.apply === true;
  const explicitId = typeof request.sessionId === "string" ? request.sessionId : undefined;
  const sessionId = explicitId ?? deps.sessions.currentId() ?? undefined;
  if (!sessionId) return failure("没有可压缩的会话（当前没有会话，且未指定 sessionId）");

  try {
    const persisted = deps.sessions.loadMessages(sessionId);
    if (!persisted) return failure(`会话不存在或不可用：${sessionId}`, sessionId);
    if (persisted.length === 0) return failure("会话没有消息，无需压缩", sessionId);
    if (deps.isBusy?.(sessionId)) return failure("会话正在生成中，请稍后再压缩", sessionId);

    // 预算按 token 目标反推：中文≈1 字/token，固定 4 字符/token 会让中文会话永不触发压缩。
    const contextWindow = deps.getContextWindow?.();
    const targetTokens = Math.floor((contextWindow && contextWindow > 0 ? contextWindow : 128_000) * 0.55);
    const messages = toCompactable(persisted);
    const budgetChars = budgetCharsForTokenTarget(messages, targetTokens);
    // /compact 是用户显式操作：语义固定为「摘要 + 最近 14 条」（minKeepRecent=14），
    // 不因为预算小就偷偷把保留条数缩到 2 条；若仍超预算由 stillOverBudget 在上层提示。
    const result = compressConversation(messages, { budgetChars, minKeepRecent: 14 });
    const before: CompactStats = { messages: persisted.length, chars: result.beforeChars };

    // 未触发压缩：before=after，不写盘、不推送（apply 也保持幂等无副作用）。
    if (!result.compressed) {
      const after: CompactStats = { messages: persisted.length, chars: result.beforeChars };
      return {
        ok: true,
        sessionId,
        compressed: false,
        applied: false,
        before,
        after,
        dropped: 0,
        savedRatio: 0,
        summary: "",
      };
    }

    const { messages: nextMessages, summary } = toPersistedMessages(result.messages, persisted, Date.now());
    const after: CompactStats = { messages: nextMessages.length, chars: charsOf(nextMessages) };
    const savedRatio =
      before.chars > 0 ? Math.round((1 - after.chars / before.chars) * 10000) / 10000 : 0;
    const base = {
      ok: true,
      sessionId,
      compressed: true,
      before,
      after,
      dropped: result.droppedCount,
      savedRatio,
      summary: result.summary || summary,
    };

    if (!apply) {
      const preview: CompactMessagePreview[] = nextMessages
        .slice(0, PREVIEW_MAX_MESSAGES)
        .map((message) => ({
          role: message.role,
          text: message.text.length > PREVIEW_TEXT_LIMIT
            ? `${message.text.slice(0, PREVIEW_TEXT_LIMIT)}…`
            : message.text,
          ...(message.compacted ? { compacted: true } : {}),
        }));
      return { ...base, applied: false, preview };
    }

    const saved = deps.sessions.replaceMessages(sessionId, nextMessages);
    if (!saved) return failure(`压缩结果写回失败（会话不可写）：${sessionId}`, sessionId);
    deps.push("chat:compacted", {
      sessionId,
      before,
      after,
      dropped: base.dropped,
      savedRatio,
      summary: base.summary,
      applied: true,
    });
    return { ...base, applied: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`压缩失败：${message}`, sessionId);
  }
}

/** 注册 chat:compact 通道（chat 域的压缩入口；四要素校验由 handleTrusted 统一负责）。 */
export function registerCompactDomain(deps: CompactDeps): void {
  handleTrusted(deps, "chat:compact", (payload) => {
    const request = (payload ?? {}) as { sessionId?: string; apply?: boolean };
    return runCompact(deps, {
      sessionId: request.sessionId,
      apply: request.apply === true,
    });
  });
}
