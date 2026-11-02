/**
 * chat:compact（/compact 真实压缩）后端用例。
 *
 * 覆盖：
 *   - 预览（apply=false）只算不写盘；
 *   - apply=true 把「合成摘要 + 最近 14 条」写回 SessionStore 并同步索引；
 *   - chat:compacted 事件不丢字段；
 *   - 未超预算 / 空会话 / 会话忙碌 / 非法会话 ID 的失败语义；
 *   - contextWindow 注入如何改变预算；
 *   - 契约层参数校验（apply 类型非法）在 IPC 包装器处被拒绝。
 * 时间线与真实落盘走临时目录（不碰用户数据）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetHandlerRegistryForTests,
  getHandlerRegistry,
  type AuditEntry,
  type TrustedIpcDeps,
} from "../../packages/shell/src/main/trustedIpc.ts";
import {
  SessionStore,
  type PersistedMessage,
} from "../../packages/shell/src/main/sessionStore.ts";
import {
  registerCompactDomain,
  runCompact,
  type CompactDeps,
} from "../../packages/shell/src/main/domains/compact.ts";

type Handler = (event: unknown, payload: unknown) => Promise<unknown> | unknown;

/** 可信帧（生产环境只认 loopsoar://）。 */
const TRUSTED_FRAME = { senderFrame: { url: "loopsoar://app/index.html" } };
const KEEP_RECENT = 14;

interface CompactTestEnv {
  dir: string;
  store: SessionStore;
  pushed: Array<{ event: string; payload: unknown }>;
  audits: AuditEntry[];
  deps: CompactDeps;
  handler: Handler;
  register(extra?: Partial<CompactDeps>): void;
}

let env: CompactTestEnv;

function makeDeps(store: SessionStore, pushed: Array<{ event: string; payload: unknown }>, audits: AuditEntry[]) {
  const base: TrustedIpcDeps = {
    ipc: { handle: () => {} },
    audit: (entry) => audits.push(entry),
  };
  return {
    ...base,
    sessions: store,
    push: (event: string, payload: unknown) => pushed.push({ event, payload }),
  } satisfies CompactDeps;
}

function seedSession(
  store: SessionStore,
  id: string,
  count: number,
  textChars: number,
  extra?: (index: number) => Partial<PersistedMessage>,
): PersistedMessage[] {
  const messages: PersistedMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `${i}:` + "x".repeat(textChars),
      ts: 1000 + i,
      ...(extra?.(i) ?? {}),
    });
  }
  store.save({ sessionId: id, updatedAt: 1000, messages });
  return messages;
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-compact-test-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  const pushed: Array<{ event: string; payload: unknown }> = [];
  const audits: AuditEntry[] = [];
  __resetHandlerRegistryForTests();
  env = {
    dir,
    store,
    pushed,
    audits,
    deps: makeDeps(store, pushed, audits),
    handler: undefined as unknown as Handler,
    register(extra?: Partial<CompactDeps>) {
      __resetHandlerRegistryForTests();
      env.deps = { ...makeDeps(env.store, env.pushed, env.audits), ...(extra ?? {}) } as CompactDeps;
      registerCompactDomain(env.deps);
      const entry = getHandlerRegistry().get("chat:compact");
      if (!entry) throw new Error("chat:compact 未注册");
      env.handler = entry.handler as unknown as Handler;
    },
  };
  env.register();
});

afterEach(() => {
  fs.rmSync(env.dir, { recursive: true, force: true });
});

describe("chat:compact 后端（/compact 真实压缩）", () => {
  it("预览（apply 缺省）只算不写盘", async () => {
    const id = "sess-compact-preview";
    seedSession(env.store, id, 60, 2500);
    const result = (await env.handler(TRUSTED_FRAME, { sessionId: id })) as {
      ok: boolean;
      compressed: boolean;
      applied: boolean;
      before: { messages: number; chars: number };
      after: { messages: number; chars: number };
      dropped: number;
      savedRatio: number;
      preview?: Array<{ role: string; text: string; compacted?: boolean }>;
    };

    expect(result.ok).toBe(true);
    expect(result.compressed).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.before.messages).toBe(60);
    expect(result.after.messages).toBe(KEEP_RECENT + 1); // 摘要 1 条 + 最近 14 条
    expect(result.dropped).toBe(60 - KEEP_RECENT);
    expect(result.after.chars).toBeLessThan(result.before.chars);
    expect(result.savedRatio).toBeGreaterThan(0);
    expect(result.savedRatio).toBeLessThan(1);
    expect(result.preview?.length).toBe(KEEP_RECENT + 1);
    expect(result.preview?.[0]?.compacted).toBe(true);

    // 预览不得改动持久化会话
    expect(env.store.loadMessages(id)?.length).toBe(60);
    expect(env.pushed).toHaveLength(0);
  });

  it("apply=true：写回「摘要 + 最近 14 条」并同步索引元信息", async () => {
    const id = "sess-compact-apply";
    const original = seedSession(env.store, id, 60, 2500);
    const result = (await env.handler(TRUSTED_FRAME, { sessionId: id, apply: true })) as {
      ok: boolean;
      applied: boolean;
      dropped: number;
      summary?: string;
    };

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.dropped).toBe(60 - KEEP_RECENT);
    expect(result.summary).toContain("已自动压缩");

    const persisted = env.store.loadMessages(id);
    expect(persisted).not.toBeNull();
    expect(persisted?.length).toBe(KEEP_RECENT + 1);
    // 第 0 条是合成摘要：assistant + compacted 标记 + 摘要标题
    expect(persisted?.[0]?.role).toBe("assistant");
    expect(persisted?.[0]?.compacted).toBe(true);
    expect(persisted?.[0]?.text).toContain("早期对话摘要");
    // 尾部 14 条必须与原始尾部逐条一致（内容不丢、顺序不变）
    const tail = persisted?.slice(1) ?? [];
    expect(tail.map((m) => m.text)).toEqual(original.slice(-KEEP_RECENT).map((m) => m.text));

    // 索引元信息同步
    const meta = env.store.list().find((item) => item.id === id);
    expect(meta?.messageCount).toBe(KEEP_RECENT + 1);
    expect(meta?.preview).toBe(tail[tail.length - 1]?.text.slice(0, 80));
  });

  it("apply=true：push chat:compacted（含 before/after/savedRatio/summary）", async () => {
    const id = "sess-compact-event";
    seedSession(env.store, id, 40, 4000);
    await env.handler(TRUSTED_FRAME, { sessionId: id, apply: true });

    expect(env.pushed).toHaveLength(1);
    const [event] = env.pushed;
    expect(event.event).toBe("chat:compacted");
    const payload = event.payload as {
      sessionId: string;
      before: { messages: number; chars: number };
      after: { messages: number; chars: number };
      dropped: number;
      savedRatio: number;
      summary: string;
      applied: boolean;
    };
    expect(payload.sessionId).toBe(id);
    expect(payload.before.messages).toBe(40);
    expect(payload.after.messages).toBe(KEEP_RECENT + 1);
    expect(payload.dropped).toBe(40 - KEEP_RECENT);
    expect(payload.savedRatio).toBeGreaterThan(0);
    expect(payload.applied).toBe(true);
    expect(payload.summary).toContain("已自动压缩");
    expect(payload.after.chars).toBeLessThan(payload.before.chars);
  });

  it("未超预算：compressed=false、不写回、不推送（apply 也幂等无副作用）", async () => {
    const id = "sess-compact-small";
    seedSession(env.store, id, 3, 10);
    const result = (await env.handler(TRUSTED_FRAME, { sessionId: id, apply: true })) as {
      ok: boolean;
      compressed: boolean;
      applied: boolean;
      before: { chars: number };
      after: { chars: number };
      savedRatio: number;
    };

    expect(result.ok).toBe(true);
    expect(result.compressed).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.after.chars).toBe(result.before.chars);
    expect(result.savedRatio).toBe(0);
    expect(env.store.loadMessages(id)?.length).toBe(3);
    expect(env.pushed).toHaveLength(0);
  });

  it("contextWindow 注入缩小预算：小会话也能触发压缩", async () => {
    const id = "sess-compact-window";
    seedSession(env.store, id, 20, 2000); // ≈40K 字符 > 32K（4000 tokens 推导）
    env.register({ getContextWindow: () => 4000 });
    const result = (await env.handler(TRUSTED_FRAME, { sessionId: id })) as {
      ok: boolean;
      compressed: boolean;
      dropped: number;
      after: { messages: number };
    };

    expect(result.ok).toBe(true);
    expect(result.compressed).toBe(true);
    expect(result.dropped).toBe(20 - KEEP_RECENT);
    expect(result.after.messages).toBe(KEEP_RECENT + 1);
  });

  it("会话忙碌（isBusy=true）→ 拒绝压缩且不写盘", async () => {
    const id = "sess-compact-busy";
    seedSession(env.store, id, 60, 2500);
    env.register({ isBusy: () => true });
    const result = (await env.handler(TRUSTED_FRAME, { sessionId: id, apply: true })) as {
      ok: boolean;
      error?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("正在生成");
    expect(env.store.loadMessages(id)?.length).toBe(60);
    expect(env.pushed).toHaveLength(0);
  });

  it("非法/不存在的会话 ID → 可读错误且绝不新建文件（fail-closed）", async () => {
    // ① 契约层先拒：路径穿越字符不符合 SessionIdSchema
    await expect(env.handler(TRUSTED_FRAME, { sessionId: "../../etc/passwd" })).rejects.toThrow(
      /参数校验失败/,
    );
    // ② 直调 runCompact（绕过契约）也必须 fail-closed
    const traversal = runCompact(env.deps, { sessionId: "../../etc/passwd" });
    expect(traversal.ok).toBe(false);
    expect(traversal.error).toBeTruthy();
    const missing = runCompact(env.deps, { sessionId: "sess-does-not-exist" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("会话不存在");
    // 数据目录里不应出现越界文件
    expect(fs.readdirSync(path.join(env.dir, "sessions"))).toEqual([]);
  });

  it("契约参数类型非法（apply: \"yes\"）→ IPC 包装器拒绝", async () => {
    const id = "sess-compact-bad-param";
    seedSession(env.store, id, 60, 2500);
    await expect(env.handler(TRUSTED_FRAME, { sessionId: id, apply: "yes" })).rejects.toThrow(
      /apply|参数校验失败/,
    );
    // 审计里必须留下拒绝记录（发布门 2 的可追溯性）
    expect(env.audits.some((entry) => entry.channel === "chat:compact" && entry.status === "rejected")).toBe(true);
  });

  it("保留消息的 timeline / provider / model / ts 不被改写", async () => {
    const id = "sess-compact-keep-fields";
    const timeline = [{ kind: "think", text: "保留我的时间线" }];
    const original = seedSession(env.store, id, 60, 2500, (index) =>
      index >= 46 ? { timeline, provider: "opencode-go", model: "deepseek-v4.1-flash" } : {},
    );
    await env.handler(TRUSTED_FRAME, { sessionId: id, apply: true });

    const persisted = env.store.loadMessages(id) ?? [];
    const tail = persisted.slice(1);
    expect(tail.map((m) => m.ts)).toEqual(original.slice(-KEEP_RECENT).map((m) => m.ts));
    expect(tail.every((m) => m.provider === "opencode-go" && m.model === "deepseek-v4.1-flash")).toBe(true);
    expect(tail.every((m) => JSON.stringify(m.timeline) === JSON.stringify(timeline))).toBe(true);
  });

  it("空会话 → ok:false（无需压缩，不产生空文件/事件）", async () => {
    const id = "sess-compact-empty";
    env.store.save({ sessionId: id, updatedAt: 1000, messages: [] });
    const result = (await env.handler(TRUSTED_FRAME, { sessionId: id, apply: true })) as {
      ok: boolean;
      error?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("没有消息");
    expect(env.pushed).toHaveLength(0);
  });

  it("缺省 sessionId 时压缩当前会话", async () => {
    const id = "sess-compact-current";
    seedSession(env.store, id, 60, 2500);
    expect(env.store.currentId()).toBe(id);
    const result = (await env.handler(TRUSTED_FRAME, {})) as {
      ok: boolean;
      sessionId?: string;
      compressed: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe(id);
    expect(result.compressed).toBe(true);
  });

  it("preview 文本截断到 200 字，最多 24 条", async () => {
    const id = "sess-compact-preview-limit";
    seedSession(env.store, id, 80, 6000); // 越大的会话越接近多次收紧
    const result = (await env.handler(TRUSTED_FRAME, { sessionId: id })) as {
      preview?: Array<{ text: string }>;
    };

    expect((result.preview?.length ?? 0) <= 24).toBe(true);
    for (const item of result.preview ?? []) {
      expect(item.text.length <= 201).toBe(true); // 200 字 + 省略号
    }
  });
});

describe("SessionStore.replaceMessages（/compact 落盘入口）", () => {
  it("整体替换消息并同步 messageCount/preview/updatedAt", () => {
    const id = "sess-replace-basic";
    seedSession(env.store, id, 10, 20);
    const before = env.store.list().find((item) => item.id === id)!;
    const replacement: PersistedMessage[] = [
      { role: "assistant", text: "压缩摘要", ts: 9999, compacted: true },
      { role: "user", text: "最后一条", ts: 10000 },
    ];

    const saved = env.store.replaceMessages(id, replacement);
    expect(saved).not.toBeNull();
    expect(env.store.loadMessages(id)).toEqual(replacement);
    const after = env.store.list().find((item) => item.id === id)!;
    expect(after.messageCount).toBe(2);
    expect(after.preview).toBe("最后一条");
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    expect(after.updatedAt).toBe(saved?.updatedAt);
  });

  it("不存在/非法会话 ID → null，且不新建会话文件", () => {
    expect(env.store.replaceMessages("sess-missing", [])).toBeNull();
    expect(env.store.replaceMessages("../escape", [])).toBeNull();
    expect(fs.readdirSync(path.join(env.dir, "sessions"))).toEqual([]);
  });

  it("超过 200 条时只保留最后 200 条（与 save 上限一致）", () => {
    const id = "sess-replace-cap";
    seedSession(env.store, id, 5, 10);
    const many: PersistedMessage[] = Array.from({ length: 260 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `m-${i}`,
      ts: i,
    }));

    const saved = env.store.replaceMessages(id, many);
    expect(saved?.messages.length).toBe(200);
    expect(saved?.messages[0]?.text).toBe("m-60");
    expect(saved?.messages[199]?.text).toBe("m-259");
    expect(env.store.list().find((item) => item.id === id)?.messageCount).toBe(200);
  });
});
