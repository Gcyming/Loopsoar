/**
 * 供应商编辑表格的 token 单位回归：
 *   - 用户看到/编辑的是实际 token 数（不是 K），避免 1048576 被四舍五入成 1049K 后再保存；
 *   - 保存前本地校验给出可操作提示，而不是把裸 IPC too_big 直接丢给用户。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { findProviderTokenLimitIssue, parseProviderTokenInput, PROVIDER_MODEL_TOKEN_LIMIT } from "../../packages/ui/src/modelGroups.ts";
import { SETTINGS_I18N } from "../../packages/ui/src/i18nSettings.ts";

const ROOT = process.cwd();
const settings = fs.readFileSync(path.join(ROOT, "packages/ui/src/Settings.tsx"), "utf8");

describe("供应商模型 token 输入", () => {
  it("直接解析实际 token 数，不再乘 1000", () => {
    expect(parseProviderTokenInput("1000000")).toBe(1_000_000);
    expect(parseProviderTokenInput("1048576")).toBe(1_048_576);
    expect(parseProviderTokenInput("1000")).toBe(1000);
    expect(parseProviderTokenInput("")).toBeUndefined();
    expect(parseProviderTokenInput("abc")).toBeUndefined();
  });

  it("接受二进制百万值，超过 10M 的值给出可定位的字段", () => {
    expect(findProviderTokenLimitIssue([{ id: "a", maxOutput: 1_048_576 }])).toBeNull();
    expect(findProviderTokenLimitIssue([{ id: "a", contextWindow: 10_000_000 }])).toBeNull();
    expect(findProviderTokenLimitIssue([{ id: "a", maxOutput: PROVIDER_MODEL_TOKEN_LIMIT + 1 }])).toMatchObject({
      id: "a",
      field: "maxOutput",
      max: PROVIDER_MODEL_TOKEN_LIMIT,
    });
    expect(findProviderTokenLimitIssue([{ id: "a", contextWindow: -1 }])).toMatchObject({ field: "contextWindow" });
  });

  it("表格不再把输入值乘 1000，并使用 tokens 列名", () => {
    expect(settings).not.toContain("maxOutput / 1000");
    expect(settings).not.toContain("contextWindow / 1000");
    expect(settings).toContain("settings.providers.col.context");
    expect(settings).toContain("settings.providers.col.output");
    expect(settings).toContain("parseProviderTokenInput");
    expect(settings).toContain("findProviderTokenLimitIssue");
  });

  it("中英文提示强调实际 token 数而不是 K", () => {
    expect(SETTINGS_I18N["settings.providers.tokenUnitHint"].zh).toContain("不是 K");
    expect(SETTINGS_I18N["settings.providers.tokenUnitHint"].en).toContain("not K");
    expect(SETTINGS_I18N["settings.providers.tokenLimitError"].zh).toContain("{max}");
    expect(SETTINGS_I18N["settings.providers.tokenLimitError"].en).toContain("{max}");
  });
});
