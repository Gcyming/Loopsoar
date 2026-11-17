import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import type { BrowserBackend } from "../../packages/shell/src/main/browserBackend.ts";
import { registerBrowserTools } from "../../packages/shell/src/main/browserTools.ts";

/**
 * P1-3 端口验证：工具层只要求 BrowserBackend，不要求 Electron BrowserHost。
 * 这个假后端没有任何 Electron 依赖，能注册并执行 browser_tabs，说明工具面已经解耦。
 */
describe("BrowserBackend 端口（P1-3）", () => {
  it("非 Electron 假后端可注册并执行 browser_tabs", async () => {
    const backend: BrowserBackend = {
      listTabs: () => [
        {
          id: "tab-1",
          url: "https://example.com/",
          title: "示例页",
          active: true,
          canBack: false,
          canForward: false,
          loading: false,
          loadFailure: null,
          agentBound: false,
        },
      ],
      activeTabId: () => "tab-1",
      navigate: async (url) => ({ ok: true, url, tabId: "tab-1" }),
      newTab: async () => ({ tabId: "tab-1", ok: true }),
      selectTab: () => true,
      closeTab: async () => true,
      goBack: async () => ({ ok: true }),
      goForward: async () => ({ ok: true }),
      reload: async () => ({ ok: true }),
      screenshot: async () => null,
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

    const registry = new ToolRegistry();
    registerBrowserTools(registry, () => backend);
    const result = await registry.get("browser_tabs")!.execute({
      agentId: "test",
      sessionId: "s1",
      params: { action: "list" },
      platform: {},
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("示例页");
    expect(result.content).toContain("https://example.com/");
  });
});
