/**
 * 会话删除 → 游离层 episode（E-M1）。
 *
 * 为什么在删除时压缩：删除是用户可见的「巩固事件」（见 docs/规划/记忆图谱-原点与三层.md §2.3）。
 * 这里用确定性摘要（标题 + 前几条用户消息 + 最后一条助手回复），不调模型、可离线；
 * 之后可把同样的入口换成 contextCompress/LLM 摘要，数据结构不变。
 */
import type { MemoryCandidate } from "loopsoar-core/memory";

export interface SessionEpisodeInput {
  sessionId: string;
  title?: string;
  workspaceId?: string | null;
  messages: ReadonlyArray<{ role: string; content?: string }>;
}

const MAX_EPISODE_CHARS = 400;

/** 纯函数：把一段会话压成一条 episode 候选；没有可用消息时返回 null。 */
export function buildSessionEpisode(input: SessionEpisodeInput): MemoryCandidate | null {
  const messages = input.messages.filter(
    (m): m is { role: string; content: string } => typeof m.content === "string" && m.content.trim().length > 0,
  );
  if (messages.length === 0) return null;

  const users = messages
    .filter((m) => m.role === "user")
    .slice(0, 3)
    .map((m) => m.content.trim().slice(0, 80));
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")
    ?.content.trim()
    .slice(0, 120);

  const title = input.title?.trim() || input.sessionId.slice(0, 8);
  const parts = [title, ...users, lastAssistant].filter((part): part is string => Boolean(part));
  const content = `会话「${title}」摘要：${parts.join(" / ")}`.slice(0, MAX_EPISODE_CHARS);

  return {
    content,
    category: "episode",
    importance: 7,
    tags: ["episode"],
    source: "session-archive",
    layer: "episodic",
    workspaceId: input.workspaceId ?? undefined,
    provenance: {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId ?? undefined,
      trust: "user",
      capturedBy: "consolidation",
    },
  };
}
