import { describe, expect, it } from "vitest";
import { ExtensionRegistry } from "../../packages/core/src/extension.ts";
import { checkExtensionCompatibility } from "../../packages/core/src/extensionCompat.ts";

const manifest = (extra: Record<string, unknown> = {}) =>
  ExtensionRegistry.parseManifest({ id: "demo", name: "Demo", version: "1.0.0", ...extra });

describe("扩展兼容性", () => {
  it("API 大版本高于宿主 → blocked；旧版 API → 警告", () => {
    const tooNew = checkExtensionCompatibility(manifest({ apiVersion: "3.0.0" }), { hostApiVersion: "2.0.0" });
    expect(tooNew.status).toBe("blocked");
    expect(tooNew.issues.map((issue) => issue.code)).toContain("api-newer");

    const legacy = checkExtensionCompatibility(manifest({ apiVersion: "1.0.0" }), { hostApiVersion: "2.0.0" });
    expect(legacy.status).toBe("compatible-with-warnings");
    expect(legacy.legacyApi).toBe(true);
  });

  it("engines.loopsoar 不满足 → blocked；缺失 → 警告（严格模式为错误）", () => {
    const mismatch = checkExtensionCompatibility(manifest({ engines: { loopsoar: ">=9.0.0" } }), { hostVersion: "0.4.0" });
    expect(mismatch.status).toBe("blocked");

    const missing = checkExtensionCompatibility(manifest(), { hostVersion: "0.4.0" });
    expect(missing.status).toBe("compatible-with-warnings");
    expect(missing.issues.map((issue) => issue.code)).toContain("engine-unpinned");

    const strict = checkExtensionCompatibility(manifest(), { hostVersion: "0.4.0", requireEngine: true });
    expect(strict.status).toBe("blocked");
  });

  it("同大版本旧 API 允许运行；宿主版本范围满足时 compatible", () => {
    const ok = checkExtensionCompatibility(manifest({ apiVersion: "2.0.0", engines: { loopsoar: ">=0.1.0" } }), {
      hostApiVersion: "2.1.0",
      hostVersion: "0.4.2",
    });
    expect(ok.status).toBe("compatible");
    expect(ok.errors).toBe(0);
  });
});
