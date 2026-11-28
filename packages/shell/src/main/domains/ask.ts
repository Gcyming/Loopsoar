/**
 * ask 域：渲染层回答 ask_user 弹窗（ask:respond）→ AskBus 结算挂起请求。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { AskBus } from "../askBus.js";

export function registerAskDomain(deps: TrustedIpcDeps, askBus: AskBus): void {
  handleTrusted(deps, "ask:respond", (payload) => {
    const p = payload as {
      requestId: string;
      answer?: string;
      choice?: string;
      choices?: string[];
      skipped?: boolean;
      cancelled?: boolean;
    };
    // 结构化回填：单选 choice / 多选 choices / 自填 answer / 跳过 skipped 分开传，
    // 由 AskBus 归一成「文本 + 选择」，避免在域层重复解析。
    const received = askBus.resolve(p.requestId, {
      ...(typeof p.answer === "string" ? { answer: p.answer } : {}),
      ...(typeof p.choice === "string" ? { choice: p.choice } : {}),
      ...(Array.isArray(p.choices) ? { choices: p.choices } : {}),
      ...(p.skipped === true ? { skipped: true } : {}),
      cancelled: p.cancelled === true,
    });
    return { received };
  });
}
