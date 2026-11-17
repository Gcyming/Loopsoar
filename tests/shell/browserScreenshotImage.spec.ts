import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import type { BrowserBackend } from "../../packages/shell/src/main/browserBackend.ts";
import { registerBrowserTools } from "../../packages/shell/src/main/browserTools.ts";

/** 1x1 PNG：足够让截图工具读出尺寸并落盘。 */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n8sAAAAASUVORK5CYII=";

function fakeBackend(screenshot: string | null): BrowserBackend {
  return {
    listTabs: () => [],
    activeTabId: () => "tab-1",
    navigate: async (url) => ({ ok: true, url, tabId: "tab-1" }),
    newTab: async () => ({ tabId: "tab-1", ok: true }),
    selectTab: () => true,
    closeTab: async () => true,
    goBack: async () => ({ ok: true }),
    goForward: async () => ({ ok: true }),
    reload: async () => ({ ok: true }),
    screenshot: async () => screenshot,
    snapshot: async () => null,
    agentClick: async () => true,
    agentType: async () => true,
    agentHover: async () => true,
    getViewportCenter: async () => ({ x: 1, y: 1 }),
    agentDrag: async () => true,
    agentWheel: async () => true,
    agentKey: async () => true,
    executeScript: async () => null,
    getPageZoom: () => 1,
    isSessionVisible: () => true,
    ensureAgentTab: async () => "tab-1",
  };
}

async function runScreenshot(visionEnabled: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-shot-"));
  try {
    const registry = new ToolRegistry();
    registerBrowserTools(registry, () => fakeBackend(TINY_PNG), () => root, { visionEnabled: () => visionEnabled });
    const result = await registry.get("browser_screenshot")!.execute({
      agentId: "test",
      sessionId: "s1",
      params: {},
      platform: {},
    });
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("browser_screenshot 图片回灌（P1-4）", () => {
  it("视觉模型拿到 image part；text-only 模型只拿路径", async () => {
    const vision = await runScreenshot(true);
    expect(vision.ok).toBe(true);
    expect(vision.images?.[0]).toMatchObject({ mime: "image/png" });
    expect(vision.content).toContain("图片已附");

    const textOnly = await runScreenshot(false);
    expect(textOnly.ok).toBe(true);
    expect(textOnly.images).toBeUndefined();
    expect(textOnly.content).not.toContain("图片已附");
  });
});
