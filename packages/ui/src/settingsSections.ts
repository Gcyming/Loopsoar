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

/** 侧栏分区：group 为分组 key（渲染时再翻译，避免语言切换后仍是旧语言）。 */
export const SECTIONS: { id: SectionId; icon: string; group: "basic" | "capability" | "data" | "other" }[] = [
  { id: "general", group: "basic", icon: "settings" },
  { id: "searchengine", group: "basic", icon: "search" },
  { id: "appearance", group: "basic", icon: "capture" },
  { id: "permissions", group: "basic", icon: "check" },
  { id: "providers", group: "capability", icon: "cloud-upload" },
  { id: "rules", group: "capability", icon: "file" },
  { id: "loop", group: "capability", icon: "agent" },
  { id: "schedules", group: "capability", icon: "clock" },
  { id: "skills", group: "capability", icon: "bulb" },
  { id: "memory", group: "capability", icon: "notes" },
  { id: "extensions", group: "capability", icon: "extension-feature" },
  { id: "browser-extensions", group: "capability", icon: "browser-plugin" },
  { id: "mcp", group: "capability", icon: "terminal" },
  { id: "terminal-env", group: "data", icon: "terminal" },
  { id: "storage", group: "data", icon: "folders" },
  { id: "advanced", group: "data", icon: "terminal" },
  { id: "about", group: "other", icon: "bulb" },
];
