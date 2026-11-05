/**
 * 剪贴板图片落盘（fs:saveImage）：base64 → 数据目录 pasted-images/ 下的图片文件。
 *
 * 为什么不让渲染层直接存文件：渲染层没有任意写文件能力（安全边界）；
 * 粘贴图片只允许图片 MIME + 6MB 上限，文件名由主进程生成，路径不可由渲染层指定。
 */
import fs from "node:fs";
import path from "node:path";
import { IMAGE_MIME } from "./imageRead.js";

const MAX_PASTED_BYTES = 6 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export interface SavePastedImageResult {
  ok: boolean;
  path?: string;
  mime?: string;
  bytes?: number;
  error?: string;
}

function fallbackDir(): string {
  const override = process.env.LOOPSOAR_DATA_DIR?.trim();
  // 与 index.ts 的 userData 归一化保持一致：相对路径统一解析成绝对路径。
  const base = override ? path.resolve(override) : path.join(process.cwd(), ".loopsoar-data");
  return path.join(base, "pasted-images");
}

/**
 * 保存粘贴图片。
 * @param dir 目标目录（数据目录下 pasted-images）；缺省用数据目录兜底。
 */
export function savePastedImage(
  dir: string | undefined,
  input: { dataBase64?: string; mime?: string; name?: string },
): SavePastedImageResult {
  const mime = String(input.mime ?? "image/png");
  const ext = MIME_EXT[mime];
  if (!ext) return { ok: false, error: "仅支持 png/jpeg/webp/gif 图片" };
  const dataBase64 = String(input.dataBase64 ?? "");
  if (!dataBase64) return { ok: false, error: "缺少图片数据" };

  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, "base64");
  } catch {
    return { ok: false, error: "图片 base64 解码失败" };
  }
  if (buffer.length === 0) return { ok: false, error: "图片数据为空" };
  if (buffer.length > MAX_PASTED_BYTES) {
    return { ok: false, error: `图片过大（${Math.round(buffer.length / 1024 / 1024)}MB，上限 6MB）` };
  }

  const targetDir = dir && dir.trim() ? path.join(dir, "pasted-images") : fallbackDir();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  // 文件名只允许 [a-z0-9-_]，渲染层传入的 name 仅作后缀提示，不参与路径
  const hint = String(input.name ?? "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const fileName = `pasted-${stamp}-${rand}${hint ? `-${hint}` : ""}${ext}`;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, fileName);
    fs.writeFileSync(target, buffer);
    return { ok: true, path: target, mime, bytes: buffer.length };
  } catch (err) {
    return { ok: false, error: `保存图片失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 供测试/诊断：允许的 MIME 列表（与 imageRead 保持一致）。 */
export const PASTED_IMAGE_MIMES = Object.keys(MIME_EXT);
export { MAX_PASTED_BYTES };
