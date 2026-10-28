/**
 * 扩展宿主稳定性：坏清单跳过 / 重复 id 忽略 / 启停持久化 / 卸载路径守卫。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExtensionHost } from "../../packages/shell/src/main/extensions.ts";

let root: string;

function writeExt(dir: string, manifest: unknown): string {
  const full = path.join(root, "extensions", dir);
  mkdirSync(full, { recursive: true });
  writeFileSync(path.join(full, "loopsoar.extension.json"), JSON.stringify(manifest, null, 2), "utf8");
  return full;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "loopsoar-ext-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ExtensionHost 稳定性", () => {
  it("坏清单被跳过且不影响好扩展", () => {
    writeExt("bad", { id: "../evil", name: "坏", version: "1" });
    writeExt("good", { id: "good-ext", name: "好扩展", version: "1.0.0" });
    const host = new ExtensionHost(path.join(root, "extensions"));
    expect(host.list().map((e) => e.manifest.id)).toEqual(["good-ext"]);
    expect(host.scan().skipped.length).toBe(1);
  });

  it("重复 id：仅第一个生效并给出告警（确定性）", () => {
    writeExt("a-first", { id: "dup", name: "甲", version: "1.0.0" });
    writeExt("b-second", { id: "dup", name: "乙", version: "2.0.0" });
    const host = new ExtensionHost(path.join(root, "extensions"));
    expect(host.list().length).toBe(1);
    expect(host.list()[0].manifest.name).toBe("甲");
    expect(host.scan().skipped.some((s) => s.reason.includes("重复"))).toBe(true);
  });

  it("启用状态持久化，重启后保持", () => {
    writeExt("x", { id: "x-ext", name: "X", version: "1.0.0" });
    const dir = path.join(root, "extensions");
    const host = new ExtensionHost(dir);
    host.setEnabled("x-ext", true);
    expect(new ExtensionHost(dir).list()[0].enabled).toBe(true);
  });

  it("卸载只允许扩展目录内；目录被删除、状态清理", () => {
    writeExt("y", { id: "y-ext", name: "Y", version: "1.0.0" });
    const dir = path.join(root, "extensions");
    const host = new ExtensionHost(dir);
    expect(host.remove("y-ext")).toBe(true);
    expect(existsSync(path.join(dir, "y"))).toBe(false);
    expect(host.list().length).toBe(0);
    expect(host.remove("nope")).toBe(false);
  });
});
