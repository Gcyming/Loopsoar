/**
 * 供应商配置：自定义请求头持久化 + 清洗（数量上限、非字符串丢弃）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderStore, isSameProviderTarget } from "../../packages/shell/src/main/providerStore.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-provider-"));
}

describe("ProviderStore 自定义请求头", () => {
  it("保存后重新加载仍保留请求头", () => {
    const dir = tempDir();
    try {
      const store = new ProviderStore(dir);
      store.upsert({
        provider: "opencode",
        baseUrl: "https://api.opencode.ai/v1",
        model: "opencode-go",
        headers: { "x-api-key": "abc", "User-Agent": "Loopsoar/1.0" },
      });
      const reloaded = new ProviderStore(dir).active();
      expect(reloaded?.headers).toEqual({ "x-api-key": "abc", "User-Agent": "Loopsoar/1.0" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("请求头最多 30 条，非字符串值被丢弃", () => {
    const dir = tempDir();
    try {
      const store = new ProviderStore(dir);
      const headers: Record<string, string> = {};
      for (let i = 0; i < 40; i += 1) headers[`x-h-${i}`] = String(i);
      headers["x-weird" as string] = 123 as unknown as string;
      const item = store.upsert({ provider: "p", baseUrl: "https://example.com/v1", model: "m", headers });
      expect(Object.keys(item.headers ?? {}).length).toBe(30);
      expect(item.headers?.["x-weird"]).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("切模型目标识别", () => {
  it("同 provider + 规范化 baseUrl 视为同一供应商（原地改 model，不新建）", () => {
    expect(
      isSameProviderTarget(
        { id: "a", provider: "mock", baseUrl: "http://127.0.0.1:19500/v1", model: "mock-chat" },
        { provider: "mock", baseUrl: "http://127.0.0.1:19500/v1/" },
      ),
    ).toBe(true);
    expect(
      isSameProviderTarget(
        { id: "a", provider: "mock", baseUrl: "http://127.0.0.1:19500/v1", model: "mock-chat" },
        { provider: "opencode-go", baseUrl: "https://opencode.ai/inference/go/openai/v1" },
      ),
    ).toBe(false);
    expect(isSameProviderTarget(null, { provider: "x", baseUrl: "https://x.test" })).toBe(false);
  });
});

describe("供应商重复合并与请求设置保留", () => {
  it("历史重复供应商自动合并，请求头/模型不丢，activeId 指向保留项", () => {
    const dir = tempDir();
    try {
      fs.writeFileSync(
        path.join(dir, "providers.json"),
        JSON.stringify({
          activeId: "opencode-go-2",
          items: [
            { id: "mock-1", provider: "mock", baseUrl: "http://127.0.0.1:19500/v1", model: "mock-chat" },
            {
              id: "opencode-go",
              provider: "opencode-go",
              baseUrl: "https://opencode.ai/inference/go/openai/v1",
              model: "glm-5.3",
              headers: { "x-opencode-session": "{{sessionId}}" },
            },
            {
              id: "opencode-go-2",
              provider: "opencode-go",
              baseUrl: "https://opencode.ai/inference/go/openai/v1/",
              model: "deepseek-v4.1-flash",
              models: [{ id: "deepseek-v4.1-flash", selected: true }],
            },
          ],
        }),
        "utf8",
      );
      const store = new ProviderStore(dir);
      const items = store.list();
      expect(items.map((item) => item.id)).toEqual(["mock-1", "opencode-go"]);
      const merged = items.find((item) => item.id === "opencode-go")!;
      expect(merged.headers?.["x-opencode-session"]).toBe("{{sessionId}}");
      expect(merged.models?.map((model) => model.id)).toContain("deepseek-v4.1-flash");
      expect(store.active()?.id).toBe("opencode-go");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("更新已有供应商时保留 headers/models/apiFormat（不因切模型丢设置）", () => {
    const dir = tempDir();
    try {
      const store = new ProviderStore(dir);
      const created = store.upsert({
        provider: "opencode-go",
        baseUrl: "https://opencode.ai/inference/go/openai/v1",
        model: "glm-5.3",
        apiFormat: "openai",
        headers: { "x-opencode-session": "{{sessionId}}" },
        models: [{ id: "glm-5.3", selected: true }],
      });
      const updated = store.upsert({ ...created, model: "kimi-k3" });
      expect(updated.headers?.["x-opencode-session"]).toBe("{{sessionId}}");
      expect(updated.apiFormat).toBe("openai");
      expect(updated.models?.[0]?.id).toBe("glm-5.3");
      expect(store.list()).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("去重合并的密钥迁移回调（2026-11-10 密钥问题）", () => {
  it("重复供应商合并时把 alias（副本 id → 保留 id）交给装配层", () => {
    const dir = tempDir();
    try {
      const file = {
        activeId: "opencode-go",
        items: [
          { id: "opencode-go", provider: "opencode-go", baseUrl: "https://opencode.ai/inference/go/openai/v1", model: "deepseek-v4.1-flash" },
          { id: "opencode-go-2", provider: "opencode-go", baseUrl: "https://opencode.ai/inference/go/openai/v1/", model: "glm-5.3" },
        ],
      };
      fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify(file));
      const seen: Map<string, string>[] = [];
      const store = new ProviderStore(dir, { onAliases: (alias) => seen.push(alias) });
      store.list();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0].get("opencode-go-2")).toBe("opencode-go");
      expect(store.list().map((i) => i.id)).toEqual(["opencode-go"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upsert 传已不存在的副本 id 时复用同端点现存记录，绝不复活副本", () => {
    const dir = tempDir();
    try {
      const store = new ProviderStore(dir);
      const first = store.upsert({ provider: "opencode-go", baseUrl: "https://opencode.ai/inference/go/openai/v1", model: "deepseek-v4.1-flash" });
      const second = store.upsert({
        id: `${first.id}-2`,
        provider: "opencode-go",
        baseUrl: "https://opencode.ai/inference/go/openai/v1",
        model: "glm-5.3",
      });
      expect(second.id).toBe(first.id);
      expect(store.list()).toHaveLength(1);
      // 新增同 provider + 同端点：同样复用，不产生副本（否则新 Key 又会挂到孤儿 id 上）
      const third = store.upsert({ provider: "opencode-go", baseUrl: "https://opencode.ai/inference/go/openai/v1/", model: "x" });
      expect(third.id).toBe(first.id);
      expect(store.list()).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
