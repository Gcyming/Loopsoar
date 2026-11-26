/**
 * bookmarks 域：浏览器书签（列表 / 新增 / 删除）。
 *
 * 数据与规则都在 BookmarksStore（持久化、URL 规范化、去重、上限淘汰）；
 * 这里只做 IPC 通道适配——不经手文件、不猜 URL 合法性（store 已是唯一判据），
 * 失败以 { ok:false, error } 返回而不是抛异常（UI 可提示「仅支持 http/https」等）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import type { BookmarksStore } from "../bookmarksStore.js";

/** 列表通道返回结构（UI 直接渲染；无分页，上限由 store 保证）。 */
export interface BookmarksListResult {
  bookmarks: ReturnType<BookmarksStore["list"]>;
}

export function registerBookmarksDomain(deps: TrustedIpcDeps, store: BookmarksStore): void {
  // 无参通道：不接收 payload（trustedIpc 对 null/undefined 之外的参数会直接拒绝）
  handleTrusted(deps, "bookmarks:list", (): BookmarksListResult => ({ bookmarks: store.list() }));

  handleTrusted(deps, "bookmarks:add", (payload) => {
    const p = payload as { url: string; title?: string };
    const result = store.add({ url: p?.url ?? "", title: p?.title });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      bookmark: result.bookmark,
      // duplicate=true 表示该 URL 已存在、返回的是已有项（UI 可提示「已在书签中」而不是重复插入）
      ...(result.duplicate ? { duplicate: true } : {}),
    };
  });

  handleTrusted(deps, "bookmarks:remove", (payload) => {
    const p = payload as { id: string };
    return { ok: store.remove(p?.id ?? "") };
  });

  handleTrusted(deps, "bookmarks:update", (payload) => {
    const p = payload as { id: string; title?: string; url?: string };
    return store.update(p?.id ?? "", { title: p?.title, url: p?.url });
  });
}
