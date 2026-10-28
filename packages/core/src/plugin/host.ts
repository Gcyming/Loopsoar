/**
 * 插件宿主（ADR-0011 万物皆插件）：装载 / 卸载 / 工具贡献。
 * 为什么内核只留宿主：内置功能也以插件形态存在（builtin 来源），只有内核四件不可卸载；
 * 卸载走 ContributionScope 逆序 dispose，保证「卸下即恢复」，不残留半截贡献。
 */
import type { PluginManifest } from "./manifest.js";
import { validateManifest } from "./manifest.js";
import { ContributionScope, type ContributionHandle } from "./scope.js";

/** 插件可贡献的工具形状（真实注册进 ToolRegistry 的最小信息）。 */
export interface PluginToolContribution {
  name: string;
  description: string;
  permissions: Record<string, boolean>;
  [key: string]: unknown;
}

export interface LoadEntry {
  manifest: PluginManifest;
  contributions?: ContributionHandle[];
}

/** builtin 来源 = 系统根：不可被插件机制卸载（防插件误撤内核能力）。 */
export function isSystemRoot(m: PluginManifest): boolean {
  return m.origin === "builtin";
}

export class PluginHost {
  private manifests = new Map<string, PluginManifest>();
  private scopes = new Map<string, ContributionScope>();
  private tools = new Map<string, PluginToolContribution[]>();
  private order: string[] = [];
  private fallbackErrors: string[] = [];

  constructor(private opts: { onContributionError?: (plugin: string, errors: string[]) => void } = {}) {}

  /** 装载单个插件：清单校验 → 依赖已装载校验 → 贡献点入作用域。 */
  load(entry: LoadEntry): void {
    const m = entry.manifest;
    const errors = validateManifest(m);
    if (errors.length > 0) {
      throw new Error(`插件 ${m.name} 清单非法：${errors.join("；")}`);
    }
    if (this.manifests.has(m.name)) {
      throw new Error(`插件 ${m.name} 已装载`);
    }
    for (const dep of m.requires ?? []) {
      if (!this.manifests.has(dep)) {
        throw new Error(`插件 ${m.name} 依赖 ${dep} 未装载（请按拓扑顺序装载）`);
      }
    }
    const scope = new ContributionScope();
    for (const c of entry.contributions ?? []) {
      scope.register(c);
    }
    this.scopes.set(m.name, scope);
    this.manifests.set(m.name, m);
    this.order.push(m.name);
  }

  /** 批量装载：按 requires 拓扑排序；环 ⇒ 抛「依赖环」。 */
  loadAll(entries: LoadEntry[]): void {
    const byName = new Map(entries.map((e) => [e.manifest.name, e]));
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string, chain: string[]): void => {
      if (done.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`插件依赖环：${[...chain, name].join(" -> ")}`);
      }
      const entry = byName.get(name);
      if (!entry) throw new Error(`依赖缺失：${name}`);
      visiting.add(name);
      for (const dep of entry.manifest.requires ?? []) {
        visit(dep, [...chain, name]);
      }
      visiting.delete(name);
      this.load(entry);
      done.add(name);
    };
    for (const e of entries) visit(e.manifest.name, []);
  }

  /** 卸载：builtin 拒绝；逆序 dispose 并返回错误列表（单失败不阻断）。 */
  unload(name: string): string[] {
    const m = this.manifests.get(name);
    if (!m) return [`插件 ${name} 未装载`];
    if (isSystemRoot(m)) return [`插件 ${name} 是 builtin（系统根），不可卸载`];
    const scope = this.scopes.get(name);
    const errors = scope ? scope.disposeAll() : [];
    if (errors.length > 0) this.opts.onContributionError?.(name, errors);
    this.scopes.delete(name);
    this.manifests.delete(name);
    this.tools.delete(name);
    this.order = this.order.filter((n) => n !== name);
    return errors;
  }

  /**
   * 登记插件的工具贡献（true implementation，修 slime 断点 B-4：registerTools 不许空数组占位）。
   * 实际注册进 ToolRegistry 由装配层调用 toolsProvider() 后完成（宿主不直接依赖 registry，避免循环依赖）。
   */
  registerTools(name: string, tools: PluginToolContribution[]): void {
    const m = this.manifests.get(name);
    if (!m) throw new Error(`插件 ${name} 未装载，不能登记工具贡献`);
    if (!m.provides.includes("tools")) throw new Error(`插件 ${name} 未声明 provides: tools`);
    this.tools.set(name, tools);
  }

  /** 取插件工具贡献；未声明的插件返回 null（不是空数组——「没有」与「空」要区分）。 */
  toolsProvider(name: string): PluginToolContribution[] | null {
    return this.tools.get(name) ?? null;
  }

  list(): PluginManifest[] {
    return [...this.manifests.values()];
  }

  /** 装载顺序（拓扑序），供卸载规划和审计。 */
  loadOrder(): string[] {
    return [...this.order];
  }

  /** 系统根清单（可观测：哪些 builtin 插件在运行）。 */
  systemRoots(): PluginManifest[] {
    return this.list().filter(isSystemRoot);
  }
}
