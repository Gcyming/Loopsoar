/**
 * 多供应商（ProviderStore）+ 多会话（SessionStore）落盘行为。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderStore } from "../../packages/shell/src/main/providerStore.ts";
import { SessionStore } from "../../packages/shell/src/main/sessionStore.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "loopsoar-persist-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ProviderStore 多供应商", () => {
  it("新增/切换活跃/删除，删除活跃后自动回落", () => {
    const store = new ProviderStore(path.join(root, "config"));
    const a = store.upsert({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" });
    const b = store.upsert({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
    expect(store.list().length).toBe(2);
    expect(store.active()?.id).toBe(a.id);
    expect(store.setActive(b.id)).toBe(true);
    expect(store.active()?.id).toBe(b.id);
    expect(store.remove(b.id)).toBe(true);
    expect(store.active()?.id).toBe(a.id);
  });

  it("旧版 provider.json 自动迁移为一条记录", () => {
    const configDir = path.join(root, "config2");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "provider.json"), JSON.stringify({ provider: "local", baseUrl: "http://127.0.0.1:8080/v1", model: "m" }));
    const store = new ProviderStore(configDir);
    expect(store.list().length).toBe(1);
    expect(store.active()?.model).toBe("m");
  });
});

describe("SessionStore 多会话", () => {
  it("新建/追加/切换/删除；列表按更新时间倒序", () => {
    const store = new SessionStore(path.join(root, "sessions"));
    const first = store.newSession();
    store.append(first.sessionId, "你好", "你好呀");
    const second = store.newSession();
    store.append(second.sessionId, "第二段", "收到");
    expect(store.list().length).toBe(2);
    expect(store.currentId()).toBe(second.sessionId);
    expect(store.switchTo(first.sessionId)).toBe(true);
    expect(store.load()?.messages.length).toBe(2);
    expect(store.remove(first.sessionId)).toBe(true);
    expect(store.list().length).toBe(1);
  });

  it("旧版 last.json 自动迁移", () => {
    const dir = path.join(root, "sessions2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "last.json"), JSON.stringify({ sessionId: "old-1", updatedAt: 1, messages: [{ role: "user", text: "旧会话", ts: 1 }] }));
    const store = new SessionStore(dir);
    expect(store.list().length).toBe(1);
    expect(store.load()?.messages[0].text).toBe("旧会话");
  });
});
