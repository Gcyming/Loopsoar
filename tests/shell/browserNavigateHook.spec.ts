/**
 * browser_navigate 的「打开网页前钩子」（第二阶段 Slice E · 功能②）。
 *
 * 断言三件事：
 *   1. 钩子 proceed:false → 工具返回 ok:false 且 host.navigate **没有被调用**（fail-closed）；
 *   2. 钩子 proceed:true + note → 成功文案后追加一行说明（模型知道这次为什么这样摆窗口）；
 *   3. 不传钩子 → 行为与之前完全一致（既有调用点/测试不受影响）；
 *   4. 钩子只拦 navigate：browser_tabs new 不触发（本片保持面收敛）。
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerBrowserTools, type BrowserToolHooks } from "../../packages/shell/src/main/browserTools.ts";

function makeRegistry(hooks?: BrowserToolHooks) {
  const registry = new ToolRegistry();
  const navigated: string[] = [];
  const newTabs: (string | undefined)[] = [];
  const state = { url: "https://example.com/", title: "示例页" };
  let extraTab = 0;
  const tabs = () => [
    { id: "tab-1", url: state.url, title: state.title, active: true, canBack: false, canForward: false, loading: false, loadFailure: null },
    ...Array.from({ length: extraTab }, (_, i) => ({
      id: `tab-${i + 2}`,
      url: "https://example.com/new",
      title: "新标签",
      active: false,
      canBack: false,
      canForward: false,
      loading: false,
      loadFailure: null,
    })),
  ];
  const host = {
    activeTabId: () => "tab-1",
    getTab: (_sessionId?: string, tabId?: string) => {
      const tab = tabs().find((t) => t.id === tabId) ?? tabs()[0];
      return tab;
    },
    listTabs: () => tabs(),
    navigate: async (url: string) => {
      navigated.push(url);
      state.url = url;
      state.title = "新页面";
      return { ok: true, url, tabId: "tab-1" };
    },
    newTab: async (url?: string) => {
      newTabs.push(url);
      extraTab += 1;
      return { ok: true, tabId: `tab-${extraTab + 1}` };
    },
  };
  registerBrowserTools(registry, () => host as never, undefined, hooks);
  return { registry, navigated, newTabs };
}

function run(registry: ToolRegistry, name: string, params: unknown, sessionId: string) {
  return registry.get(name)!.execute({ agentId: "a", params, platform: {}, sessionId });
}

describe("browser_navigate · beforeOpenPage 钩子", () => {
  it("proceed:false → ok:false + [已取消]，host.navigate 未被调用", async () => {
    const seen: { sessionId?: string; url: string }[] = [];
    const { registry, navigated } = makeRegistry({
      beforeOpenPage: async (args) => {
        seen.push(args);
        return { proceed: false, note: "用户取消了本次打开网页" };
      },
    });

    const result = await run(registry, "browser_navigate", { url: "https://example.com/x" }, "sess-1");

    expect(result.ok).toBe(false);
    expect(result.content.startsWith("[已取消]")).toBe(true);
    expect(result.content).toContain("用户取消了本次打开网页");
    // fail-closed：一次真实导航都不能发生（否则「取消」已经打到源站）
    expect(navigated).toEqual([]);
    expect(seen).toEqual([{ sessionId: "sess-1", url: "https://example.com/x" }]);
  });

  it("proceed:false 且没给 note → 仍然有可读的取消原因", async () => {
    const { registry, navigated } = makeRegistry({ beforeOpenPage: async () => ({ proceed: false }) });
    const result = await run(registry, "browser_navigate", { url: "https://example.com/y" }, "sess-2");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[已取消]");
    expect(result.content.trim().length).toBeGreaterThan("[已取消]".length);
    expect(navigated).toEqual([]);
  });

  it("proceed:true + note → 成功状态行后追加一行说明", async () => {
    const { registry, navigated } = makeRegistry({
      beforeOpenPage: async () => ({ proceed: true, note: "已把会话切换为小窗（独立 Agent 窗口）" }),
    });
    const result = await run(registry, "browser_navigate", { url: "https://example.com/z" }, "sess-3");

    expect(result.ok).toBe(true);
    expect(navigated).toEqual(["https://example.com/z"]);
    const lines = result.content.split("\n");
    expect(lines[0]).toContain("[状态] ✓ 已打开 https://example.com/z");
    expect(lines[lines.length - 1]).toBe("已把会话切换为小窗（独立 Agent 窗口）");
  });

  it("proceed:true 但没有 note → 文案与不传钩子时一致", async () => {
    const withHook = makeRegistry({ beforeOpenPage: async () => ({ proceed: true }) });
    const without = makeRegistry();

    const a = await run(withHook.registry, "browser_navigate", { url: "https://example.com/same" }, "sess-4");
    const b = await run(without.registry, "browser_navigate", { url: "https://example.com/same" }, "sess-4");

    expect(a.ok).toBe(true);
    expect(a.content).toBe(b.content);
    expect(withHook.navigated).toEqual(["https://example.com/same"]);
    expect(without.navigated).toEqual(["https://example.com/same"]);
  });

  it("不传钩子 → 行为完全不变（没有多出来的提示行）", async () => {
    const { registry, navigated } = makeRegistry();
    const result = await run(registry, "browser_navigate", { url: "https://example.com/plain" }, "sess-5");

    expect(result.ok).toBe(true);
    expect(result.content).toContain("[状态] ✓ 已打开 https://example.com/plain");
    expect(result.content).not.toContain("布局");
    expect(navigated).toEqual(["https://example.com/plain"]);
  });

  it("钩子只拦 navigate：browser_tabs action=new 不触发（本片面收敛）", async () => {
    let calls = 0;
    const { registry, newTabs } = makeRegistry({
      beforeOpenPage: async () => {
        calls += 1;
        return { proceed: false };
      },
    });

    const result = await run(registry, "browser_tabs", { action: "new", url: "https://example.com/new" }, "sess-6");

    expect(result.ok).toBe(true);
    expect(newTabs).toEqual(["https://example.com/new"]);
    expect(calls).toBe(0);
  });
});
