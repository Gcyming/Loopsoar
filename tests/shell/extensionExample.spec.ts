/**
 * 开发者示例必须真的能跑：manifest 可解析、worker 可激活、工具可调用、视图入口存在。
 * 防止文档/示例随运行时协议演进而腐烂。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { ExtensionHost } from "../../packages/shell/src/main/extensions.ts";
import { ExtensionRuntime } from "../../packages/shell/src/main/extensionRuntime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.join(here, "../../examples/extensions/rich-panel-demo");
const workerPath = path.join(here, "../../packages/shell/src/main/extensionWorker.mjs");
const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe("examples/extensions/rich-panel-demo", () => {
  it("安装目录 → 启动 worker → 工具可调用 → 视图消息可达", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-example-"));
    roots.push(root);
    const dir = path.join(root, "extensions", "rich-panel-demo");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(example, dir, { recursive: true });

    const host = new ExtensionHost(path.join(root, "extensions"), { hostVersion: "0.4.0" });
    host.scan();
    const item = host.list().find((ext) => ext.manifest.id === "rich-panel-demo");
    expect(item, JSON.stringify(host.scan().skipped)).toBeTruthy();
    expect(item!.manifest.contributes?.views?.[0]?.entry).toBe("views/panel.html");
    expect(fs.existsSync(path.join(dir, item!.manifest.contributes!.views![0].entry))).toBe(true);

    host.setEnabled("rich-panel-demo", true);
    const registry = new ToolRegistry();
    const runtime = new ExtensionRuntime({ extensions: host, registry: registry as never, workerPath });
    try {
      const status = await runtime.start("rich-panel-demo");
      expect(status.state, status.error).toBe("ready");
      const tool = registry.get("ext__rich-panel-demo__greet");
      expect(tool).toBeTruthy();
      const result = await tool!.execute({ agentId: "a", params: { name: "Loopsoar" }, platform: {} });
      expect(result).toEqual({ ok: true, content: "Hello, Loopsoar!" });
      expect(runtime.sendViewMessage("rich-panel-demo", "panel", { text: "ping" })).toBe(true);
    } finally {
      runtime.stopAll();
    }
  }, 25000);
});
