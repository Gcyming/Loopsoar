import { describe, expect, it } from "vitest";
import { ExtensionRegistry } from "../../packages/core/src/extension.ts";
import {
  computeTreeDigest,
  generateSigningKeyPair,
  signExtensionManifest,
  verifyManifestSignature,
} from "../../packages/core/src/extensionSignature.ts";

describe("扩展签名与包摘要", () => {
  it("签名后可用对应公钥指纹校验；篡改清单 → invalid", () => {
    const keys = generateSigningKeyPair();
    const manifest = ExtensionRegistry.parseManifest({
      id: "signed",
      name: "Signed",
      version: "1.0.0",
      publisher: "Acme",
    });
    const signed = signExtensionManifest(manifest, keys.privateKeyPem, 1_700_000_000_000);
    expect(signed.signature?.publicKey).toBe(keys.publicKey);

    const trusted = verifyManifestSignature(signed, new Set([keys.fingerprint]));
    expect(trusted.status).toBe("trusted");
    expect(trusted.fingerprint).toBe(keys.fingerprint);

    const untrusted = verifyManifestSignature(signed, new Set());
    expect(untrusted.status).toBe("untrusted");

    const tampered = verifyManifestSignature({ ...signed, name: "Tampered" }, new Set([keys.fingerprint]));
    expect(tampered.status).toBe("invalid");
  });

  it("未签名 → unsigned；错误公钥 → invalid", () => {
    const manifest = ExtensionRegistry.parseManifest({ id: "plain", name: "Plain", version: "1.0.0" });
    expect(verifyManifestSignature(manifest, new Set()).status).toBe("unsigned");
    const broken = { ...manifest, signature: { algorithm: "ed25519" as const, publicKey: "AAAA", value: "AAAA" } };
    expect(verifyManifestSignature(broken, new Set()).status).toBe("invalid");
  });

  it("包摘要与文件顺序无关，内容变化会改变摘要", () => {
    const a = { path: "a.txt", data: Buffer.from("a") };
    const b = { path: "b.txt", data: Buffer.from("b") };
    const digest = computeTreeDigest([a, b]);
    expect(computeTreeDigest([b, a])).toBe(digest);
    expect(computeTreeDigest([a, { path: "b.txt", data: Buffer.from("changed") }])).not.toBe(digest);
    expect(computeTreeDigest([a])).toMatch(/^sha256-[A-Za-z0-9+/=]+$/);
  });
});
