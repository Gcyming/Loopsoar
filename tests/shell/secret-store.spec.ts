/** 密钥库：加密落盘（磁盘无明文）/ 掩码 / 读取 / 清除 / 降级后端。 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
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

describe("SecretStore：跨重启加密模式兼容", () => {
  it("degraded 文件在下次启动（safeStorage 可用）时仍能解密 → 密钥不丢", () => {
    const dir = path.join(os.tmpdir(), `loopsoar-secret-mode-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, ".secret.key");

    // 第一次启动：系统密钥库不可用 → 降级写盘
    const first = new SecretStore(dir, {
      available: false,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => "",
    });
    first.useDegradedBackend(keyFile);
    first.set("agnes", "sk-restart-persist-1234");

    // 第二次启动：safeStorage 可用（os 后端），但文件是 degraded → 装配层按 fileMode 切回降级后端
    const second = new SecretStore(dir, {
      available: true,
      encrypt: (plain) => Buffer.from(plain, "utf8"),
      decrypt: (buf) => buf.toString("utf8"),
    });
    expect(second.fileMode()).toBe("degraded");
    second.useDegradedBackend(keyFile);
    expect(second.get("agnes")).toBe("sk-restart-persist-1234");
    expect(second.storageMode()).toBe("degraded");
  });

  it("os 模式写入后重启仍可读（模拟同一后端）", () => {
    const dir = path.join(os.tmpdir(), `loopsoar-secret-os-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const backend = {
      available: true,
      encrypt: (plain: string) => Buffer.from(`os:${plain}`, "utf8"),
      decrypt: (buf: Buffer) => buf.toString("utf8").replace(/^os:/, ""),
    };
    const first = new SecretStore(dir, backend);
    first.set("mock", "sk-os-mode-5678");
    const second = new SecretStore(dir, backend);
    expect(second.fileMode()).toBe("os");
    expect(second.get("mock")).toBe("sk-os-mode-5678");
  });
});

describe("SecretStore：供应商合并迁移所需的元信息", () => {
  it("ids()/meta() 只给 id、hint、updatedAt，不泄露明文", () => {
    const store = new SecretStore(root, fakeBackend);
    store.set("opencode-go-2", "oc-super-secret-7lyv");
    store.set("opencode-go", "oc-another-secret-DO2x");
    expect(store.ids().sort()).toEqual(["opencode-go", "opencode-go-2"]);
    const meta = store.meta("opencode-go-2");
    expect(meta?.hint).toBe("oc-…7lyv".slice(0, 3) + "…" + "7lyv");
    expect(typeof meta?.updatedAt).toBe("number");
    expect(store.meta("missing")).toBeNull();
    expect(JSON.stringify(meta)).not.toContain("super-secret");
  });
});
