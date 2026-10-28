/**
 * agents 域：agents:list。
 * P1 接入 AgentService（注册表/人格/身份迁移）；当前返回空清单占位。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export function registerAgentsDomain(deps: TrustedIpcDeps): void {
  handleTrusted(deps, "agents:list", () => ({
    agents: [], // P1：AgentService.list() 接入
  }));
}
