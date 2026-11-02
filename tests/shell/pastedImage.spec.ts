/**
 * 剪贴板图片落盘：图片 MIME 白名单、6MB 上限、文件名主进程生成（渲染层不能指定路径）。
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  savePastedImage,
  MAX_PASTED_BYTES,
  PASTED_IMAGE_MIMES,
} from "../../packages/shell/src/main/pastedImage.ts";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "loopsoar-paste-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 1x1 PNG
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("剪贴板图片落盘 fs:saveImage", () => {
  it("保存 PNG 到 <dataDir>/pasted-images/，返回路径与字节数", () => {
    const dataDir = tmpDir();
    const result = savePastedImage(dataDir, { dataBase64: PNG_BASE64, mime: "image/png", name: "截图" });
    expect(result.ok).toBe(true);
    expect(result.path).toBeTruthy();
    expect(result.path!.startsWith(path.join(dataDir, "pasted-images"))).toBe(true);
    expect(existsSync(result.path!)).toBe(true);
    expect(readFileSync(result.path!).length).toBe(result.bytes);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("文件名由主进程生成：渲染层 name 只作后缀提示，不参与路径", () => {
    const dataDir = tmpDir();
    const result = savePastedImage(dataDir, {
      dataBase64: PNG_BASE64,
      mime: "image/png",
      name: "../../evil path",
    });
    expect(result.ok).toBe(true);
    expect(result.path!).not.toContain("..");
    expect(result.path!).not.toContain("evil path");
    expect(path.dirname(result.path!)).toBe(path.join(dataDir, "pasted-images"));
  });

  it("拒绝非图片 MIME 与空数据", () => {
    const dataDir = tmpDir();
    expect(savePastedImage(dataDir, { dataBase64: PNG_BASE64, mime: "text/html" }).ok).toBe(false);
    expect(savePastedImage(dataDir, { dataBase64: "", mime: "image/png" }).ok).toBe(false);
    expect(savePastedImage(dataDir, { dataBase64: "!!!", mime: "image/png" }).ok).toBe(false);
  });

  it("超过 6MB 拒绝（不落盘）", () => {
    const dataDir = tmpDir();
    const big = Buffer.alloc(MAX_PASTED_BYTES + 1).toString("base64");
    const result = savePastedImage(dataDir, { dataBase64: big, mime: "image/png" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("上限");
    expect(existsSync(path.join(dataDir, "pasted-images"))).toBe(false);
  });

  it("MIME 白名单与 imageRead 一致", () => {
    expect(PASTED_IMAGE_MIMES.sort()).toEqual(["image/gif", "image/jpeg", "image/png", "image/webp"]);
  });
});
