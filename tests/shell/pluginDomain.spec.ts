/**
 * plugin 域（受信 IPC）：list 字段/状态映射、setEnabled 触发运行时启停 + 事件、
 * reload 重新扫描 + 运行时 sync、builtin 只读拒绝、未知插件错误、非法参数 deny。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginStore } from "../../packages/shell/src/main/pluginStore.ts";
import { registerPluginDomain } from "../../packages/shell/src/main/domains/plugin.ts";
import { __resetHandlerRegistryForTests } from "../../packages/shell/src/main/trustedIpc.ts";
import type { PluginRuntime, PluginRuntimeStatus } from "../../packages/shell/src/main/pluginRuntime.ts";
import type { PluginManifest } from "../../packages/core/src/plugin/index.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-plugindom-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function writePlugin(dataDir: string, id: string, opts: { main?: string | null } = {}): void {
  const dir = path.join(dataDir, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = { name: id, version: "0.1.0", origin: "user", provides: ["tools"], description: `插件 ${id}` };
  if (opts.main !== null) {
    const main = opts.main ?? "index.mjs";
    manifest.main = main;
    fs.writeFileSync(path.join(dir, main), "export async function activate() {}\n", "utf8");
  }
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest), "utf8");
}

interface Pushed {
  event: string;
  payload: unknown;
}

interface FakeRuntimeHarness {
  runtime: PluginRuntime;
  calls: { started: string[]; stopped: string[]; synced: number };
}

function makeFakeRuntime(statuses: Record<string, PluginRuntimeStatus> = {}): FakeRuntimeHarness {
  const calls = { started: [] as string[], stopped: [] as string[], synced: 0 };
  const runtime = {
    status: (id: string): PluginRuntimeStatus =>
      statuses[id] ?? { state: "idle", tools: [], toolInfos: [] },
    start: async (id: string): Promise<PluginRuntimeStatus> => {
      calls.started.push(id);
      return statuses[id] ?? { state: "ready", tools: [], toolInfos: [] };
    },
    stop: (id: string): PluginRuntimeStatus => {
      calls.stopped.push(id);
      return { state: "idle", tools: [], toolInfos: [] };
    },
    sync: async (): Promise<void> => {
      calls.synced += 1;
    },
  } as unknown as PluginRuntime;
  return { runtime, calls };
}

interface Harness {
  dataDir: string;
  store: PluginStore;
  pushed: Pushed[];
  invoke(channel: string, payload?: unknown): Promise<Record<string, unknown>>;
}

function makeHarness(opts: {
  runtime?: PluginRuntime;
  builtins?: PluginManifest[];
  setup?: (dataDir: string) => void;
} = {}): Harness {
  __resetHandlerRegistryForTests();
  const dataDir = tempDir();
  opts.setup?.(dataDir);
  const store = new PluginStore(dataDir, opts.builtins ? { builtins: opts.builtins } : {});
  const pushed: Pushed[] = [];
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  registerPluginDomain({
    ipc: {
      handle(channel: string, fn: (event: unknown, payload: unknown) => unknown) {
        handlers.set(channel, fn);
      },
    },
    audit: () => {},
    plugins: store,
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    push: (event, payload) => pushed.push({ event, payload }),
  });
  const event = { senderFrame: { url: "loopsoar://app/index.html" } };
  return {
    dataDir,
    store,
    pushed,
    invoke: async (channel: string, payload?: unknown): Promise<Record<string, unknown>> => {
      const handler = handlers.get(`loopsoar:${channel}`);
      if (!handler) throw new Error(`未注册通道 ${channel}`);
      return (await handler(event, payload)) as Record<string, unknown>;
    },
  };
}

const CORE_BUILTIN: PluginManifest = {
  name: "core-capabilities",
  version: "0.1.0",
  origin: "builtin",
  provides: ["tools"],
  description: "内核能力（系统根）",
};

describe("plugin 域 · 列表", () => {
  it("builtin 在前 + 用户插件字段完整 + state=disabled + 坏清单 skipped", async () => {
    const h = makeHarness({
      builtins: [CORE_BUILTIN],
      setup: (dataDir) => {
        writePlugin(dataDir, "demo-plugin");
        const badDir = path.join(dataDir, "plugins", "bad-plugin");
        fs.mkdirSync(badDir, { recursive: true });
        fs.writeFileSync(path.join(badDir, "plugin.json"), JSON.stringify({ name: "bad-plugin", version: "1", origin: "user", provides: [] }));
      },
    });
    const result = await h.invoke("plugin:list");
    const plugins = result.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(2);
    expect(plugins[0]).toMatchObject({
      id: "core-capabilities",
      origin: "builtin",
      builtin: true,
      enabled: true,
      state: "loaded",
      tools: [],
    });
    expect(plugins[1]).toMatchObject({
      id: "demo-plugin",
      name: "demo-plugin",
      version: "0.1.0",
      origin: "local",
      builtin: false,
      enabled: false,
      state: "disabled",
      description: "插件 demo-plugin",
      tools: [],
    });
    const skipped = result.skipped as Array<{ reason: string }>;
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("清单校验失败");
  });

  it("运行中插件：state=loaded，tools 来自 runtime 的短名+描述", async () => {
    const status: PluginRuntimeStatus = {
      state: "ready",
      tools: ["plugin__demo-plugin__greet"],
      toolInfos: [{ name: "greet", description: "打招呼" }],
    };
    const fake = makeFakeRuntime({ "demo-plugin": status });
    const h = makeHarness({
      runtime: fake.runtime,
      setup: (dataDir) => {
        writePlugin(dataDir, "demo-plugin");
      },
    });
    h.store.setEnabled("demo-plugin", true);
    const result = await h.invoke("plugin:list");
    const plugins = result.plugins as Array<Record<string, unknown>>;
    expect(plugins[0]).toMatchObject({ id: "demo-plugin", enabled: true, state: "loaded" });
    expect(plugins[0].tools).toEqual([{ name: "greet", description: "打招呼" }]);
  });

  it("runtime 报错：state=error 且带 error 文本", async () => {
    const fake = makeFakeRuntime({
      "demo-plugin": { state: "error", tools: [], toolInfos: [], error: "插件入口不存在：index.mjs" },
    });
    const h = makeHarness({
      runtime: fake.runtime,
      setup: (dataDir) => {
        writePlugin(dataDir, "demo-plugin");
      },
    });
    h.store.setEnabled("demo-plugin", true);
    const plugins = (await h.invoke("plugin:list")).plugins as Array<Record<string, unknown>>;
    expect(plugins[0]).toMatchObject({ state: "error", error: "插件入口不存在：index.mjs" });
  });
});

describe("plugin 域 · 启停 / 重载", () => {
  it("setEnabled 启用/停用：落盘 + 调用 runtime + 推送 plugins:updated", async () => {
    const fake = makeFakeRuntime({ "demo-plugin": { state: "ready", tools: [], toolInfos: [] } });
    const h = makeHarness({
      runtime: fake.runtime,
      setup: (dataDir) => {
        writePlugin(dataDir, "demo-plugin");
      },
    });

    const enabled = await h.invoke("plugin:setEnabled", { id: "demo-plugin", enabled: true });
    expect(enabled.ok).toBe(true);
    expect(fake.calls.started).toEqual(["demo-plugin"]);
    expect(h.store.get("demo-plugin")?.enabled).toBe(true);
    expect(h.pushed).toContainEqual({ event: "plugins:updated", payload: { action: "enabled", id: "demo-plugin" } });

    const disabled = await h.invoke("plugin:setEnabled", { id: "demo-plugin", enabled: false });
    expect(disabled.ok).toBe(true);
    expect(fake.calls.stopped).toEqual(["demo-plugin"]);
    expect(h.store.get("demo-plugin")?.enabled).toBe(false);
    expect(h.pushed).toContainEqual({ event: "plugins:updated", payload: { action: "disabled", id: "demo-plugin" } });
  });

  it("builtin 只读：setEnabled 返回 ok=false + 可读错误（不触碰 runtime）", async () => {
    const fake = makeFakeRuntime();
    const h = makeHarness({ runtime: fake.runtime, builtins: [CORE_BUILTIN] });
    const result = await h.invoke("plugin:setEnabled", { id: "core-capabilities", enabled: false });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("内置");
    expect(fake.calls.stopped).toEqual([]);
  });

  it("未知插件：setEnabled 返回 ok=false（fail-closed，不抛异常）", async () => {
    const h = makeHarness();
    const result = await h.invoke("plugin:setEnabled", { id: "ghost-plugin", enabled: true });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("插件不存在");
  });

  it("reload：重新扫描 + runtime.sync + 推送 plugins:updated", async () => {
    const fake = makeFakeRuntime();
    const h = makeHarness({
      runtime: fake.runtime,
      setup: (dataDir) => {
        writePlugin(dataDir, "plugin-one");
      },
    });
    writePlugin(h.dataDir, "plugin-two");
    const result = await h.invoke("plugin:reload");
    expect((result.plugins as unknown[]).length).toBe(2);
    expect(fake.calls.synced).toBe(1);
    expect(h.pushed).toContainEqual({ event: "plugins:updated", payload: { action: "reload", total: 2, skipped: 0 } });
  });
});

describe("plugin 域 · 受信 IPC 参数校验", () => {
  it("非法插件 id / 缺 enabled / 无参通道带参数：一律拒绝", async () => {
    const h = makeHarness();
    for (const payload of [
      { id: "Bad_Id", enabled: true },
      { id: "demo-plugin" },
    ]) {
      let threw = false;
      try {
        await h.invoke("plugin:setEnabled", payload);
      } catch {
        threw = true;
      }
      expect(threw, JSON.stringify(payload)).toBe(true);
    }
    let listThrew = false;
    try {
      await h.invoke("plugin:list", { unexpected: true });
    } catch {
      listThrew = true;
    }
    expect(listThrew).toBe(true);
  });
});
