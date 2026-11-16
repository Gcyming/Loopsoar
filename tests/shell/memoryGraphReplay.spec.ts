/**
 * memory:graph 的时间回放参数（M4）：IPC 必须把 at 透传给图谱派生，并据此放开失效条目。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createFact, type MemoryFact } from "../../packages/core/src/memory/fact.ts";
import { registerMemoryDomain } from "../../packages/shell/src/main/domains/memory.ts";
import {
  __resetHandlerRegistryForTests,
  getHandlerRegistry,
  type AuditEntry,
} from "../../packages/shell/src/main/trustedIpc.ts";

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;
const ago = (days: number): number => NOW - days * DAY;
const TRUSTED_FRAME = { senderFrame: { url: "loopsoar://app/index.html" } };
type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

function fact(id: string, opts: { bornAt: number; invalidatedAt?: number }): MemoryFact {
  return createFact({
    id,
    content: id,
    category: "fact",
    timestamp: opts.bornAt,
    lastAccessed: opts.bornAt,
    invalidatedAt: opts.invalidatedAt,
    workspaceId: "default",
    provenance: { sessionId: "s1", workspaceId: "default", trust: "user", capturedBy: "auto" },
  });
}

function setup(facts: MemoryFact[]) {
  const listCalls: { includeInvalidated?: boolean }[] = [];
  const audits: AuditEntry[] = [];
  registerMemoryDomain({
    ipc: { handle: () => undefined },
    audit: (entry: AuditEntry) => audits.push(entry),
    memory: {
      list: (opts: { includeInvalidated?: boolean } = {}) => {
        listCalls.push(opts);
        return opts.includeInvalidated ? facts : facts.filter((f) => f.invalidatedAt === undefined);
      },
      stats: () => ({ total: facts.length, active: facts.length, archived: 0, links: 0, totalAccess: 0, byCategory: {} }),
      usageSnapshot: () => ({}),
      filePath: "C:/tmp/memory.json",
    } as never,
    sessions: {
      list: () => [{ id: "s1", title: "会话一", updatedAt: NOW, preview: "", messageCount: 0 }],
    } as never,
  });
  const handler = getHandlerRegistry().get("memory:graph")!.handler as unknown as Handler;
  return { listCalls, audits, handler };
}

describe("memory:graph 时间回放（M4）", () => {
  beforeEach(() => {
    __resetHandlerRegistryForTests();
  });

  it("带 at 调用：只返回当时已存在的事实，并标记已失效条目", async () => {
    const { handler, listCalls } = setup([
      fact("old", { bornAt: ago(10) }),
      fact("future", { bornAt: ago(1) }),
      fact("gone", { bornAt: ago(9), invalidatedAt: ago(6) }),
    ]);
    const result = (await handler(TRUSTED_FRAME, { at: ago(5) })) as {
      nodes: { id: string; superseded?: boolean }[];
      stats: { facts: number };
    };
    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain("fact:old");
    expect(ids).not.toContain("fact:future");
    expect(result.nodes.find((n) => n.id === "fact:gone")?.superseded).toBe(true);
    expect(result.stats.facts).toBe(2);
    expect(listCalls[0]?.includeInvalidated).toBe(true);
  });

  it("不带 at 调用：行为与旧版一致，不放开失效条目", async () => {
    const { handler, listCalls } = setup([fact("old", { bornAt: ago(10) })]);
    await handler(TRUSTED_FRAME, undefined);
    expect(listCalls[0]?.includeInvalidated).toBe(false);
  });

  it("at 必须是合法时间戳（负数被契约拒绝）", async () => {
    const { handler, audits } = setup([]);
    await expect(handler(TRUSTED_FRAME, { at: -1 })).rejects.toThrow(/参数校验失败/);
    expect(audits.some((entry) => entry.status === "rejected")).toBe(true);
  });
});
