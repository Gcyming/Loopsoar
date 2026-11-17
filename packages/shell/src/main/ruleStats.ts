/**
 * 规则统计：注入次数（分母）与守卫命中次数（分子）、最近命中工具/目标。
 * 只记录规则行，不记录完整 prompt；文件损坏时从空开始。
 */
import fs from "node:fs";
import path from "node:path";

export interface RuleHit {
  text: string;
  /** 守卫命中次数。 */
  count: number;
  /** 进入 prompt 的次数。 */
  injected: number;
  firstAt: number;
  lastAt: number;
  lastInjectedAt?: number;
  lastTool?: string;
  lastTarget?: string;
}

interface StatsFile {
  version: 1;
  hits: RuleHit[];
}

const MAX_HITS = 80;

export class RuleStatsStore {
  private hits: RuleHit[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.hits = this.load();
  }

  private load(): RuleHit[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StatsFile>;
      if (!Array.isArray(raw.hits)) return [];
      return raw.hits
        .filter(
          (hit): hit is RuleHit =>
            Boolean(hit) &&
            typeof hit.text === "string" &&
            typeof hit.count === "number" &&
            typeof hit.firstAt === "number" &&
            typeof hit.lastAt === "number",
        )
        // 旧 stats 没有 injected：迁移为 0，不能因为升级把旧数据丢掉。
        .map((hit) => ({ ...hit, injected: typeof hit.injected === "number" ? hit.injected : 0 }));
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + ".tmp";
      const data: StatsFile = { version: 1, hits: this.hits };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch {
      // 统计失败不影响工具调用
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
    this.saveTimer.unref?.();
  }

  /** 规则进入 prompt 时调用；1s 合并落盘，避免每轮多次写文件。 */
  recordInjection(texts: string[]): void {
    const unique = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
    if (unique.length === 0) return;
    const at = this.now();
    for (const text of unique) {
      const existing = this.hits.find((hit) => hit.text === text);
      if (existing) {
        existing.injected += 1;
        existing.lastInjectedAt = at;
        existing.lastAt = at;
      } else {
        this.hits.push({
          text,
          count: 0,
          injected: 1,
          firstAt: at,
          lastAt: at,
          lastInjectedAt: at,
        });
      }
    }
    this.hits = this.hits.slice(0, MAX_HITS);
    this.scheduleSave();
  }

  record(input: { text: string; toolName?: string; target?: string }): void {
    const text = input.text.trim();
    if (!text) return;
    const at = this.now();
    const existing = this.hits.find((hit) => hit.text === text);
    if (existing) {
      existing.count += 1;
      existing.lastAt = at;
      if (input.toolName) existing.lastTool = input.toolName;
      if (input.target) existing.lastTarget = input.target;
    } else {
      this.hits.push({
        text,
        count: 1,
        injected: 0,
        firstAt: at,
        lastAt: at,
        ...(input.toolName ? { lastTool: input.toolName } : {}),
        ...(input.target ? { lastTarget: input.target } : {}),
      });
    }
    this.hits = this.hits.sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_HITS);
    this.save();
  }

  /** 测试/退出用：立即落盘。 */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  list(): RuleHit[] {
    return [...this.hits].sort((a, b) => b.count - a.count || b.injected - a.injected || b.lastAt - a.lastAt);
  }

  clear(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.hits = [];
    this.save();
  }
}
