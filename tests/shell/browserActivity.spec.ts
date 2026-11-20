import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { instrumentBrowserActivity } from "../../packages/shell/src/main/browserActivity.js";

describe("browser activity instrumentation", () => {
  it("执行浏览器工具时推 start/end", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "browser_click",
      description: "x",
      permissions: { browser: true },
      schema: { parse: (v: unknown) => v } as any,
      execute: vi.fn(async () => ({ ok: true, content: "ok" })),
    });
    const push = vi.fn();
    instrumentBrowserActivity(registry as any, ["browser_click", "missing"], push);
    const result = await registry.get("browser_click")!.execute({ agentId: "a", sessionId: "s", platform: {}, params: {} });
    expect(result.ok).toBe(true);
    expect(push.mock.calls.map((c) => (c[1] as any).phase)).toEqual(["start", "end"]);
  });
});
