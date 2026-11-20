import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../../packages/shell/src/shared/brand.ts";

/**
 * 版本单一产地守门：APP_VERSION 必须与根 package.json、shell package.json 同步。
 * 版本漂移会让「设置 → 关于」显示旧值，也会让安装器/自动更新比较错版本。
 */
describe("program version", () => {
  const root = process.cwd();
  const readVersion = (file: string): string =>
    (JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) as { version?: string }).version ?? "";

  it("APP_VERSION 是合法 SemVer", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("根 package.json 与 shell package.json 使用同一版本", () => {
    expect(readVersion("package.json")).toBe(APP_VERSION);
    expect(readVersion("packages/shell/package.json")).toBe(APP_VERSION);
  });
});
