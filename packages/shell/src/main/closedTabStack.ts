/**
 * 最近关闭的网页栈（Chrome 式「最近关闭」）。
 *
 * 抽成独立模块：标签关闭/重开是纯数据操作（压栈、倒序读、按下标取），
 * 与浏览器宿主的视图生命周期无关；放在 browserHost 里会让组合根继续膨胀，
 * 也让「按下标重开」这类边界（搜索过滤后下标仍指向原条目）难以单测。
 */
export interface ClosedTabEntry {
  url: string;
  title: string;
  sessionId: string;
  /** 关闭时刻（ms）：面板按它做「几分钟前」展示与排序。 */
  closedAt: number;
  agentBound?: boolean;
  pinned?: boolean;
}

/** 面板用的只读条目：agentBound 统一给出布尔值，UI 不必再处理 undefined。 */
export interface ClosedTabView {
  url: string;
  title: string;
  sessionId: string;
  closedAt: number;
  agentBound: boolean;
}

/** 上限：最多记住最近 40 条，超出丢弃最旧的（只淘汰这份记录，不动浏览历史）。 */
export const CLOSED_TAB_LIMIT = 40;

export class ClosedTabStack {
  private items: ClosedTabEntry[] = [];

  /** onChange：压栈/取出后回调（宿主据此防抖落盘，退出后仍能看到「最近关闭」）。 */
  constructor(private readonly onChange?: (entries: ClosedTabEntry[]) => void) {}

  /** 记一条关闭记录（time 由调用方给，便于测试固定时刻）。 */
  pushEntry(entry: Omit<ClosedTabEntry, "closedAt">, closedAt = Date.now()): void {
    this.items.push({ ...entry, closedAt });
    if (this.items.length > CLOSED_TAB_LIMIT) this.items.shift();
    this.onChange?.(this.export());
  }

  /** 新 → 旧：面板「最近关闭」的显示顺序。 */
  list(): ClosedTabView[] {
    return this.items
      .slice()
      .reverse()
      .map((item) => ({
        url: item.url,
        title: item.title,
        sessionId: item.sessionId,
        closedAt: item.closedAt,
        agentBound: item.agentBound === true,
      }));
  }

  /** 取出第 index 条（0 = 最新）并移除；越界返回 undefined。 */
  take(index = 0): ClosedTabEntry | undefined {
    const at = this.items.length - 1 - Math.max(0, Math.trunc(index));
    const entry = at >= 0 ? this.items.splice(at, 1)[0] : undefined;
    if (entry) this.onChange?.(this.export());
    return entry;
  }

  /** 落盘用（时间正序，最旧的在前）；直接可 JSON 化。 */
  export(): ClosedTabEntry[] {
    return this.items.map((item) => ({ ...item }));
  }

  /** 从磁盘恢复：逐条校验字段，丢弃坏数据并只保留最近 CLOSED_TAB_LIMIT 条。 */
  restore(raw: unknown): void {
    this.items = [];
    if (!Array.isArray(raw)) return;
    for (const value of raw) {
      const entry = sanitizeClosedTab(value);
      if (entry) this.items.push(entry);
    }
    if (this.items.length > CLOSED_TAB_LIMIT) this.items = this.items.slice(-CLOSED_TAB_LIMIT);
  }

  get size(): number {
    return this.items.length;
  }
}

/** 磁盘条目校验：url 必填，其余按需裁剪；时间缺失按 0（显示为「较早」）。 */
function sanitizeClosedTab(value: unknown): ClosedTabEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) return null;
  const closedAt = typeof raw.closedAt === "number" && Number.isFinite(raw.closedAt) ? raw.closedAt : 0;
  return {
    url,
    title: typeof raw.title === "string" ? raw.title : "",
    sessionId: typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : "__user_tabs__",
    closedAt,
    ...(raw.agentBound === true ? { agentBound: true } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
  };
}
