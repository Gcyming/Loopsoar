/** 扩展清单校验 + 注册表（纯逻辑）。 */
import { describe, expect, it } from "vitest";
import {
  ExtensionRegistry,
  ExtensionManifestSchema,
  collectExtensionCommands,
  resolveExtensionToolPermissions,
} from "../../packages/core/src/extension.ts";

describe("扩展清单与注册表", () => {
  it("合法清单通过校验，非法 id 被拒", () => {
    const ok = ExtensionManifestSchema.parse({ id: "my-tool", name: "工具", version: "0.1.0" });
    expect(ok.id).toBe("my-tool");
    expect(() => ExtensionManifestSchema.parse({ id: "../evil", name: "x", version: "1" })).toThrow();
    expect(() => ExtensionManifestSchema.parse({ name: "缺 id", version: "1" })).toThrow();
  });

  it("安装/启停/卸载/promptSummary", () => {
    const reg = new ExtensionRegistry();
    reg.install(ExtensionRegistry.parseManifest({ id: "a", name: "甲", version: "1.0.0", description: "第一" }), "C:/ext/a", false);
    expect(reg.list().length).toBe(1);
    expect(reg.enabled().length).toBe(0);
    expect(reg.promptSummary()).toBe("");
    reg.setEnabled("a", true);
    expect(reg.enabled().length).toBe(1);
    expect(reg.promptSummary()).toContain("甲");
    expect(reg.remove("a")?.manifest.id).toBe("a");
    expect(reg.list().length).toBe(0);
  });

  it("声明式 commands 只收集已启用扩展，并加扩展前缀", () => {
    const manifest = ExtensionManifestSchema.parse({
      id: "writer",
      name: "写作扩展",
      version: "1.0.0",
      contributes: {
        commands: [{ id: "outline", title: "列大纲", description: "先列结构", prompt: "请先列出大纲" }],
      },
    });
    const disabled = { manifest, dir: "C:/ext/writer", enabled: false, installedAt: 1 };
    const enabled = { ...disabled, enabled: true };
    expect(collectExtensionCommands([disabled])).toEqual([]);
    expect(collectExtensionCommands([enabled])).toEqual([
      {
        command: "/writer.outline",
        title: "列大纲",
        description: "先列结构",
        prompt: "请先列出大纲",
        extensionId: "writer",
        extensionName: "写作扩展",
      },
    ]);
    expect(() =>
      ExtensionManifestSchema.parse({
        id: "bad",
        name: "坏",
        version: "1",
        contributes: { commands: [{ id: "a b", title: "x", prompt: "y" }] },
      }),
    ).toThrow();
  });

  it("声明式 instructions 仅注入已启用扩展，并受长度上限约束", () => {
    const reg = new ExtensionRegistry();
    reg.install(
      ExtensionRegistry.parseManifest({
        id: "guide",
        name: "指南",
        version: "1",
        contributes: { instructions: "先读 README，再动代码。" },
      }),
      "C:/ext/guide",
      false,
    );
    expect(reg.instructionsPrompt()).toBe("");
    reg.setEnabled("guide", true);
    expect(reg.instructionsPrompt()).toContain("## 扩展指令");
    expect(reg.instructionsPrompt()).toContain("先读 README，再动代码。");
    expect(() =>
      ExtensionManifestSchema.parse({
        id: "too-long",
        name: "长",
        version: "1",
        contributes: { instructions: "x".repeat(4_001) },
      }),
    ).toThrow();
  });

  it("声明式 UI 面板 + turn.start hooks 只注入已启用扩展", () => {
    const reg = new ExtensionRegistry();
    reg.install(
      ExtensionRegistry.parseManifest({
        id: "panel",
        name: "面板扩展",
        version: "1",
        contributes: {
          ui: [{ id: "status", title: "状态", items: [{ label: "区域", value: "本地" }] }],
          hooks: [{ event: "turn.start", prompt: "先检查工作区状态。" }],
        },
      }),
      "C:/ext/panel",
      false,
    );
    expect(reg.instructionsPrompt()).toBe("");
    reg.setEnabled("panel", true);
    expect(reg.instructionsPrompt()).toContain("## 扩展 hooks（turn.start）");
    expect(reg.instructionsPrompt()).toContain("先检查工作区状态。");
    expect(() =>
      ExtensionManifestSchema.parse({
        id: "bad-hook",
        name: "坏 hook",
        version: "1",
        contributes: { hooks: [{ event: "turn.end", prompt: "x" }] },
      }),
    ).toThrow();
  });
});

describe("扩展工具权限：manifest 授权 ∩ 工具声明（fail-closed）", () => {
  it("正常交集：manifest 授权 read + 工具声明 read → 通过", () => {
    const r = resolveExtensionToolPermissions(["read"], { read: true });
    expect(r.errors).toEqual([]);
    expect(r.permissions).toEqual({ read: true });
  });

  it("manifest 未声明权限 → 工具一律拒绝", () => {
    const r = resolveExtensionToolPermissions(undefined, { read: true });
    expect(r.permissions).toEqual({});
    expect(r.errors.join("；")).toContain("manifest 未声明 permissions");
  });

  it("工具未声明权限 → 拒绝（不能默认按 read 放行）", () => {
    const r = resolveExtensionToolPermissions(["read"], {});
    expect(r.permissions).toEqual({});
    expect(r.errors.join("；")).toContain("工具未声明任何 permissions");
  });

  it("工具越权（声明 write 但 manifest 只给 read）→ 拒绝整个工具", () => {
    const r = resolveExtensionToolPermissions(["read"], { read: true, write: true });
    expect(r.errors.join("；")).toContain("未授权的权限：write");
    expect(r.permissions).toEqual({});
  });

  it("未知权限键（如 browser）→ 拒绝", () => {
    const r = resolveExtensionToolPermissions(["read"], { read: true, browser: true });
    expect(r.errors.join("；")).toContain("未知权限：browser");
  });
});
