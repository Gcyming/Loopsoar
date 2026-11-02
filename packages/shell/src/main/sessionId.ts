/**
 * 会话 ID 净化（单一入口）。
 *
 * 为什么需要：sessionId 来自 IPC 入参，而会话持久化会把它直接拼进
 * `path.join(dataDir/sessions, `${id}.json`)`。`..`、`/`、`\` 这类字符一旦进入拼接，
 * 就能把「写会话文件」变成「任意路径写文件」。契约层（SESSION_ID_RE）已经收紧 IPC 入参，
 * 这里是落盘前的最后一道：只校验、不修正（fail-closed），绝不把非法输入「净化后」使用。
 */
import { SESSION_ID_RE } from "loopsoar-contracts/schemas";

/** 与契约 SessionIdSchema 的 max(120) 保持一致。 */
const SESSION_ID_MAX_LENGTH = 120;

/**
 * 校验并返回可安全用于文件名的会话 ID；非法返回 null。
 * 规则（与 contracts 的 SessionIdSchema 同源，另显式拒绝 "."/".."）：
 *   - 非空字符串，长度 ≤ 120；
 *   - 首字符必须是字母或数字（因此 "." / ".." / "_x" 天然非法，仍显式判定便于阅读）；
 *   - 其余仅允许 [A-Za-z0-9._-]（不含路径分隔符、空白、中文等）；
 *   - 不得为 "." 或 ".."（防止 `path.join(dir, "../..")` 逃逸）。
 * 不做 trim / 字符替换：静默修正可能让两个不同输入落进同一个文件名，且掩盖攻击尝试。
 */
export function sanitizeSessionId(id: string | null | undefined): string | null {
  if (typeof id !== "string") return null;
  if (id.length === 0 || id.length > SESSION_ID_MAX_LENGTH) return null;
  if (id === "." || id === "..") return null;
  if (!SESSION_ID_RE.test(id)) return null;
  return id;
}

/**
 * 要求合法会话 ID：非法一律抛可读错误（调用方负责转成 IPC 错误/日志，绝不落盘）。
 * 报错只回显前 80 字符，避免超长入参刷屏日志。
 */
export function requireSessionId(id: string | null | undefined): string {
  const safe = sanitizeSessionId(id);
  if (safe !== null) return safe;
  const shown = typeof id === "string" ? `"${id.slice(0, 80)}"` : String(id);
  throw new Error(
    `非法会话 ID：${shown}（要求：字母或数字开头，仅含字母/数字/. _ -，长度 1~120，且不得为 "." 或 ".."）`,
  );
}
