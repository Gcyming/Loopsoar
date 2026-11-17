/**
 * 规则候选存储（壳层）：把用户说过的硬约束暂存成「待确认规则」。
 *
 * 关键取舍：默认不自动改写 AGENTS.md。候选必须经用户采纳才进入规则文件，
 * 避免把一次性纠正、例外和噪声写成永久规则（CLR-Bench 的失败模式）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { extractCorrectionCandidates, extractRuleCandidates, ruleKey, type RuleCandidate } from "loopsoar-core/rules/learn";
import type { RecentFailure } from "./toolEvidence.js";

export type RuleCandidateStatus = "pending" | "accepted" | "dismissed";

export interface StoredRuleCandidate extends RuleCandidate {
  id: string;
  status: RuleCandidateStatus;
  workspaceId?: string;
  sessionId?: string;
  seenCount: number;
  createdAt: number;
  lastSeenAt: number;
  acceptedAt?: number;
  promotedTo?: string;
  /** 触发这条候选的最近工具失败（只在有失败证据时出现）。 */
  evidence?: RecentFailure[];
}

interface CandidateFile {
  version: 1;
  items: StoredRuleCandidate[];
}

const MAX_PENDING = 80;
const MAX_SETTLED = 40;

function isCandidate(value: unknown): value is StoredRuleCandidate {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<StoredRuleCandidate>;
  return (
    typeof c.id === "string" &&
    typeof c.key === "string" &&
    typeof c.text === "string" &&
    typeof c.status === "string" &&
    typeof c.seenCount === "number" &&
    typeof c.createdAt === "number" &&
    typeof c.lastSeenAt === "number"
  );
}

export class RuleCandidateStore {
  private items: StoredRuleCandidate[] = [];

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.items = this.load();
  }

  private load(): StoredRuleCandidate[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<CandidateFile>;
      return Array.isArray(raw.items) ? raw.items.filter(isCandidate) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + ".tmp";
      const data: CandidateFile = { version: 1, items: this.items };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch {
      // 候选只是提示，写盘失败不阻断对话
    }
  }

  private prune(): void {
    const pending = this.items
      .filter((item) => item.status === "pending")
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, MAX_PENDING);
    const settled = this.items
      .filter((item) => item.status !== "pending")
      .sort((a, b) => (b.acceptedAt ?? b.lastSeenAt) - (a.acceptedAt ?? a.lastSeenAt))
      .slice(0, MAX_SETTLED);
    this.items = [...pending, ...settled];
  }

  /** 观察一条用户消息：同工作区同 key 只累加证据，不重复建条目。 */
  observe(input: {
    sessionId: string;
    workspaceId?: string;
    message: string;
    evidence?: RecentFailure[];
  }): {
    added: number;
    repeated: number;
    candidates: StoredRuleCandidate[];
  } {
    const evidence = (input.evidence ?? []).slice(-3);
    const extracted = [
      ...extractRuleCandidates(input.message),
      ...(evidence.length > 0 ? extractCorrectionCandidates(input.message) : []),
    ];
    if (extracted.length === 0) return { added: 0, repeated: 0, candidates: [] };
    const now = this.now();
    let added = 0;
    let repeated = 0;
    const touched: StoredRuleCandidate[] = [];

    for (const candidate of extracted) {
      const scopeId = candidate.scopeHint === "global" ? "global" : input.workspaceId ?? "default";
      const existing = this.items.find(
        (item) =>
          item.key === candidate.key &&
          item.status !== "dismissed" &&
          (item.scopeHint === "global" ? "global" : item.workspaceId ?? "default") === scopeId,
      );
      if (existing) {
        existing.seenCount += 1;
        existing.lastSeenAt = now;
        existing.confidence = Math.min(0.95, Math.round((existing.confidence + 0.02) * 100) / 100);
        existing.quote = candidate.quote;
        if (evidence.length > 0) {
          const merged = [...(existing.evidence ?? [])];
          for (const item of evidence) {
            if (!merged.some((old) => old.toolName === item.toolName && old.error === item.error)) merged.push(item);
          }
          existing.evidence = merged.slice(-3);
          existing.confidence = Math.min(0.95, Math.round((existing.confidence + 0.02) * 100) / 100);
        }
        if (existing.status === "pending") repeated += 1;
        touched.push(existing);
        continue;
      }
      const item: StoredRuleCandidate = {
        ...candidate,
        id: "rc-" + randomUUID().slice(0, 8),
        status: "pending",
        ...(candidate.scopeHint === "workspace" && input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        sessionId: input.sessionId,
        ...(evidence.length > 0 ? { evidence } : {}),
        seenCount: 1,
        createdAt: now,
        lastSeenAt: now,
      };
      this.items.push(item);
      touched.push(item);
      added += 1;
    }

    this.prune();
    if (added > 0 || repeated > 0) this.save();
    return { added, repeated, candidates: touched };
  }

  list(workspaceId?: string): StoredRuleCandidate[] {
    return this.items
      .filter((item) => !workspaceId || item.scopeHint === "global" || item.workspaceId === workspaceId)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
        return b.lastSeenAt - a.lastSeenAt;
      });
  }

  pendingCount(): number {
    return this.items.filter((item) => item.status === "pending").length;
  }

  get(id: string): StoredRuleCandidate | null {
    return this.items.find((item) => item.id === id) ?? null;
  }

  accept(id: string, promotedTo?: string, text?: string): StoredRuleCandidate | null {
    const item = this.get(id);
    if (!item) return null;
    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed.length < 4 || trimmed.length > 240) throw new Error("规则文本长度需在 4–240 字之间");
      item.text = trimmed;
      item.key = ruleKey(trimmed);
    }
    item.status = "accepted";
    item.acceptedAt = this.now();
    if (promotedTo) item.promotedTo = promotedTo;
    this.save();
    return item;
  }

  dismiss(id: string): StoredRuleCandidate | null {
    const item = this.get(id);
    if (!item) return null;
    item.status = "dismissed";
    this.save();
    return item;
  }
}
