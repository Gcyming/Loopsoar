/**
 * P1-7 自动技能候选：任务成功后，从「用户目标 + 最终答复」生成低置信度草稿。
 *
 * 设计边界：
 * - 默认关闭，由设置·通用 `skillAutoCandidate` 显式开启；
 * - 只生成候选（SkillHost.createCandidate 默认禁用），不会自动注入/启用；
 * - 纯规则，不额外调用模型；失败静默，不能影响本轮聊天；
 * - 调用方负责每会话节流（避免每轮都写文件）。
 */
import type { SkillRecord } from "loopsoar-core/skill";
import type { SkillHost } from "./skills.js";

const MIN_USER_CHARS = 16;
const MIN_FINAL_CHARS = 40;
const MIN_TOOL_CALLS = 2;
const MAX_NAME_CHARS = 48;
const MAX_DESC_CHARS = 200;
const MAX_BODY_CHARS = 3_000;

export interface AutoCandidateInput {
  status: string;
  toolCalls: number;
  userText: string;
  finalText: string;
}

export interface AutoCandidateDraft {
  name: string;
  description: string;
  whenToUse: string;
  body: string;
  tags: string[];
}

function oneLine(text: string, max: number): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** 纯函数：不满足门槛时返回 null，便于单测与复用。 */
export function buildAutoSkillDraft(input: AutoCandidateInput): AutoCandidateDraft | null {
  if (input.status !== "done" || input.toolCalls < MIN_TOOL_CALLS) return null;
  const user = input.userText.trim();
  const finalText = input.finalText.trim();
  if (user.length < MIN_USER_CHARS || finalText.length < MIN_FINAL_CHARS) return null;

  const firstLine = user.split(/\r?\n/).find((line) => line.trim()) ?? user;
  const name = oneLine(firstLine, MAX_NAME_CHARS) || "任务经验";
  const whenToUse = oneLine(user, MAX_DESC_CHARS);
  const summary = oneLine(finalText, MAX_DESC_CHARS);
  const body = [
    "## 适用场景",
    whenToUse,
    "",
    "## 本次做法",
    finalText.slice(0, MAX_BODY_CHARS),
    "",
    "## 验证",
    "由 Agent 在任务成功后自动生成的候选草稿；启用前请人工核对事实、命令与适用范围。",
  ].join("\n");

  return {
    name,
    description: `自动候选：${summary || name}`.slice(0, MAX_DESC_CHARS),
    whenToUse,
    body,
    tags: ["auto-candidate"],
  };
}

/** 真正写入技能库；任何异常都吞掉，自动候选不能影响聊天主流程。 */
export function maybeAutoSkillCandidate(input: AutoCandidateInput, skills: SkillHost): SkillRecord | null {
  const draft = buildAutoSkillDraft(input);
  if (!draft) return null;
  try {
    return skills.createCandidate(draft);
  } catch {
    return null;
  }
}
