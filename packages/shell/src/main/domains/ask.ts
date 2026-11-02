/**
 * ask 域：渲染层回答 ask_user 弹窗（ask:respond）→ AskBus 结算挂起请求。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { AskBus } from "../askBus.js";

export function registerAskDomain(deps: TrustedIpcDeps, askBus: AskBus): void {
  handleTrusted(deps, "ask:respond", (payload) => {
    const p = payload as { requestId: string; answer?: string; cancelled?: boolean };
    const received = askBus.resolve(p.requestId, {
      answer: typeof p.answer === "string" ? p.answer : undefined,
      cancelled: p.cancelled === true,
    });
    return { received };
  });
}
