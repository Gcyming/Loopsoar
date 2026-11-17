/**
 * rule-learning 域：待确认规则（候选）的查看、采纳、忽略。
 *
 * 采纳 = 把候选追加到项目的 AGENTS.md（或全局 learned-rules.md）；
 * 只有完成这一步，规则才会在下一轮进入 system prompt。
 */
import fs from "node:fs";
import path from "node:path";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { RuleCandidateStore, StoredRuleCandidate } from "../ruleCandidates.js";
import type { SessionStore } from "../sessionStore.js";
import type { RuleHistoryStore } from "../ruleHistory.js";
import { ruleKey } from "loopsoar-core/rules/learn";

const AGENTS_FILE = "AGENTS.md";
const LEARNED_HEADER = "## 学到的规则（Loopsoar）";
const GLOBAL_HEADER = "# 学到的规则（Loopsoar）";

export interface RuleLearningDeps extends TrustedIpcDeps {
  dataDir: string;
  store: RuleCandidateStore;
  workspaces?: { list(): { id: string; name: string; root: string }[]; activeId(): string | null };
  sessions?: Pick<SessionStore, "currentId" | "get" | "loadMessages">;
  evidenceFor?: (sessionId: string) => { toolName: string; error: string; at: number }[];
  history?: RuleHistoryStore;
  /** LLM 会话回顾（可选）：返回 0-3 条候选文本。 */
  review?: (messages: { role: string; text: string }[]) => Promise<{ text: string; quote: string }[] | null>;
  push?: (event: string, payload: unknown) => void;
}

function appendRule(file: string, header: string, text: string): {
  written: boolean;
  path: string;
  before: string;
  after: string;
} {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let content = "";
  try {
    if (fs.existsSync(file)) content = fs.readFileSync(file, "utf8");
  } catch {
    content = "";
  }
  const before = content;
  const line = "- " + text;
  if (content.split(/\r?\n/).some((existing) => existing.trim() === line.trim())) {
    return { written: false, path: file, before: content, after: content };
  }
  if (!content.trim()) {
    content = header + "\n\n";
  } else {
    if (!content.endsWith("\n")) content += "\n";
    if (!content.includes(header)) content += "\n" + header + "\n\n";
  }
  content += line + "\n";
  fs.writeFileSync(file, content, "utf8");
  return { written: true, path: file, before, after: content };
}

function isAllowedRulePath(deps: RuleLearningDeps, file: string): boolean {
  const resolved = path.resolve(file);
  const rulesDir = path.resolve(deps.dataDir, "rules");
  if (resolved === rulesDir || resolved.startsWith(rulesDir + path.sep)) return true;
  // 启用/停用状态也是规则的一部分：允许回滚 config/rules.json。
  if (resolved === path.resolve(deps.dataDir, "config", "rules.json")) return true;
  return (deps.workspaces?.list() ?? []).some((workspace) => {
    const root = path.resolve(workspace.root);
    return resolved === path.join(root, AGENTS_FILE) || resolved === path.join(root, "CLAUDE.md");
  });
}

function resolveWorkspace(deps: RuleLearningDeps, candidate: StoredRuleCandidate) {
  const workspaceId = candidate.workspaceId ?? deps.workspaces?.activeId() ?? null;
  const workspace = workspaceId
    ? deps.workspaces?.list().find((item) => item.id === workspaceId) ?? null
    : null;
  if (!workspace) throw new Error("没有可用工作区，无法把规则写入项目 AGENTS.md");
  return workspace;
}

export function registerRuleLearningDomain(deps: RuleLearningDeps): void {
  handleTrusted(deps, "rules:candidates", (payload) => {
    const workspaceId = (payload as { workspaceId?: string } | undefined)?.workspaceId
      ?? deps.workspaces?.activeId()
      ?? undefined;
    return {
      candidates: deps.store.list(workspaceId),
      pending: deps.store.pendingCount(),
      workspaces: deps.workspaces?.list() ?? [],
      activeWorkspaceId: deps.workspaces?.activeId() ?? null,
    };
  });

  handleTrusted(deps, "rules:learnFromSession", (payload) => {
    const explicit = (payload as { sessionId?: string } | undefined)?.sessionId;
    const sessionId = explicit ?? deps.sessions?.currentId() ?? null;
    if (!sessionId) throw new Error("当前没有可回顾的会话");
    const session = deps.sessions?.get(sessionId);
    if (!session) throw new Error("会话不存在");
    const messages = deps.sessions?.loadMessages(sessionId) ?? [];
    const userMessages = messages.filter((message) => message.role === "user").slice(-20);
    let added = 0;
    let repeated = 0;
    for (const message of userMessages) {
      const result = deps.store.observe({
        sessionId,
        workspaceId: session.workspaceId ?? undefined,
        message: message.text,
        evidence: deps.evidenceFor?.(sessionId) ?? [],
      });
      added += result.added;
      repeated += result.repeated;
    }
    if (added > 0 || repeated > 0) {
      deps.push?.("rules:updated", { action: "session-review", sessionId, added, repeated });
    }
    return { sessionId, scanned: userMessages.length, added, repeated, pending: deps.store.pendingCount() };
  });

  handleTrusted(deps, "rules:reviewSession", async (payload) => {
    const explicit = (payload as { sessionId?: string } | undefined)?.sessionId;
    const sessionId = explicit ?? deps.sessions?.currentId() ?? null;
    if (!sessionId) throw new Error("当前没有可回顾的会话");
    const session = deps.sessions?.get(sessionId);
    if (!session) throw new Error("会话不存在");
    if (!deps.review) throw new Error("未配置模型，无法做 AI 回顾");
    const messages = (deps.sessions?.loadMessages(sessionId) ?? [])
      .slice(-20)
      .map((message) => ({ role: message.role, text: message.text }));
    if (messages.length < 2) throw new Error("会话消息太少，无法回顾");
    const proposals = await deps.review(messages);
    if (!proposals) throw new Error("模型不可用或输出不合法");
    let added = 0;
    for (const proposal of proposals.slice(0, 3)) {
      const text = proposal.text.trim().slice(0, 160);
      if (text.length < 4) continue;
      const result = deps.store.addCandidate(
        {
          key: ruleKey(text),
          text,
          quote: proposal.quote || text,
          strength: "should",
          scopeHint: "workspace",
          confidence: 0.65,
          tags: ["AI回顾"],
        },
        {
          sessionId,
          workspaceId: session.workspaceId ?? undefined,
          origin: "llm-review",
        },
      );
      if (result.added) added += 1;
    }
    deps.push?.("rules:updated", { action: "llm-review", sessionId, added });
    return { sessionId, scanned: messages.length, added, proposals: proposals.length };
  });

  handleTrusted(deps, "rules:acceptCandidate", (payload) => {
    const { id, target, text } = payload as { id?: string; target?: "workspace" | "global"; text?: string };
    if (!id) throw new Error("缺少候选规则 id");
    const candidate = deps.store.get(id);
    if (!candidate) throw new Error("候选规则不存在");
    if (candidate.status !== "pending") throw new Error("该候选已处理");
    const finalText = (text ?? candidate.text).trim();
    if (finalText.length < 4 || finalText.length > 240) throw new Error("规则文本长度需在 4–240 字之间");

    let result: { written: boolean; path: string; before: string; after: string };
    if (target === "global" || (!target && candidate.scopeHint === "global")) {
      const file = path.join(deps.dataDir, "rules", "learned-rules.md");
      result = appendRule(file, GLOBAL_HEADER, finalText);
    } else {
      const workspace = resolveWorkspace(deps, candidate);
      result = appendRule(path.join(workspace.root, AGENTS_FILE), LEARNED_HEADER, finalText);
    }
    deps.store.accept(id, result.path, finalText);
    if (result.written) {
      deps.history?.add({
        action: "accept",
        summary: "采纳规则：" + finalText.slice(0, 40),
        files: [{ path: result.path, before: result.before, after: result.after }],
      });
    }
    deps.push?.("rules:updated", { action: "accepted", id, path: result.path, written: result.written });
    return { ok: true, candidate: deps.store.get(id), path: result.path, written: result.written };
  });

  handleTrusted(deps, "rules:history", (payload) => {
    const limit = (payload as { limit?: number } | undefined)?.limit ?? 20;
    return { revisions: deps.history?.list(limit) ?? [] };
  });

  handleTrusted(deps, "rules:rollback", (payload) => {
    const { id } = payload as { id?: string };
    if (!id) throw new Error("缺少历史版本 id");
    const revision = deps.history?.get(id);
    if (!revision) throw new Error("历史版本不存在");
    for (const file of revision.files) {
      if (!isAllowedRulePath(deps, file.path)) throw new Error("历史包含非规则路径，已拒绝回滚");
    }
    const changes: { path: string; before: string; after: string }[] = [];
    for (const file of revision.files) {
      let current = "";
      try {
        if (fs.existsSync(file.path)) current = fs.readFileSync(file.path, "utf8");
      } catch {
        current = "";
      }
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.before, "utf8");
      changes.push({ path: file.path, before: current, after: file.before });
    }
    const recorded = deps.history?.add({
      action: "rollback",
      summary: "回滚到 " + revision.id + "（" + revision.summary + "）",
      files: changes,
    });
    deps.push?.("rules:updated", { action: "rollback", id, revision: recorded?.id });
    return { ok: true, revision: recorded, restored: changes.length };
  });

  handleTrusted(deps, "rules:dismissCandidate", (payload) => {
    const { id } = payload as { id?: string };
    if (!id) throw new Error("缺少候选规则 id");
    const dismissed = deps.store.dismiss(id);
    if (!dismissed) throw new Error("候选规则不存在");
    deps.push?.("rules:updated", { action: "dismissed", id });
    return { ok: true, candidate: dismissed };
  });
}
