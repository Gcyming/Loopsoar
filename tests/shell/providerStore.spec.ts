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
