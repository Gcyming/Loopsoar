/**
 * 沙箱管理器（§4.3 S4 安全核心，fail-closed）。
 * 八步决策链（顺序即优先级，任一拒绝不可被上层覆盖）：
 *   ① 白名单目录命中 → allow
 *   ② 目标越出工作目录且未授权 → deny
 *   ③ 异常检测（写频率 >100/min、危险命令正则、循环 >1000）→ deny
 *   ④ deny_tools → deny
 *   ⑤ require_approval_tools → confirm
 *   ⑥ auto_approve_tools 或会话白名单（按 sessionId + agentId）→ allow
 *   ⑦ 按当前安全等级策略（DEFAULT_LEVEL_POLICY）：auto→allow / deny→deny / confirm→confirm
 *   ⑧ 兜底 → deny（fail-closed；未知工具名也是 deny，不抛错——「判不了≠不存在」在注册表层区分）
 */
import type { PathPort } from "./platform/types.js";
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
  /** 会话 id：会话白名单按 session+agent 隔离；缺省时退回旧的 agent 级白名单（兼容单测/旧装配）。 */
  sessionId?: string;
  toolName: string;
  target?: string;
  kind: PermissionKind;
}

/**
 * 单次判定的作用域覆盖（当前会话的工作根）。
 * 为什么不直接 setWorkspaceRoot 再判：SandboxManager 是进程级单例，多会话/多窗口并发工具调用时
 * 「先改全局根再判定」会互相串根（A 会话的写判定用到 B 会话的根）；作用域参数只影响本次判定，
 * 并发安全且不改变实例状态。
 */
export interface SandboxScope {
  /** 本次判定使用的工作根；缺省用实例全局根（setWorkspaceRoot 兼容路径）。 */
  workspaceRoot?: string;
}

export interface SandboxOptions {
  /**
   * 显式工作根：core 不再回落到 process.cwd()（DoD：找不到根就 fail-fast，不在核心猜）。
   * 装配层（shell）必须传入；按会话判定时仍可用 checkPermission 的 opts.workspaceRoot 覆盖。
   */
  workspaceRoot?: string;
  /** 路径能力注入（Node 装配用 nodePathPort）；缺失时任何越界判定直接抛错。 */
  paths?: PathPort;
}

export class SandboxManager {
  private workspaceRoot: string;
  private paths?: PathPort;
  private allowedDirs: string[] = [];
  /** key = `${sessionId}\0${agentId}`；无会话时用 `\0${agentId}` 兼容旧行为。 */
  private sessionApprovals = new Map<string, Set<string>>();
  private denyTools = new Set<string>();
  private requireApprovalTools = new Set<string>();
  private autoApproveTools = new Set<string>();
  private writeHistory = new Map<string, number[]>(); // `${sessionId}\0${agentId}` -> 写操作时间戳
  private terminalCount = new Map<string, number>(); // `${sessionId}\0${agentId}` -> 终端调用计数
  private knownTools = new Set<string>(); // 已装配工具名（由 ToolRegistry 同步）
  private assemblyDone = false; // 「判不了 ≠ 不存在」：未装配完成时不因空清单而全拒

  constructor(opts: SandboxOptions = {}) {
    this.workspaceRoot = opts.workspaceRoot?.trim() ?? "";
    this.paths = opts.paths;
  }

  /** 设置实例级默认工作根（兼容旧装配）。按会话判定时应改用 checkPermission 的 opts.workspaceRoot。 */
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  addAllowedDir(dir: string): void {
    this.allowedDirs.push(dir);
  }

  /** 替换额外授权目录（设置页保存权限后即时生效；传空数组 = 撤销全部额外授权）。 */
  setAllowedDirs(dirs: string[]): void {
    this.allowedDirs = dirs.map((dir) => dir.trim()).filter(Boolean);
  }

  /** 会话白名单 key：会话 + Agent 双维度，避免 A 会话的授权泄漏到 B 会话。 */
  private approvalKey(agentId: string, sessionId?: string): string {
    return `${sessionId ?? ""}\u0000${agentId}`;
  }

  /** 会话白名单：用户点「本次会话总是允许」后，同会话同 Agent 同工具不再询问。 */
  approveToolForSession(agentId: string, toolName: string, sessionId?: string): void {
    const key = this.approvalKey(agentId, sessionId);
    if (!this.sessionApprovals.has(key)) this.sessionApprovals.set(key, new Set());
    this.sessionApprovals.get(key)!.add(toolName);
  }

  /** 删除会话时清理该会话的全部会话白名单（不传则保持旧行为，不清）。 */
  clearSessionApprovals(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of [...this.sessionApprovals.keys()]) {
      if (key.startsWith(prefix)) this.sessionApprovals.delete(key);
    }
    // 限流历史同样按会话隔离；会话删除后一并清掉，避免内存驻留和同 id 重建时继承旧计数。
    for (const key of [...this.writeHistory.keys()]) {
      if (key.startsWith(prefix)) this.writeHistory.delete(key);
    }
    for (const key of [...this.terminalCount.keys()]) {
      if (key.startsWith(prefix)) this.terminalCount.delete(key);
    }
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

  private isInsideWorkspace(p: string | undefined, workspaceRoot: string): boolean {
    if (!p) return true;
    const configuredRoot = workspaceRoot.trim();
    if (!configuredRoot) {
      throw new Error("SandboxManager：未配置 workspaceRoot（core 不再回落到 process.cwd()）");
    }
    const paths = this.paths;
    if (!paths) throw new Error("SandboxManager：未注入 PathPort，无法判定路径越界");
    const root = paths.resolve(configuredRoot);
    // 相对路径按工作区根解析（工具参数通常给相对路径；不解析会永远判"越界"）
    const target = paths.isAbsolute(p) ? paths.resolve(p) : paths.resolve(root, p);
    const normRoot = this.norm(root);
    const normTarget = this.norm(target);
    return normTarget === normRoot || normTarget.startsWith(normRoot + "/");
  }

  private isWhitelistedDir(p?: string, scopeRoot?: string): boolean {
    if (!p) return false;
    // 工具参数常是相对路径；先按本次判定的工作根解析，否则白名单永远匹配不到。
    const paths = this.paths;
    const base = scopeRoot?.trim() || this.workspaceRoot;
    const t = this.norm(paths && !paths.isAbsolute(p) && base ? paths.resolve(base, p) : p);
    return this.allowedDirs.some((d) => {
      const n = this.norm(d);
      return t === n || t.startsWith(n + "/");
    });
  }

  /** 异常检测：三条规则真正生效（写频率、危险命令、循环），任何命中即拒。 */
  private checkAnomaly(agentId: string, kind: PermissionKind, target?: string, sessionId?: string): string | null {
    const key = this.approvalKey(agentId, sessionId);
    if (kind === "write") {
      const now = Date.now();
      const window = (this.writeHistory.get(key) ?? []).filter((t) => now - t < 60_000);
      window.push(now);
      this.writeHistory.set(key, window);
      if (window.length > 100) return "写入频率超过 100 次/分钟";
    }
    if (kind === "terminal") {
      const count = (this.terminalCount.get(key) ?? 0) + 1;
      this.terminalCount.set(key, count);
      if (count > 1000) return "循环操作超过 1000 次";
      if (typeof target === "string" && target.length > 0) {
        const r = hardRuleCheck(target);
        if (r.blocked) return `危险命令：${r.reason ?? ""}`;
      }
    }
    return null;
  }

  /**
   * 八步决策链。opts.workspaceRoot 只影响本次判定的越界检查，不回写实例全局根
   * （保留 setWorkspaceRoot 兼容旧装配：未传作用域时仍用全局根）。
   */
  checkPermission(req: PermissionReq, opts?: SandboxScope): SandboxDecision {
    const { agentId, sessionId, toolName, target, kind } = req;
    const level = kindToLevel(kind);
    // 显式传入且非空才覆盖；空串视为未传（fail-safe，避免把根解析成 cwd 之外的空路径）
    const scopeRoot = opts?.workspaceRoot?.trim() ? opts.workspaceRoot : this.workspaceRoot;

    // ① 白名单目录命中 → 放行
    if (this.isWhitelistedDir(target, scopeRoot)) {
      return { action: "allow", level: 0, reason: "白名单目录命中" };
    }

    // ② 目标越出工作目录且未授权 → 拒绝（terminal 的 target 是命令串，不做路径越界判定）
    if (
      kind !== "terminal" &&
      target &&
      !this.isInsideWorkspace(target, scopeRoot) &&
      !this.isWhitelistedDir(target, scopeRoot)
    ) {
      return { action: "deny", level: 5, reason: "目标越出工作目录且未授权" };
    }

    // ③ 异常检测 → 拒绝
    const anomaly = this.checkAnomaly(agentId, kind, target, sessionId);
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
    const sessionApproved = this.sessionApprovals.get(this.approvalKey(agentId, sessionId))?.has(toolName) ?? false;
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
