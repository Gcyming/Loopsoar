/**
 * 本地图片读取（附件缩略图用）：只允许常见图片扩展、限制大小，返回 data URL。
 *
 * 安全边界：不提供任意文件读取——扩展名白名单 + 6MB 上限；
 * 路径来自用户显式选择/消息附件，不做目录遍历能力扩展。
 */
import fs from "node:fs";
import path from "node:path";

export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export interface ImageReadResult {
  ok: boolean;
  dataUrl?: string;
  mime?: string;
  error?: string;
}

export function readImageDataUrl(filePath: string): ImageReadResult {
  const ext = path.extname(filePath).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) return { ok: false, error: "仅支持 png/jpg/jpeg/webp/gif 图片" };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, error: "不是文件" };
    if (stat.size > MAX_IMAGE_BYTES) return { ok: false, error: `图片过大（${Math.round(stat.size / 1024 / 1024)}MB，上限 6MB）` };
    const buffer = fs.readFileSync(filePath);
    return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString("base64")}`, mime };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
