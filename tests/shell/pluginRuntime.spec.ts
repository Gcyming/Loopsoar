/**
 * PluginRuntime：子进程桥接（fake spawn）、工具命名/权限/parameters 透传、JSON-RPC 调用、
 * 冲突 fail-closed、停用/崩溃精确注销、启动/调用超时、env 白名单、声明式插件不拉进程。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { PluginStore } from "../../packages/shell/src/main/pluginStore.ts";
import {
  buildPluginWorkerEnv,
  pluginToolRegistryName,
  PluginRuntime,
} from "../../packages/shell/src/main/pluginRuntime.ts";
import type { PluginChild, PluginSpawn } from "../../packages/shell/src/main/pluginRuntime.ts";
import type { ExtensionToolDef } from "../../packages/core/src/extensionWorker.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-pluginrt-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

interface FakeChild {
  child: PluginChild;
  stdout: PassThrough;
  stderr: PassThrough;
  /** runtime 写入 stdin 的原始行（同步捕获，便于断言 JSON-RPC 请求）。 */
  writes: string[];
  readonly killed: boolean;
  emitReady(tools: ExtensionToolDef[]): void;
  emitResult(message: { id: number; ok: boolean; content?: string; error?: string }): void;
  emitExit(code: number | null): void;
  emitError(message: string): void;
}

/** fake spawn：每个插件一个可控子进程（PassThrough 模拟 stdout/stderr，stdin 只记录写入）。 */
function makeFakeSpawn(): { spawn: PluginSpawn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawn: PluginSpawn = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const writes: string[] = [];
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    let killed = false;
    const child: PluginChild = {
      stdin: {
        write(chunk: string) {
          writes.push(String(chunk));
          return true;
        },
      },
      stdout,
      stderr,
      kill() {
        killed = true;
        return true;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return child;
      },
    };
    const emit = (event: string, ...args: unknown[]): void => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    };
    const fake: FakeChild = {
      child,
      stdout,
      stderr,
      writes,
      get killed() {
        return killed;
      },
      emitReady: (tools) => stdout.write(`${JSON.stringify({ type: "ready", tools })}\n`),
      emitResult: (message) => stdout.write(`${JSON.stringify({ type: "result", ...message })}\n`),
      emitExit: (code) => emit("exit", code),
      emitError: (message) => emit("error", new Error(message)),
    };
    children.push(fake);
    return child;
  };
  return { spawn, children };
}

/** 写一个插件目录（main 缺省 index.mjs 并创建真实入口文件，runtime 会校验存在性）。 */
function writePlugin(dataDir: string, id: string, opts: { main?: string | null } = {}): void {
  const dir = path.join(dataDir, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = { name: id, version: "0.1.0", origin: "user", provides: ["tools"] };
  if (opts.main !== null) {
    const main = opts.main ?? "index.mjs";
    manifest.main = main;
    fs.writeFileSync(path.join(dir, main), "export async function activate() {}\n", "utf8");
  }
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest), "utf8");
}

interface Harness {
  dataDir: string;
  store: PluginStore;
  registry: ToolRegistry;
  runtime: PluginRuntime;
  fake: { spawn: PluginSpawn; children: FakeChild[] };
}

function makeHarness(opts: {
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  /** 在构造 PluginStore 之前写插件目录（store 构造时扫描一次）。 */
  setup?: (dataDir: string) => void;
} = {}): Harness {
  const dataDir = tempDir();
  opts.setup?.(dataDir);
  const workerPath = path.join(dataDir, "worker.mjs");
  fs.writeFileSync(workerPath, "// fake worker\n", "utf8");
  const store = new PluginStore(dataDir);
  const registry = new ToolRegistry();
  const fake = makeFakeSpawn();
  const runtime = new PluginRuntime({
    plugins: store,
    registry,
    workerPath,
    spawn: fake.spawn,
    startTimeoutMs: opts.startTimeoutMs ?? 200,
    callTimeoutMs: opts.callTimeoutMs ?? 200,
  });
  return { dataDir, store, registry, runtime, fake };
}

const greetTool: ExtensionToolDef = {
  name: "greet",
  description: "打招呼",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  permissions: { read: true },
};

describe("PluginRuntime · 启动与工具桥接", () => {
  it("ready → 注册 plugin__<id>__<tool>，权限/parameters 透传，调用走 JSON-RPC", async () => {
    const h = makeHarness({ setup: (dataDir) => writePlugin(dataDir, "demo") });
    h.store.setEnabled("demo", true);

    const started = h.runtime.start("demo");
    const child = h.fake.children[0];
    expect(child).toBeDefined();
    child.emitReady([greetTool]);
    const status = await started;
    expect(status.state).toBe("ready");
    expect(status.tools).toEqual(["plugin__demo__greet"]);
    expect(status.toolInfos).toEqual([{ name: "greet", description: "打招呼" }]);

    const def = h.registry.get("plugin__demo__greet");
    expect(def).toBeDefined();
    expect(def?.permissions).toEqual({ read: true });
    expect(def?.parameters).toEqual(greetTool.parameters);

    const resultPromise = def!.execute({ agentId: "a", params: { name: "世界" }, platform: undefined });
    const call = JSON.parse(child.writes.at(-1) ?? "{}") as { type: string; id: number; tool: string; args: unknown };
    expect(call).toEqual({ type: "call", id: 1, tool: "greet", args: { name: "世界" } });
    child.emitResult({ id: call.id, ok: true, content: "你好，世界" });
    const result = await resultPromise;
    expect(result).toMatchObject({ ok: true, content: "你好，世界" });
  });

  it("工具名冲突 fail-closed：绝不覆盖已有工具，其余工具照常注册", async () => {
    const h = makeHarness({ setup: (dataDir) => writePlugin(dataDir, "demo") });
    h.store.setEnabled("demo", true);
    h.registry.register({
      name: "plugin__demo__clash",
      description: "内置占位（不可被覆盖）",
      permissions: {},
      schema: { safeParse: () => ({ success: true, data: {} }) } as never,
      execute: async () => ({ ok: true, content: "original" }),
    });

    const started = h.runtime.start("demo");
    h.fake.children[0].emitReady([
      { name: "clash", description: "插件想覆盖" },
      { name: "extra", description: "另一个工具" },
    ]);
    const status = await started;
    expect(status.state).toBe("ready");
    expect(status.error).toContain("工具名冲突");
    expect(h.registry.get("plugin__demo__clash")?.description).toBe("内置占位（不可被覆盖）");
    expect(h.registry.has("plugin__demo__extra")).toBe(true);
    expect(status.tools).toEqual(["plugin__demo__extra"]);
  });

  it("停用：精确注销该插件工具 + 发送 shutdown", async () => {
    const h = makeHarness({ setup: (dataDir) => writePlugin(dataDir, "demo") });
    h.store.setEnabled("demo", true);
    const started = h.runtime.start("demo");
    h.fake.children[0].emitReady([greetTool, { name: "bye" }]);
    await started;
    expect(h.registry.has("plugin__demo__greet")).toBe(true);

    const status = h.runtime.stop("demo");
    expect(status.state).toBe("idle");
    expect(h.registry.has("plugin__demo__greet")).toBe(false);
    expect(h.registry.has("plugin__demo__bye")).toBe(false);
    const shutdown = JSON.parse(h.fake.children[0].writes.at(-1) ?? "{}") as { type?: string };
    expect(shutdown.type).toBe("shutdown");
  });

  it("崩溃隔离：一个插件退出只注销自己的工具，另一插件继续 ready", async () => {
    const h = makeHarness({
      setup: (dataDir) => {
        for (const id of ["demo-a", "demo-b"]) writePlugin(dataDir, id);
      },
    });
    h.store.setEnabled("demo-a", true);
    h.store.setEnabled("demo-b", true);
    const startA = h.runtime.start("demo-a");
    h.fake.children[0].emitReady([{ name: "tool-a" }]);
    await startA;
    const startB = h.runtime.start("demo-b");
    h.fake.children[1].emitReady([{ name: "tool-b" }]);
    await startB;

    h.fake.children[0].emitExit(1);
    expect(h.runtime.status("demo-a").state).toBe("error");
    expect(h.runtime.status("demo-a").error).toContain("退出");
    expect(h.registry.has("plugin__demo-a__tool-a")).toBe(false);
    expect(h.runtime.status("demo-b").state).toBe("ready");
    expect(h.registry.has("plugin__demo-b__tool-b")).toBe(true);
  });

  it("启动超时（8s 默认，测试用短超时）", async () => {
    const h = makeHarness({ startTimeoutMs: 30, setup: (dataDir) => writePlugin(dataDir, "demo") });
    h.store.setEnabled("demo", true);
    const status = await h.runtime.start("demo");
    expect(status.state).toBe("error");
    expect(status.error).toContain("启动超时");
    expect(h.registry.list()).toHaveLength(0);
  });

  it("调用超时：worker 不返回时按超时失败（不悬挂）", async () => {
    const h = makeHarness({ callTimeoutMs: 30, setup: (dataDir) => writePlugin(dataDir, "demo") });
    h.store.setEnabled("demo", true);
    const started = h.runtime.start("demo");
    h.fake.children[0].emitReady([greetTool]);
    await started;
    const def = h.registry.get("plugin__demo__greet")!;
    const result = await def.execute({ agentId: "a", params: {}, platform: undefined });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("执行超时");
  });

  it("声明式插件（无 main）不拉子进程；启动失败以 error 状态返回（不抛）", async () => {
    const h = makeHarness({
      setup: (dataDir) => {
        writePlugin(dataDir, "declarative", { main: null });
        writePlugin(dataDir, "broken");
      },
    });
    h.store.setEnabled("declarative", true);
    h.store.setEnabled("broken", true);
    fs.rmSync(path.join(h.dataDir, "plugins", "broken", "index.mjs"));

    const declStatus = await h.runtime.start("declarative");
    expect(declStatus.state).toBe("idle");
    expect(h.fake.children).toHaveLength(0);
    const brokenStatus = await h.runtime.start("broken");
    expect(brokenStatus.state).toBe("error");
    expect(brokenStatus.error).toContain("入口不存在");
  });

  it("startEnabled：只启动已启用且声明 main 的插件", async () => {
    const h = makeHarness({
      setup: (dataDir) => {
        writePlugin(dataDir, "enabled-plugin");
        writePlugin(dataDir, "declarative", { main: null });
        writePlugin(dataDir, "disabled-plugin");
      },
    });
    h.store.setEnabled("enabled-plugin", true);
    h.store.setEnabled("declarative", true);

    const pending = h.runtime.startEnabled();
    // 等 spawn 出来（startEnabled 内部并发 start；spawn 在微任务前已完成）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.fake.children).toHaveLength(1);
    h.fake.children[0].emitReady([]);
    await pending;
    expect(h.runtime.status("enabled-plugin").state).toBe("ready");
    expect(h.runtime.status("disabled-plugin").state).toBe("idle");
    expect(h.runtime.status("declarative").state).toBe("idle");
  });
});

describe("PluginRuntime · 安全辅助", () => {
  it("env 白名单：不继承 API key/token，只放行启动必需变量", () => {
    const env = buildPluginWorkerEnv("demo", {
      Path: "C:/bin",
      HOME: "/home/user",
      TEMP: "C:/tmp",
      API_KEY: "secret",
      OPENAI_API_KEY: "sk-xxx",
      AUTH_TOKEN: "token",
    } as NodeJS.ProcessEnv);
    expect(env.Path).toBe("C:/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.TEMP).toBe("C:/tmp");
    expect(env.API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AUTH_TOKEN).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.LOOPSOAR_PLUGIN_ID).toBe("demo");
  });

  it("工具注册名清洗：非法字符替换为 -，前缀固定 plugin__", () => {
    expect(pluginToolRegistryName("demo", "greet")).toBe("plugin__demo__greet");
    expect(pluginToolRegistryName("Demo Plugin", "do:it")).toBe("plugin__Demo-Plugin__do-it");
    expect(pluginToolRegistryName("a/b.c", "x y")).toBe("plugin__a-b-c__x-y");
  });
});
