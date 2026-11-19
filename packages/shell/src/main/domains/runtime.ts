/**
 * runtime 域：boot:status。
 * 全部经受信 IPC 入口注册；依赖注入，不 import electron。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export function registerRuntimeDomain(deps: TrustedIpcDeps): void {
  handleTrusted(deps, "boot:status", () => ({ status: "ok" }));
}
