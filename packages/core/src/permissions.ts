/**
 * 权限策略（设置 · 权限）：工具类别默认决策（纯逻辑）。
 * 语义：allow = 直接执行；confirm = 每次询问（走 PermRequestBus）；deny = 直接拒绝。
 * 为什么按「类别」而不是「工具名」：工具会随插件增减，按类别才能得到稳定的心智模型；
 * 具体敏感工具再由硬规则（hard_rules）兜底，两层互不替代。
 *
 * 「浏览器操作」（browser）为什么值得单独一档：浏览器动作本质联网，但它比 network 更具体——
 * network 是「抓网页 / 调外部服务」的粗粒度授权，browser 才是「Agent 操控内嵌浏览器」这件事本身。
 * 分开之后 network 可以继续保持 confirm（抓取陌生 URL 仍值得问），而浏览器连续动作不必每步弹窗。
 * 为什么 browser 默认 allow：会话级「浏览器控制」开关本身就是显式授权（默认关，用户打开后模型才看得见
 * browser_* 工具），每一步再确认一次属于重复授权，长任务跑不动。**这不等于全放开**：
 * 登录 / 支付 / 不可撤销动作由 core/sensitiveSteps 的「写死确认」逐次拦截（见 services/chat.ts 的
 * forceSensitiveConfirm），即使 browser=allow 也每次都问；用户也可随时在「设置 · 权限」把 browser 改成 confirm / deny。
 */
import { z } from "zod";

export const PermissionDecisionSchema = z.enum(["allow", "confirm", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionsSchema = z.object({
  read: PermissionDecisionSchema,
  write: PermissionDecisionSchema,
  terminal: PermissionDecisionSchema,
  network: PermissionDecisionSchema,
  /**
   * 浏览器操作（Agent 操控内嵌浏览器）：策略层独立档位，比 network 更具体。
   * 沙箱层不新增档位——browser 工具在沙箱仍按 network（L4）判定，见 services/chat.ts 的 kindOfTool。
   */
  browser: PermissionDecisionSchema,
  workspaceRoots: z.array(z.string().max(1024)).max(20),
  confirmDangerousAlways: z.boolean(),
});

export type Permissions = z.infer<typeof PermissionsSchema>;

/** 默认策略：读放开、写/命令/网络每次确认、危险操作始终确认（fail-closed 基线）。 */
export const DEFAULT_PERMISSIONS: Permissions = {
  read: "allow",
  write: "confirm",
  terminal: "confirm",
  network: "confirm",
  // 浏览器操作默认 allow：会话级「浏览器控制」开关已是显式授权（默认关），每步再确认属于重复授权。
  // 兜底仍在：登录 / 支付 / 不可撤销动作由 sensitiveSteps 逐次强制确认（browser=allow 不放行敏感步骤）。
  browser: "allow",
  workspaceRoots: [],
  confirmDangerousAlways: true,
};

export function mergePermissions(raw: unknown): Permissions {
  const merged = { ...DEFAULT_PERMISSIONS, ...(typeof raw === "object" && raw !== null ? raw : {}) };
  const parsed = PermissionsSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；");
    throw new Error(`权限配置非法：${detail}`);
  }
  // 去重 + 去空 + 规范化（保持用户输入顺序，UI 展示更直观）
  const roots = [...new Set(parsed.data.workspaceRoots.map((r) => r.trim()).filter(Boolean))];
  return { ...parsed.data, workspaceRoots: roots };
}

/** 供 UI 展示的类别元信息（名称/说明/影响面）。 */
export const PERMISSION_CATEGORIES = [
  { key: "read", label: "读取文件", description: "读取工作目录内文件内容" },
  { key: "write", label: "写入文件", description: "新建、修改、删除文件" },
  { key: "terminal", label: "执行命令", description: "在本机运行命令行程序" },
  { key: "browser", label: "浏览器操作", description: "Agent 操控内嵌浏览器：点击、输入、按键、下拉、悬停、切换标签" },
  { key: "network", label: "网络访问", description: "抓取网页、调用外部服务" },
] as const;

/**
 * 工具权限声明 → 权限类别（策略层判定用）。
 *
 * browser 在 terminal / network **之前**判：它更具体（浏览器动作既联网又属于「浏览器操作」档），
 * 声明了 browser 的工具不应该被 network 这个粗粒度类别接走——否则 browser 档永远不生效。
 * 注意与沙箱分层：类别只决定策略，沙箱等级仍由 services/chat.ts 的 kindOfTool 推导（browser → network/L4）。
 */
export function categoryForToolPermissions(
  permissions?: Record<string, unknown>,
): "read" | "write" | "terminal" | "network" | "browser" {
  if (!permissions) return "read";
  if (permissions.browser) return "browser";
  if (permissions.terminal) return "terminal";
  if (permissions.network) return "network";
  if (permissions.write) return "write";
  return "read";
}

/** 取某类别当前决策（供执行器在沙箱之前先做 Agent 层判定）。 */
export function decisionFor(
  permissions: Permissions,
  category: "read" | "write" | "terminal" | "network" | "browser",
): PermissionDecision {
  return permissions[category];
}

/* ───────────────────── 权限等级 L0–L5（形式化分级） ───────────────────── */

/**
 * 沙箱等级与 core/sandbox.ts 的 `SandboxLevel` 是**同一刻度**（0–5），这里补的是「命名 + 元信息」。
 * 为什么不直接 import sandbox 的 SandboxLevel：permissions 是纯策略层，sandbox 是执行层，
 * 策略反向依赖执行器会让「策略可单测」变成「策略依赖实现」；两处一致性由
 * tests/core/permissionLevels.spec.ts 断言（levelForPermissionKind 必须与 kindToLevel 逐项相等）。
 */
export const SANDBOX_LEVELS = {
  0: "L0_READ",
  1: "L1_INSPECT",
  2: "L2_WRITE",
  3: "L3_EXEC",
  4: "L4_NETWORK",
  5: "L5_SYSTEM",
} as const;

/** 0=L0_READ … 5=L5_SYSTEM（数字即优先级刻度，可直接比较大小）。 */
export type PermissionLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface PermissionLevelMeta {
  level: PermissionLevel;
  name: string;
  zh: string;
  en: string;
  description: string;
}

/** 供 UI / 诊断 / 报告直接展示的分级元信息（顺序即 0→5）。 */
export const PERMISSION_LEVELS: readonly PermissionLevelMeta[] = [
  {
    level: 0,
    name: SANDBOX_LEVELS[0],
    zh: "读取",
    en: "read",
    description: "读取工作目录内文件内容（无副作用）",
  },
  {
    level: 1,
    name: SANDBOX_LEVELS[1],
    zh: "查看/探测",
    en: "inspect",
    description: "页面快照、列表、状态、历史等只读探测（仍无副作用）",
  },
  {
    level: 2,
    name: SANDBOX_LEVELS[2],
    zh: "写入",
    en: "write",
    description: "新建、修改、删除工作区内文件",
  },
  {
    level: 3,
    name: SANDBOX_LEVELS[3],
    zh: "执行命令",
    en: "exec",
    description: "在本机运行命令行程序（副作用取决于命令）",
  },
  {
    level: 4,
    name: SANDBOX_LEVELS[4],
    zh: "网络访问",
    en: "network",
    description: "抓取网页、调用外部服务、浏览器导航与点击",
  },
  {
    level: 5,
    name: SANDBOX_LEVELS[5],
    zh: "系统级",
    en: "system",
    description: "系统/不可归类操作：默认强制拒绝（fail-closed）",
  },
] as const;

/** 只读但「查看/探测」语义的工具名特征（read 类内部分 L0 与 L1）。 */
const INSPECT_TOOL_NAME_RE = /(snapshot|inspect|scroll|list|stat|exists|search|grep|glob|history|tabs|status|diagnostic|describe)/i;

/** 工具权限声明的最小形状（与 core/tools/registry.ts 的 ToolPermissions 结构兼容）。 */
export interface PermissionFlags {
  read?: boolean;
  write?: boolean;
  terminal?: boolean;
  network?: boolean;
  /** 浏览器操作（Agent 操控内嵌浏览器）：策略层独立档，沙箱等级仍按 network/L4。 */
  browser?: boolean;
}

/** 权限类别 → 等级（与 sandbox.kindToLevel 严格一致：read=0 / write=2 / terminal=3 / network=4）。 */
export function levelForPermissionKind(kind: "read" | "write" | "terminal" | "network"): PermissionLevel {
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

/**
 * 工具声明 → 权限等级（与 categoryForToolPermissions 同优先级：browser > terminal > network > write > read）。
 * browser 没有独立等级：沙箱刻度只有 L0–L5，浏览器动作就是 L4 网络访问（策略层才区分 browser 与 network）；
 * 这里放在最前，保证与 categoryForToolPermissions 的归类顺序一致（同一个工具两处不会给出矛盾答案）。
 * read 类再细分：纯读取 = L0；快照/列表/历史等「查看」类 = L1（两者在 DEFAULT_LEVEL_POLICY 都是 auto，
 * 分级只用于展示与审计，不改变放行行为）。没有任何已知标志位 = 无法归类 → L5（fail-closed）。
 */
export function levelForTool(toolName: string, permissions?: PermissionFlags | null): PermissionLevel {
  if (!permissions) return 5;
  if (permissions.browser) return 4;
  if (permissions.terminal) return 3;
  if (permissions.network) return 4;
  if (permissions.write) return 2;
  if (permissions.read) return INSPECT_TOOL_NAME_RE.test(toolName) ? 1 : 0;
  return 5;
}
