/**
 * 权限策略（设置 · 权限）：工具类别默认决策（纯逻辑）。
 * 语义：allow = 直接执行；confirm = 每次询问（走 PermRequestBus）；deny = 直接拒绝。
 * 为什么按「类别」而不是「工具名」：工具会随插件增减，按类别才能得到稳定的心智模型；
 * 具体敏感工具再由硬规则（hard_rules）兜底，两层互不替代。
 */
import { z } from "zod";

export const PermissionDecisionSchema = z.enum(["allow", "confirm", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionsSchema = z.object({
  read: PermissionDecisionSchema,
  write: PermissionDecisionSchema,
  terminal: PermissionDecisionSchema,
  network: PermissionDecisionSchema,
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
  { key: "network", label: "网络访问", description: "抓取网页、调用外部服务" },
] as const;
