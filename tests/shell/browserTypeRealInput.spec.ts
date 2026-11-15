/**
 * browser_type 的真实键盘优先路径：
 *   · 可编辑元素 → 点进输入框 + agentType 逐字输入 → 回读一致即成功（不再走原生 setter）；
 *   · 真实输入不可用/回读不一致 → 回退原生 setter（既有行为不丢）。
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerBrowserTools } from "../../packages/shell/src/main/browserTools.ts";

function makeHost(options: { typed?: boolean } = {}) {
  const scripts: string[] = [];
  const typeCalls: { text: string; multiline?: boolean }[] = [];
  let value = "";
  const host = {
    activeTabId: () => "tab-1",
    getTab: () => ({
      id: "tab-1",
      url: "https://example.com/",
      title: "示例页",
      active: true,
      canBack: false,
      canForward: false,
      loading: false,
      loadFailure: null,
    }),
    executeScript: async (script: string) => {
      scripts.push(script);
      if (script.includes("loopsoar:target-point")) {
        return { ok: true, x: 100, y: 50, width: 120, height: 24, tag: "input", type: "text", editable: true, multiline: false };
      }
      if (script.includes("loopsoar:type-readback")) return { ok: true, value };
      return { ok: true };
    },
    agentClick: async () => true,
    agentType: async (_sessionId: string | undefined, _tabId: string | undefined, text: string, opts?: { multiline?: boolean }) => {
      if (options.typed === false) return false;
      value = opts?.multiline ? text : text.replace(/\r\n?/g, "\n").replace(/\n/g, " ");
      typeCalls.push({ text, ...(opts?.multiline !== undefined ? { multiline: opts.multiline } : {}) });
      return true;
    },
    isSessionVisible: () => true,
    getPageZoom: () => 1,
  };
  const registry = new ToolRegistry();
  registerBrowserTools(registry, () => host as never);
  return { registry, scripts, typeCalls };
}

function run(registry: ToolRegistry, params: unknown, sessionId = "type-1") {
  return registry.get("browser_type")!.execute({ agentId: "a", params, platform: {}, sessionId });
}

describe("browser_type · 真实键盘优先", () => {
  it("可编辑元素：逐字输入并回读校验通过，不再注入原生 setter", async () => {
    const { registry, scripts, typeCalls } = makeHost();
    const result = await run(registry, { target: "#name", text: "Loopsoar 中文 123" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("已输入");
    expect(typeCalls).toEqual([{ text: "Loopsoar 中文 123", multiline: false }]);
    // 只跑了定位/回读，没有 buildTypeScript（原生 setter 的标志）
    expect(scripts.some((script) => script.includes("Object.getOwnPropertyDescriptor"))).toBe(false);
    expect(scripts.some((script) => script.includes("loopsoar:type-readback"))).toBe(true);
  });

  it("真实输入不可用 → 回退原生 setter", async () => {
    const { registry, scripts } = makeHost({ typed: false });
    const result = await run(registry, { target: "#name", text: "fallback" });
    expect(result.ok).toBe(true);
    expect(scripts.some((script) => script.includes("Object.getOwnPropertyDescriptor"))).toBe(true);
  });
});
