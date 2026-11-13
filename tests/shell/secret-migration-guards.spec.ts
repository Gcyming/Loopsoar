/**
 * 密钥关联守卫（用户 2026-11-10：「我给的密钥都是有订阅的」「绝对是密钥方面的大问题」）。
 *
 * 根因：旧版切模型会 upsert 出重复供应商（如 opencode-go-2）；用户把新 Key 保存在副本上，
 * 之后 dedupe 合并副本只保留首条 id，**密钥留在孤儿副本 id 上**，聊天按保留 id 取旧 Key
 * → 上游 403「无订阅」；同时「测试连接」用活动供应商的 Key，切 Key 后也显示 403 → 双重误判。
 *
 * 本文件锁定修复的四个接点，防止回退：
 *   1) ProviderStore 去重合并时必须把 alias 交给装配层（onAliases）；
 *   2) 装配层在 ProviderStore 之前建好 SecretStore，并按 updatedAt 迁移密钥到保留 id；
 *   3) upsert 绝不复活已合并的副本 id（同 provider+端点复用现存 id）；
 *   4) 保存/切换 Key 后立刻用「用户输入的那把」真实验证。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("密钥迁移接线（ProviderStore dedupe alias → SecretStore）", () => {
  it("SecretStore 先于 ProviderStore 创建，并注入 onAliases 迁移回调", () => {
    const index = read("packages/shell/src/main/index.ts");
    const secretsPos = index.indexOf("const secrets = new SecretStore(");
    const providersPos = index.indexOf("new ProviderStore(");
    expect(secretsPos).toBeGreaterThan(0);
    expect(providersPos).toBeGreaterThan(0);
    expect(secretsPos).toBeLessThan(providersPos);
    expect(index).toContain("onAliases: migrateAliasedSecrets");
    expect(index).toContain("secrets.meta(from)");
    expect(index).toContain("secrets.set(to, key)");
  });

  it("历史孤儿副本（opencode-go-2 之类）在启动时按后缀归并", () => {
    const index = read("packages/shell/src/main/index.ts");
    expect(index).toContain("reconcileOrphanSecrets");
    expect(index).toContain("secret reconciled");
    const callPos = index.indexOf("reconcileOrphanSecrets();");
    const llmPos = index.indexOf("= buildLlmFromActive()");
    expect(callPos).toBeGreaterThan(0);
    expect(llmPos).toBeGreaterThan(callPos);
  });

  it("ProviderStore.load 会把 alias 交给回调；upsert 复用同端点现存 id", () => {
    const store = read("packages/shell/src/main/providerStore.ts");
    expect(store).toContain("this.onAliases?.(alias)");
    expect(store).toContain("sameEndpoint");
    expect(store).toContain("绝不复活副本 id");
  });
});

describe("保存/切换 Key 后立刻真实验证（用刚输入的 Key）", () => {
  const settings = read("packages/ui/src/Settings.tsx");

  it("编辑弹窗保存：keyInput 作为 apiKey 传给 testProvider 校验，并给出明确结果", () => {
    expect(settings).toContain("apiKey: typedKey");
    expect(settings).toContain("settings.providers.keyVerified");
    expect(settings).toContain("settings.providers.keyVerifyFailed");
  });

  it("「保存密钥」按钮同样用刚输入的 Key 验证（不再用活动供应商的旧 Key）", () => {
    const saveKeyBlock = settings.slice(settings.indexOf("settings.providers.saveKey"), settings.indexOf("settings.providers.saveKey") + 3200);
    expect(saveKeyBlock).toContain("apiKey: typed");
    expect(saveKeyBlock).toContain("testProvider");
  });
});
