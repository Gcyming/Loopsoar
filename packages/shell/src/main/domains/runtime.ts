/**
 * runtime 域：app:version / boot:status。
 * 全部经受信 IPC 入口注册；依赖注入，不 import electron。
 */
import { APP_NAME, APP_ID } from "../../shared/brand.js";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export function registerRuntimeDomain(deps: TrustedIpcDeps): void {
  handleTrusted(deps, "app:version", () => ({
    app: APP_NAME,
    id: APP_ID,
    version: "0.1.0-scaffold",
  }));
  handleTrusted(deps, "boot:status", () => ({ status: "ok" }));
}
