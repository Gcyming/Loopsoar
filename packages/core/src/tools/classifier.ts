/**
 * 安全分类器（§4.3 S4）
 */
import { SENSITIVE_FILES, PROTECTED_SOURCE_DIRS } from "loopsoar-contracts/security-policy";
import { hardRuleCheck } from "./hard_rules.js";

export function isSensitivePath(p: string): boolean {
  const basename = p.split(/[\/]/).pop() ?? "";
  for (const s of SENSITIVE_FILES) {
    if (s.includes("*") || s.includes("?")) {
      // 简化通配符匹配：将通配符转换为正则
      const regexStr = "^" + s.replace(/\.\*/g, "\\.*").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
      try {
        const regex = new RegExp(regexStr, "i");
        if (regex.test(basename)) return true;
      } catch {
        if (basename === s.replace(/\*.*$/, "")) return true;
      }
    } else if (basename.toLowerCase() === s.toLowerCase()) {
      return true;
    }
  }
  return false;
}

export function isProtectedSourceDir(p: string): boolean {
  const normalized = p.replace(/\\/g, "/");
  for (const dir of PROTECTED_SOURCE_DIRS) {
    if (normalized.endsWith("/" + dir) || normalized.endsWith("/" + dir + "/") || normalized === dir) return true;
  }
  return false;
}

export function classifyCommand(cmd: string): "readonly" | "confirm" | "block" {
  const result = hardRuleCheck(cmd);
  if (result.blocked) return "block";
  // 只读命令占位：不含危险规则且不含写操作关键字
  const lower = cmd.toLowerCase();
  if (lower.includes("cat") || lower.includes("ls") || lower.includes("echo") || lower.includes("pwd")) {
    return "readonly";
  }
  return "confirm";
}
