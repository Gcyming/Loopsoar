/**
 * 浏览器扩展宿主（纯逻辑）：
 *   · Chrome 商店 ID / CRX 头解析；
 *   · 极简 ZIP 解包（stored 方式；扩展包常见是 deflate，但路径穿越/坏头必须在测试里覆盖）；
 *   · 本地文件夹安装 → 复制到管理目录 → loadExtension → 列表/卸载。
 * 不启动 Electron：ExtensionApiLike 用假实现。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BrowserExtensionHost,
  chromeStoreCrxUrl,
  crxZipOffset,
  edgeStoreCrxUrl,
  extractChromeStoreId,
  extractEdgeStoreId,
  extractZip,
  type ExtensionApiLike,
} from "../../packages/shell/src/main/browserExtensions.ts";

/** 构造一个 stored（无压缩）ZIP，供解包测试使用。 */
function makeStoredZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

class FakeExtensionApi implements ExtensionApiLike {
  readonly loaded = new Map<string, { id: string; name: string; version: string; manifest?: Record<string, unknown> }>();
  async loadExtension(extensionPath: string): Promise<{ id: string; name: string; version: string; manifest?: Record<string, unknown> }> {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, "manifest.json"), "utf8"));
    const id = `fake-${path.basename(extensionPath)}`;
    const ext = { id, name: String(manifest.name ?? "extension"), version: String(manifest.version ?? "1.0.0"), manifest };
    this.loaded.set(id, ext);
    return ext;
  }
  async removeExtension(extensionId: string): Promise<void> {
    this.loaded.delete(extensionId);
  }
  getAllExtensions(): Array<{ id: string; name: string; version: string; manifest?: Record<string, unknown> }> {
    return [...this.loaded.values()];
  }
}

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-ext-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Chrome 商店 ID / CRX 头", () => {
  it("从 URL 或裸 ID 提取扩展 ID", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    expect(extractChromeStoreId(id)).toBe(id);
    expect(extractChromeStoreId(`https://chromewebstore.google.com/detail/name/${id}`)).toBe(id);
    expect(extractChromeStoreId("https://example.com/not-an-extension")).toBeNull();
  });

  it("构造官方 update2 下载地址", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    const url = chromeStoreCrxUrl(id);
    expect(url.startsWith("https://clients2.google.com/service/update2/crx?")).toBe(true);
    expect(url).toContain(encodeURIComponent(`id=${id}&uc`));
  });

  it("解析 CRX3 / CRX2 头偏移，拒绝非 CRX", () => {
    const crx3 = Buffer.alloc(20);
    crx3.writeUInt32LE(0x34327243, 0); // "Cr24"
    crx3.writeUInt32LE(3, 4);
    crx3.writeUInt32LE(4, 8);
    expect(crxZipOffset(crx3)).toBe(16);

    const crx2 = Buffer.alloc(20);
    crx2.writeUInt32LE(0x34327243, 0);
    crx2.writeUInt32LE(2, 4);
    crx2.writeUInt32LE(0, 8);
    crx2.writeUInt32LE(0, 12);
    expect(crxZipOffset(crx2)).toBe(16);

    expect(crxZipOffset(Buffer.from("PK\u0003\u0004 not a crx"))).toBeNull();
  });
});

describe("ZIP 解包", () => {
  it("解出 stored 文件", () => {
    const zip = makeStoredZip({ "manifest.json": '{"name":"x"}', "sub/a.txt": "hello" });
    const out = path.join(dir, "unzip");
    extractZip(zip, out);
    expect(fs.readFileSync(path.join(out, "manifest.json"), "utf8")).toContain("name");
    expect(fs.readFileSync(path.join(out, "sub", "a.txt"), "utf8")).toBe("hello");
  });

  it("拒绝路径穿越条目", () => {
    const zip = makeStoredZip({ "../evil.txt": "x" });
    expect(() => extractZip(zip, path.join(dir, "unzip2"))).toThrow(/穿越/);
  });

  it("拒绝非 ZIP 数据", () => {
    expect(() => extractZip(Buffer.from("not a zip"), path.join(dir, "u3"))).toThrow(/EOCD/);
  });
});

describe("BrowserExtensionHost", () => {
  it("本地文件夹安装：复制到管理目录、加载、列表、卸载", async () => {
    const source = path.join(dir, "src-ext");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(
      path.join(source, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "Loopsoar Test Ext", version: "1.2.3", description: "test" }),
      "utf8",
    );
    const api = new FakeExtensionApi();
    const host = new BrowserExtensionHost({ rootDir: path.join(dir, "managed"), api });
    const installed = await host.installFromFolder(source);
    expect(installed.name).toBe("Loopsoar Test Ext");
    expect(installed.version).toBe("1.2.3");
    expect(installed.source).toBe("folder");
    expect(installed.enabled).toBe(true);
    // 复制到管理目录（源目录删掉也不影响）
    fs.rmSync(source, { recursive: true, force: true });
    const list = host.list();
    expect(list).toHaveLength(1);
    expect(list[0].enabled).toBe(true);
    // 重启后 loadAll 仍能加载
    const host2 = new BrowserExtensionHost({ rootDir: path.join(dir, "managed"), api: new FakeExtensionApi() });
    await host2.loadAll();
    expect(host2.list().some((item) => item.name === "Loopsoar Test Ext")).toBe(true);
    // 卸载
    const removed = await host.remove(installed.id);
    expect(removed.ok).toBe(true);
    expect(host.list()).toHaveLength(0);
  });

  it("拒绝坏 manifest", async () => {
    const source = path.join(dir, "bad-ext");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "manifest.json"), "{}", "utf8");
    const host = new BrowserExtensionHost({ rootDir: path.join(dir, "managed"), api: new FakeExtensionApi() });
    await expect(host.installFromFolder(source)).rejects.toThrow(/manifest_version/);
  });
});

describe("Edge Add-ons", () => {
  it("从 Edge 详情页提取 ID 并构造 CRX 下载地址", () => {
    const id = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
    expect(extractEdgeStoreId(`https://microsoftedge.microsoft.com/addons/detail/name/${id}`)).toBe(id);
    expect(extractEdgeStoreId(id)).toBe(id);
    expect(extractEdgeStoreId("https://chromewebstore.google.com/")).toBeNull();
    const url = edgeStoreCrxUrl(id);
    expect(url.startsWith("https://edge.microsoft.com/extensionwebstorebase/v1/crx?")).toBe(true);
    expect(url).toContain(encodeURIComponent(`id=${id}&uc`));
  });
});
