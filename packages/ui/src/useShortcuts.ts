/**
 * 新标签页「快捷方式」的数据与动作。
 *
 * 与历史记录解耦：历史是自动积累、不可编辑的；这里读写 shortcuts.json（用户主动添加、可改名/改址/删除）。
 * 图标只抓一次并写回存储（data URL），避免每次打开新标签页都重新联网抓 favicon。
 */
import * as React from "react";
import { useLoopsoarApi } from "./useLoopsoarApi.js";
import type { ShortcutItem } from "./types.js";

export interface ShortcutActions {
  items: ShortcutItem[] | null;
  add: (input: { url: string; title?: string }) => Promise<{ ok: boolean; error?: string }>;
  update: (id: string, input: { title?: string; url?: string }) => Promise<{ ok: boolean; error?: string }>;
  remove: (id: string) => Promise<void>;
  pin: (id: string) => Promise<void>;
}

export function useShortcuts(): ShortcutActions {
  const api = useLoopsoarApi();
  const [items, setItems] = React.useState<ShortcutItem[] | null>(null);

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!api) return;
    try {
      const result = await api.shortcuts.list();
      setItems(result?.shortcuts ?? []);
    } catch {
      setItems([]);
    }
  }, [api]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 图标补齐：只对缺少 icon 的条目抓一次，抓到的 data URL 写回存储。
   * 失败（离线/站点不给图标）保持首字母块，不影响点击。
   */
  React.useEffect(() => {
    if (!api || !items || items.length === 0) return;
    let alive = true;
    const pending = items.filter((item) => !item.icon);
    if (pending.length === 0) return;
    void (async () => {
      for (const item of pending) {
        try {
          const resolved = await api.browser.resolveFavicon({ url: item.url });
          if (!alive || !resolved?.favicon) continue;
          await api.shortcuts.update({ id: item.id, icon: resolved.favicon });
        } catch {
          // 单个图标失败不影响其他条目
        }
      }
      if (alive) await refresh();
    })();
    return () => {
      alive = false;
    };
  }, [api, items, refresh]);

  const add = React.useCallback(
    async (input: { url: string; title?: string }) => {
      if (!api) return { ok: false, error: "应用未就绪" };
      const result = await api.shortcuts.add(input);
      if (result?.ok) await refresh();
      return { ok: result?.ok === true, error: result?.error };
    },
    [api, refresh],
  );

  const update = React.useCallback(
    async (id: string, input: { title?: string; url?: string }) => {
      if (!api) return { ok: false, error: "应用未就绪" };
      const result = await api.shortcuts.update({ id, ...input });
      if (result?.ok) await refresh();
      return { ok: result?.ok === true, error: result?.error };
    },
    [api, refresh],
  );

  const remove = React.useCallback(
    async (id: string) => {
      if (!api) return;
      await api.shortcuts.remove({ id }).catch(() => undefined);
      await refresh();
    },
    [api, refresh],
  );

  const pin = React.useCallback(
    async (id: string) => {
      if (!api) return;
      await api.shortcuts.pin({ id }).catch(() => undefined);
      await refresh();
    },
    [api, refresh],
  );

  return { items, add, update, remove, pin };
}
