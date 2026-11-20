import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractZipToDir, readZip } from "../../packages/shell/src/main/zip.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-zip-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 只生成 stored（无压缩）zip，足够覆盖路径/CRC/结构校验。 */
function makeZip(entries: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

describe("安全 ZIP 读取", () => {
  it("解压正常包并保留目录结构", () => {
    const zip = makeZip([
      { name: "extension.json", data: "{\"id\":\"demo\"}" },
      { name: "views/index.html", data: "<html></html>" },
    ]);
    expect(readZip(zip).map((entry) => entry.name)).toEqual(["extension.json", "views/index.html"]);
    const dest = tempDir();
    const result = extractZipToDir(zip, dest);
    expect(result.files).toBe(2);
    expect(fs.readFileSync(path.join(dest, "views", "index.html"), "utf8")).toBe("<html></html>");
  });

  it("拒绝路径穿越、绝对路径与反斜杠", () => {
    const dest = tempDir();
    expect(() => extractZipToDir(makeZip([{ name: "../evil.txt", data: "x" }]), dest)).toThrow(/路径|非法/);
    expect(() => extractZipToDir(makeZip([{ name: "/abs.txt", data: "x" }]), dest)).toThrow(/路径|非法/);
    expect(() => extractZipToDir(makeZip([{ name: "..\\evil.txt", data: "x" }]), dest)).toThrow(/路径|非法/);
    expect(fs.existsSync(path.join(dest, "..", "evil.txt"))).toBe(false);
  });

  it("CRC 不符时拒绝（避免损坏包被当成完整包）", () => {
    const zip = makeZip([{ name: "a.txt", data: "hello" }]);
    zip[30 + "a.txt".length] ^= 0xff; // 破坏第一个文件内容
    expect(() => readZip(zip)).toThrow(/CRC/);
  });
});
