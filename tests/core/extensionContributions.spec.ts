/**
 * 扩展贡献点（第三阶段 C）：清单 schema fail-closed + loop/theme 收集与冲突上报。
 */
import { describe, expect, it } from "vitest";
import { ExtensionManifestSchema } from "../../packages/contracts/src/extension.ts";
import {
  collectExtensionLoops,
  collectExtensionThemes,
  type InstalledExtension,
} from "../../packages/core/src/extension.ts";

function installed(manifest: unknown, enabled = true): InstalledExtension {
  return {
    manifest: ExtensionManifestSchema.parse(manifest),
    dir: "C:/ext/demo",
    enabled,
    installedAt: 0,
  };
}

describe("扩展清单：loops / themes 贡献点", () => {
  it("接受合法 loop 与 theme", () => {
    const manifest = ExtensionManifestSchema.parse({
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      contributes: {
        loops: [{ id: "fast", name: "快速循环", maxRounds: 3, allowedTools: ["file_read"] }],
        themes: [{ id: "night", name: "夜航", tokens: { "ls-accent": "#123456", "ls-bg": "rgb(10, 12, 16)" } }],
      },
    });
    expect(manifest.contributes?.loops?.[0].id).toBe("fast");
    expect(manifest.contributes?.themes?.[0].tokens["ls-accent"]).toBe("#123456");
  });

  it("非法贡献 fail-closed：坏 loop id / 越界预算 / 非白名单 token / CSS 注入值", () => {
    const base = { id: "demo", name: "Demo", version: "1.0.0" };
    expect(() => ExtensionManifestSchema.parse({ ...base, contributes: { loops: [{ id: "bad id", name: "x" }] } })).toThrow();
    expect(() =>
      ExtensionManifestSchema.parse({ ...base, contributes: { loops: [{ id: "x", name: "x", maxRounds: 9999 }] } }),
    ).toThrow();
    expect(() =>
      ExtensionManifestSchema.parse({ ...base, contributes: { themes: [{ id: "t", name: "t", tokens: { "not-a-token": "#fff" } }] } }),
    ).toThrow();
    expect(() =>
      ExtensionManifestSchema.parse({
        ...base,
        contributes: { themes: [{ id: "t", name: "t", tokens: { "ls-accent": "url(https://evil/x.png)" } }] },
      }),
    ).toThrow();
    expect(() =>
      ExtensionManifestSchema.parse({ ...base, contributes: { themes: [{ id: "t", name: "t", tokens: { "ls-bg": "red; }" } }] } }),
    ).toThrow();
  });
});

describe("collectExtensionLoops / Themes", () => {
  const manifest = {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    contributes: {
      loops: [{ id: "fast", name: "快速循环", systemPromptAppend: "只读优先", maxToolCalls: 5 }],
      themes: [{ id: "night", name: "夜航", tokens: { "ls-accent": "#123456" } }],
    },
  };

  it("全局 id 加 ext 前缀并带上来源扩展", () => {
    const { loops } = collectExtensionLoops([installed(manifest)]);
    expect(loops).toHaveLength(1);
    expect(loops[0].id).toBe("ext.demo.fast");
    expect(loops[0].extensionName).toBe("Demo");
    expect(loops[0].config.maxToolCalls).toBe(5);
    const { themes } = collectExtensionThemes([installed(manifest)]);
    expect(themes[0].id).toBe("ext.demo.night");
    expect(themes[0].tokens["ls-accent"]).toBe("#123456");
  });

  it("禁用扩展不贡献", () => {
    expect(collectExtensionLoops([installed(manifest, false)]).loops).toEqual([]);
    expect(collectExtensionThemes([installed(manifest, false)]).themes).toEqual([]);
  });

  it("重复 id 冲突上报，不静默覆盖", () => {
    const other = { ...manifest, id: "demo", name: "Demo2" };
    const { conflicts } = collectExtensionLoops([installed(manifest), installed(other)]);
    expect(conflicts.length).toBeGreaterThan(0);
  });
});
