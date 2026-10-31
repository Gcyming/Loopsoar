/**
 * 设置 · 通用偏好 / 权限策略：默认值、校验、搜索引擎 URL。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  searchUrlFor,
} from "../../packages/core/src/preferences.ts";
import {
  DEFAULT_PERMISSIONS,
  mergePermissions,
} from "../../packages/core/src/permissions.ts";

describe("通用偏好", () => {
  it("空输入 → 全部默认值", () => {
    expect(mergePreferences({})).toEqual(DEFAULT_PREFERENCES);
    expect(mergePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it("缺字段补默认、未知字段丢弃", () => {
    const prefs = mergePreferences({ language: "en-US", unknownKey: 1 });
    expect(prefs.language).toBe("en-US");
    expect(prefs.animations).toBe(DEFAULT_PREFERENCES.animations);
    expect("unknownKey" in prefs).toBe(false);
  });

  it("非法枚举值 → 可读错误", () => {
    expect(() => mergePreferences({ animations: "galaxy" })).toThrow(/偏好配置非法/);
    expect(() => mergePreferences({ language: "fr-FR" })).toThrow(/language/);
  });

  it("searchUrlFor：三种引擎生成正确模板", () => {
    expect(searchUrlFor("bing", "loop soare")).toContain("bing.com/search?q=loop%20soare");
    expect(searchUrlFor("google", "x")).toContain("google.com/search?q=x");
    expect(searchUrlFor("duckduckgo", "x")).toContain("duckduckgo.com/?q=x");
  });
});

describe("权限策略", () => {
  it("默认 fail-closed：读放开、写/命令/网络询问、危险始终确认", () => {
    expect(mergePermissions({})).toEqual(DEFAULT_PERMISSIONS);
    expect(DEFAULT_PERMISSIONS.read).toBe("allow");
    expect(DEFAULT_PERMISSIONS.write).toBe("confirm");
    expect(DEFAULT_PERMISSIONS.terminal).toBe("confirm");
    expect(DEFAULT_PERMISSIONS.network).toBe("confirm");
    expect(DEFAULT_PERMISSIONS.confirmDangerousAlways).toBe(true);
  });

  it("非法决策值拒绝", () => {
    expect(() => mergePermissions({ write: "maybe" })).toThrow(/权限配置非法/);
  });

  it("工作目录去空去重（保持顺序）", () => {
    const perms = mergePermissions({ workspaceRoots: [" D:\\a ", "", "D:\\a", "D:\\b"] });
    expect(perms.workspaceRoots).toEqual(["D:\\a", "D:\\b"]);
  });

  it("工作目录数量上限 20", () => {
    const many = Array.from({ length: 21 }, (_, i) => `D:\\w${i}`);
    expect(() => mergePermissions({ workspaceRoots: many })).toThrow(/workspaceRoots/);
  });
});

describe("推理强度偏好", () => {
  it("缺省为空（模型默认），非法类型被拒绝，合法值保留", () => {
    expect(mergePreferences({}).reasoningEffort).toBe("");
    const merged = mergePreferences({ reasoningEffort: "high" });
    expect(merged.reasoningEffort).toBe("high");
    expect(() => mergePreferences({ reasoningEffort: 123 })).toThrow(/偏好配置非法/);
  });
});
