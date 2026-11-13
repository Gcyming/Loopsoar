/**
 * OpenCode 计划端点：
 *   · Go 订阅端点（/inference/go/openai/v1）必须原样保留——2026-11 实测 Go 的 Key 打按量付费端点
 *     会 403「Model access is disabled」，历史版本把它统一改写成 /inference/openai/v1 是错误迁移；
 *   · 历史 zen 端点（/zen/v1）迁到当前按量付费端点；
 *   · **没有「默认模型」概念**：模型只是当前选用/最近使用，加载与保存都不得自动改写用户选的模型
 *     （哪怕它是免费模型、或不在已探测清单里）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProviderStore,
  canonicalOpenCodeBaseUrl,
  isOpenCodeBaseUrl,
  isOpenCodeGoBaseUrl,
} from "../../packages/shell/src/main/providerStore.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-provider-oc-"));
}

function writeProviders(dir: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify(value), "utf8");
}

describe("OpenCode 端点识别", () => {
  it("区分 Go 订阅端点与按量付费端点", () => {
    expect(isOpenCodeBaseUrl("https://opencode.ai/inference/go/openai/v1")).toBe(true);
    expect(isOpenCodeGoBaseUrl("https://opencode.ai/inference/go/openai/v1")).toBe(true);
    expect(isOpenCodeGoBaseUrl("https://opencode.ai/inference/openai/v1")).toBe(false);
    expect(isOpenCodeBaseUrl("https://api.deepseek.com/v1")).toBe(false);
  });

  it("只迁移历史 zen 路径，不动 Go 端点", () => {
    expect(canonicalOpenCodeBaseUrl("https://opencode.ai/zen/v1")).toBe("https://opencode.ai/inference/openai/v1");
    expect(canonicalOpenCodeBaseUrl("https://opencode.ai/inference/go/openai/v1")).toBe(
      "https://opencode.ai/inference/go/openai/v1",
    );
    expect(canonicalOpenCodeBaseUrl("https://opencode.ai/inference/openai/v1/")).toBe(
      "https://opencode.ai/inference/openai/v1",
    );
    expect(canonicalOpenCodeBaseUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1");
  });
});

describe("ProviderStore OpenCode 加载迁移", () => {
  it("Go 订阅配置原样保留（地址/请求头/当前模型都不动）", () => {
    const dir = tempDir();
    try {
      writeProviders(dir, {
        activeId: "go",
        items: [
          {
            id: "go",
            provider: "opencode-go",
            baseUrl: "https://opencode.ai/inference/go/openai/v1",
            model: "deepseek-v4.1-flash",
            headers: { "x-opencode-session": "{{sessionId}}" },
            models: [{ id: "deepseek-v4.1-flash" }],
          },
        ],
      });
      const store = new ProviderStore(dir);
      const item = store.active()!;
      expect(item.baseUrl).toBe("https://opencode.ai/inference/go/openai/v1");
      expect(item.model).toBe("deepseek-v4.1-flash");
      expect(item.headers?.["x-opencode-session"]).toBe("{{sessionId}}");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("历史 zen 端点迁移，但当前模型（含免费模型）不被自动改写", () => {
    const dir = tempDir();
    try {
      writeProviders(dir, {
        activeId: "zen",
        items: [
          {
            id: "zen",
            provider: "opencode-zen",
            baseUrl: "https://opencode.ai/zen/v1",
            model: "beam-free",
            models: [{ id: "beam-free" }, { id: "deepseek-v4.1-flash" }, { id: "glm-5.3" }],
          },
        ],
      });
      const store = new ProviderStore(dir);
      const item = store.active()!;
      expect(item.baseUrl).toBe("https://opencode.ai/inference/openai/v1");
      expect(item.model).toBe("beam-free");
      expect(item.models?.map((model) => model.id)).toEqual(["beam-free", "deepseek-v4.1-flash", "glm-5.3"]);
      // 迁移写回是幂等的：再次读取不再变化
      expect(new ProviderStore(dir).active()?.model).toBe("beam-free");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非 OpenCode 供应商不迁移端点/模型", () => {
    const dir = tempDir();
    try {
      writeProviders(dir, {
        activeId: "ds",
        items: [
          {
            id: "ds",
            provider: "deepseek",
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            models: [{ id: "deepseek-chat" }],
          },
        ],
      });
      const item = new ProviderStore(dir).active()!;
      expect(item.baseUrl).toBe("https://api.deepseek.com/v1");
      expect(item.model).toBe("deepseek-chat");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("保存 OpenCode 配置时保留用户选的模型（即使是免费模型）", () => {
    const dir = tempDir();
    try {
      const store = new ProviderStore(dir);
      const saved = store.upsert({
        provider: "opencode-go",
        baseUrl: "https://opencode.ai/inference/go/openai/v1",
        model: "beam-free",
        apiFormat: "openai",
        models: [{ id: "beam-free" }, { id: "deepseek-v4.1-flash" }],
      });
      expect(saved.model).toBe("beam-free");
      expect(saved.models?.map((model) => model.id)).toEqual(["beam-free", "deepseek-v4.1-flash"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
