/**
 * loop 域：Agent-Loop 列表 / 活动 loop 切换 / 重扫（ADR-0010）。
 * 参数校验在契约层（handleTrusted 按 loop:list / loop:setActive / loop:reload 的 schema）；
 * 域层只做转发与错误归一（未知 loop 返回 {ok:false,error}，不让 IPC 调用方拿到裸异常）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { LoopRuntime } from "../loopRuntime.js";

export function registerLoopDomain(deps: TrustedIpcDeps, runtime: LoopRuntime): void {
  // 无参：返回 loops[{id,name,kind,builtin,active,valid,error?}] + activeId + fallbacks + errors
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

  // 重扫 loops/ 目录（L2 声明式 / L3 脚本增删改即时生效）→ push loop:changed → 返回最新列表。
  // 返回与 loop:list 同构（UI 的 loop.reload(): Promise<LoopListResult>）。
  handleTrusted(deps, "loop:reload", () => runtime.reload());
}
