/**
 * 审计日志（§4.3 S4）
 * 串行队列，条目类型明确
 */

export interface AuditEntry {
  ts: number;
  agentId: string;
  action: string;
  target?: string;
  level: "info" | "warn" | "error" | "critical";
  status: "success" | "failure" | "pending";
  reason?: string;
}

export class AuditLog {
  private queue: AuditEntry[] = [];

  append(entry: AuditEntry): void {
    this.queue.push(entry);
  }

  get entries(): ReadonlyArray<AuditEntry> {
    return this.queue;
  }

  clear(): void {
    this.queue = [];
  }
}
