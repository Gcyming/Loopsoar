/**
 * 安全分类器（§4.3 S4）
 */
import { SENSITIVE_FILES, PROTECTED_SOURCE_DIRS } from "loopsoar-contracts/security-policy";
import { hardRuleCheck } from "./hard_rules.js";

/** 把 glob 片段转为正则：只支持安全策略里用到的 `*` / `?`，其余字符全部转义。 */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function isSensitivePath(p: string): boolean {
  // 统一分隔符后同时用「完整路径」和「basename」匹配：
  // 数据源既有 *.pem 这类文件名规则，也有 config/auth_token*、config/providers.enc.json
  // 这类带目录规则；只取 basename 会让后者永远匹配不到。
  const normalized = p.replace(/\\/g, "/").replace(/^\.\//, "");
  const basename = normalized.split("/").pop() ?? "";
  for (const pattern of SENSITIVE_FILES) {
    if (pattern.includes("/")) {
      const regex = globToRegex(pattern);
      // 带目录的规则按路径后缀匹配，避免要求调用方必须传仓库绝对路径。
      if (regex.test(normalized) || new RegExp(`(?:^|/)${regex.source.slice(1, -1)}$`, "i").test(normalized)) {
        return true;
      }
      continue;
    }
    if (globToRegex(pattern).test(basename)) return true;
  }
  return false;
}

export function isProtectedSourceDir(p: string): boolean {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return false;
  const segments = normalized.split("/").filter(Boolean);
  for (const dir of PROTECTED_SOURCE_DIRS) {
    const dirSegments = dir.split("/").filter(Boolean);
    // 目录本身或其任意子路径（如 .git/config、node_modules/pkg/index.js）都受保护；
    // packages/contracts/gen 这类多段目录按连续片段匹配。
    for (let i = 0; i + dirSegments.length <= segments.length; i += 1) {
      if (dirSegments.every((segment, offset) => segments[i + offset] === segment)) return true;
    }
  }
  return false;
}

/** 写入前置判定：返回命中原因；null 表示普通路径。 */
export function sensitivePathReason(p: string): "sensitive" | "protected" | null {
  if (isSensitivePath(p)) return "sensitive";
  if (isProtectedSourceDir(p)) return "protected";
  return null;
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
