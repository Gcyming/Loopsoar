import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();

/** 读取 PNG 的 IHDR 宽高，不引入图像解码依赖。 */
function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 1, 4) !== "PNG") throw new Error(`不是 PNG：${file}`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function icoImageCount(file: string): number {
  const buf = fs.readFileSync(file);
  // ICONDIR: reserved(2) type(2) count(2)
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error(`不是 ICO：${file}`);
  return buf.readUInt16LE(4);
}

describe("官方 app icon 品牌资产", () => {
  const shellIcon = path.join(ROOT, "packages/shell/resources/icon.png");
  const shellIco = path.join(ROOT, "packages/shell/resources/icon.ico");
  const uiLogo = path.join(ROOT, "packages/ui/public/logo.png");

  it("窗口图标与界面 logo 使用同一张官方 512 图，且尺寸正确", () => {
    expect(pngSize(shellIcon)).toEqual({ width: 512, height: 512 });
    expect(pngSize(uiLogo)).toEqual({ width: 512, height: 512 });
    expect(fs.readFileSync(shellIcon).equals(fs.readFileSync(uiLogo))).toBe(true);
  });

  it("Windows 图标是多档 ICO（至少包含 16–256 六档）", () => {
    expect(fs.existsSync(shellIco)).toBe(true);
    expect(icoImageCount(shellIco)).toBeGreaterThanOrEqual(6);
  });

  it("渲染层 favicon / touch icon 使用官方配套尺寸", () => {
    expect(pngSize(path.join(ROOT, "packages/ui/public/icon-32.png"))).toEqual({ width: 32, height: 32 });
    expect(pngSize(path.join(ROOT, "packages/ui/public/icon-192.png"))).toEqual({ width: 192, height: 192 });
    expect(pngSize(path.join(ROOT, "packages/ui/public/apple-touch-icon.png"))).toEqual({ width: 180, height: 180 });
    expect(fs.existsSync(path.join(ROOT, "packages/ui/public/favicon.ico"))).toBe(true);
  });

  it("旧单色 logo 已移除，index.html 不再引用旧 logo 作为 favicon", () => {
    expect(fs.existsSync(path.join(ROOT, "packages/ui/public/logo-mono-dark.png"))).toBe(false);
    const html = fs.readFileSync(path.join(ROOT, "packages/ui/index.html"), "utf8");
    expect(html).toContain('href="./favicon.ico"');
    expect(html).toContain('href="./icon-32.png"');
    expect(html).not.toContain('rel="icon" type="image/png" href="./logo.png"');
  });
});
