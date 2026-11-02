/**
 * ExtensionHost（扩展存储）对齐插件独有能力后的回归：
 *   - 坏清单 / 重复 id / main 入口越界 → 跳过并记录可读原因，合法扩展不受影响；
 *   - 启用/停用状态持久化（跨实例保持）；
 *   - 状态文件损坏 → 以默认（停用）启动，不抛异常，后续可正常写回。
 * 为什么单独成文件：这些是「插件合并进扩展」时从 PluginStore 对过来的行为契约，
 * 用存储层测试锁住，避免后续重构悄悄退化成「静默丢弃/静默放行」。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionHost } from "../../packages/shell/src/main/extensions.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-extstore-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function writeExt(root: string, dirName: string, manifest: unknown, files: Record<string, string> = {}): string {
  const dir = path.join(root, "extensions", dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "loopsoar.extension.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
    "utf8",
  );
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, "utf8");
  return dir;
}

function stateFile(root: string): string {
  return path.join(root, "extensions.json");
}

describe("ExtensionHost · 清单与入口守卫", () => {
  it("main 入口越界（../ 或绝对路径）：跳过并记录原因，合法扩展照常加载", () => {
    const root = tempRoot();
    writeExt(root, "good", { id: "good", name: "好扩展", version: "1.0.0", main: "index.mjs" }, { "index.mjs": "export async function activate() {}" });
    writeExt(root, "escape", { id: "escape", name: "越界", version: "1.0.0", main: "../evil.mjs" });
    writeExt(root, "absolute", { id: "absolute", name: "绝对", version: "1.0.0", main: path.resolve("evil.mjs") });

    const host = new ExtensionHost(path.join(root, "extensions"));
    expect(host.list().map((item) => item.manifest.id)).toEqual(["good"]);
    const skipped = host.scan().skipped;
    const reasons = skipped.map((item) => item.reason).join("\n");
    expect(reasons).toContain("main 入口必须是扩展目录内的相对路径");
    expect(skipped.filter((item) => item.reason.includes("main 入口"))).toHaveLength(2);
  });

  it("坏 JSON / 校验失败 / 重复 id：各自跳过并记录原因，不互相影响", () => {
    const root = tempRoot();
    writeExt(root, "ok", { id: "ok-ext", name: "正常", version: "1.0.0" });
    writeExt(root, "bad-json", "{ 不是 json");
    writeExt(root, "bad-manifest", { id: "../evil", name: "坏 id", version: "1.0.0" });
    writeExt(root, "dup-a", { id: "dup", name: "甲", version: "1.0.0" });
    writeExt(root, "dup-b", { id: "dup", name: "乙", version: "2.0.0" });

    const host = new ExtensionHost(path.join(root, "extensions"));
    expect(host.list().map((item) => item.manifest.id).sort()).toEqual(["dup", "ok-ext"]);
    const skippedDirs = host.scan().skipped.map((item) => path.basename(item.dir));
    expect(skippedDirs).toContain("bad-json");
    expect(skippedDirs).toContain("bad-manifest");
    expect(skippedDirs).toContain("dup-b");
  });
});

describe("ExtensionHost · 启用状态持久化与容错", () => {
  it("启用/停用状态跨实例持久化", () => {
    const root = tempRoot();
    writeExt(root, "a", { id: "ext-a", name: "A", version: "1.0.0" });
    writeExt(root, "b", { id: "ext-b", name: "B", version: "1.0.0" });
    const dir = path.join(root, "extensions");
    const host = new ExtensionHost(dir);
    expect(host.setEnabled("ext-a", true)?.enabled).toBe(true);
    expect(host.setEnabled("ext-b", true)?.enabled).toBe(true);

    const reloaded = new ExtensionHost(dir);
    expect(reloaded.list().find((item) => item.manifest.id === "ext-a")?.enabled).toBe(true);
    expect(reloaded.setEnabled("ext-b", false)?.enabled).toBe(false);
    expect(new ExtensionHost(dir).list().find((item) => item.manifest.id === "ext-b")?.enabled).toBe(false);
  });

  it("状态文件损坏：默认停用启动、不抛异常；后续 setEnabled 写回有效状态", () => {
    const root = tempRoot();
    writeExt(root, "a", { id: "ext-a", name: "A", version: "1.0.0" });
    fs.writeFileSync(stateFile(root), "{ 坏状态", "utf8");
    const host = new ExtensionHost(path.join(root, "extensions"));
    expect(host.list()[0].enabled).toBe(false);
    expect(host.setEnabled("ext-a", true)?.enabled).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(stateFile(root), "utf8")) as { enabled: Record<string, boolean> };
    expect(persisted.enabled["ext-a"]).toBe(true);
  });

  it("未知扩展 setEnabled 返回 null（fail-closed，不创建幽灵状态）", () => {
    const root = tempRoot();
    writeExt(root, "a", { id: "ext-a", name: "A", version: "1.0.0" });
    const host = new ExtensionHost(path.join(root, "extensions"));
    expect(host.setEnabled("ghost-ext", true)).toBeNull();
  });
});
