/** 设置页侧栏分区定义（与 Settings.tsx 分离，控制组合根行数）。 */
export type SectionId =
  | "general"
  | "searchengine"
  | "appearance"
  | "permissions"
  | "providers"
  | "rules"
  | "loop"
  | "schedules"
  | "skills"
  | "memory"
  | "extensions"
  | "browser-extensions"
  | "mcp"
  | "terminal-env"
  | "storage"
  | "advanced"
  | "about";

export type SectionGroup = "basic" | "agent" | "integrations" | "data" | "other";

/**
 * 侧栏分区：group 为分组 key（渲染时再翻译，避免语言切换后仍是旧语言）。
 * 排序原则（用户 2026-11-28 反馈）：
 *   1. 越宽泛的越靠上（通用 → 外观 → 搜索 → 权限）；
 *   2. 功能相近的相邻（供应商/规则/Loop/技能/记忆 同属 Agent 能力；
 *      MCP/扩展/浏览器扩展 同属「连接与扩展」；定时/终端/存储 同属「数据与运行」）。
 */
export const SECTIONS: { id: SectionId; icon: string; group: SectionGroup }[] = [
  { id: "general", group: "basic", icon: "settings" },
  { id: "appearance", group: "basic", icon: "capture" },
  { id: "searchengine", group: "basic", icon: "search" },
  { id: "permissions", group: "basic", icon: "check" },
  { id: "providers", group: "agent", icon: "cloud-upload" },
  { id: "rules", group: "agent", icon: "file" },
  { id: "loop", group: "agent", icon: "agent" },
  { id: "skills", group: "agent", icon: "bulb" },
  { id: "memory", group: "agent", icon: "notes" },
  { id: "mcp", group: "integrations", icon: "terminal" },
  { id: "extensions", group: "integrations", icon: "extension-feature" },
  { id: "browser-extensions", group: "integrations", icon: "browser-plugin" },
  { id: "schedules", group: "data", icon: "clock" },
  { id: "terminal-env", group: "data", icon: "terminal" },
  { id: "storage", group: "data", icon: "folders" },
  { id: "advanced", group: "other", icon: "terminal" },
  { id: "about", group: "other", icon: "bulb" },
];
