import { describe, expect, it } from "vitest";
import { OfficeZipError, readZipEntry } from "../../packages/shell/src/main/officeZip.ts";
import { zipFixture } from "./zipFixture.ts";

describe("Office ZIP 稳定性（P1-6）", () => {
  it("读取 store/deflate 条目", () => {
    const zip = zipFixture([
      { name: "word/document.xml", data: Buffer.from("<doc>hello</doc>") },
      { name: "meta.xml", data: Buffer.from("<meta>压缩</meta>"), method: 8 },
    ]);
    expect(readZipEntry(zip, "word/document.xml")?.toString("utf8")).toBe("<doc>hello</doc>");
    expect(readZipEntry(zip, "meta.xml")?.toString("utf8")).toBe("<meta>压缩</meta>");
    expect(readZipEntry(zip, "missing.xml")).toBeNull();
  });

  it("加密条目拒绝并给出 code", () => {
    const zip = zipFixture([{ name: "secret.xml", data: Buffer.from("x"), flags: 1 }]);
    try {
      readZipEntry(zip, "secret.xml");
      throw new Error("应当拒绝");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeZipError);
      expect((err as OfficeZipError).code).toBe("encrypted");
    }
  });

  it("声明解压大小小于实际时由 zlib 上限阻断（zip bomb）", () => {
    const zip = zipFixture([
      { name: "bomb.xml", data: Buffer.alloc(1_000_000, 0x41), method: 8, claimedUncompressed: 10 },
    ]);
    expect(() => readZipEntry(zip, "bomb.xml")).toThrow(/ZIP 解压失败/);
  });

  it("中央目录损坏时返回 null，不抛异常", () => {
    const zip = zipFixture([{ name: "a.xml", data: Buffer.from("a") }]);
    zip.writeUInt32LE(0, zip.length - 22);
    expect(readZipEntry(zip, "a.xml")).toBeNull();
  });
});
