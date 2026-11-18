/**
 * 扩展运行时（子进程隔离）：加载真实 worker，注册扩展工具、调用、停止注销、崩溃隔离；
 * 以及 fake spawn 覆盖的确定性路径（冲突 fail-closed / 超时 / 入口守卫 / env 白名单）。
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { ExtensionHost } from "../../packages/shell/src/main/extensions.ts";
import {
  buildExtensionWorkerEnv,
  extensionSpawnArgs,
  ExtensionRuntime,
  type ExtensionChild,
  type ExtensionSpawn,
} from "../../packages/shell/src/main/extensionRuntime.ts";
import type { ExtensionToolDef } from "../../packages/core/src/extensionWorker.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, "../../packages/shell/src/main/extensionWorker.mjs");
const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function makeExtension(id: string, source: string, permissions: string[] = ["read"]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `loopsoar-ext-${id}-`));
  roots.push(root);
  const dir = path.join(root, "extensions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "loopsoar.extension.json"),
    JSON.stringify({ id, name: id, version: "0.1.0", main: "index.mjs", permissions }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "index.mjs"), source, "utf8");
  return root;
}

function makeRuntime(root: string) {
  const registry = new ToolRegistry();
  const host = new ExtensionHost(path.join(root, "extensions"));
  const runtime = new ExtensionRuntime({ extensions: host, registry, workerPath });
  return { registry, host, runtime };
}

describe("扩展运行时（通过真实 worker 子进程）", () => {
  it("启动 → 工具注册进 ToolRegistry（带 JSON Schema）→ 调用返回 → 停止注销", async () => {
    const root = makeExtension(
      "demo",
      `export async function activate(api) {
        api.registerTool({
          name: "echo",
          description: "回显",
          parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          permissions: { read: true },
          execute: async (args) => "echo:" + String(args.text ?? ""),
        });
      }`,
    );
    const { registry, host, runtime } = makeRuntime(root);
    try {
      host.setEnabled("demo", true);
      const status = await runtime.start("demo");
      expect(status.state).toBe("ready");
      expect(status.tools).toEqual(["ext__demo__echo"]);

      const tool = registry.get("ext__demo__echo");
      expect(tool).toBeTruthy();
      expect(tool!.description).toBe("回显");
      expect(tool!.parameters).toMatchObject({ type: "object" });
      expect(tool!.permissions.read).toBe(true);
      const result = await tool!.execute({ agentId: "a", params: { text: "hi" }, platform: {} });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("echo:hi");

      // 工具 Schema 进入 LLM tools 声明（扩展工具真实 parameters 不再占位为空）
      const schemas = registry.toolSchemas(["ext__demo__echo"]);
      expect(schemas[0].function.parameters).toMatchObject({ properties: { text: { type: "string" } } });

      runtime.stop("demo");
      expect(registry.has("ext__demo__echo")).toBe(false);
      expect(runtime.status("demo").state).toBe("idle");
    } finally {
      runtime.stopAll();
    }
  }, 25000);

  it("isolation:node 在 worker 进程启用文件系统权限：扩展目录可读，外部写入被拒", async () => {
    const root = makeExtension(
      "iso",
      `import fs from "node:fs";
       import path from "node:path";
       export async function activate(api) {
         api.registerTool({
           name: "probe",
           description: "隔离探针",
           parameters: {},
           permissions: { read: true },
           execute: async () => {
             let read = "";
             try { read = fs.readFileSync(path.join(api.extensionDir, "marker.txt"), "utf8"); }
             catch (err) { read = "READ_" + (err && err.code ? err.code : "ERR"); }
             let write = "";
             try { fs.writeFileSync(path.join(process.env.TEMP || ".", "loopsoar-iso-probe.txt"), "x"); write = "WRITE_OK"; }
             catch (err) { write = "WRITE_" + (err && err.code ? err.code : "ERR"); }
             return read + "|" + write;
           },
         });
       }`,
    );
    const dir = path.join(root, "extensions", "iso");
    fs.writeFileSync(path.join(dir, "marker.txt"), "MARKER", "utf8");
    fs.writeFileSync(
      path.join(dir, "loopsoar.extension.json"),
      JSON.stringify({
        id: "iso",
        name: "iso",
        version: "0.1.0",
        main: "index.mjs",
        permissions: ["read"],
        isolation: "node",
      }),
      "utf8",
    );
    const { registry, host, runtime } = makeRuntime(root);
    try {
      host.setEnabled("iso", true);
      const status = await runtime.start("iso");
      expect(status.state).toBe("ready");
      const result = await registry.get("ext__iso__probe")!.execute({
        agentId: "a",
        params: {},
        platform: {},
      });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("MARKER|WRITE_ERR_ACCESS_DENIED");
    } finally {
      runtime.stopAll();
    }
  }, 25000);

  it("isolation:node 启动参数只放行扩展目录/worker 目录，write/terminal 按 manifest 授予", () => {
    const dir = path.resolve("C:/extensions/iso");
    const args = extensionSpawnArgs(
      {
        manifest: {
          id: "iso",
          name: "iso",
          version: "0.1.0",
          main: "index.mjs",
          permissions: ["read", "write", "terminal"],
          isolation: "node",
        },
        dir,
        enabled: true,
        installedAt: 0,
      },
      workerPath,
    );
    expect(args[0]).toBe("--permission");
    expect(args).toContain(`--allow-fs-read=${dir}`);
    expect(args).toContain(`--allow-fs-read=${path.dirname(path.resolve(workerPath))}`);
    expect(args).toContain(`--allow-fs-write=${dir}`);
    expect(args).toContain("--allow-child-process");
    expect(args.slice(-3)).toEqual([workerPath, dir, "index.mjs"]);
  });

  it("isolation:strict 去掉 write/child/addons，只保留扩展目录与 worker 目录读", () => {
    const dir = path.resolve("C:/extensions/strict");
    const args = extensionSpawnArgs(
      {
        manifest: {
          id: "strict",
          name: "strict",
          version: "0.1.0",
          main: "index.mjs",
          permissions: ["read", "write", "terminal"],
          isolation: "strict",
        },
        dir,
        enabled: true,
        installedAt: 0,
      },
      workerPath,
    );
    expect(args).toContain("--permission");
    expect(args).toContain(`--allow-fs-read=${dir}`);
    expect(args).toContain(`--allow-fs-read=${path.dirname(path.resolve(workerPath))}`);
    expect(args).toContain("--no-addons");
    expect(args).not.toContain(`--allow-fs-write=${dir}`);
    expect(args).not.toContain("--allow-child-process");
    expect(args.slice(-3)).toEqual([workerPath, dir, "index.mjs"]);
  });

  it("坏扩展崩溃互相隔离：一个启动失败不影响另一个", async () => {
    const goodRoot = makeExtension(
      "good",
      `export async function activate(api) {
        api.registerTool({ name: "ping", permissions: { read: true }, execute: async () => "pong" });
      }`,
    );
    // 同一个 extensions 根下再加一个坏扩展
    const badDir = path.join(goodRoot, "extensions", "bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, "loopsoar.extension.json"),
      JSON.stringify({ id: "bad", name: "bad", version: "0.1.0", main: "index.mjs", permissions: ["read"] }),
      "utf8",
    );
    fs.writeFileSync(path.join(badDir, "index.mjs"), `throw new Error("boom from bad extension");`, "utf8");
    const { registry, host, runtime } = makeRuntime(goodRoot);
    try {
      host.scan();
      host.setEnabled("good", true);
      host.setEnabled("bad", true);
      const [bad, good] = await Promise.all([runtime.start("bad"), runtime.start("good")]);
      expect(bad.state).toBe("error");
      expect(bad.error).toContain("boom");
      expect(good.state).toBe("ready");
      expect(registry.has("ext__good__ping")).toBe(true);
      expect(registry.has("ext__bad__ping")).toBe(false);
      const result = await registry.get("ext__good__ping")!.execute({ agentId: "a", params: {}, platform: {} });
      expect(result.content).toBe("pong");
    } finally {
      runtime.stopAll();
    }
  }, 25000);

  it("未声明 main 的纯声明式扩展：启动返回明确错误", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-ext-decl-"));
    roots.push(root);
    const dir = path.join(root, "extensions", "decl");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "loopsoar.extension.json"),
      JSON.stringify({ id: "decl", name: "decl", version: "0.1.0", description: "只有清单" }),
      "utf8",
    );
    const { host, runtime } = makeRuntime(root);
    host.scan();
    const status = await runtime.start("decl");
    expect(status.state).toBe("error");
    expect(status.error).toContain("main");
  }, 15000);
});

/* ─────────────── fake spawn：确定性覆盖冲突/超时/入口守卫/env（不依赖真实子进程） ─────────────── */

interface FakeChild {
  child: ExtensionChild;
  stdout: PassThrough;
  stderr: PassThrough;
  /** runtime 写入 stdin 的原始行（同步捕获，便于断言 JSON-RPC/shutdown）。 */
  writes: string[];
  readonly killed: boolean;
  emitReady(tools: ExtensionToolDef[]): void;
  emitResult(message: { id: number; ok: boolean; content?: string; error?: string }): void;
  emitExit(code: number | null): void;
  emitError(message: string): void;
}

function makeFakeSpawn(): { spawn: ExtensionSpawn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnImpl: ExtensionSpawn = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const writes: string[] = [];
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    let killed = false;
    const child: ExtensionChild = {
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
  return { spawn: spawnImpl, children };
}

function makeFakeRuntime(root: string, opts: { startTimeoutMs?: number; callTimeoutMs?: number } = {}) {
  const registry = new ToolRegistry();
  const host = new ExtensionHost(path.join(root, "extensions"));
  host.scan();
  const fake = makeFakeSpawn();
  const runtime = new ExtensionRuntime({
    extensions: host,
    registry,
    workerPath,
    spawn: fake.spawn,
    timeoutMs: opts.startTimeoutMs ?? 200,
    callTimeoutMs: opts.callTimeoutMs ?? 200,
  });
  return { registry, host, runtime, fake };
}

function addExtensionDir(root: string, id: string, source = ""): string {
  const dir = path.join(root, "extensions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "loopsoar.extension.json"),
    JSON.stringify({ id, name: id, version: "0.1.0", main: "index.mjs", permissions: ["read"] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "index.mjs"), source, "utf8");
  return dir;
}

describe("扩展运行时 · 合并插件能力后的确定性回归（fake spawn）", () => {
  it("工具名冲突 fail-closed：不覆盖已有工具，状态里可见冲突原因，其余工具照常注册", async () => {
    const root = makeExtension("conflict-ext", "");
    const { registry, host, runtime, fake } = makeFakeRuntime(root);
    registry.register({
      name: "ext__conflict-ext__clash",
      description: "内置占位（不可被覆盖）",
      permissions: {},
      schema: { safeParse: () => ({ success: true, data: {} }) } as never,
      execute: async () => ({ ok: true, content: "original" }),
    });
    host.setEnabled("conflict-ext", true);
    const started = runtime.start("conflict-ext");
    fake.children[0].emitReady([
      { name: "clash", description: "扩展想覆盖", permissions: { read: true } },
      { name: "extra", description: "另一个工具", permissions: { read: true } },
    ]);
    const status = await started;
    expect(status.state).toBe("ready");
    expect(status.error).toContain("工具名已存在");
    expect(registry.get("ext__conflict-ext__clash")?.description).toBe("内置占位（不可被覆盖）");
    expect(registry.has("ext__conflict-ext__extra")).toBe(true);
    expect(status.tools).toEqual(["ext__conflict-ext__extra"]);
    expect(runtime.status("conflict-ext").error).toContain("工具名已存在");
  });

  it("扩展工具权限越权（manifest 只给 read，工具声明 write）→ fail-closed 不注册", async () => {
    const root = makeExtension("perm-ext", "");
    const { registry, host, runtime, fake } = makeFakeRuntime(root);
    host.setEnabled("perm-ext", true);
    const started = runtime.start("perm-ext");
    fake.children[0].emitReady([{ name: "write-tool", permissions: { write: true } }]);
    const status = await started;
    expect(status.state).toBe("ready");
    expect(status.tools).toEqual([]);
    expect(status.error).toContain("未授权的权限：write");
    expect(registry.has("ext__perm-ext__write-tool")).toBe(false);
  });

  it("调用超时：worker 不返回时按超时失败（不悬挂）", async () => {
    const root = makeExtension("slow-ext", "");
    const { registry, host, runtime, fake } = makeFakeRuntime(root, { callTimeoutMs: 30 });
    host.setEnabled("slow-ext", true);
    const started = runtime.start("slow-ext");
    fake.children[0].emitReady([{ name: "slow-tool", permissions: { read: true } }]);
    await started;
    const result = await registry.get("ext__slow-ext__slow-tool")!.execute({ agentId: "a", params: {}, platform: {} });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("执行超时");
  });

  it("启动超时：worker 迟迟不 ready → error 状态（不悬挂）", async () => {
    const root = makeExtension("timeout-ext", "");
    const { host, runtime } = makeFakeRuntime(root, { startTimeoutMs: 30 });
    host.setEnabled("timeout-ext", true);
    const status = await runtime.start("timeout-ext");
    expect(status.state).toBe("error");
    expect(status.error).toContain("启动超时");
  });

  it("入口守卫：文件缺失 / 越界在起进程前拒绝；崩溃只注销自己的工具", async () => {
    const root = makeExtension("entry-ext", "");
    const { host, runtime } = makeFakeRuntime(root);
    fs.rmSync(path.join(root, "extensions", "entry-ext", "index.mjs"));
    host.setEnabled("entry-ext", true);
    expect((await runtime.start("entry-ext")).error).toContain("入口不存在");

    // 绕过 scan 直接篡改内存清单，验证运行时自己的第二道入口守卫
    const escapeRoot = makeExtension("escape-ext", "");
    const second = makeFakeRuntime(escapeRoot);
    second.host.list()[0].manifest.main = "../evil.mjs";
    expect((await second.runtime.start("escape-ext")).error).toContain("入口越界");

    // 崩溃隔离：一个扩展 exit 只注销自己的工具，另一扩展继续 ready
    const crashRoot = makeExtension("crash-a", "");
    addExtensionDir(crashRoot, "crash-b");
    const third = makeFakeRuntime(crashRoot);
    third.host.scan();
    third.host.setEnabled("crash-a", true);
    third.host.setEnabled("crash-b", true);
    const a = third.runtime.start("crash-a");
    third.fake.children[0].emitReady([{ name: "tool-a", permissions: { read: true } }]);
    await a;
    const b = third.runtime.start("crash-b");
    third.fake.children[1].emitReady([{ name: "tool-b", permissions: { read: true } }]);
    await b;
    third.fake.children[0].emitExit(1);
    expect(third.runtime.status("crash-a").state).toBe("error");
    expect(third.registry.has("ext__crash-a__tool-a")).toBe(false);
    expect(third.runtime.status("crash-b").state).toBe("ready");
    expect(third.registry.has("ext__crash-b__tool-b")).toBe(true);
  });

  it("停用：精确注销该扩展工具 + 发送 shutdown", async () => {
    const root = makeExtension("stop-ext", "");
    const { registry, host, runtime, fake } = makeFakeRuntime(root);
    host.setEnabled("stop-ext", true);
    const started = runtime.start("stop-ext");
    fake.children[0].emitReady([{ name: "greet", permissions: { read: true } }, { name: "bye", permissions: { read: true } }]);
    await started;
    expect(registry.has("ext__stop-ext__greet")).toBe(true);

    const status = runtime.stop("stop-ext");
    expect(status.state).toBe("idle");
    expect(registry.has("ext__stop-ext__greet")).toBe(false);
    expect(registry.has("ext__stop-ext__bye")).toBe(false);
    const shutdown = JSON.parse(fake.children[0].writes.at(-1) ?? "{}") as { type?: string };
    expect(shutdown.type).toBe("shutdown");
  });

  it("worker env 白名单：只放行启动必需变量，不继承 API key/token", () => {
    const env = buildExtensionWorkerEnv("demo-ext", {
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
    expect(env.LOOPSOAR_EXTENSION_ID).toBe("demo-ext");
  });
});
