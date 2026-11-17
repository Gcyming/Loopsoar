/**
 * 规则守卫命中统计：哪个规则真的在拦东西、最近拦了什么。
 * 只记命中，不记每次注入；数据量小、可丢弃，文件损坏时从空开始。
 */
import fs from "node:fs";
import path from "node:path";

export interface RuleHit {
  text: string;
  count: number;
  firstAt: number;
  lastAt: number;
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
      return raw.hits.filter(
        (hit): hit is RuleHit =>
          Boolean(hit) &&
          typeof hit.text === "string" &&
          typeof hit.count === "number" &&
          typeof hit.firstAt === "number" &&
          typeof hit.lastAt === "number",
      );
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
        firstAt: at,
        lastAt: at,
        ...(input.toolName ? { lastTool: input.toolName } : {}),
        ...(input.target ? { lastTarget: input.target } : {}),
      });
    }
    this.hits = this.hits.sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_HITS);
    this.save();
  }

  list(): RuleHit[] {
    return [...this.hits].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  }

  clear(): void {
    this.hits = [];
    this.save();
  }
}
