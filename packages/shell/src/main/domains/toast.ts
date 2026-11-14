/**
 * 应用级 Toast 的 IPC 入口：渲染层只送文案，窗口创建/定位/隐藏全在壳层。
 * 单独成域是为了让「提示必须压住原生网页」这条约束只有一个实现点。
 */
import { z } from "zod";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export interface ToastDeps extends TrustedIpcDeps {
  /** 由 index.ts 注入（toastWindow 控制器）；缺省时静默忽略，不影响主流程。 */
  showToast?: (text: string, sticky?: boolean) => void;
}

export function registerToastDomain(deps: ToastDeps): void {
  handleTrusted(deps, "ui:toast", (payload) => {
    const parsed = z.object({ text: z.string().min(1).max(300), sticky: z.boolean().optional() }).safeParse(payload);
    if (!parsed.success) return { ok: false };
    deps.showToast?.(parsed.data.text, parsed.data.sticky);
    return { ok: true };
  });
}
