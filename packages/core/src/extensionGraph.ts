/**
 * 插件依赖图（纯逻辑）：版本校验、环检测、拓扑顺序、被依赖者索引。
 *
 * 设计原则：
 *   · 依赖只约束「启用」与「启动顺序」，不改变 npm 依赖安装（插件包自带代码）；
 *   · 任何无法满足的依赖都 fail-closed，并且错误会沿依赖链传播（A→B→缺失 C 时 A 也 blocked）；
 *   · 环不是「后到者覆盖」，而是整环 blocked 并给出可见的环路径。
 */
import { parseSemVer, satisfies } from "./semver.js";

export interface ExtensionGraphNode {
  id: string;
  version: string;
  dependencies?: Record<string, string>;
}

export type ExtensionGraphIssueCode =
  | "duplicate"
  | "self-dependency"
  | "missing-dependency"
  | "dependency-version"
  | "invalid-version"
  | "cycle";

export interface ExtensionGraphIssue {
  id: string;
  code: ExtensionGraphIssueCode;
  message: string;
  dependency?: string;
}

export interface ExtensionGraphResult {
  /** 依赖优先的拓扑顺序（只含未 blocked 的节点）。 */
  order: string[];
  issues: ExtensionGraphIssue[];
  /** 直接依赖某节点的扩展（用于禁用级联）。 */
  dependents: Record<string, string[]>;
  /** 自身或依赖链上有错误的节点。 */
  blocked: string[];
  cycles: string[][];
}

/**
 * 解析依赖图。输入为空返回空结果；重复 id 全部标记 duplicate（宿主扫描本应先去重，
 * 这里再守一层，避免调用方绕过宿主）。
 */
export function resolveExtensionGraph(nodes: readonly ExtensionGraphNode[]): ExtensionGraphResult {
  const issues: ExtensionGraphIssue[] = [];
  const byId = new Map<string, ExtensionGraphNode>();
  const duplicates = new Set<string>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      duplicates.add(node.id);
      continue;
    }
    byId.set(node.id, node);
  }
  for (const id of duplicates) {
    issues.push({ id, code: "duplicate", message: `扩展 id 重复：${id}` });
  }

  const dependents: Record<string, string[]> = {};
  for (const node of byId.values()) {
    const version = parseSemVer(node.version);
    if (!version) {
      issues.push({ id: node.id, code: "invalid-version", message: `扩展版本不是合法 SemVer：${node.version}` });
    }
    for (const [dep, range] of Object.entries(node.dependencies ?? {})) {
      if (!dependents[dep]) dependents[dep] = [];
      dependents[dep].push(node.id);
      if (dep === node.id) {
        issues.push({ id: node.id, code: "self-dependency", dependency: dep, message: "扩展不能依赖自身" });
        continue;
      }
      const target = byId.get(dep);
      if (!target) {
        issues.push({
          id: node.id,
          code: "missing-dependency",
          dependency: dep,
          message: `缺少依赖扩展 ${dep}（需要 ${range}）`,
        });
        continue;
      }
      const targetVersion = parseSemVer(target.version);
      if (!targetVersion) {
        issues.push({
          id: node.id,
          code: "dependency-version",
          dependency: dep,
          message: `依赖 ${dep} 的已安装版本非法：${target.version}`,
        });
        continue;
      }
      if (!satisfies(target.version, range)) {
        issues.push({
          id: node.id,
          code: "dependency-version",
          dependency: dep,
          message: `依赖 ${dep}@${target.version} 不满足 ${range}`,
        });
      }
    }
  }

  // 环检测：DFS 三色标记；发现回边时截取栈中的环。
  const cycles: string[][] = [];
  const stack: string[] = [];
  const stateById = new Map<string, "new" | "visiting" | "done">();
  const visit = (id: string): void => {
    const current = stateById.get(id) ?? "new";
    if (current === "done") return;
    if (current === "visiting") {
      const start = stack.indexOf(id);
      if (start >= 0) {
        const cycle = stack.slice(start);
        if (!cycles.some((existing) => existing.join(">") === cycle.join(">"))) cycles.push(cycle);
      }
      return;
    }
    stateById.set(id, "visiting");
    stack.push(id);
    const node = byId.get(id);
    for (const dep of Object.keys(node?.dependencies ?? {})) {
      if (byId.has(dep)) visit(dep);
    }
    stack.pop();
    stateById.set(id, "done");
  };
  for (const id of byId.keys()) visit(id);
  for (const cycle of cycles) {
    issues.push({
      id: cycle[0],
      code: "cycle",
      message: `依赖环：${[...cycle, cycle[0]].join(" → ")}`,
    });
  }

  const blocked = new Set<string>();
  for (const item of issues) blocked.add(item.id);
  for (const id of duplicates) blocked.add(id);

  // 依赖链传播：A 依赖 blocked B → A 也 blocked（直到不动点）。
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of byId.values()) {
      if (blocked.has(node.id)) continue;
      for (const dep of Object.keys(node.dependencies ?? {})) {
        if (blocked.has(dep)) {
          blocked.add(node.id);
          changed = true;
          break;
        }
      }
    }
  }

  // 拓扑排序（Kahn），只排未 blocked 的节点；同层按 id 排序保证确定性。
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const node of byId.values()) {
    if (blocked.has(node.id)) continue;
    if (!indegree.has(node.id)) indegree.set(node.id, 0);
    for (const dep of Object.keys(node.dependencies ?? {})) {
      if (blocked.has(dep) || !byId.has(dep)) continue;
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      const list = children.get(dep) ?? [];
      list.push(node.id);
      children.set(dep, list);
    }
  }
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of (children.get(id) ?? []).sort()) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  return {
    order,
    issues,
    dependents,
    blocked: [...blocked].sort(),
    cycles,
  };
}

/**
 * 计算启用某扩展所需的最小依赖闭包（按拓扑顺序，依赖在前）。
 * 缺失/版本不符/环上的节点不会出现在结果里；调用方应先检查 graph.blocked。
 */
export function dependencyClosure(id: string, graph: ExtensionGraphResult, nodes: readonly ExtensionGraphNode[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (current: string): void => {
    if (seen.has(current)) return;
    seen.add(current);
    for (const dep of Object.keys(byId.get(current)?.dependencies ?? {})) {
      if (byId.has(dep)) visit(dep);
    }
    out.push(current);
  };
  if (byId.has(id)) visit(id);
  const allowed = new Set(graph.order);
  return out.filter((item) => allowed.has(item));
}
