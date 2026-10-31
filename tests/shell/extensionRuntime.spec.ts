/**
 * 扩展运行时（子进程隔离）：加载真实 worker，注册扩展工具、调用、停止注销、崩溃隔离。
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { ExtensionHost } from "../../packages/shell/src/main/extensions.ts";
import { ExtensionRuntime } from "../../packages/shell/src/main/extensionRuntime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, "../../packages/shell/src/main/extensionWorker.mjs");
const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function makeExtension(id: string, source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `loopsoar-ext-${id}-`));
  roots.push(root);
  const dir = path.join(root, "extensions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "loopsoar.extension.json"),
    JSON.stringify({ id, name: id, version: "0.1.0", main: "index.mjs" }, null, 2),
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

  it("坏扩展崩溃互相隔离：一个启动失败不影响另一个", async () => {
    const goodRoot = makeExtension(
      "good",
      `export async function activate(api) {
        api.registerTool({ name: "ping", execute: async () => "pong" });
      }`,
    );
    // 同一个 extensions 根下再加一个坏扩展
    const badDir = path.join(goodRoot, "extensions", "bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, "loopsoar.extension.json"),
      JSON.stringify({ id: "bad", name: "bad", version: "0.1.0", main: "index.mjs" }),
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
