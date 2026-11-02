/**
 * loop 域：Agent-Loop 列表 / 活动 loop 切换（ADR-0010）。
 * 参数校验在契约层（handleTrusted 按 loop:list / loop:setActive 的 schema）；
 * 域层只做转发与错误归一（未知 loop 返回 {ok:false,error}，不让 IPC 调用方拿到裸异常）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { LoopRuntime } from "../loopRuntime.js";

export function registerLoopDomain(deps: TrustedIpcDeps, runtime: LoopRuntime): void {
  // 无参：返回 loops[{id,name,builtin,active}] + activeId + fallbacks
  handleTrusted(deps, "loop:list", () => runtime.list());

  // 切换活动 loop：校验存在性 → 持久化 → push loop:changed
  handleTrusted(deps, "loop:setActive", (payload) => {
    const id = (payload as { id: string }).id;
    try {
      return { ok: true, ...runtime.setActive(id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
