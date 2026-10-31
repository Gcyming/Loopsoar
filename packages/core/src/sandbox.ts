/**
 * 沙箱管理器（§4.3 S4 安全核心，fail-closed）。
 * 八步决策链（顺序即优先级，任一拒绝不可被上层覆盖）：
 *   ① 白名单目录命中 → allow
 *   ② 目标越出工作目录且未授权 → deny
 *   ③ 异常检测（写频率 >100/min、危险命令正则、循环 >1000）→ deny
 *   ④ deny_tools → deny
 *   ⑤ require_approval_tools → confirm
 *   ⑥ auto_approve_tools 或会话白名单（approveToolForSession）→ allow
 *   ⑦ 按当前安全等级策略（DEFAULT_LEVEL_POLICY）：auto→allow / deny→deny / confirm→confirm
 *   ⑧ 兜底 → deny（fail-closed；未知工具名也是 deny，不抛错——「判不了≠不存在」在注册表层区分）
 */
import path from "node:path";
import { hardRuleCheck } from "./tools/hard_rules.js";

export type SandboxLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** L0 纯读取 / L1 查看信息 自动；L2 改文件 / L3 执行命令 / L4 网络 需确认；L5 系统操作 强制拒绝。 */
export const DEFAULT_LEVEL_POLICY: Record<SandboxLevel, "auto" | "confirm" | "deny"> = {
  0: "auto",
  1: "auto",
  2: "confirm",
  3: "confirm",
  4: "confirm",
  5: "deny",
};

export type PermissionKind = "read" | "write" | "terminal" | "network";

/** kind → 沙箱等级（系统操作 L5 由目标/工具显式指定，本表仅按 kind 兜底推导）。 */
export function kindToLevel(kind: PermissionKind): SandboxLevel {
  switch (kind) {
    case "read":
      return 0;
    case "write":
      return 2;
    case "terminal":
      return 3;
    case "network":
      return 4;
  }
}

export interface SandboxDecision {
  action: "allow" | "confirm" | "deny";
  level: SandboxLevel;
  reason: string;
}

export interface PermissionReq {
  agentId: string;
  toolName: string;
  target?: string;
  kind: PermissionKind;
}

export class SandboxManager {
  private workspaceRoot: string = process.cwd();
  private allowedDirs: string[] = [];
  private sessionApprovals = new Map<string, Set<string>>(); // agentId -> toolNames
  private denyTools = new Set<string>();
  private requireApprovalTools = new Set<string>();
  private autoApproveTools = new Set<string>();
  private writeHistory = new Map<string, number[]>(); // agentId -> 写操作时间戳
  private terminalCount = new Map<string, number>(); // agentId -> 终端调用计数
  private knownTools = new Set<string>(); // 已装配工具名（由 ToolRegistry 同步）
  private assemblyDone = false; // 「判不了 ≠ 不存在」：未装配完成时不因空清单而全拒

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  addAllowedDir(dir: string): void {
    this.allowedDirs.push(dir);
  }

  /** 会话白名单：用户点「本次会话总是允许」后，同 Agent 同工具不再询问。 */
  approveToolForSession(agentId: string, toolName: string): void {
    if (!this.sessionApprovals.has(agentId)) this.sessionApprovals.set(agentId, new Set());
    this.sessionApprovals.get(agentId)!.add(toolName);
  }

  addDenyTool(tool: string): void {
    this.denyTools.add(tool);
  }

  addRequireApprovalTool(tool: string): void {
    this.requireApprovalTools.add(tool);
  }

  addAutoApproveTool(tool: string): void {
    this.autoApproveTools.add(tool);
  }

  /** 由装配层（ToolRegistry）同步已知工具清单；同步完成后未知工具名一律 deny。 */
  syncKnownTools(names: string[]): void {
    this.knownTools = new Set(names);
    this.assemblyDone = true;
  }

  private norm(p: string): string {
    return p.replace(/\\/g, "/");
  }

  private isInsideWorkspace(p?: string): boolean {
    if (!p) return true;
    const root = path.resolve(this.workspaceRoot);
    // 相对路径按工作区根解析（工具参数通常给相对路径；不解析会永远判"越界"）
    const target = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
    const normRoot = this.norm(root);
    const normTarget = this.norm(target);
    return normTarget === normRoot || normTarget.startsWith(normRoot + "/");
  }

  private isWhitelistedDir(p?: string): boolean {
    if (!p) return false;
    const t = this.norm(p);
    return this.allowedDirs.some((d) => {
      const n = this.norm(d);
      return t === n || t.startsWith(n + "/");
    });
  }

  /** 异常检测：三条规则真正生效（写频率、危险命令、循环），任何命中即拒。 */
  private checkAnomaly(agentId: string, kind: PermissionKind, target?: string): string | null {
    if (kind === "write") {
      const now = Date.now();
      const window = (this.writeHistory.get(agentId) ?? []).filter((t) => now - t < 60_000);
      window.push(now);
      this.writeHistory.set(agentId, window);
      if (window.length > 100) return "写入频率超过 100 次/分钟";
    }
    if (kind === "terminal") {
      const count = (this.terminalCount.get(agentId) ?? 0) + 1;
      this.terminalCount.set(agentId, count);
      if (count > 1000) return "循环操作超过 1000 次";
      if (typeof target === "string" && target.length > 0) {
        const r = hardRuleCheck(target);
        if (r.blocked) return `危险命令：${r.reason ?? ""}`;
      }
    }
    return null;
  }

  checkPermission(req: PermissionReq): SandboxDecision {
    const { agentId, toolName, target, kind } = req;
    const level = kindToLevel(kind);

    // ① 白名单目录命中 → 放行
    if (this.isWhitelistedDir(target)) {
      return { action: "allow", level: 0, reason: "白名单目录命中" };
    }

    // ② 目标越出工作目录且未授权 → 拒绝（terminal 的 target 是命令串，不做路径越界判定）
    if (
      kind !== "terminal" &&
      target &&
      !this.isInsideWorkspace(target) &&
      !this.isWhitelistedDir(target)
    ) {
      return { action: "deny", level: 5, reason: "目标越出工作目录且未授权" };
    }

    // ③ 异常检测 → 拒绝
    const anomaly = this.checkAnomaly(agentId, kind, target);
    if (anomaly) {
      return { action: "deny", level: 5, reason: `异常检测：${anomaly}` };
    }

    // ③.5 未知工具名 → deny（不抛错）；「判不了 ≠ 不存在」：未装配完成时不据此拒绝
    if (this.assemblyDone && !this.knownTools.has(toolName)) {
      return { action: "deny", level: 5, reason: "未知工具名（不在注册表）" };
    }

    // ④ deny_tools → 拒绝
    if (this.denyTools.has(toolName)) {
      return { action: "deny", level: 5, reason: "工具在 deny 列表" };
    }

    // ⑤ require_approval_tools → 需确认
    if (this.requireApprovalTools.has(toolName)) {
      return { action: "confirm", level, reason: "工具需要人工确认" };
    }

    // ⑥ auto_approve_tools 或会话白名单 → 放行
    const sessionApproved = this.sessionApprovals.get(agentId)?.has(toolName) ?? false;
    if (this.autoApproveTools.has(toolName) || sessionApproved) {
      return { action: "allow", level, reason: sessionApproved ? "会话白名单" : "自动批准" };
    }

    // ⑦ 按等级策略（L5 强制拒绝、L0/L1 自动、其余确认）
    const policy = DEFAULT_LEVEL_POLICY[level];
    if (policy === "auto") return { action: "allow", level, reason: `L${level} 自动批准` };
    if (policy === "deny") return { action: "deny", level, reason: `L${level} 强制拒绝` };
    return { action: "confirm", level, reason: `L${level} 需要确认` };
  }
}
