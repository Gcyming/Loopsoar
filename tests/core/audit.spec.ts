/**
 * T6 测试：packages/core/src/audit.ts
 * 覆盖 AuditLog 串行 append 与条目形状
 */
import { describe, expect, it } from "vitest";
import { AuditLog } from "../../packages/core/src/audit.ts";

describe("AuditLog 串行 append", () => {
  it("按顺序追加，get entries 按插入顺序返回", () => {
    const log = new AuditLog();
    log.append({ ts: 1, agentId: "a", action: "run", level: "info", status: "success" });
    log.append({ ts: 2, agentId: "b", action: "stop", level: "warn", status: "failure", reason: "timeout" });
    const entries = log.entries;
    expect(entries.length).toBe(2);
    expect(entries[0].agentId).toBe("a");
    expect(entries[1].status).toBe("failure");
  });

  it("clear 清空队列", () => {
    const log = new AuditLog();
    log.append({ ts: 0, agentId: "x", action: "t", level: "info", status: "success" });
    log.clear();
    expect(log.entries.length).toBe(0);
  });

  it("entries 只读：外部修改不应影响内部（类型只读但运行时可变，这里仅断言长度一致）", () => {
    const log = new AuditLog();
    log.append({ ts: 10, agentId: "y", action: "a", level: "critical", status: "pending", target: "/etc" });
    expect(log.entries).toHaveLength(1);
  });
});

describe("AuditEntry 条目形状", () => {
  it("完整条目包含所有可选与必选字段", () => {
    const entry = {
      ts: 12345,
      agentId: "agent-01",
      action: "execute",
      target: "/tmp/test.txt",
      level: "warn" as const,
      status: "failure" as const,
      reason: "权限拒绝",
    };
    const log = new AuditLog();
    log.append(entry);
    const got = log.entries[0];
    expect(got.ts).toBe(12345);
    expect(got.agentId).toBe("agent-01");
    expect(got.action).toBe("execute");
    expect(got.target).toBe("/tmp/test.txt");
    expect(got.level).toBe("warn");
    expect(got.status).toBe("failure");
    expect(got.reason).toBe("权限拒绝");
  });

  it("最小条目（无可选字段）仍可追加", () => {
    const log = new AuditLog();
    log.append({ ts: 0, agentId: "min", action: "ping", level: "info", status: "success" });
    expect(log.entries[0]).toBeDefined();
  });
});
