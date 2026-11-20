#!/usr/bin/env tsx
/**
 * 扩展签名工具（开发者用）：
 *   pnpm ext:keygen -- --out .loopsoar-keys
 *   pnpm ext:sign -- ./my-extension --key .loopsoar-keys/extension-key.pem
 *   pnpm ext:verify -- ./my-extension [--trusted <fingerprint|publicKey>]
 *
 * 签名前自动计算并写入 integrity（排除 manifest 自身），因此签名同时覆盖清单与包内容；
 * 私钥只写本地文件，绝不打印到 stdout。
 */
import fs from "node:fs";
import path from "node:path";
import { ExtensionManifestSchema } from "../packages/contracts/dist/src/extension.js";
import {
  fingerprintPublicKey,
  generateSigningKeyPair,
  signExtensionManifest,
  verifyManifestSignature,
} from "../packages/core/dist/extensionSignature.js";
import { computePackageIntegrity } from "../packages/shell/src/main/extensionTrust.js";

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

function keygen(args: string[]): void {
  const out = path.resolve(takeFlag(args, "--out") ?? ".loopsoar-keys");
  fs.mkdirSync(out, { recursive: true });
  const privatePath = path.join(out, "extension-key.pem");
  const publicPath = path.join(out, "extension-key.pub");
  if (fs.existsSync(privatePath)) fail(`私钥已存在，拒绝覆盖：${privatePath}`);
  const pair = generateSigningKeyPair();
  fs.writeFileSync(privatePath, pair.privateKeyPem, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(publicPath, `${pair.publicKey}\n`, "utf8");
  console.log(`私钥：${privatePath}（务必加入 .gitignore，不要提交/外发）`);
  console.log(`公钥：${publicPath}`);
  console.log(`指纹：${pair.fingerprint}`);
  console.log(`公钥(base64)：${pair.publicKey}`);
}

function sign(args: string[]): void {
  const dirArg = args.find((arg) => !arg.startsWith("--") && arg !== args[args.indexOf("--key") + 1]);
  if (!dirArg) fail("用法：ext:sign -- <扩展目录> --key <私钥.pem>");
  const dir = path.resolve(dirArg);
  const keyPath = path.resolve(takeFlag(args, "--key") ?? path.join(dir, "extension-key.pem"));
  if (!fs.existsSync(keyPath)) fail(`找不到私钥：${keyPath}（先运行 ext:keygen）`);
  const manifestPath = path.join(dir, MANIFEST);
  if (!fs.existsSync(manifestPath)) fail(`找不到清单：${manifestPath}`);

  const parsed = ExtensionManifestSchema.safeParse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  if (!parsed.success) fail(`清单不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("；")}`);

  const integrity = computePackageIntegrity(dir);
  const unsigned = { ...parsed.data, integrity, signature: undefined };
  const signed = signExtensionManifest(unsigned, fs.readFileSync(keyPath, "utf8"));
  const { signature, ...rest } = signed;
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...rest, signature }, null, 2)}\n`, "utf8");

  const fingerprint = signature ? fingerprintPublicKey(signature.publicKey) : "";
  console.log(`已签名：${signed.id}@${signed.version}`);
  console.log(`integrity：${integrity}`);
  console.log(`指纹：${fingerprint}`);
  console.log("下一步：把公钥指纹发给用户信任，或运行 ext:verify 校验。");
}

function verify(args: string[]): void {
  const dirArg = args.find((arg) => !arg.startsWith("--") && arg !== args[args.indexOf("--trusted") + 1]);
  if (!dirArg) fail("用法：ext:verify -- <扩展目录> [--trusted <fingerprint|publicKey>]");
  const dir = path.resolve(dirArg);
  const manifestPath = path.join(dir, MANIFEST);
  if (!fs.existsSync(manifestPath)) fail(`找不到清单：${manifestPath}`);
  const parsed = ExtensionManifestSchema.safeParse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  if (!parsed.success) fail(`清单不合法：${parsed.error.issues.map((issue) => issue.message).join("；")}`);

  const actual = computePackageIntegrity(dir);
  const integrityOk = !parsed.data.integrity || parsed.data.integrity === actual;
  let trusted: string | undefined;
  const requested = takeFlag(args, "--trusted");
  if (requested) {
    // 允许直接给公钥文件/公钥 base64/指纹三种形式。
    const material = fs.existsSync(requested) ? fs.readFileSync(requested, "utf8").trim() : requested;
    trusted = material.startsWith("sha256:") ? material : fingerprintPublicKey(material);
  }
  const trust = verifyManifestSignature(parsed.data, new Set(trusted ? [trusted] : []));
  console.log(`扩展：${parsed.data.id}@${parsed.data.version}`);
  console.log(`签名：${trust.status}${trust.fingerprint ? `（${trust.fingerprint}）` : ""}`);
  console.log(`内容摘要：${integrityOk ? "OK" : `不匹配（清单 ${parsed.data.integrity}，实际 ${actual}）`}`);
  if (trust.status === "invalid" || !integrityOk) process.exit(1);
  if (trust.status === "untrusted") console.log("提示：签名有效但公钥未被信任；安装时需用户确认。");
  if (trust.status === "unsigned") console.log("提示：未签名；strict 策略下不可安装。");
}

const [command, ...rest] = process.argv.slice(2);
if (command === "keygen") keygen(rest);
else if (command === "sign") sign(rest);
else if (command === "verify") verify(rest);
else {
  console.log("用法：");
  console.log("  extension-sign.ts keygen --out <目录>");
  console.log("  extension-sign.ts sign <扩展目录> --key <私钥.pem>");
  console.log("  extension-sign.ts verify <扩展目录> [--trusted <fingerprint|publicKey>]");
  process.exit(command ? 1 : 0);
}
