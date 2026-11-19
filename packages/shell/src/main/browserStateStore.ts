import fs from "node:fs";
import path from "node:path";
import type { PersistedBrowserState } from "./browserSessionState.js";

/**
 * 全局标签状态仓库：用户标签 + 各任务工作区共用一份 browser-state.json。
 * 以前用户标签在 browser-user-tabs.json、任务快照嵌在 session 文件里，两套存储走两套读写；
 * 现在统一 key（sessionId / __user_tabs__）落到同一文件，避免「关页/过户/退出」三处各写一份。
 *
 * P2-3：改为**内存缓存 + 合并写（防抖）**。原来每次 set/delete 都 readAll()+writeAll() 整个 JSON，
 * 拖标签/批量关闭时会 O(n²) 读写；现在读只解析一次，写统一防抖，退出前 flush()。
 */
export class BrowserStateStore {
  /** null = 尚未加载（首次访问时才读盘，启动不被大文件拖慢）。 */
  private cache: Record<string, PersistedBrowserState> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private dirty = false;

  constructor(
    private readonly file: string,
    opts: { debounceMs?: number } = {},
  ) {
    this.debounceMs = Math.max(0, opts.debounceMs ?? 200);
  }

  private data(): Record<string, PersistedBrowserState> {
    if (!this.cache) this.cache = this.readAll();
    return this.cache;
  }

  private readAll(): Record<string, PersistedBrowserState> {
    try {
      if (!fs.existsSync(this.file)) return {};
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") return {};
      const out: Record<string, PersistedBrowserState> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!key || !value || typeof value !== "object") continue;
        out[key] = value as PersistedBrowserState;
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, PersistedBrowserState>): void {
    try {
      const tmp = this.file + ".tmp";
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      // 标签状态落盘失败不阻断浏览
    }
  }

  /** 合并写：窗口内多次修改只落盘一次；0ms 时下一 tick 写（仍合并同一 tick 的批量修改）。 */
  private scheduleWrite(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** 立即落盘（退出前 / 需要强一致的测试调用）。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.cache || !this.dirty) return;
    this.writeAll(this.cache);
    this.dirty = false;
  }

  get(key: string): PersistedBrowserState | null {
    return this.data()[key] ?? null;
  }

  set(key: string, state: PersistedBrowserState): void {
    const all = this.data();
    if (state.tabs.length === 0) delete all[key];
    else all[key] = state;
    this.scheduleWrite();
  }

  delete(key: string): void {
    const all = this.data();
    if (!(key in all)) return;
    delete all[key];
    this.scheduleWrite();
  }

  entries(): Array<[string, PersistedBrowserState]> {
    return Object.entries(this.data());
  }
}
