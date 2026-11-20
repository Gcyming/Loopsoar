import { describe, expect, it } from "vitest";
import {
  findRevocation,
  registrySigningPayload,
  signRegistryIndex,
  verifyRegistrySignature,
} from "../../packages/core/src/registrySignature.ts";
import { generateSigningKeyPair } from "../../packages/core/src/extensionSignature.ts";
import type { ExtensionRegistryIndex } from "../../packages/contracts/src/extensionRegistry.ts";

function makeIndex(): ExtensionRegistryIndex {
  return {
    schemaVersion: 2,
    name: "test-market",
    updatedAt: 1_700_000_000_000,
    channel: "stable",
    expiresAt: 1_800_000_000_000,
    plugins: [
      {
        id: "demo",
        name: "Demo",
        versions: [{ version: "1.0.0", downloadUrl: "demo-1.0.0.zip", sha256: "a".repeat(64) }],
      },
    ],
  };
}

describe("扩展市场目录签名", () => {
  it("签名后可被受信公钥验证，签名不进入载荷", () => {
    const key = generateSigningKeyPair();
    const index = signRegistryIndex(makeIndex(), key.privateKeyPem, 123);
    expect(index.signature?.algorithm).toBe("ed25519");
    expect(registrySigningPayload(index)).not.toContain("signature");
    const state = verifyRegistrySignature(index, new Set([key.fingerprint]));
    expect(state.status).toBe("trusted");
    expect(state.fingerprint).toBe(key.fingerprint);
  });

  it("未配置公钥时签名有效但标记 untrusted，不冒充 trusted", () => {
    const key = generateSigningKeyPair();
    const index = signRegistryIndex(makeIndex(), key.privateKeyPem);
    expect(verifyRegistrySignature(index, new Set()).status).toBe("untrusted");
  });

  it("篡改 plugins / 撤销列表会让签名失效", () => {
    const key = generateSigningKeyPair();
    const signed = signRegistryIndex(makeIndex(), key.privateKeyPem);
    const tampered: ExtensionRegistryIndex = {
      ...signed,
      plugins: [{ ...signed.plugins[0], name: "Evil" }],
    };
    expect(verifyRegistrySignature(tampered, new Set([key.fingerprint])).status).toBe("invalid");
    const revocationTampered: ExtensionRegistryIndex = {
      ...signed,
      revocations: [{ id: "demo", reason: "test", revokedAt: 1 }],
    };
    expect(verifyRegistrySignature(revocationTampered, new Set([key.fingerprint])).status).toBe("invalid");
  });

  it("无签名返回 unsigned，坏签名返回 invalid", () => {
    expect(verifyRegistrySignature(makeIndex(), new Set()).status).toBe("unsigned");
    const key = generateSigningKeyPair();
    const signed = signRegistryIndex(makeIndex(), key.privateKeyPem);
    const broken: ExtensionRegistryIndex = {
      ...signed,
      signature: { ...signed.signature!, value: "A".repeat(88) },
    };
    expect(verifyRegistrySignature(broken, new Set([key.fingerprint])).status).toBe("invalid");
  });

  it("撤销按 id/version 命中，缺省 version 匹配全部版本", () => {
    const index: ExtensionRegistryIndex = {
      ...makeIndex(),
      revocations: [
        { id: "demo", version: "1.0.0", reason: "bad build", revokedAt: 1 },
        { id: "all", reason: "key leaked", revokedAt: 2 },
      ],
    };
    expect(findRevocation(index, "demo", "1.0.0")?.reason).toBe("bad build");
    expect(findRevocation(index, "demo", "1.0.1")).toBeUndefined();
    expect(findRevocation(index, "all", "9.9.9")?.reason).toBe("key leaked");
  });
});
