/**
 * 插件清单（ADR-0011 万物皆插件）：manifest 的声明与校验。
 * 为什么先校验后装载：裸装载会让 manifest 里的未知键/自引用/非法 provides 变成运行期炸弹；
 * 校验集中在入口，错误以「可读错误列表」返回（空数组=合法），装载器负责拒绝。
 */

/** 插件名：小写字母数字 + 连字符（^[a-z0-9]+(-[a-z0-9]+)*$）。 */
export const PLUGIN_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 贡献点白名单（slime 八类 + loop/omnibox/agent-template）。 */
export const PROVIDES_KEYS = [
  "tools",
  "skills",
  "loop",
  "mode",
  "settings",
  "ui",
  "page",
  "views",
  "theme",
  "themes",
  "css",
  "scripts",
  "omnibox",
  "agent-template",
] as const;

export type ProvidesKey = (typeof PROVIDES_KEYS)[number];

/** contributes 只允许已知键（未知键即拒）。 */
export const CONTRIBUTES_KEYS = ["settings", "ui", "scripts", "page", "theme", "themes", "css", "views"] as const;

export interface PluginManifest {
  /** 唯一名（同名装载冲突由 host 处理）。 */
  name: string;
  version: string;
  description?: string;
  /** builtin 由内核提供（不可卸载、不可被顶替）；user/agent 可卸载。 */
  origin: "builtin" | "user" | "agent";
  /** 声明提供的贡献点（非空、去重、禁自引）。 */
  provides: ProvidesKey[];
  /** 依赖的插件名（拓扑排序装载；环 ⇒ failed）。 */
  requires?: string[];
  /** 贡献声明（未知键即拒）。 */
  contributes?: Partial<Record<(typeof CONTRIBUTES_KEYS)[number], unknown>> & Record<string, unknown>;
}

/** 校验 manifest：返回错误列表（空 = 合法）。 */
export function validateManifest(m: PluginManifest): string[] {
  const errors: string[] = [];

  if (!m || typeof m !== "object") {
    return ["manifest 必须是对象"];
  }
  if (!PLUGIN_NAME_RE.test(m.name ?? "")) {
    errors.push(`插件名 "${m.name}" 不合法（要求 ^[a-z0-9]+(-[a-z0-9]+)*$）`);
  }
  if (!m.version) errors.push("缺少 version");
  if (m.origin !== "builtin" && m.origin !== "user" && m.origin !== "agent") {
    errors.push(`origin "${String(m.origin)}" 不合法（builtin|user|agent）`);
  }
  if (!Array.isArray(m.provides) || m.provides.length === 0) {
    errors.push("provides 不能为空");
  } else {
    const seen = new Set<string>();
    for (const p of m.provides) {
      if (!PROVIDES_KEYS.includes(p)) {
        errors.push(`provides 含未知贡献点 "${String(p)}"`);
      }
      if (seen.has(p)) {
        errors.push(`provides 重复 "${p}"`);
      }
      seen.add(p);
    }
  }
  if (m.requires) {
    if (!Array.isArray(m.requires)) {
      errors.push("requires 必须是数组");
    } else if (m.requires.includes(m.name)) {
      errors.push("requires 不得自引（含自身名）");
    }
  }
  if (m.contributes) {
    if (typeof m.contributes !== "object" || Array.isArray(m.contributes)) {
      errors.push("contributes 必须是对象");
    } else {
      for (const key of Object.keys(m.contributes)) {
        if (!CONTRIBUTES_KEYS.includes(key as (typeof CONTRIBUTES_KEYS)[number])) {
          errors.push(`contributes 含未知键 "${key}"`);
        }
      }
    }
  }
  return errors;
}
