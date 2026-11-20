import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionHost } from "../../packages/shell/src/main/extensions.ts";
import { installExtension, rollbackExtension } from "../../packages/shell/src/main/extensionInstaller.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-install-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function packageDir(root: string, version: string): string {
  const dir = path.join(root, `pkg-${version}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "loopsoar.extension.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      version,
      apiVersion: "2.0.0",
      engines: { loopsoar: ">=0.1.0" },
      contributes: { instructions: `version ${version}` },
    }),
    "utf8",
  );
  return dir;
}

describe("扩展安装 / 更新 / 回滚", () => {
  it("首次安装、升级、回滚到上一版本，状态文件记录版本", () => {
    const root = tempDir();
    const host = new ExtensionHost(path.join(root, "extensions"), { hostVersion: "0.4.0" });
    const first = installExtension(host, { path: packageDir(root, "1.0.0") }, { allowUntrusted: true, activate: true });
    expect(first.ok).toBe(true);
    expect(first.version).toBe("1.0.0");
    expect(host.list().find((ext) => ext.manifest.id === "demo")?.enabled).toBe(true);

    const update = installExtension(host, { path: packageDir(root, "1.1.0") }, { activate: true, allowUntrusted: true });
    expect(update.ok, update.error).toBe(true);
    expect(host.versionInfo("demo")?.active).toBe("1.1.0");
    expect(host.versionInfo("demo")?.previous).toBe("1.0.0");

    const rollback = rollbackExtension(host, "demo", undefined, { allowUntrusted: true });
    expect(rollback.ok).toBe(true);
    expect(rollback.version).toBe("1.0.0");
    expect(host.list().find((ext) => ext.manifest.id === "demo")?.manifest.version).toBe("1.0.0");
  });

  it("相同版本默认拒绝；force 允许重装；非法路径被拒", () => {
    const root = tempDir();
    const host = new ExtensionHost(path.join(root, "extensions"), { hostVersion: "0.4.0" });
    expect(installExtension(host, { path: packageDir(root, "1.0.0") }, { allowUntrusted: true }).ok).toBe(true);

    const again = installExtension(host, { path: packageDir(root, "1.0.0") }, { allowUntrusted: true });
    expect(again.ok).toBe(false);
    expect(again.error).toContain("相同版本");

    const forced = installExtension(host, { path: packageDir(root, "1.0.0") }, { allowUntrusted: true, force: true });
    expect(forced.ok).toBe(true);

    const bad = path.join(root, "bad");
    fs.mkdirSync(bad);
    fs.writeFileSync(
      path.join(bad, "loopsoar.extension.json"),
      JSON.stringify({ id: "bad", name: "Bad", version: "1.0.0", main: "../escape.js" }),
    );
    expect(installExtension(host, { path: bad }, { allowUntrusted: true }).ok).toBe(false);
  });

  it("未确认信任时返回 requiresTrust，不落盘", () => {
    const root = tempDir();
    const host = new ExtensionHost(path.join(root, "extensions"), { hostVersion: "0.4.0" });
    const source = packageDir(root, "1.0.0");
    const pending = installExtension(host, { path: source });
    expect(pending.ok).toBe(false);
    expect(pending.requiresTrust).toBeDefined();
    expect(pending.requiresTrust?.fingerprint).toBe("");
    expect(pending.sourcePath).toBe(source);
    expect(host.list().find((ext) => ext.manifest.id === "demo")).toBeUndefined();
  });
});
