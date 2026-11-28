/**
 * shortcuts 域：新标签页「快捷方式」（列表 / 新增 / 编辑 / 删除 / 置顶）。
 *
 * 数据与规则都在 ShortcutsStore（持久化、URL 规范化、去重、上限淘汰）；
 * 这里只做 IPC 适配，失败以 { ok:false, error } 返回而不是抛异常。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { ShortcutsStore } from "../shortcutsStore.js";

export function registerShortcutsDomain(deps: TrustedIpcDeps, store: ShortcutsStore): void {
  handleTrusted(deps, "shortcuts:list", () => ({ shortcuts: store.list() }));

  handleTrusted(deps, "shortcuts:add", (payload) => {
    const p = payload as { url?: string; title?: string; icon?: string };
    return store.add({ url: p?.url ?? "", title: p?.title, icon: p?.icon });
  });

  handleTrusted(deps, "shortcuts:update", (payload) => {
    const p = payload as { id?: string; title?: string; url?: string; icon?: string };
    return store.update(p?.id ?? "", { title: p?.title, url: p?.url, icon: p?.icon });
  });

  handleTrusted(deps, "shortcuts:remove", (payload) => {
    const p = payload as { id?: string };
    return { ok: store.remove(p?.id ?? "") };
  });

  handleTrusted(deps, "shortcuts:pin", (payload) => {
    const p = payload as { id?: string };
    return { ok: store.moveToFront(p?.id ?? "") };
  });
}
