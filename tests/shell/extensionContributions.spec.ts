/**
 * 扩展贡献点接线（第三阶段 C）：loop 注册 / 停用精确撤下 / 卸载不残留 / 活动 loop 回退 builtin。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopRuntime } from "../../packages/shell/src/main/loopRuntime.ts";
import { ExtensionHost } from "../../packages/shell/src/main/extensions.ts";
import { ExtensionContributions } from "../../packages/shell/src/main/extensionContributions.ts";

const dirs: string[] = [];

function makeWorld() {
  const dir = mkdtempSync(path.join(tmpdir(), "loopsoar-ext-contrib-"));
  dirs.push(dir);
  const extDir = path.join(dir, "extensions");
  const demoDir = path.join(extDir, "demo");
  mkdirSync(demoDir, { recursive: true });
  writeFileSync(
    path.join(demoDir, "loopsoar.extension.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      contributes: {
        loops: [{ id: "fast", name: "快速循环", maxRounds: 3 }],
        themes: [{ id: "night", name: "夜航", tokens: { "ls-accent": "#123456" } }],
      },
    }),
    "utf8",
  );
  const runtime = createLoopRuntime({ push: () => {}, dataDir: path.join(dir, "loops"), seedExample: false });
  const host = new ExtensionHost(extDir);
  const contributions = new ExtensionContributions(runtime, host);
  return { runtime, host, contributions };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("扩展 loop 贡献点", () => {
  it("启用扩展 → loop 注册；停用 → 精确撤下并回退 builtin", () => {
    const { runtime, host, contributions } = makeWorld();
    contributions.sync();
    expect(runtime.registry.list().map((loop) => loop.id)).not.toContain("ext.demo.fast");

    host.setEnabled("demo", true);
    const idsAfterEnable = runtime.registry.list().map((loop) => loop.id);
    expect(idsAfterEnable).toContain("ext.demo.fast");
    expect(contributions.state().themes[0]?.id).toBe("ext.demo.night");

    runtime.registry.switchTo("ext.demo.fast");
    host.setEnabled("demo", false);
    const idsAfterDisable = runtime.registry.list().map((loop) => loop.id);
    expect(idsAfterDisable).not.toContain("ext.demo.fast");
    expect(runtime.registry.current()).toBe("core-loop");
    expect(contributions.state().loops).toEqual([]);
  });

  it("卸载扩展 → loop 与主题都不残留", () => {
    const { runtime, host, contributions } = makeWorld();
    host.setEnabled("demo", true);
    runtime.registry.switchTo("ext.demo.fast");
    expect(host.remove("demo")).toBe(true);
    expect(runtime.registry.current()).toBe("core-loop");
    expect(runtime.registry.list().map((loop) => loop.id)).not.toContain("ext.demo.fast");
    const state = contributions.state();
    expect(state.loops).toEqual([]);
    expect(state.themes).toEqual([]);
  });

  it("重复同步幂等（不重复注册、不抛错）", () => {
    const { host, contributions } = makeWorld();
    host.setEnabled("demo", true);
    const first = contributions.sync();
    const second = contributions.sync();
    expect(second.registeredLoopIds).toEqual(first.registeredLoopIds);
    expect(second.conflicts).toEqual(first.conflicts);
  });
});
