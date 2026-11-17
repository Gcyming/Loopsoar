/**
 * 工具结果 → 记忆证据。
 *
 * 只处理「同一会话、同一工具、同一错误特征连续失败」：第一次是偶发，第二次才值得记。
 * 写入的是 lesson 记忆（可召回），不是规则；规则仍由用户确认。
 */
import type { MemoryCandidate, MemoryFact } from "loopsoar-core/memory";

interface MemoryWriter {
  add(candidate: MemoryCandidate): Promise<MemoryFact>;
}

export interface ToolFailureInput {
  sessionId: string;
  workspaceId?: string;
  toolName: string;
  ok: boolean;
  error?: string;
  /** 供未来做「参数模式」分析；当前只记录，不解析。 */
  args?: Record<string, unknown>;
}

interface FailureState {
  count: number;
  reported: boolean;
  lastAt: number;
  error: string;
}

const SKIP_ERRORS = /(已停止|用户已停止|rule-denied|规则禁止|权限设置拒绝|确认被拒绝)/;

function signatureOf(error: string): string {
  return error
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export interface RecentFailure {
  toolName: string;
  error: string;
  at: number;
}

export class ToolEvidence {
  private failures = new Map<string, FailureState>();
  private recent = new Map<string, RecentFailure[]>();

  constructor(
    private readonly memory?: MemoryWriter,
    private readonly opts: { threshold?: number; now?: () => number } = {},
  ) {}

  private threshold(): number {
    return Math.max(1, this.opts.threshold ?? 2);
  }

  async observe(input: ToolFailureInput): Promise<{ lesson: MemoryFact | null; repeated: boolean }> {
    const prefix = input.sessionId + "|" + input.toolName + "|";
    if (input.ok) {
      for (const key of this.failures.keys()) {
        if (key.startsWith(prefix)) this.failures.delete(key);
      }
      return { lesson: null, repeated: false };
    }
    const error = (input.error ?? "").trim();
    if (!error || SKIP_ERRORS.test(error)) return { lesson: null, repeated: false };
    const signature = signatureOf(error);
    if (!signature) return { lesson: null, repeated: false };

    const key = prefix + signature;
    const at = (this.opts.now ?? Date.now)();
    const history = this.recent.get(input.sessionId) ?? [];
    history.push({ toolName: input.toolName, error, at });
    this.recent.set(input.sessionId, history.slice(-20));
    if (this.recent.size > 50) {
      const oldest = [...this.recent.keys()][0];
      if (oldest) this.recent.delete(oldest);
    }
    const state = this.failures.get(key) ?? { count: 0, reported: false, lastAt: at, error };
    state.count += 1;
    state.lastAt = at;
    this.failures.set(key, state);
    if (this.failures.size > 200) {
      const oldest = [...this.failures.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
      if (oldest) this.failures.delete(oldest[0]);
    }

    if (state.count < this.threshold() || state.reported || !this.memory) {
      return { lesson: null, repeated: state.count >= this.threshold() };
    }
    state.reported = true;
    const content = "工具 " + input.toolName + " 连续失败 " + state.count + " 次：" + signature;
    try {
      const lesson = await this.memory.add({
        content,
        category: "lesson",
        tags: ["tool", input.toolName],
        importance: 5,
        layer: "episodic",
        source: "tool-evidence",
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        provenance: {
          sessionId: input.sessionId,
          toolCallId: undefined,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          trust: "tool",
          capturedBy: "tool",
        },
      });
      return { lesson, repeated: true };
    } catch {
      // 记忆写入失败不阻断工具循环，也不要把 reported 回滚成重复写
      return { lesson: null, repeated: true };
    }
  }

  /** 最近失败（给规则候选做证据）；不因成功清空，便于「失败后用户纠正」关联。 */
  recentFailures(sessionId: string, limit = 3): RecentFailure[] {
    return (this.recent.get(sessionId) ?? []).slice(-Math.max(1, limit));
  }

  clear(): void {
    this.failures.clear();
    this.recent.clear();
  }
}
