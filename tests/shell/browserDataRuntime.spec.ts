import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerBrowserDataRuntime } from "../../packages/shell/src/main/browserDataRuntime.js";

function setup(host: any, getCookies: any = async () => []) {
  const registry = new ToolRegistry();
  const downloads = { list: () => [] };
  registerBrowserDataRuntime(
    registry as any,
    () => host,
    downloads,
    () => root,
    getCookies,
  );
  return registry;
}

async function call(registry: ToolRegistry, name: string, params: unknown) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool.execute({ agentId: "a", sessionId: "s", platform: {}, params });
}

let root = "";

describe("browser data runtime", () => {
  it("cookies 用活动标签 URL 查询，并去掉值", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-data-"));
    const getCookies = vi.fn(async () => [{ name: "sid", domain: ".x.test", path: "/", secure: true }]);
    const host = { listTabs: () => [{ url: "https://x.test/", active: true }], console: () => [], network: () => [], uploadFiles: vi.fn() };
    const registry = setup(host, getCookies);
    const result = await call(registry, "browser_cookies", {});
    expect(getCookies).toHaveBeenCalledWith("https://x.test/");
    expect(result.content).toContain("sid");
    expect(result.content).not.toContain("value");
  });

  it("upload 把工作区相对路径解析成绝对路径", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-data-"));
    fs.writeFileSync(path.join(root, "a.txt"), "x");
    const uploadFiles = vi.fn(async () => ({ ok: true, message: "ok" }));
    const host = { listTabs: () => [], console: () => [], network: () => [], uploadFiles };
    const registry = setup(host);
    const result = await call(registry, "browser_upload", { target: "input[type=file]", files: ["a.txt"] });
    expect(result.ok).toBe(true);
    expect(uploadFiles).toHaveBeenCalledWith("s", "input[type=file]", [path.join(root, "a.txt")]);
  });

  it("upload 拒绝工作区外的路径", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-data-"));
    const uploadFiles = vi.fn();
    const host = { listTabs: () => [], console: () => [], network: () => [], uploadFiles };
    const registry = setup(host);
    const result = await call(registry, "browser_upload", { target: "input[type=file]", files: ["../outside.txt"] });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("UPLOAD_FAILED");
    expect(uploadFiles).not.toHaveBeenCalled();
  });
});
