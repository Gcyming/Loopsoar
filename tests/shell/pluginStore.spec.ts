/**
 * PluginStore：插件目录扫描、清单校验（core validateManifest）、启用状态持久化、
 * builtin 系统根只读、坏清单跳过原因、main 入口防穿越、数量上限。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PLUGINS,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_STATE_FILE,
  PluginStore,
} from "../../packages/shell/src/main/pluginStore.ts";
import type { PluginManifest } from "../../packages/core/src/plugin/index.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-plugin-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** 写一个插件目录（dirName 与 manifest.name 可不同，便于测重复 id）。 */
function writePlugin(dataDir: string, dirName: string, content: Record<string, unknown> | string): string {
  const dir = path.join(dataDir, "plugins", dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PLUGIN_MANIFEST_FILE), typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  return dir;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "demo-plugin", version: "0.1.0", origin: "user", provides: ["tools"], description: "演示插件", ...overrides };
}

function readState(dataDir: string): { version: number; enabled: Record<string, boolean> } {
  return JSON.parse(fs.readFileSync(path.join(dataDir, PLUGIN_STATE_FILE), "utf8"));
}

describe("PluginStore · 扫描与启用状态", () => {
  it("扫描合法插件：默认停用、读取 main、状态文件落盘", () => {
    const dataDir = tempDir();
    writePlugin(dataDir, "plugin-a", manifest({ name: "plugin-a", main: "index.mjs" }));
    writePlugin(dataDir, "plugin-b", manifest({ name: "plugin-b", description: undefined }));

    const store = new PluginStore(dataDir);
    const plugins = store.list();
    expect(plugins.map((item) => item.id)).toEqual(["plugin-a", "plugin-b"]);
    const a = store.get("plugin-a");
    expect(a).toMatchObject({ id: "plugin-a", enabled: false, builtin: false, main: "index.mjs" });
    expect(a?.manifest).toMatchObject({ name: "plugin-a", version: "0.1.0", origin: "user", provides: ["tools"] });
    expect(store.get("plugin-b")?.main).toBeNull();
    expect(store.listSkipped()).toEqual([]);
    expect(store.dirPath()).toBe(path.join(dataDir, "plugins"));

    // 状态文件：version=1 + 新发现插件默认 false
    const state = readState(dataDir);
    expect(state.version).toBe(1);
    expect(state.enabled).toEqual({ "plugin-a": false, "plugin-b": false });
  });

  it("setEnabled 持久化：重新构造仍保持启用状态", () => {
    const dataDir = tempDir();
    writePlugin(dataDir, "plugin-a", manifest({ name: "plugin-a" }));
    const store = new PluginStore(dataDir);
    expect(store.setEnabled("plugin-a", true)).toMatchObject({ ok: true, entry: { enabled: true } });
    expect(new PluginStore(dataDir).get("plugin-a")?.enabled).toBe(true);
    // 停用同样落盘
    expect(new PluginStore(dataDir).setEnabled("plugin-a", false).ok).toBe(true);
    expect(new PluginStore(dataDir).get("plugin-a")?.enabled).toBe(false);
  });

  it("setEnabled：未知插件返回可读错误", () => {
    const store = new PluginStore(tempDir());
    const result = store.setEnabled("ghost-plugin", true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("插件不存在");
  });

  it("builtin 系统根：列出且默认启用、只读不可停用；非法内置清单只跳过", () => {
    const dataDir = tempDir();
    const builtins: PluginManifest[] = [
      { name: "core-capabilities", version: "0.1.0", origin: "builtin", provides: ["tools"], description: "内核能力" },
      { name: "Bad_Name", version: "0.1.0", origin: "builtin", provides: [] },
    ];
    const store = new PluginStore(dataDir, { builtins });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "core-capabilities", builtin: true, enabled: true, dir: "" });
    expect(list[0].manifest.origin).toBe("builtin");
    const toggle = store.setEnabled("core-capabilities", false);
    expect(toggle.ok).toBe(false);
    if (!toggle.ok) expect(toggle.error).toContain("内置");
    expect(store.listSkipped()[0]?.reason).toContain("内置插件");
  });

  it("重复 id / 坏 JSON / 校验失败 / 非插件目录：坏清单跳过但合法插件照常列出", () => {
    const dataDir = tempDir();
    writePlugin(dataDir, "ok-plugin", manifest({ name: "ok-plugin" }));
    writePlugin(dataDir, "dup-a", manifest({ name: "same-plugin" }));
    writePlugin(dataDir, "dup-b", manifest({ name: "same-plugin" }));
    writePlugin(dataDir, "bad-json", "{ 不是 json");
    writePlugin(dataDir, "bad-manifest", manifest({ name: "bad-manifest", provides: [] }));
    writePlugin(dataDir, "bad-origin", manifest({ name: "bad-origin", origin: "market" }));
    fs.mkdirSync(path.join(dataDir, "plugins", "not-a-plugin"), { recursive: true }); // 无 plugin.json
    fs.writeFileSync(path.join(dataDir, "plugins", "stray.txt"), "x", "utf8"); // 非目录

    const store = new PluginStore(dataDir);
    expect(store.list().map((item) => item.id).sort()).toEqual(["ok-plugin", "same-plugin"]);
    const skippedDirs = store.listSkipped().map((item) => path.basename(item.dir));
    expect(skippedDirs).toContain("bad-json");
    expect(skippedDirs).toContain("bad-manifest");
    expect(skippedDirs).toContain("bad-origin");
    expect(skippedDirs).toContain("dup-b");
    // 非插件目录/普通文件不该出现在跳过原因里（它们本来就不是插件）
    expect(skippedDirs).not.toContain("not-a-plugin");
    expect(skippedDirs).not.toContain("stray.txt");
    const reasons = store.listSkipped().map((item) => item.reason).join("\n");
    expect(reasons).toContain("清单校验失败");
    expect(reasons).toContain("origin");
    expect(reasons).toContain("插件 id 重复");
  });

  it("main 入口安全：绝对路径 / ../ 穿越被拒绝，插件整条跳过", () => {
    const dataDir = tempDir();
    writePlugin(dataDir, "escape-plugin", manifest({ name: "escape-plugin", main: "../evil.mjs" }));
    writePlugin(dataDir, "absolute-plugin", manifest({ name: "absolute-plugin", main: path.resolve("evil.mjs") }));
    writePlugin(dataDir, "bad-type-plugin", manifest({ name: "bad-type-plugin", main: 42 }));

    const store = new PluginStore(dataDir);
    expect(store.list()).toHaveLength(0);
    const reasons = store.listSkipped().map((item) => item.reason);
    expect(reasons.every((reason) => reason.includes("main 入口"))).toBe(true);
    expect(store.listSkipped()).toHaveLength(3);
  });

  it("数量上限：超过 maxPlugins 的插件被跳过", () => {
    const dataDir = tempDir();
    for (const id of ["p1", "p2", "p3"]) writePlugin(dataDir, id, manifest({ name: id }));
    const store = new PluginStore(dataDir, { maxPlugins: 2 });
    expect(store.list()).toHaveLength(2);
    expect(store.listSkipped().some((item) => item.reason.includes("上限"))).toBe(true);
    // 默认常量是 500 量级之上的合理值（100）
    expect(MAX_PLUGINS).toBe(100);
  });

  it("状态文件损坏：以默认（停用）启动，不抛异常；后续可正常写回", () => {
    const dataDir = tempDir();
    writePlugin(dataDir, "plugin-a", manifest({ name: "plugin-a" }));
    fs.writeFileSync(path.join(dataDir, PLUGIN_STATE_FILE), "{ 坏状态", "utf8");
    const store = new PluginStore(dataDir);
    expect(store.get("plugin-a")?.enabled).toBe(false);
    expect(store.setEnabled("plugin-a", true).ok).toBe(true);
    expect(readState(dataDir).enabled["plugin-a"]).toBe(true);
  });

  it("reload：发现新插件、移除已删除插件；启用状态保留", () => {
    const dataDir = tempDir();
    writePlugin(dataDir, "plugin-a", manifest({ name: "plugin-a" }));
    const store = new PluginStore(dataDir);
    store.setEnabled("plugin-a", true);

    writePlugin(dataDir, "plugin-b", manifest({ name: "plugin-b" }));
    expect(store.reload().plugins).toBe(2);
    expect(store.get("plugin-a")?.enabled).toBe(true);
    expect(store.get("plugin-b")?.enabled).toBe(false);

    fs.rmSync(path.join(dataDir, "plugins", "plugin-a"), { recursive: true, force: true });
    expect(store.reload().plugins).toBe(1);
    expect(store.get("plugin-b")).not.toBeNull();
  });
});
