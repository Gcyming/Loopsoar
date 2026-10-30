/**
 * 浏览器工具集：注册/权限声明/快照格式化/点击脚本（假 BrowserHost，无 electron）。
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerBrowserTools } from "../../packages/shell/src/main/browserTools.ts";

function makeRegistry() {
  const registry = new ToolRegistry();
  const calls: string[] = [];
  const host = {
    snapshot: async () => ({
      url: "https://example.com/",
      title: "示例页",
      text: "正文内容 ABC",
      elements: [{ id: "1", tag: "button", text: "点我" }],
    }),
    navigate: async (url: string) => {
      calls.push(`navigate:${url}`);
      return { ok: true, url };
    },
    executeScript: async (_script: string) => {
      calls.push("script");
      return { ok: true };
    },
  };
  registerBrowserTools(registry, () => host as never);
  return { registry, calls };
}

describe("浏览器工具集", () => {
  it("注册了核心浏览器工具并声明正确权限类别", () => {
    const { registry } = makeRegistry();
    const names = registry.list().map((t) => t.name);
    for (const name of ["browser_snapshot", "browser_navigate", "browser_click", "browser_type", "browser_scroll", "web_fetch"]) {
      expect(names).toContain(name);
    }
    expect(registry.get("browser_snapshot")!.permissions.read).toBe(true);
    expect(registry.get("browser_navigate")!.permissions.network).toBe(true);
    expect(registry.get("web_fetch")!.permissions.network).toBe(true);
  });

  it("browser_snapshot：返回 URL/标题/正文/可交互元素编号", async () => {
    const { registry } = makeRegistry();
    const result = await registry.get("browser_snapshot")!.execute({ agentId: "a", params: {}, platform: {} });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("https://example.com/");
    expect(result.content).toContain("示例页");
    expect(result.content).toContain("正文内容 ABC");
    expect(result.content).toContain("[#1]");
  });

  it("browser_navigate / browser_click：调用宿主并返回可读结果", async () => {
    const { registry, calls } = makeRegistry();
    const nav = await registry.get("browser_navigate")!.execute({
      agentId: "a",
      params: { url: "https://example.com/x" },
      platform: {},
    });
    expect(nav.ok).toBe(true);
    expect(calls.some((c) => c.startsWith("navigate:https://example.com/x"))).toBe(true);

    const click = await registry.get("browser_click")!.execute({ agentId: "a", params: { target: "text=点我" }, platform: {} });
    expect(click.ok).toBe(true);
    expect(calls.filter((c) => c === "script").length).toBe(1);
  });
});
