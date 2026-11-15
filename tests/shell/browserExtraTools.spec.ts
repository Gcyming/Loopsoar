/**
 * browser_screenshot / browser_wait 工具（packages/shell/src/main/browserTools.ts）：
 * 注册/权限/PNG 落盘与尺寸/selector 定位/轮询就绪/超时/边界。
 * 假 BrowserHost + 临时工作根，不联网、不启 Electron。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerBrowserTools } from "../../packages/shell/src/main/browserTools.ts";

/** 伪造一个带 IHDR 宽高的最小 PNG 头（足够让工具解析尺寸并落盘）。 */
function tinyPng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  Buffer.from("IHDR", "ascii").copy(buffer, 12);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

interface FakeHost {
  scripts: string[];
  screenshotCalls: number;
  executes: number;
}

function makeHost(opts: {
  executeResults?: unknown[] | ((script: string) => unknown);
  screenshot?: (() => Promise<string | null>) | null;
  executeError?: Error;
} = {}): { host: {
  executeScript: (script: string, sessionId?: string) => Promise<unknown>;
  screenshot: (sessionId?: string) => Promise<string | null>;
}; state: FakeHost } {
  const state: FakeHost = { scripts: [], screenshotCalls: 0, executes: 0 };
  const queue = Array.isArray(opts.executeResults) ? [...opts.executeResults] : null;
  const host = {
    async executeScript(script: string, _sessionId?: string): Promise<unknown> {
      state.scripts.push(script);
      state.executes += 1;
      if (opts.executeError) throw opts.executeError;
      if (typeof opts.executeResults === "function") return opts.executeResults(script);
      if (queue) return queue.length > 0 ? queue.shift() : false;
      return { ok: true };
    },
    async screenshot(_sessionId?: string): Promise<string | null> {
      state.screenshotCalls += 1;
      if (!opts.screenshot) return null;
      return opts.screenshot();
    },
  };
  return { host, state };
}

let roots: string[] = [];
function tempRoot(prefix = "loopsoar-browser-extra-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

function makeRegistry(host: unknown, root: string) {
  const registry = new ToolRegistry();
  registerBrowserTools(registry, () => host as never, () => root);
  return registry;
}

async function run(registry: ToolRegistry, name: string, params: unknown, platform: unknown = {}) {
  return registry.get(name)!.execute({ agentId: "test-agent", sessionId: undefined, platform, params });
}

describe("browserExtraTools · 注册与权限", () => {
  it("新增工具注册且不破坏既有工具；截图/等待声明为 read", () => {
    const registry = makeRegistry(makeHost().host, tempRoot());
    const names = registry.list().map((tool) => tool.name);
    for (const name of [
      "browser_snapshot",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_scroll",
      "browser_screenshot",
      "browser_wait",
      "web_fetch",
    ]) {
      expect(names, name).toContain(name);
    }
    expect(registry.get("browser_screenshot")!.permissions).toEqual({ read: true });
    expect(registry.get("browser_wait")!.permissions).toEqual({ read: true });
    expect(registry.get("browser_screenshot")!.schema.safeParse({}).success).toBe(true);
    expect(registry.get("browser_screenshot")!.schema.safeParse({ selector: "x".repeat(201) }).success).toBe(false);
    expect(registry.get("browser_wait")!.schema.safeParse({ ms: 99 }).success).toBe(false);
    expect(registry.get("browser_wait")!.schema.safeParse({ ms: 10_001 }).success).toBe(false);
  });
});

describe("browser_screenshot · 截图落盘", () => {
  it("成功：PNG 写入 <会话根>/.loopsoar/screenshots/，返回路径与尺寸", async () => {
    const root = tempRoot();
    const png = tinyPng(2, 3);
    const { host } = makeHost({ screenshot: async () => png.toString("base64") });
    const registry = makeRegistry(host, root);

    const result = await run(registry, "browser_screenshot", {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain("尺寸：2x3");

    const dir = path.join(root, ".loopsoar", "screenshots");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^screenshot-\d{8}-\d{6}-[0-9a-f]{8}\.png$/);
    const saved = readFileSync(path.join(dir, files[0]));
    expect(saved.equals(png)).toBe(true);
    expect(result.content).toContain(path.join(dir, files[0]));
  });

  it("兼容 dataURL 前缀（不同适配器返回格式不同）", async () => {
    const root = tempRoot();
    const png = tinyPng(10, 20);
    const { host } = makeHost({ screenshot: async () => `data:image/png;base64,${png.toString("base64")}` });
    const registry = makeRegistry(host, root);
    const result = await run(registry, "browser_screenshot", {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain("尺寸：10x20");
    expect(existsSync(path.join(root, ".loopsoar", "screenshots"))).toBe(true);
  });

  it("selector：先把元素滚进视野再截图", async () => {
    const root = tempRoot();
    const png = tinyPng(1, 1);
    const { host, state } = makeHost({
      executeResults: () => ({ ok: true }),
      screenshot: async () => png.toString("base64"),
    });
    const registry = makeRegistry(host, root);
    const result = await run(registry, "browser_screenshot", { selector: "#main .card" });
    expect(result.ok).toBe(true);
    // 光标画在应用级覆盖窗口（capturePage 拍不到），截图路径只注入滚动定位脚本
    expect(state.scripts.length).toBe(1);
    expect(state.scripts[0]).toContain('"#main .card"');
    expect(state.scripts[0]).toContain("scrollIntoView");
    expect(state.screenshotCalls).toBe(1);
  });

  it("selector 未找到 → 报错且不截图", async () => {
    const root = tempRoot();
    const { host, state } = makeHost({ executeResults: () => ({ ok: false, reason: "未找到元素：#nope" }) });
    const registry = makeRegistry(host, root);
    const result = await run(registry, "browser_screenshot", { selector: "#nope" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("未找到元素");
    expect(state.screenshotCalls).toBe(0);
    expect(existsSync(path.join(root, ".loopsoar", "screenshots"))).toBe(false);
  });

  it("无活动网页（screenshot 返回 null）→ 可读错误", async () => {
    const registry = makeRegistry(makeHost({ screenshot: null }).host, tempRoot());
    const result = await run(registry, "browser_screenshot", {});
    expect(result.ok).toBe(false);
    expect(result.content).toContain("当前没有打开的网页标签");
  });

  it("宿主未就绪 → 可读错误", async () => {
    const registry = new ToolRegistry();
    registerBrowserTools(registry, () => null, () => tempRoot());
    const result = await run(registry, "browser_screenshot", {});
    expect(result.ok).toBe(false);
    expect(result.content).toContain("浏览器未就绪");
  });
});

describe("browser_wait · 轮询就绪", () => {
  it("选择器轮询出现 → [就绪]（前几次未就绪）", async () => {
    const { host, state } = makeHost({ executeResults: [false, false, true] });
    const registry = makeRegistry(host, tempRoot());
    const result = await run(registry, "browser_wait", { selector: "#loaded", ms: 1000 });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("[就绪]");
    expect(result.content).toContain("选择器 #loaded");
    expect(state.executes).toBe(3);
    expect(state.scripts[0]).toContain('"#loaded"');
  });

  it("文本轮询出现 → [就绪]（脚本检查 body.innerText）", async () => {
    const { host, state } = makeHost({ executeResults: [false, true] });
    const registry = makeRegistry(host, tempRoot());
    const result = await run(registry, "browser_wait", { text: "加载完成", ms: 1000 });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("文本「加载完成」");
    expect(state.scripts[0]).toContain('"加载完成"');
    expect(state.scripts[0]).toContain("innerText");
  });

  it("超时 → ok:false + [超时] 可读文案", async () => {
    const { host } = makeHost({ executeResults: () => false });
    const registry = makeRegistry(host, tempRoot());
    const result = await run(registry, "browser_wait", { selector: ".never", ms: 150 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[超时]");
    expect(result.content).toContain("等待 150ms");
  });

  it("只给 ms：简单等待（不执行脚本）", async () => {
    const { host, state } = makeHost();
    const registry = makeRegistry(host, tempRoot());
    const started = Date.now();
    const result = await run(registry, "browser_wait", { ms: 200 });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("已等待 200ms");
    expect(state.executes).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("页面上无网页/执行脚本抛错 → 可读错误", async () => {
    const { host } = makeHost({ executeError: new Error("当前会话没有打开的网页标签") });
    const registry = makeRegistry(host, tempRoot());
    const result = await run(registry, "browser_wait", { selector: "#x", ms: 200 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[错误]");
    expect(result.content).toContain("当前会话没有打开的网页标签");
  });
});
