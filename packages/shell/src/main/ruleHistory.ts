/**
 * 规则变更历史：每次保存/采纳记录 before/after，可回滚。
 * 只保存规则文件快照（最多 100 条），不保存其他用户文件。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface RuleRevisionFile {
  path: string;
  before: string;
  after: string;
}

export interface RuleRevision {
  id: string;
  at: number;
  action: "save" | "accept" | "rollback";
  summary: string;
  files: RuleRevisionFile[];
}

interface HistoryFile {
  version: 1;
  items: RuleRevision[];
}

const MAX_REVISIONS = 100;

export class RuleHistoryStore {
  private items: RuleRevision[] = [];

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.items = this.load();
  }

  private load(): RuleRevision[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<HistoryFile>;
      return Array.isArray(raw.items) ? raw.items.filter((item): item is RuleRevision => Boolean(item?.id) && Array.isArray(item?.files)) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + ".tmp";
      const data: HistoryFile = { version: 1, items: this.items };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch {
      // 历史失败不影响规则生效
    }
  }

  add(input: Omit<RuleRevision, "id" | "at">): RuleRevision {
    const revision: RuleRevision = {
      ...input,
      id: "rev-" + randomUUID().slice(0, 8),
      at: this.now(),
    };
    this.items.unshift(revision);
    this.items = this.items.slice(0, MAX_REVISIONS);
    this.save();
    return revision;
  }

  list(limit = 20): RuleRevision[] {
    return this.items.slice(0, Math.max(1, limit));
  }

  get(id: string): RuleRevision | null {
    return this.items.find((item) => item.id === id) ?? null;
  }
}
