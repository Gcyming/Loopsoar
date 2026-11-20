import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSigningKeyPair } from "../../packages/core/src/extensionSignature.ts";
import { ExtensionTrustStore } from "../../packages/shell/src/main/extensionTrust.ts";
import { ExtensionHost } from "../../packages/shell/src/main/extensions.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-trust-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("扩展信任库", () => {
  it("信任公钥时重算指纹，拒绝伪造；持久化后可重新加载", () => {
    const file = path.join(tempDir(), "extensions-trust.json");
    const keys = generateSigningKeyPair();
    const store = new ExtensionTrustStore(file);
    expect(store.policy()).toBe("warn");

    expect(store.trust({ fingerprint: "f".repeat(64), publicKey: keys.publicKey }).ok).toBe(false);
    expect(store.trust({ fingerprint: keys.fingerprint, publicKey: keys.publicKey, publisher: "Acme" }).ok).toBe(true);
    expect(store.has(keys.fingerprint)).toBe(true);
    expect(store.fingerprints().has(keys.fingerprint)).toBe(true);

    store.setPolicy("strict");
    const reloaded = new ExtensionTrustStore(file);
    expect(reloaded.policy()).toBe("strict");
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].publisher).toBe("Acme");
  });

  it("移除信任与非法 JSON 回退 warn，不阻塞启动", () => {
    const file = path.join(tempDir(), "extensions-trust.json");
    const keys = generateSigningKeyPair();
    const store = new ExtensionTrustStore(file);
    store.trust({ fingerprint: keys.fingerprint, publicKey: keys.publicKey });
    expect(store.untrust(keys.fingerprint)).toBe(true);
    expect(store.list()).toEqual([]);

    fs.writeFileSync(file, "{not json", "utf8");
    const fallback = new ExtensionTrustStore(file);
    expect(fallback.policy()).toBe("warn");
    expect(fallback.list()).toEqual([]);
  });

  it("撤销密钥后退出有效信任集并保留审计记录；过期密钥自动失效", () => {
    const file = path.join(tempDir(), "extensions-trust.json");
    const revokedKey = generateSigningKeyPair();
    const expiringKey = generateSigningKeyPair();
    const store = new ExtensionTrustStore(file);
    store.trust({ fingerprint: revokedKey.fingerprint, publicKey: revokedKey.publicKey, publisher: "Acme" });
    store.trust({
      fingerprint: expiringKey.fingerprint,
      publicKey: expiringKey.publicKey,
      notBefore: Date.now() - 1_000,
      notAfter: Date.now() - 500,
    });
    expect(store.fingerprints().has(revokedKey.fingerprint)).toBe(true);
    expect(store.fingerprints().has(expiringKey.fingerprint)).toBe(false);

    expect(store.revoke(revokedKey.fingerprint, "私钥泄露").ok).toBe(true);
    expect(store.fingerprints().has(revokedKey.fingerprint)).toBe(false);
    expect(store.revokedFingerprints().has(revokedKey.fingerprint)).toBe(true);
    expect(store.list().find((entry) => entry.fingerprint === revokedKey.fingerprint)?.revokeReason).toBe("私钥泄露");

    const reloaded = new ExtensionTrustStore(file);
    expect(reloaded.revokedFingerprints().has(revokedKey.fingerprint)).toBe(true);
    expect(reloaded.list()).toHaveLength(2);
  });

  it("strict 策略把未签名扩展标 blocked，并在启用时给出明确原因", () => {
    const root = tempDir();
    const dir = path.join(root, "extensions", "unsigned");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "loopsoar.extension.json"),
      JSON.stringify({ id: "unsigned", name: "Unsigned", version: "1.0.0", apiVersion: "2.0.0" }),
      "utf8",
    );
    const host = new ExtensionHost(path.join(root, "extensions"), { hostVersion: "0.4.0" });
    host.trust().setPolicy("strict");
    host.scan();
    expect(host.list()[0]?.info?.certification).toBe("blocked");
    expect(host.setEnabled("unsigned", true)).toBeNull();
    expect(host.lastEnableError).toContain("严格信任策略");
  });
});
