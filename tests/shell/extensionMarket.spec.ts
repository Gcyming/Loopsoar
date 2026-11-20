import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionHost } from "../../packages/shell/src/main/extensions.ts";
import { ExtensionMarket } from "../../packages/shell/src/main/extensionMarket.ts";
import { generateSigningKeyPair } from "../../packages/core/src/extensionSignature.ts";
import { signRegistryIndex } from "../../packages/core/src/registrySignature.ts";

const dirs: string[] = [];
const servers: http.Server[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-market-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
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

async function startServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("扩展市场（真实 HTTP registry）", () => {
  it("拉取目录、下载 zip、校验 sha256 并安装", async () => {
    const pkg = makeZip([
      {
        name: "loopsoar.extension.json",
        data: JSON.stringify({
          id: "market-demo",
          name: "Market Demo",
          version: "1.0.0",
          apiVersion: "2.0.0",
          contributes: { instructions: "from market" },
        }),
      },
    ]);
    const sha256 = createHash("sha256").update(pkg).digest("hex");
    let base = "";
    base = await startServer((req, res) => {
      if (req.url === "/index.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            name: "test",
            plugins: [
              {
                id: "market-demo",
                name: "Market Demo",
                versions: [{ version: "1.0.0", downloadUrl: "/pkg.zip", sha256 }],
              },
            ],
          }),
        );
        return;
      }
      if (req.url === "/pkg.zip") {
        res.writeHead(200, { "content-type": "application/zip", "content-length": String(pkg.length) });
        res.end(pkg);
        return;
      }
      res.writeHead(404).end();
    });

    const host = new ExtensionHost(path.join(tempDir(), "extensions"), { hostVersion: "0.4.0" });
    const market = new ExtensionMarket({ host, registryUrl: () => `${base}/index.json` });
    const catalog = await market.catalog(true);
    expect(catalog.plugins[0].latestVersion).toBe("1.0.0");
    expect(catalog.plugins[0].installedVersion).toBeUndefined();

    const result = await market.install("market-demo", undefined, { allowUntrusted: true, activate: true });
    expect(result.ok, result.error).toBe(true);
    expect(host.list().find((ext) => ext.manifest.id === "market-demo")?.manifest.version).toBe("1.0.0");
    expect((await market.catalog(false)).plugins[0].installedVersion).toBe("1.0.0");
  });

  it("未信任确认后的重试复用已校验的包（不二次下载）", async () => {
    const pkg = makeZip([
      {
        name: "loopsoar.extension.json",
        data: JSON.stringify({
          id: "trust-retry",
          name: "Trust Retry",
          version: "1.0.0",
          apiVersion: "2.0.0",
          engines: { loopsoar: ">=0.4.0" },
        }),
      },
    ]);
    let hits = 0;
    const base = await startServer((req, res) => {
      if (req.url === "/index.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            plugins: [
              {
                id: "trust-retry",
                name: "Trust Retry",
                versions: [
                  {
                    version: "1.0.0",
                    downloadUrl: "/pkg.zip",
                    sha256: createHash("sha256").update(pkg).digest("hex"),
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      if (req.url === "/pkg.zip") {
        hits += 1;
        res.writeHead(200).end(pkg);
        return;
      }
      res.writeHead(404).end();
    });
    const host = new ExtensionHost(path.join(tempDir(), "extensions"), { hostVersion: "0.4.0" });
    const market = new ExtensionMarket({ host, registryUrl: () => `${base}/index.json` });
    const pending = await market.install("trust-retry", "1.0.0");
    expect(pending.requiresTrust).toBeDefined();
    const result = await market.install("trust-retry", "1.0.0", { allowUntrusted: true, activate: true });
    expect(result.ok, result.error).toBe(true);
    expect(hits).toBe(1);
  });

  it("摘要不匹配拒绝安装；302 到云元数据地址在发起请求前被拒", async () => {
    const pkg = makeZip([
      { name: "loopsoar.extension.json", data: JSON.stringify({ id: "redir", name: "R", version: "1.0.0" }) },
    ]);
    const base = await startServer((req, res) => {
      if (req.url === "/index.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            plugins: [
              {
                id: "redir",
                name: "R",
                versions: [
                  { version: "1.0.0", downloadUrl: "/redirect", sha256: "0".repeat(64) },
                  { version: "0.9.0", downloadUrl: "/pkg.zip", sha256: createHash("sha256").update(pkg).digest("hex") },
                  { version: "0.8.0", downloadUrl: "/pkg.zip", sha256: "0".repeat(64) },
                ],
              },
            ],
          }),
        );
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      if (req.url === "/pkg.zip") {
        res.writeHead(200).end(pkg);
        return;
      }
      res.writeHead(404).end();
    });
    const host = new ExtensionHost(path.join(tempDir(), "extensions"), { hostVersion: "0.4.0" });
    const market = new ExtensionMarket({ host, registryUrl: () => `${base}/index.json` });
    await market.catalog(true);
    await expect(market.install("redir", "1.0.0", { allowUntrusted: true })).rejects.toThrow(/云元数据|不允许/);
    await expect(market.install("redir", "0.8.0", { allowUntrusted: true })).rejects.toThrow(/摘要不匹配/);
  });

  it("配置市场公钥后拒绝未签名目录，并接受受信签名目录", async () => {
    const key = generateSigningKeyPair();
    const unsigned = {
      schemaVersion: 1 as const,
      plugins: [
        {
          id: "signed-demo",
          name: "Signed",
          versions: [{ version: "1.0.0", downloadUrl: "/pkg.zip", sha256: "a".repeat(64) }],
        },
      ],
    };
    const signed = signRegistryIndex(
      { schemaVersion: 2, name: "signed", channel: "stable", plugins: [] },
      key.privateKeyPem,
    );
    let current: unknown = unsigned;
    const base = await startServer((req, res) => {
      if (req.url === "/index.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(current));
        return;
      }
      res.writeHead(404).end();
    });
    const host = new ExtensionHost(path.join(tempDir(), "extensions"), { hostVersion: "0.4.0" });
    const market = new ExtensionMarket({
      host,
      registryUrl: () => `${base}/index.json`,
      catalogPublicKey: () => key.publicKey,
    });
    await expect(market.catalog(true)).rejects.toThrow(/未签名/);
    current = signed;
    const catalog = await market.catalog(true);
    expect(catalog.signature?.status).toBe("trusted");
    expect(catalog.signature?.fingerprint).toBe(key.fingerprint);

    current = { ...signed, name: "tampered" };
    await expect(market.catalog(true)).rejects.toThrow(/签名无效|篡改/);

    current = signRegistryIndex(
      { schemaVersion: 2, name: "expired", expiresAt: Date.now() - 1, plugins: [] },
      key.privateKeyPem,
    );
    await expect(market.catalog(true)).rejects.toThrow(/过期/);
  });

  it("撤销列表命中后已安装版本立即 blocked，且拒绝再次安装", async () => {
    const pkg = makeZip([
      {
        name: "loopsoar.extension.json",
        data: JSON.stringify({ id: "revoke-me", name: "Revoke Me", version: "1.0.0" }),
      },
    ]);
    const sha256 = createHash("sha256").update(pkg).digest("hex");
    let current: Record<string, unknown> = {
      schemaVersion: 1,
      plugins: [{ id: "revoke-me", name: "Revoke Me", versions: [{ version: "1.0.0", downloadUrl: "/pkg.zip", sha256 }] }],
    };
    const base = await startServer((req, res) => {
      if (req.url === "/index.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(current));
        return;
      }
      if (req.url === "/pkg.zip") {
        res.writeHead(200).end(pkg);
        return;
      }
      res.writeHead(404).end();
    });
    const host = new ExtensionHost(path.join(tempDir(), "extensions"), { hostVersion: "0.4.0" });
    const market = new ExtensionMarket({ host, registryUrl: () => `${base}/index.json` });
    await market.catalog(true);
    const installed = await market.install("revoke-me", "1.0.0", { allowUntrusted: true, activate: true });
    expect(installed.ok, installed.error).toBe(true);
    expect(host.list()[0].enabled).toBe(true);

    current = {
      schemaVersion: 2,
      revocations: [{ id: "revoke-me", version: "1.0.0", reason: "恶意版本", revokedAt: Date.now() }],
      plugins: [{ id: "revoke-me", name: "Revoke Me", versions: [{ version: "1.0.0", downloadUrl: "/pkg.zip", sha256 }] }],
    };
    const catalog = await market.catalog(true);
    expect(catalog.revoked).toBe(1);
    const after = host.list()[0];
    expect(after.info?.certification).toBe("blocked");
    expect(after.info?.revocation?.reason).toBe("恶意版本");
    expect(after.enabled).toBe(false);
    await expect(market.install("revoke-me", "1.0.0", { allowUntrusted: true })).rejects.toThrow(/撤销/);
  });
});
