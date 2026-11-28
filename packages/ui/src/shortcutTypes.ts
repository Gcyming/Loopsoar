/** 新标签页快捷方式（用户主动添加）的对外类型；types.d.ts 继续再导出。 */
import type { ShortcutItem } from "./types.js";

export interface ShortcutWriteResult {
  ok: boolean;
  shortcut?: ShortcutItem;
  error?: string;
  duplicate?: boolean;
}
