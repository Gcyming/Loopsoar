/**
 * Agent 定义与权限模型（框架基建，纯逻辑）。
 * 为什么需要它：Agent 是「身份 + 能力边界 + loop」的组合；权限边界必须在执行器之前生效
 * （工具白名单先于沙箱判定），否则不同 Agent 会用同一份全集能力，安全模型形同虚设。
 * 语义约定（fail-closed）：
 *   - toolAllowlist === undefined → 允许全部已注册工具（内置默认 Agent）；
 *   - toolAllowlist === []        → 全部禁止（只读/受限 Agent 的最小态）；
 *   - toolAllowlist 非空          → 仅白名单内工具可用。
 */
export interface AgentDefinition {
  /** 稳定 id（小写字母数字与连字符）。 */
  id: string;
  /** 展示名（进提示词的身份段）。 */
  name: string;
  /** 角色（进提示词的身份段）。 */
  role: string;
  description?: string;
  /** 绑定的 Agent-Loop id（默认为内核 builtin loop）。 */
  loopId?: string;
  /** 工具白名单语义见文件头注释。 */
  toolAllowlist?: string[];
  /** 单轮任务最大轮数覆盖（不填则用预算硬上限）。 */
  maxRounds?: number;
  /** builtin 来源：不可被删除（可复制为新 Agent 再改）。 */
  builtin?: boolean;
}

const AGENT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 内置默认 Agent：Loopsoar 本体（浏览器优先，全工具）。 */
export const BUILTIN_AGENT: AgentDefinition = {
  id: "loopsoar",
  name: "Loopsoar",
  role: "浏览器优先的本地 AI Agent",
  description: "默认 Agent：可读写文件、执行命令、访问网络、操控浏览器",
  loopId: "core-loop",
  builtin: true,
};

export class AgentRegistry {
  private map = new Map<string, AgentDefinition>();
  private defaultId: string | null = null;

  /** 注册（含内置）：id 非法/重复 → 抛错；内置 Agent 用 registerBuiltin。 */
  register(def: AgentDefinition): void {
    if (!AGENT_ID_RE.test(def.id)) {
      throw new Error(`Agent id "${def.id}" 不合法（要求 ^[a-z0-9]+(-[a-z0-9]+)*$）`);
    }
    if (this.map.has(def.id)) {
      throw new Error(`Agent ${def.id} 已存在（内置不可覆盖，请复制为新 Agent 再改）`);
    }
    if (def.maxRounds !== undefined && (!Number.isInteger(def.maxRounds) || def.maxRounds <= 0)) {
      throw new Error(`Agent ${def.id} 的 maxRounds 必须是正整数`);
    }
    this.map.set(def.id, { ...def, builtin: Boolean(def.builtin) });
    if (!this.defaultId) this.defaultId = def.id;
  }

  registerBuiltin(def: AgentDefinition): void {
    this.register({ ...def, builtin: true });
    this.defaultId = this.defaultId ?? def.id;
  }

  get(id: string): AgentDefinition | undefined {
    return this.map.get(id);
  }

  list(): AgentDefinition[] {
    return [...this.map.values()];
  }

  /** 删除自定义 Agent；builtin 拒绝；删除默认则回落到第一个 builtin。 */
  remove(id: string): void {
    const def = this.map.get(id);
    if (!def) throw new Error(`Agent ${id} 不存在`);
    if (def.builtin) throw new Error(`Agent ${id} 是内置 Agent，不可删除`);
    this.map.delete(id);
    if (this.defaultId === id) {
      const fallback = [...this.map.values()].find((a) => a.builtin);
      this.defaultId = fallback?.id ?? null;
    }
  }

  setDefault(id: string): void {
    if (!this.map.has(id)) throw new Error(`Agent ${id} 不存在`);
    this.defaultId = id;
  }

  defaultAgent(): AgentDefinition | null {
    return this.defaultId ? this.map.get(this.defaultId) ?? null : null;
  }
}

/** 工具白名单判定（fail-closed 语义见文件头）。接受最小结构，避免生产端为了调用它伪造完整 AgentDefinition。 */
export function canUseTool(agent: Pick<AgentDefinition, "toolAllowlist">, toolName: string): boolean {
  if (agent.toolAllowlist === undefined) return true;
  return agent.toolAllowlist.includes(toolName);
}
