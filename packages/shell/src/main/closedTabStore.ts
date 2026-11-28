import fs from "node:fs";
import path from "node:path";
import type { ClosedTabEntry } from "./closedTabStack.js";

/**
 * 「最近关闭」仓库：独立文件 `<dataDir>/closed-tabs.json`。
 *
 * 为什么要落盘：关闭栈原来只在内存里，退出应用就清空——用户下次打开面板看到「还没有关闭的网页」，
 * 与浏览器「最近关闭」的心智模型不符。这里只持久化这份**标签关闭记录**，
 * 与浏览历史（history.json）完全分开：清这里不影响历史，清历史也不会动这里。
 *
 * 写策略沿用 BrowserStateStore：内存缓存 + 防抖合并写，退出前 flush()；
 * 落盘失败不阻断浏览（返回 false，由调用方忽略）。
 */
export class ClosedTabStore {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: ClosedTabEntry[] | null = null;

  constructor(
    private readonly file: string,
    private readonly debounceMs = 300,
  ) {}

  /** 读盘（文件不存在/损坏都返回空数组：旧数据不能阻断启动）。 */
  load(): ClosedTabEntry[] {
    try {
      if (!fs.existsSync(this.file)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as ClosedTabEntry[]) : [];
    } catch {
      return [];
    }
  }

  /** 记住最新状态：窗口内多次关闭/重开只落盘一次。 */
  save(entries: ClosedTabEntry[]): void {
    this.pending = entries;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** 立即落盘（退出前/测试调用）。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const entries = this.pending;
    if (!entries) return;
    this.pending = null;
    try {
      const tmp = this.file + ".tmp";
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(entries), "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      // 关闭记录落盘失败不影响浏览器使用。
    }
  }
}
