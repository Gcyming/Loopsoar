import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerBrowserDataTools } from "../../packages/shell/src/main/browserDataTools.js";

function setup(hooks = {}) {
  const registry = new ToolRegistry();
  registerBrowserDataTools(registry as any, hooks);
  return registry;
}

async function call(registry: ToolRegistry, name: string, params: unknown) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool.execute({ agentId: "a", sessionId: "s", platform: {}, params });
}

describe("browser data tools", () => {
  it("downloads: list 与 wait（完成/超时）", async () => {
    const list = vi.fn(() => [
      { id: "dl-1", filename: "a.pdf", savePath: "/tmp/a.pdf", state: "completed" as const, received: 10, total: 10, startedAt: 1 },
    ]);
    const registry = setup({ downloads: { list } });
    const listed = await call(registry, "browser_downloads", { action: "list" });
    expect(listed.ok).toBe(true);
    expect(listed.content).toContain("a.pdf");
    expect(listed.content).toContain("completed");
    const waited = await call(registry, "browser_downloads", { action: "wait", filename: "a", timeoutMs: 100 });
    expect(waited.ok).toBe(true);
    expect(waited.content).toContain("下载完成");
  });

  it("downloads: 没有记录时 wait 超时", async () => {
    const registry = setup({ downloads: { list: () => [] } });
    const result = await call(registry, "browser_downloads", { action: "wait", timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("TIMEOUT");
  });

  it("cookies: 只输出元数据，不返回值", async () => {
    const registry = setup({
      cookies: async () => [
        { name: "sid", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax" },
      ],
    });
    const result = await call(registry, "browser_cookies", {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain("sid");
    expect(result.content).toContain("HttpOnly");
    expect(result.content).not.toContain("value");
  });

  it("diagnostics: console 级别过滤与 network 错误状态", async () => {
    const registry = setup({
      console: () => [
        { tabId: "t1", level: "info" as const, message: "hello", at: 1 },
        { tabId: "t1", level: "error" as const, message: "boom", at: 2 },
      ],
      network: () => [
        { tabId: "t1", method: "GET", url: "https://x.test/a", status: 500, at: 3 },
      ],
    });
    const logs = await call(registry, "browser_diagnostics", { kind: "console", level: "error" });
    expect(logs.content).toContain("boom");
    expect(logs.content).not.toContain("hello");
    const net = await call(registry, "browser_diagnostics", { kind: "network" });
    expect(net.content).toContain("[500] GET https://x.test/a");
  });

  it("upload: 透传 selector/文件，并拒绝空文件", async () => {
    const upload = vi.fn(async () => ({ ok: true, message: "已选择 1 个文件" }));
    const registry = setup({ upload });
    const ok = await call(registry, "browser_upload", { target: "input[type=file]", files: ["a.txt"] });
    expect(ok.ok).toBe(true);
    expect(upload).toHaveBeenCalledWith("s", "input[type=file]", ["a.txt"]);
    const empty = await call(registry, "browser_upload", { target: "input[type=file]", files: [] });
    expect(empty.ok).toBe(false);
  });
});
