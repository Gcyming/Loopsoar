import fs from "node:fs";
import path from "node:path";
import type { PersistedBrowserState } from "./browserSessionState.js";

/**
 * 全局标签状态仓库：用户标签 + 各任务工作区共用一份 browser-state.json。
 * 以前用户标签在 browser-user-tabs.json、任务快照嵌在 session 文件里，两套存储走两套读写；
 * 现在统一 key（sessionId / __user_tabs__）落到同一文件，避免「关页/过户/退出」三处各写一份。
 */
export class BrowserStateStore {
  constructor(private readonly file: string) {}

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

  get(key: string): PersistedBrowserState | null {
    const all = this.readAll();
    return all[key] ?? null;
  }

  set(key: string, state: PersistedBrowserState): void {
    const all = this.readAll();
    if (state.tabs.length === 0) delete all[key];
    else all[key] = state;
    this.writeAll(all);
  }

  delete(key: string): void {
    const all = this.readAll();
    if (!(key in all)) return;
    delete all[key];
    this.writeAll(all);
  }

  entries(): Array<[string, PersistedBrowserState]> {
    return Object.entries(this.readAll());
  }
}
