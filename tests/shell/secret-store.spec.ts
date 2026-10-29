/** 密钥库：加密落盘（磁盘无明文）/ 掩码 / 读取 / 清除 / 降级后端。 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SecretStore, maskSecret } from "../../packages/shell/src/main/secretStore.ts";

const fakeBackend = {
  available: true,
  encrypt: (plain: string) => Buffer.from(`enc:${plain.split("").reverse().join("")}`, "utf8"),
  decrypt: (buf: Buffer) => buf.toString("utf8").replace(/^enc:/, "").split("").reverse().join(""),
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "loopsoar-secret-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SecretStore", () => {
  it("保存后磁盘无明文；get 可还原；hint 掩码", () => {
    const store = new SecretStore(root, fakeBackend);
    store.set("p1", "sk-super-secret-1234");
    const raw = readFileSync(path.join(root, "secrets.enc.json"), "utf8");
    expect(raw).not.toContain("super-secret");
    expect(raw).toContain("sk-");
    expect(store.get("p1")).toBe("sk-super-secret-1234");
    expect(store.hint("p1")).toBe("sk-…1234");
    expect(maskSecret("short")).toBe("********");
  });

  it("重启后（新实例）仍能解密", () => {
    new SecretStore(root, fakeBackend).set("p1", "sk-abcdefgh99");
    const again = new SecretStore(root, fakeBackend);
    expect(again.get("p1")).toBe("sk-abcdefgh99");
  });

  it("清除后 has=false，get=null", () => {
    const store = new SecretStore(root, fakeBackend);
    store.set("p1", "sk-abcdefgh99");
    expect(store.clear("p1")).toBe(true);
    expect(store.has("p1")).toBe(false);
    expect(store.get("p1")).toBeNull();
  });

  it("密钥库不可用时拒绝保存（fail-closed）", () => {
    const store = new SecretStore(root, { available: false, encrypt: () => Buffer.alloc(0), decrypt: () => "" });
    expect(store.storageMode()).toBe("unavailable");
    expect(() => store.set("p1", "sk-abcdefgh99")).toThrow(/密钥库不可用/);
  });

  it("降级后端：AES-GCM 往返 + 密钥文件生成", () => {
    const store = new SecretStore(root, { available: false, encrypt: () => Buffer.alloc(0), decrypt: () => "" });
    store.useDegradedBackend(path.join(root, ".secret.key"));
    expect(store.storageMode()).toBe("degraded");
    store.set("p1", "sk-degraded-test-1");
    expect(store.get("p1")).toBe("sk-degraded-test-1");
    expect(existsSync(path.join(root, ".secret.key"))).toBe(true);
    const raw = readFileSync(path.join(root, "secrets.enc.json"), "utf8");
    expect(raw).not.toContain("degraded-test");
    expect(crypto.randomBytes).toBeTruthy();
  });
});
