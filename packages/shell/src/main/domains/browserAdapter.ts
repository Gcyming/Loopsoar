/**
 * browser 域：browser:navigate / browser:screenshot / browser:snapshot。
 * D0 验证（P0 决策门）通过前不实现，返回结构化「未实现」错误而非抛异常；
 * 接口语义见 src/browserAdapter/types.ts（ADR-0003）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export function registerBrowserDomain(deps: TrustedIpcDeps): void {
  const d0 = (m: string) => ({
    ok: false,
    error: `browser:${m} —— D0 验证阶段未实现（ADR-0003：先验证 WebContentsView 路线再冻结接口）`,
  });
  handleTrusted(deps, "browser:navigate", (payload) => {
    void payload;
    return d0("navigate");
  });
  handleTrusted(deps, "browser:screenshot", (payload) => {
    void payload;
    return d0("screenshot");
  });
  handleTrusted(deps, "browser:snapshot", () => d0("snapshot"));
}
