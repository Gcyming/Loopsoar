/**
 * loop 域：Agent-Loop 列表 / 活动 loop 切换 / 重扫（ADR-0010）。
 * 参数校验在契约层（handleTrusted 按 loop:list / loop:setActive / loop:reload 的 schema）；
 * 域层只做转发与错误归一（未知 loop 返回 {ok:false,error}，不让 IPC 调用方拿到裸异常）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import { deleteDeclarativeLoop, saveDeclarativeLoop } from "../loopDefs.js";
import { CORE_LOOP_ID, type LoopRuntime } from "../loopRuntime.js";

export function registerLoopDomain(deps: TrustedIpcDeps, runtime: LoopRuntime, dataDir?: string): void {
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

  // 读取单个声明式 loop 的完整配置（编辑器打开时用）。
  handleTrusted(deps, "loop:get", (payload) => {
    const id = (payload as { id: string }).id;
    try {
      return runtime.get(id);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 「编译」= 校验并原子写入 loops/<id>.json → 重扫注册 →（可选）立即设为活动 loop。
  // 与手工改文件走同一条扫描/注册路径，避免编辑器成为第二套运行时。
  handleTrusted(deps, "loop:save", (payload) => {
    if (!dataDir) return { ok: false, error: "当前运行未配置数据目录，无法保存 loop" };
    const p = payload as { config: unknown; activate?: boolean };
    try {
      const saved = saveDeclarativeLoop(dataDir, p.config);
      const id = saved.config.id;
      if (!id) return { ok: false, error: "保存的 loop 缺少 id" };
      let latest = runtime.reload();
      if (p.activate !== false) latest = runtime.setActive(id);
      return { ok: true, ...latest, savedId: id, filePath: saved.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 删除用户自定义的 L2 JSON；若删除的是当前活动 loop，安全回落内置并持久化选择。
  handleTrusted(deps, "loop:delete", (payload) => {
    if (!dataDir) return { ok: false, error: "当前运行未配置数据目录，无法删除 loop" };
    const id = (payload as { id: string }).id;
    try {
      const activeBefore = runtime.list().activeId;
      const removed = deleteDeclarativeLoop(dataDir, id);
      let latest = runtime.reload();
      if (activeBefore === id) latest = runtime.setActive(CORE_LOOP_ID);
      return { ok: true, ...latest, deletedId: id, filePath: removed.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
