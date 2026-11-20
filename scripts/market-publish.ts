#!/usr/bin/env tsx
/**
 * 扩展市场发布工具（零服务器）：从 zip 目录生成 index.json、签名、校验。
 *
 *   pnpm market:keygen -- --out .loopsoar-market-keys
 *   pnpm market:build -- ./dist/extensions --base-url https://cdn.example.com/extensions \
 *       --out ./dist/extensions/index.json --key .loopsoar-market-keys/market-key.pem
 *   pnpm market:verify -- ./dist/extensions/index.json --key .loopsoar-market-keys/market-key.pub
 *
 * 也可以先 build 后单独 sign：
 *   pnpm market:sign -- ./dist/extensions/index.json --key .loopsoar-market-keys/market-key.pem
 *
 * 私钥只读写本地文件，绝不打印；index.json 的签名覆盖除 signature 外的全部字段。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ExtensionManifestSchema } from "../packages/contracts/dist/src/extension.js";
import { generateSigningKeyPair, fingerprintPublicKey } from "../packages/core/dist/extensionSignature.js";
import { signRegistryIndex, verifyRegistrySignature } from "../packages/core/dist/registrySignature.js";
import { readZip } from "../packages/shell/src/main/zip.ts";
import type {
  ExtensionRegistryEntry,
  ExtensionRegistryIndex,
  ExtensionRegistryVersion,
  ExtensionRevocation,
} from "../packages/contracts/dist/src/extensionRegistry.js";
import { ExtensionRegistryIndexSchema, ExtensionRevocationSchema } from "../packages/contracts/dist/src/extensionRegistry.js";
import { compareSemVer, parseSemVer } from "../packages/core/dist/semver.js";

const MANIFEST = "loopsoar.extension.json";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function takeFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} 缺少参数`);
  return value;
}

function positional(args: string[], flagsWithValue: string[]): string | undefined {
  const skip = new Set<number>();
  for (const flag of flagsWithValue) {
    const index = args.indexOf(flag);
    if (index !== -1) {
      skip.add(index);
      skip.add(index + 1);
    }
  }
  return args.find((arg, index) => !arg.startsWith("--") && !skip.has(index));
}

function keygen(args: string[]): void {
  const out = path.resolve(takeFlag(args, "--out") ?? ".loopsoar-market-keys");
  fs.mkdirSync(out, { recursive: true });
  const privatePath = path.join(out, "market-key.pem");
  const publicPath = path.join(out, "market-key.pub");
  if (fs.existsSync(privatePath)) fail(`私钥已存在，拒绝覆盖：${privatePath}`);
  const pair = generateSigningKeyPair();
  fs.writeFileSync(privatePath, pair.privateKeyPem, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(publicPath, `${pair.publicKey}\n`, "utf8");
  console.log(`私钥：${privatePath}（加入 .gitignore，不要提交/外发）`);
  console.log(`公钥：${publicPath}`);
  console.log(`指纹：${pair.fingerprint}`);
  console.log(`把公钥(base64)配置到客户端的「市场目录签名公钥」：${pair.publicKey}`);
}

function collectZips(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function build(args: string[]): void {
  const input = positional(args, ["--out", "--base-url", "--key", "--channel", "--name", "--expires-days", "--revocations"]);
  if (!input) fail("用法：market:build -- <zip 目录> [--out index.json] [--base-url URL] [--key 私钥.pem]");
  const dir = path.resolve(input);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`目录不存在：${dir}`);
  const out = path.resolve(takeFlag(args, "--out") ?? path.join(dir, "index.json"));
  const baseUrl = takeFlag(args, "--base-url")?.replace(/\/+$/, "");
  const channel = takeFlag(args, "--channel") === "beta" ? "beta" : "stable";
  const name = takeFlag(args, "--name") ?? "Loopsoar Extensions";
  const expiresDays = Number(takeFlag(args, "--expires-days") ?? "30");
  if (!Number.isFinite(expiresDays) || expiresDays < 0) fail("--expires-days 必须是非负数");
  const keyPath = takeFlag(args, "--key");
  if (keyPath && !fs.existsSync(path.resolve(keyPath))) fail(`找不到私钥：${keyPath}`);

  const entries = new Map<string, ExtensionRegistryEntry>();
  for (const zipPath of collectZips(dir)) {
    const buffer = fs.readFileSync(zipPath);
    let manifest;
    try {
      const manifestEntry = readZip(buffer).find((entry) => entry.name === MANIFEST);
      if (!manifestEntry) fail(`${path.basename(zipPath)} 缺少 ${MANIFEST}`);
      const parsed = ExtensionManifestSchema.safeParse(JSON.parse(manifestEntry.data.toString("utf8")));
      if (!parsed.success) {
        fail(`${path.basename(zipPath)} 清单不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("；")}`);
      }
      manifest = parsed.data;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("✗")) throw err;
      fail(`${path.basename(zipPath)} 无法读取：${err instanceof Error ? err.message : String(err)}`);
    }

    const existing = entries.get(manifest.id);
    const version: ExtensionRegistryVersion = {
      version: manifest.version,
      ...(manifest.apiVersion ? { apiVersion: manifest.apiVersion } : {}),
      ...(manifest.engines?.loopsoar ? { engines: { loopsoar: manifest.engines.loopsoar } } : {}),
      downloadUrl: baseUrl ? `${baseUrl}/${encodeURIComponent(path.basename(zipPath))}` : path.basename(zipPath),
      sha256: createHash("sha256").update(buffer).digest("hex"),
      size: buffer.byteLength,
      publishedAt: Math.round(fs.statSync(zipPath).mtimeMs),
    };
    if (existing) {
      if (existing.versions.some((item) => item.version === version.version)) {
        fail(`重复版本：${manifest.id}@${manifest.version}（同一目录里只能有一个包）`);
      }
      existing.versions.push(version);
    } else {
      entries.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        ...(manifest.description ? { description: manifest.description } : {}),
        ...(manifest.publisher ? { publisher: manifest.publisher } : {}),
        ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
        ...(manifest.keywords ? { keywords: manifest.keywords } : {}),
        versions: [version],
      });
    }
  }
  if (entries.size === 0) fail("目录里没有 .zip 包");

  for (const entry of entries.values()) {
    entry.versions.sort((a, b) => compareSemVer(parseSemVer(b.version)!, parseSemVer(a.version)!));
    const latest = entry.versions.find((version) => !version.yanked);
    if (latest) entry.latest = latest.version;
  }

  const revocationsPath = takeFlag(args, "--revocations");
  let revocations: ExtensionRevocation[] | undefined;
  if (revocationsPath) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(revocationsPath), "utf8"));
    const parsed = ExtensionRevocationSchema.array().safeParse(raw);
    if (!parsed.success) fail(`撤销列表不合法：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
    revocations = parsed.data;
  }

  const index: ExtensionRegistryIndex = {
    schemaVersion: 2,
    name,
    updatedAt: Date.now(),
    channel,
    ...(expiresDays > 0 ? { expiresAt: Date.now() + expiresDays * 86_400_000 } : {}),
    ...(revocations && revocations.length > 0 ? { revocations } : {}),
    plugins: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const signed = keyPath
    ? signRegistryIndex(index, fs.readFileSync(path.resolve(keyPath), "utf8"))
    : index;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(signed, null, 2)}\n`, "utf8");

  console.log(`已生成：${out}`);
  console.log(`扩展 ${entries.size} 个，通道 ${channel}${signed.expiresAt ? `，有效期至 ${new Date(signed.expiresAt).toISOString()}` : "，不过期"}`);
  if (signed.signature) {
    console.log(`已签名，公钥指纹：${fingerprintPublicKey(signed.signature.publicKey)}`);
  } else {
    console.log("未签名（建议加 --key；客户端配置市场公钥后会拒绝无签名目录）。");
  }
}

function signIndex(args: string[]): void {
  const input = positional(args, ["--key", "--out"]);
  if (!input) fail("用法：market:sign -- <index.json> --key <私钥.pem>");
  const keyPath = takeFlag(args, "--key");
  if (!keyPath) fail("缺少 --key <私钥.pem>");
  const index = JSON.parse(fs.readFileSync(path.resolve(input), "utf8")) as ExtensionRegistryIndex;
  const parsed = ExtensionRegistryIndexSchema.safeParse(index);
  if (!parsed.success) fail(`index.json 不符合 schema：${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("；")}`);
  const signed = signRegistryIndex(index, fs.readFileSync(path.resolve(keyPath), "utf8"));
  const out = path.resolve(takeFlag(args, "--out") ?? input);
  fs.writeFileSync(out, `${JSON.stringify(signed, null, 2)}\n`, "utf8");
  console.log(`已签名：${out}`);
  console.log(`公钥指纹：${fingerprintPublicKey(signed.signature!.publicKey)}`);
}

function verifyIndex(args: string[]): void {
  const input = positional(args, ["--key"]);
  if (!input) fail("用法：market:verify -- <index.json> [--key 公钥|指纹]");
  const index = JSON.parse(fs.readFileSync(path.resolve(input), "utf8")) as ExtensionRegistryIndex;
  const parsed = ExtensionRegistryIndexSchema.safeParse(index);
  if (!parsed.success) fail(`index.json 不符合 schema：${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("；")}`);
  const requested = takeFlag(args, "--key");
  let trusted = new Set<string>();
  if (requested) {
    const material = fs.existsSync(path.resolve(requested))
      ? fs.readFileSync(path.resolve(requested), "utf8").trim()
      : requested;
    trusted = new Set([material.startsWith("sha256:") ? material : fingerprintPublicKey(material)]);
  }
  const state = verifyRegistrySignature(index, trusted);
  console.log(`目录：${index.name ?? "(未命名)"} · 通道 ${index.channel ?? "stable"}`);
  console.log(`插件：${index.plugins.length} 个 · 撤销：${index.revocations?.length ?? 0} 条`);
  console.log(`签名：${state.status}${state.fingerprint ? `（${state.fingerprint}）` : ""}`);
  if (index.expiresAt !== undefined) {
    const expired = Date.now() > index.expiresAt;
    console.log(`有效期：${new Date(index.expiresAt).toISOString()}${expired ? "（已过期）" : ""}`);
    if (expired) process.exit(1);
  }
  if (state.status === "invalid") process.exit(1);
  if (state.status === "unsigned") console.log("提示：目录未签名；配置市场公钥的客户端会拒绝它。");
  if (state.status === "untrusted") console.log("提示：签名有效，但未指定/配置受信公钥。");
}

const [command, ...rest] = process.argv.slice(2);
if (command === "keygen") keygen(rest);
else if (command === "build") build(rest);
else if (command === "sign") signIndex(rest);
else if (command === "verify") verifyIndex(rest);
else {
  console.log("用法：");
  console.log("  market-publish.ts keygen --out <目录>");
  console.log("  market-publish.ts build <zip目录> --base-url <URL> [--out index.json] [--key 私钥.pem] [--expires-days 30] [--revocations revocations.json]");
  console.log("  market-publish.ts sign <index.json> --key <私钥.pem>");
  console.log("  market-publish.ts verify <index.json> [--key <公钥|指纹>]");
  process.exit(command ? 1 : 0);
}
