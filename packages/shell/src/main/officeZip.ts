/**
 * 办公文档共用的 ZIP 读取层（P1-6 增强）。
 *
 * 不引入第三方解压库：Office/ODF 都是标准 ZIP，这里只读指定条目。
 * 稳定性边界：
 *   · 限制条目数、单条解压上限、压缩/解压长度和偏移越界，防 zip bomb；
 *   · 拒绝加密条目、zip64/未知压缩方法，并返回可读错误；
 *   · 只做内存读取，不落盘解包，避免路径穿越。
 */
import zlib from "node:zlib";

export const MAX_OFFICE_BYTES = 30 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 4096;
export const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_ZIP_CENTRAL_BYTES = 16 * 1024 * 1024;

export class OfficeZipError extends Error {
  constructor(
    public readonly code: "encrypted" | "zip64" | "unsupported-method" | "too-large" | "corrupt",
    message: string,
  ) {
    super(message);
    this.name = "OfficeZipError";
  }
}

export function hasZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

function findEocd(zip: Buffer): number {
  if (zip.length < 22) return -1;
  const min = Math.max(0, zip.length - 65_557);
  for (let index = zip.length - 22; index >= min; index -= 1) {
    if (zip.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

/**
 * 读取 ZIP 中的指定条目。条目不存在/中央目录损坏时返回 null；
 * 加密、超限、zip64、未知压缩方法抛出带 code 的 OfficeZipError。
 */
export function readZipEntry(
  zip: Buffer,
  wanted: string,
  limits: { maxEntries?: number; maxEntryBytes?: number } = {},
): Buffer | null {
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxEntryBytes = limits.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  const eocd = findEocd(zip);
  if (eocd < 0) return null;
  if (zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0) {
    throw new OfficeZipError("zip64", "不支持分卷 ZIP");
  }
  const entries = zip.readUInt16LE(eocd + 10);
  if (entries > maxEntries) {
    throw new OfficeZipError("too-large", `ZIP 条目过多（${entries}，上限 ${maxEntries}）`);
  }
  const centralSize = zip.readUInt32LE(eocd + 12);
  let offset = zip.readUInt32LE(eocd + 16);
  if (centralSize > MAX_ZIP_CENTRAL_BYTES || offset + centralSize > zip.length) {
    throw new OfficeZipError("corrupt", "ZIP 中央目录越界");
  }
  const centralEnd = offset + centralSize;

  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > zip.length || offset + 46 > centralEnd) return null;
    if (zip.readUInt32LE(offset) !== 0x02014b50) return null;
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > zip.length || next > centralEnd || nameLength === 0 || nameLength > 4096) return null;
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === wanted) {
      if (flags & 0x1) throw new OfficeZipError("encrypted", `ZIP 条目已加密：${wanted}`);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        throw new OfficeZipError("zip64", `不支持 zip64 条目：${wanted}`);
      }
      if (uncompressedSize > maxEntryBytes) {
        throw new OfficeZipError("too-large", `条目解压后过大：${wanted}（${uncompressedSize} 字节）`);
      }
      if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new OfficeZipError("corrupt", `ZIP 本地头损坏：${wanted}`);
      }
      const localFlags = zip.readUInt16LE(localOffset + 6);
      if (localFlags & 0x1) throw new OfficeZipError("encrypted", `ZIP 条目已加密：${wanted}`);
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataStart > zip.length || dataEnd > zip.length || dataEnd < dataStart) {
        throw new OfficeZipError("corrupt", `ZIP 数据区越界：${wanted}`);
      }
      const data = zip.subarray(dataStart, dataEnd);
      if (method === 0) {
        if (compressedSize > maxEntryBytes) {
          throw new OfficeZipError("too-large", `条目存储过大：${wanted}`);
        }
        return Buffer.from(data);
      }
      if (method !== 8) {
        throw new OfficeZipError("unsupported-method", `不支持的 ZIP 压缩方法 ${method}：${wanted}`);
      }
      try {
        // 用中央目录声明的大小做硬上限；若实际解压超过声明值，zlib 会直接抛错。
        const cap = Math.max(1, Math.min(uncompressedSize + 1, maxEntryBytes + 1));
        return zlib.inflateRawSync(data, { maxOutputLength: cap });
      } catch (err) {
        if (err instanceof OfficeZipError) throw err;
        throw new OfficeZipError("corrupt", `ZIP 解压失败：${wanted}（${err instanceof Error ? err.message : String(err)}）`);
      }
    }
    offset = next;
  }
  return null;
}
