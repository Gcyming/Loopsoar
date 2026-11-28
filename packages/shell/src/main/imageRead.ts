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
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, error: "不是文件" };
    if (stat.size > MAX_IMAGE_BYTES) return { ok: false, error: `图片过大（${Math.round(stat.size / 1024 / 1024)}MB，上限 6MB）` };
    // 先读文件头校验魔数：扩展名可随意改名，读 6MB 再判断太晚，也会把非图片内容塞进 data URL。
    const header = Buffer.alloc(Math.min(64, stat.size));
    const headRead = fs.readSync(fd, header, 0, header.length, 0);
    if (!magicMatches(mime, header.subarray(0, headRead))) {
      return { ok: false, error: `文件内容不是有效的 ${mime} 图片` };
    }
    const buffer = Buffer.alloc(stat.size);
    const read = fs.readSync(fd, buffer, 0, stat.size, 0);
    if (read !== stat.size) return { ok: false, error: "图片读取不完整（文件在读取过程中被修改）" };
    return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString("base64")}`, mime };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败不影响已读结果
      }
    }
  }
}

/**
 * LLM 多模态附件读取：非视觉模型 / 读取失败都返回可读原因，由 ChatService 转成可见提示。
 * （旧实现返回 null 静默丢弃，用户以为模型看到了图，实际只发了路径文字。）
 */
export function readImageAttachmentForLlm(
  filePath: string,
  model: { id: string; vision?: boolean; inputModalities?: string[] } | null | undefined,
  modelLabel: string,
): { mime: string; base64: string } | { error: string } {
  // 只在「明确不支持」时拒绝：vision=false，或填了输入模态但没有 image。
  // 很多自定义供应商（OpenAI 兼容网关）不填能力表 —— 旧实现把 undefined 当不支持，
  // 用户明明用了视觉模型却永远发不出图。未知能力交给上游裁决，错误会以可见提示回来。
  const modalities = Array.isArray(model?.inputModalities) ? model.inputModalities : [];
  const explicitlyUnsupported =
    model?.vision === false || (modalities.length > 0 && !modalities.includes("image"));
  if (explicitlyUnsupported) {
    return { error: `当前模型（${modelLabel || "未配置"}）不支持图片输入，请切换视觉模型` };
  }
  const image = readImageDataUrl(filePath);
  if (!image.ok || !image.dataUrl) return { error: image.error ?? "图片读取失败" };
  const comma = image.dataUrl.indexOf(",");
  if (comma < 0) return { error: "图片编码失败" };
  return { mime: image.mime ?? "image/png", base64: image.dataUrl.slice(comma + 1) };
}

/** 扩展名 → 文件头魔数校验（防止把任意 6MB 文件改名成 .png 后回传渲染层）。 */
function magicMatches(mime: string, b: Buffer): boolean {
  if (b.length < 12) return false;
  if (mime === "image/png") {
    return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/gif") return b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a";
  if (mime === "image/webp") {
    return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  }
  return false;
}

/** 设置·通用 imageInputEnabled 关闭时，连像素都不读；否则按模型能力走原有读取。 */
export function readImageAttachmentWithPrivacy(
  filePath: string,
  active: { model?: string; models?: { id: string; vision?: boolean; inputModalities?: string[] }[] } | null | undefined,
  imageInputEnabled: boolean,
): ReturnType<typeof readImageAttachmentForLlm> {
  if (!imageInputEnabled) {
    return { error: "图片输入已在「设置 · 通用」中关闭（隐私开关）" };
  }
  return readImageAttachmentForLlm(
    filePath,
    active?.models?.find((model) => model.id === active.model),
    active?.model ?? "",
  );
}
