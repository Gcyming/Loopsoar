/** 扩展清单校验 + 注册表（纯逻辑）。 */
import { describe, expect, it } from "vitest";
import { ExtensionRegistry, ExtensionManifestSchema } from "../../packages/core/src/extension.ts";

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
});
