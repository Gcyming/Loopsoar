/**
 * 最小 ZIP 读取器（仅支持商店包需要的 stored / deflate，无加密、无 ZIP64）。
 *
 * 为什么自己写：插件安装是供应链入口，解压库的攻击面/传递依赖不值得为「读一个 zip」
 * 引入；这里显式限制条目数、单文件/总解压体积、拒绝 symlink 与路径穿越，并校验 CRC。
 * 不支持的特性一律报错（fail-closed），不做「尽量解」。
 */
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2_000,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      const commentLength = buffer.readUInt16LE(i + 20);
      if (i + 22 + commentLength === buffer.length) return i;
    }
  }
  return -1;
}

function safeEntryName(raw: string): string {
  const name = raw.replace(/\\/g, "/");
  if (!name || name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.includes("\0")) {
    throw new Error(`ZIP 内含非法路径：${raw}`);
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "..")) throw new Error(`ZIP 内含路径穿越：${raw}`);
  return segments.filter((segment) => segment !== "" && segment !== ".").join("/");
}

/** 读取 zip 到内存。目录条目会被忽略（由文件路径隐式创建）。 */
export function readZip(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (buffer.length < 22) throw new Error("不是有效的 ZIP（文件过小）");
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error("不是有效的 ZIP（找不到中央目录）");
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  if (disk !== 0 || centralDisk !== 0) throw new Error("不支持分卷 ZIP");
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) throw new Error("不支持 ZIP64");
  if (count > limits.maxEntries) throw new Error(`ZIP 条目数超过 ${limits.maxEntries}`);

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error("ZIP 中央目录损坏");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    if (nameStart + nameLength > buffer.length) throw new Error("ZIP 中央目录损坏（文件名越界）");
    const rawName = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    offset = nameStart + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error(`ZIP 内条目已加密，不支持：${rawName}`);
    const mode = (externalAttrs >>> 16) & 0xffff;
    if ((mode & 0xf000) === 0xa000) throw new Error(`ZIP 内不允许符号链接：${rawName}`);
    const name = safeEntryName(rawName);
    if (!name) continue; // 目录条目
    if (seen.has(name)) throw new Error(`ZIP 内路径重复：${name}`);
    seen.add(name);

    if (uncompressedSize > limits.maxEntryBytes) throw new Error(`ZIP 条目解压后超过 ${limits.maxEntryBytes} 字节：${name}`);
    total += uncompressedSize;
    if (total > limits.maxTotalBytes) throw new Error(`ZIP 解压总量超过 ${limits.maxTotalBytes} 字节`);
    if (method !== 0 && method !== 8) throw new Error(`不支持的 ZIP 压缩方法 ${method}：${name}`);

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`ZIP 本地头损坏：${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`ZIP 数据越界：${name}`);
    const compressed = buffer.subarray(dataStart, dataEnd);

    let data: Buffer;
    if (method === 0) {
      if (compressedSize !== uncompressedSize) throw new Error(`ZIP stored 条目大小不一致：${name}`);
      data = Buffer.from(compressed);
    } else {
      data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
      if (data.length !== uncompressedSize) throw new Error(`ZIP 解压大小不一致：${name}`);
    }
    if (crc32(data) !== expectedCrc) throw new Error(`ZIP CRC 校验失败：${name}`);
    entries.push({ name, data });
  }
  return entries;
}

/** 解压到目标目录（路径已校验在 dest 内；写普通文件，不保留可执行位）。 */
export function extractZipToDir(buffer: Buffer, dest: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): { files: number; bytes: number } {
  const entries = readZip(buffer, limits);
  const root = path.resolve(dest);
  let bytes = 0;
  for (const entry of entries) {
    const target = path.resolve(root, ...entry.name.split("/"));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`ZIP 路径逃逸：${entry.name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data, { mode: 0o644 });
    bytes += entry.data.byteLength;
  }
  return { files: entries.length, bytes };
}

/** Deflate 压缩（仅供测试/打包脚本使用；生产安装只读不写）。 */
export function inflateEntryForTest(data: Buffer): Buffer {
  return inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
}
