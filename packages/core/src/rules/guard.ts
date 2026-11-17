/**
 * 规则 → 工具守卫（纯逻辑）。
 *
 * 只编译「明确的写/读路径禁令」，例如：
 *   不要修改 dist/ 下的文件
 *   Never edit files in build/
 *   禁止读取 .env
 *
 * 不做自然语言全量理解：编译不了的一律留给 prompt/checklist，避免误杀。
 */
import { parseRuleDocument } from "./document.js";

export type RuleGuardAction = "read" | "write";

export interface CompiledRuleGuard {
  id: string;
  rule: string;
  path: string;
  actions: RuleGuardAction[];
}

export interface ToolGuardRequest {
  toolName: string;
  args?: Record<string, unknown>;
  /** write/read/terminal... 来自工具声明的 permissions.kind。 */
  kind?: string;
  target?: string;
  workspaceRoot?: string;
}

export interface ToolGuardDecision {
  action: "deny";
  reason: string;
  rule: string;
  guard: CompiledRuleGuard;
}

const WRITE_NEGATION = /(不要|禁止|不得|不能|不允许|严禁|别再|请勿)\s*(修改|编辑|写入|写|改|动|碰|删除|删)?/;
const READ_NEGATION = /(不要|禁止|不得|不能|不允许|严禁|别再|请勿)\s*(读取|读|查看|打开)/;
const EN_WRITE = /(?:never|do not|don't|must not|cannot|can't)\s+(?:edit|modify|write|change|touch|delete)\s+(?:files?\s+in\s+|the\s+)?([^\s,.;]+)/i;
const EN_READ = /(?:never|do not|don't|must not|cannot|can't)\s+(?:read|open|view)\s+(?:the\s+)?([^\s,.;]+)/i;
const KNOWN_DIRS = new Set(["dist", "build", "node_modules", "coverage", ".git", ".next", "out", "target", "vendor", "release"]);

function cleanPath(raw: string): string | null {
  let value = raw.trim().replace(/^["'\u0060“”‘’「」]+|["'\u0060“”‘’「」]+$/g, "");
  value = value.replace(/[。.!！?？；;，,：:)\]】」]+$/g, "").replace(/^\.\//, "");
  if (!value || value.includes("..")) return null;
  if (/[\p{Script=Han}]/u.test(value)) return null;
  if (value.endsWith("/**")) value = value.slice(0, -3);
  if (!value) return null;
  const first = value.split("/")[0];
  const looksLikePath = value.includes("/") || value.startsWith(".") || value.includes("*") || KNOWN_DIRS.has(first);
  return looksLikePath ? value.replace(/\\/g, "/") : null;
}

function pathFromWriteRule(text: string): string | null {
  const zh = text.match(WRITE_NEGATION);
  if (zh) {
    const after = text.slice((zh.index ?? 0) + zh[0].length).replace(/^(在|对|把|将)?\s*/, "");
    const token = after.match(/^([^\s，,。；;]+)/)?.[1] ?? "";
    const path = cleanPath(token);
    if (path) return path;
  }
  const en = text.match(EN_WRITE);
  return en ? cleanPath(en[1]) : null;
}

function pathFromReadRule(text: string): string | null {
  const zh = text.match(READ_NEGATION);
  if (zh) {
    const after = text.slice((zh.index ?? 0) + zh[0].length).replace(/^(在|对|把|将)?\s*/, "");
    const token = after.match(/^([^\s，,。；;]+)/)?.[1] ?? "";
    const path = cleanPath(token);
    if (path) return path;
  }
  const en = text.match(EN_READ);
  return en ? cleanPath(en[1]) : null;
}

export function compileRuleGuards(sources: { id: string; text: string }[]): CompiledRuleGuard[] {
  const out: CompiledRuleGuard[] = [];
  let index = 0;
  for (const source of sources) {
    for (const line of parseRuleDocument(source.text)) {
      const text = line.text;
      const writePath = pathFromWriteRule(text);
      if (writePath) {
        out.push({ id: "g" + String(++index), rule: text, path: writePath, actions: ["write"] });
        continue;
      }
      const readPath = pathFromReadRule(text);
      if (readPath) {
        out.push({ id: "g" + String(++index), rule: text, path: readPath, actions: ["read"] });
      }
    }
  }
  return out;
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
}

function relativeToRoot(target: string, root?: string): string {
  const t = normalize(target);
  if (!isAbsolute(t) || !root) return t;
  const r = normalize(root);
  return t.toLowerCase().startsWith(r.toLowerCase() + "/") ? t.slice(r.length + 1) : t;
}

function isAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:\//.test(value);
}

function globMatch(pattern: string, target: string): boolean {
  const escaped = pattern
    .replace(/[.*+?^(){}|[\]\\$]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE__/g, ".*");
  return new RegExp("^" + escaped + "$", "i").test(target);
}

function matches(guardPath: string, target: string): boolean {
  const g = normalize(guardPath);
  const t = normalize(target);
  if (g.includes("*")) return globMatch(g, t) || globMatch(g + "/**", t);
  if (t === g) return true;
  if (t.startsWith(g + "/")) return true;
  // .env / *.lock 这类文件名规则：允许出现在任意目录
  if (!g.includes("/") && t.endsWith("/" + g)) return true;
  return false;
}

function targetOf(req: ToolGuardRequest): string | null {
  if (req.target) return req.target;
  const args = req.args ?? {};
  for (const key of ["path", "file_path", "filename", "file"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  if (Array.isArray(args.paths)) {
    const first = args.paths.find((item) => typeof item === "string" && item.trim());
    if (typeof first === "string") return first;
  }
  return null;
}

/** 命中则返回 deny；未命中返回 null。 */
export function checkRuleGuards(guards: CompiledRuleGuard[], req: ToolGuardRequest): ToolGuardDecision | null {
  const kind = (req.kind ?? "").toLowerCase();
  const target = targetOf(req);
  if (!target) return null;
  const relativeTarget = relativeToRoot(target, req.workspaceRoot);
  for (const guard of guards) {
    if (guard.actions.includes("write") && kind === "write" && matches(guard.path, relativeTarget)) {
      return { action: "deny", reason: "规则「" + guard.rule + "」禁止写入 " + guard.path, rule: guard.rule, guard };
    }
    if (guard.actions.includes("read") && kind === "read" && matches(guard.path, relativeTarget)) {
      return { action: "deny", reason: "规则「" + guard.rule + "」禁止读取 " + guard.path, rule: guard.rule, guard };
    }
  }
  return null;
}
