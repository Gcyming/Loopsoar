/**
 * 图片读取（附件缩略图）：扩展名白名单、大小上限、data URL 正确。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readImageDataUrl } from "../../packages/shell/src/main/imageRead.ts";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-img-"));
}

describe("图片读取", () => {
  it("png → data URL（mime 正确）", () => {
    const dir = makeDir();
    try {
      const file = path.join(dir, "a.png");
      // 1x1 透明 PNG
      fs.writeFileSync(
        file,
        Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
      );
      const result = readImageDataUrl(file);
      expect(result.ok).toBe(true);
      expect(result.mime).toBe("image/png");
      expect(result.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非图片扩展名 / 不存在文件 → 可读错误", () => {
    const dir = makeDir();
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "x");
      expect(readImageDataUrl(path.join(dir, "a.txt")).ok).toBe(false);
      expect(readImageDataUrl(path.join(dir, "missing.png")).ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("超过 6MB 的图片 → 拒绝并说明大小", () => {
    const dir = makeDir();
    try {
      const file = path.join(dir, "big.png");
      fs.writeFileSync(file, Buffer.alloc(6 * 1024 * 1024 + 10));
      const result = readImageDataUrl(file);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("图片过大");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
