/**
 * agents 域：agents:list（真实 AgentRegistry，P1 接线）。
 * 只暴露展示所需字段——loopId / toolAllowlist 属于权限细节，界面上仅以摘要呈现。
 */
import type { AgentRegistry } from "loopsoar-core/agent";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export interface AgentsDeps extends TrustedIpcDeps {
  agents: AgentRegistry;
}

export function registerAgentsDomain(deps: AgentsDeps): void {
  handleTrusted(deps, "agents:list", () => ({
    agents: deps.agents.list().map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      description: a.description ?? null,
      builtin: Boolean(a.builtin),
      loopId: a.loopId ?? null,
      toolCount: a.toolAllowlist === undefined ? null : a.toolAllowlist.length,
      isDefault: deps.agents.defaultAgent()?.id === a.id,
    })),
  }));
}
