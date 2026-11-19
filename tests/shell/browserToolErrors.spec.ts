/**
 * 浏览器工具错误码（P2-1）：失败必须带 error，上层才能按码分流。
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import {
  BROWSER_ERROR_CODES,
  deriveBrowserErrorCode,
  registerBrowserTools,
  withBrowserErrorCode,
} from "../../packages/shell/src/main/browserTools.ts";
import type { BrowserBackend } from "../../packages/shell/src/main/browserBackend.ts";

function registryWith(host: Partial<BrowserBackend>): ToolRegistry {
  const registry = new ToolRegistry();
  registerBrowserTools(registry, () => host as BrowserBackend);
  return registry;
}

async function run(registry: ToolRegistry, name: string, params: unknown): Promise<{ ok: boolean; error?: string; content: string }> {
  const def = registry.get(name);
  if (!def) throw new Error("工具未注册：" + name);
  return def.execute({ params, sessionId: "s-e2e" } as never);
}

describe("deriveBrowserErrorCode", () => {
  it("已有 [CODE] 前缀优先", () => {
    expect(deriveBrowserErrorCode("[STALE_REF] 引用已过期")).toBe("STALE_REF");
    expect(deriveBrowserErrorCode("[TARGET_MOVED] 位置变了")).toBe("TARGET_MOVED");
    expect(deriveBrowserErrorCode("[NO_TAB] 没标签")).toBe("NO_TAB");
    expect(deriveBrowserErrorCode("[BLOCKED_LOOPBACK] 回环")).toBe("BLOCKED_LOOPBACK");
  });

  it("中文文案按关键词映射", () => {
    expect(deriveBrowserErrorCode("[已取消] 用户取消")).toBe("CANCELLED");
    expect(deriveBrowserErrorCode("[错误] 缺少 target")).toBe("INVALID_ARGS");
    expect(deriveBrowserErrorCode("[错误] 没有打开的网页标签")).toBe("NO_TAB");
    expect(deriveBrowserErrorCode("[错误] 浏览器未就绪")).toBe("NO_HOST");
    expect(deriveBrowserErrorCode("[错误] 导航失败：net::ERR")).toBe("NAV_FAILED");
    expect(deriveBrowserErrorCode("[错误] 点击失败：x")).toBe("CLICK_FAILED");
    expect(deriveBrowserErrorCode("[错误] 输入失败：x")).toBe("TYPE_FAILED");
    expect(deriveBrowserErrorCode("[错误] 等待超时")).toBe("TIMEOUT");
    expect(deriveBrowserErrorCode("[错误] 未找到匹配元素")).toBe("NOTHING_FOUND");
    expect(deriveBrowserErrorCode("[错误] 说不清的原因")).toBe("UNKNOWN");
  });

  it("withBrowserErrorCode：成功/已有码不改，失败补码", () => {
    expect(withBrowserErrorCode({ ok: true, content: "ok" })).toEqual({ ok: true, content: "ok" });
    expect(withBrowserErrorCode({ ok: false, content: "x", error: "已知" }).error).toBe("已知");
    expect(withBrowserErrorCode({ ok: false, content: "[NO_TAB] 没标签" }).error).toBe("NO_TAB");
  });

  it("错误码集合稳定（供上层 switch 使用）", () => {
    expect(BROWSER_ERROR_CODES).toContain("STALE_REF");
    expect(new Set(BROWSER_ERROR_CODES).size).toBe(BROWSER_ERROR_CODES.length);
  });
});

describe("工具返回值的 error 字段", () => {
  it("browser_snapshot 无页 → NO_TAB", async () => {
    const registry = registryWith({ snapshot: async () => null } as Partial<BrowserBackend>);
    const result = await run(registry, "browser_snapshot", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("NO_TAB");
  });

  it("browser_click 缺 target → INVALID_ARGS", async () => {
    const registry = registryWith({} as Partial<BrowserBackend>);
    const result = await run(registry, "browser_click", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("INVALID_ARGS");
  });

  it("browser_snapshot 来源标记：agent-tab / user-tab（P2-4）", async () => {
    const agent = registryWith({
      snapshot: async () => ({ tabId: "t1", url: "https://x", title: "X", text: "hi", elements: [] }),
      listTabs: () => [{ id: "t1", agentBound: true }],
    } as never);
    const agentResult = await run(agent, "browser_snapshot", {});
    expect(agentResult.ok).toBe(true);
    expect(agentResult.content).toContain("source=agent-tab");

    const user = registryWith({
      snapshot: async () => ({ tabId: "t1", url: "https://x", title: "X", text: "hi", elements: [] }),
      listTabs: () => [{ id: "t1", agentBound: false }],
    } as never);
    const userResult = await run(user, "browser_snapshot", {});
    expect(userResult.ok).toBe(true);
    expect(userResult.content).toContain("source=user-tab");
    expect(userResult.content).toContain("用户全局标签");
  });

  it("browser_navigate 缺 url → INVALID_ARGS", async () => {
    const registry = registryWith({} as Partial<BrowserBackend>);
    const result = await run(registry, "browser_navigate", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("INVALID_ARGS");
  });
});
