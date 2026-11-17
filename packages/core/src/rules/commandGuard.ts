/**
 * 命令类规则守卫：只处理「只能使用 pnpm」「不要用 npm」这类包管理器约束。
 * 不做通用命令语义解析——误杀成本太高，编译不了的一律留给 prompt/checklist。
 */

export interface CommandGuard {
  id: string;
  rule: string;
  /** 被禁止的包管理器。 */
  managers: string[];
}

const MANAGERS = ["pnpm", "npm", "yarn", "bun"];
const ONLY = /(?:只能|只准|仅能|only)\s*(?:使用|用)?\s*(pnpm|npm|yarn|bun)/i;
const BAN = /(?:不要|禁止|不能|不允许|严禁|never|do not|don't)\s*(?:使用|用)?\s*(npm|yarn|pnpm|bun)/i;

export function compileCommandGuards(sources: { id: string; text: string }[]): CommandGuard[] {
  const out: CommandGuard[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const source of sources) {
    for (const raw of source.text.split(/\r?\n/)) {
      const text = raw.replace(/^\s*[-*]\s*/, "").trim();
      if (!text || /[\?？]\s*$/.test(text)) continue;
      const only = text.match(ONLY);
      if (only) {
        const allowed = only[1].toLowerCase();
        const managers = MANAGERS.filter((manager) => manager !== allowed);
        const key = "only:" + allowed;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ id: "cg" + String(++index), rule: text, managers });
        }
        continue;
      }
      const ban = text.match(BAN);
      if (ban) {
        const manager = ban[1].toLowerCase();
        const key = "ban:" + manager;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ id: "cg" + String(++index), rule: text, managers: [manager] });
        }
      }
    }
  }
  return out;
}

export interface CommandGuardDecision {
  action: "deny";
  reason: string;
  rule: string;
  manager: string;
}

/** 检查一条 shell 命令；命中返回 deny。 */
export function checkCommandGuards(guards: CommandGuard[], command: string): CommandGuardDecision | null {
  if (!command || guards.length === 0) return null;
  const found = new Set<string>();
  for (const match of command.matchAll(/\b(pnpm|npm|yarn|bun)\b/gi)) {
    found.add(match[1].toLowerCase());
  }
  if (found.size === 0) return null;
  for (const guard of guards) {
    for (const manager of guard.managers) {
      if (found.has(manager)) {
        return {
          action: "deny",
          reason: "规则「" + guard.rule + "」禁止使用 " + manager,
          rule: guard.rule,
          manager,
        };
      }
    }
  }
  return null;
}
