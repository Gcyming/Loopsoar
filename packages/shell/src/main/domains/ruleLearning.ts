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

const AGENTS_FILE = "AGENTS.md";
const LEARNED_HEADER = "## 学到的规则（Loopsoar）";
const GLOBAL_HEADER = "# 学到的规则（Loopsoar）";

export interface RuleLearningDeps extends TrustedIpcDeps {
  dataDir: string;
  store: RuleCandidateStore;
  workspaces?: { list(): { id: string; name: string; root: string }[]; activeId(): string | null };
  push?: (event: string, payload: unknown) => void;
}

function appendRule(file: string, header: string, text: string): { written: boolean; path: string } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let content = "";
  try {
    if (fs.existsSync(file)) content = fs.readFileSync(file, "utf8");
  } catch {
    content = "";
  }
  const line = "- " + text;
  if (content.split(/\r?\n/).some((existing) => existing.trim() === line.trim())) {
    return { written: false, path: file };
  }
  if (!content.trim()) {
    content = header + "\n\n";
  } else {
    if (!content.endsWith("\n")) content += "\n";
    if (!content.includes(header)) content += "\n" + header + "\n\n";
  }
  content += line + "\n";
  fs.writeFileSync(file, content, "utf8");
  return { written: true, path: file };
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

  handleTrusted(deps, "rules:acceptCandidate", (payload) => {
    const { id, target, text } = payload as { id?: string; target?: "workspace" | "global"; text?: string };
    if (!id) throw new Error("缺少候选规则 id");
    const candidate = deps.store.get(id);
    if (!candidate) throw new Error("候选规则不存在");
    if (candidate.status !== "pending") throw new Error("该候选已处理");
    const finalText = (text ?? candidate.text).trim();
    if (finalText.length < 4 || finalText.length > 240) throw new Error("规则文本长度需在 4–240 字之间");

    let result: { written: boolean; path: string };
    if (target === "global" || (!target && candidate.scopeHint === "global")) {
      const file = path.join(deps.dataDir, "rules", "learned-rules.md");
      result = appendRule(file, GLOBAL_HEADER, finalText);
    } else {
      const workspace = resolveWorkspace(deps, candidate);
      result = appendRule(path.join(workspace.root, AGENTS_FILE), LEARNED_HEADER, finalText);
    }
    deps.store.accept(id, result.path, finalText);
    deps.push?.("rules:updated", { action: "accepted", id, path: result.path, written: result.written });
    return { ok: true, candidate: deps.store.get(id), path: result.path, written: result.written };
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
