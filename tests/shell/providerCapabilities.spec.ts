/**
 * 供应商模型能力自动补全（providerStore）：
 *   · 保存供应商时，内置能力表自动补全「上下文/最大输出/视觉/思考/推理等级/输入模态/函数调用/结构化输出」；
 *   · 用户/上游显式值绝不覆盖；
 *   · 旧 providers.json（没有 models 清单）读取时也能看到补全后的默认模型信息；
 *   · NVIDIA NIM 端点走官方模型卡数据（用户提供的最新文档）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderStore } from "../../packages/shell/src/main/providerStore.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-provider-caps-"));
}

function withStore(fn: (store: ProviderStore, dir: string) => void): void {
  const dir = tmpDir();
  try {
    fn(new ProviderStore(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe("供应商模型能力自动补全", () => {
  it("保存时自动补全：上下文/输出/思考/推理等级（slime 家族表）", () => {
    withStore((store) => {
      const item = store.upsert({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-v4.1-flash",
      });
      const model = item.models?.[0];
      expect(model?.id).toBe("deepseek-v4.1-flash");
      expect(model?.contextWindow).toBeGreaterThan(0);
      expect(model?.maxOutput).toBeGreaterThan(0);
      expect(model?.thinking).toBe(true);
      expect(model?.thinkingEfforts?.length).toBeGreaterThan(0);
    });
  });

  it("NVIDIA NIM：用官方模型卡数据补全（上下文/输出/图片/工具/结构化）", () => {
    withStore((store) => {
      const item = store.upsert({
        provider: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        model: "kimi-k3",
      });
      const model = item.models?.[0];
      expect(model?.contextWindow).toBe(1_048_576);
      expect(model?.maxOutput).toBe(16_384);
      expect(model?.vision).toBe(true);
      expect(model?.inputModalities).toEqual(expect.arrayContaining(["text", "image"]));
      expect(model?.functionCalling).toBe(true);
      expect(model?.structuredOutput).toBe(true);
    });
  });

  it("显式值绝不覆盖：用户手填的上下文/关闭的视觉保持原样", () => {
    withStore((store) => {
      const item = store.upsert({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2",
        models: [{ id: "gpt-5.2", selected: true, contextWindow: 12_345, vision: false }],
      });
      const model = item.models?.[0];
      expect(model?.contextWindow).toBe(12_345);
      expect(model?.vision).toBe(false);
      // 未显式给的字段仍由内置表补全
      expect(model?.thinking).toBe(true);
    });
  });

  it("旧 providers.json（无 models 清单）读取时补全默认模型信息", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, "providers.json"),
        JSON.stringify(
          {
            activeId: "p1",
            items: [
              { id: "p1", provider: "agnes", baseUrl: "https://api.agnes-ai.cn/v1", model: "deepseek-v4.1-flash" },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );
      const store = new ProviderStore(dir);
      const item = store.list()[0];
      expect(item.models?.[0]?.id).toBe("deepseek-v4.1-flash");
      expect(item.models?.[0]?.contextWindow).toBeGreaterThan(0);
      expect(item.models?.[0]?.thinking).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("补全结果会随保存落盘（下次启动读到的就是完整信息）", () => {
    withStore((store, dir) => {
      store.upsert({ provider: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", model: "gpt-oss-20b" });
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "providers.json"), "utf8")) as {
        items: { models?: { id: string; contextWindow?: number; maxOutput?: number }[] }[];
      };
      const model = raw.items[0]?.models?.[0];
      expect(model?.id).toBe("gpt-oss-20b");
      expect(model?.contextWindow).toBe(131_072);
      expect(model?.maxOutput).toBe(4096);
    });
  });
});
