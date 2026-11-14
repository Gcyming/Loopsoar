/**
 * 设置 · 通用偏好 / 权限策略：默认值、校验、搜索引擎 URL。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  searchUrlFor,
} from "../../packages/core/src/preferences.ts";
import { PreferencesSchema } from "../../packages/contracts/src/schemas.ts";
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
    expect(searchUrlFor("baidu", "x")).toContain("baidu.com/s?wd=x");
    // 旧版本 DuckDuckGo 配置在合并时迁移为 Bing，不应把整份偏好判非法
    expect(mergePreferences({ searchEngine: "duckduckgo" }).searchEngine).toBe("bing");
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

  it("浏览器操作默认 allow：会话「浏览器控制」开关即显式授权，不再每步确认", () => {
    expect(DEFAULT_PERMISSIONS.browser).toBe("allow");
    expect(mergePermissions({}).browser).toBe("allow");
    // 仍然可被用户收紧
    expect(mergePermissions({ browser: "confirm" }).browser).toBe("confirm");
    expect(mergePermissions({ browser: "deny" }).browser).toBe("deny");
    // 与 network 是两档：收紧 browser 不影响 network 的既有默认（反之亦然）
    expect(mergePermissions({ browser: "deny" }).network).toBe("confirm");
    expect(mergePermissions({ network: "allow" }).browser).toBe("allow");
  });

  it("旧配置无 browser 字段 → 迁移为默认 allow，不判整份配置非法", () => {
    // Slice G 之前的 permissions.json 只有四类，直接按旧文件内容合并必须成功
    const legacy = { read: "allow", write: "confirm", terminal: "confirm", network: "confirm", workspaceRoots: [], confirmDangerousAlways: true };
    expect(() => mergePermissions(legacy)).not.toThrow();
    expect(mergePermissions(legacy)).toEqual({ ...legacy, browser: "allow" });
  });

  it("非法决策值拒绝", () => {
    expect(() => mergePermissions({ write: "maybe" })).toThrow(/权限配置非法/);
    expect(() => mergePermissions({ browser: "maybe" })).toThrow(/权限配置非法/);
    expect(() => mergePermissions({ browser: "always" })).toThrow(/browser/);
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

describe("浏览器打开布局偏好（browserOpenLayout）", () => {
  it("缺省为 ask，DEFAULT 可被契约 schema 解析", () => {
    expect(mergePreferences({}).browserOpenLayout).toBe("ask");
    expect(DEFAULT_PREFERENCES.browserOpenLayout).toBe("ask");
    expect(PreferencesSchema.parse(DEFAULT_PREFERENCES)).toEqual(DEFAULT_PREFERENCES);
  });

  it("四个合法值均保留", () => {
    for (const value of ["ask", "docked", "agentWindow", "keep"] as const) {
      expect(mergePreferences({ browserOpenLayout: value }).browserOpenLayout).toBe(value);
    }
  });

  it("未知字符串被拒（与既有非法枚举行为一致）", () => {
    expect(() => mergePreferences({ browserOpenLayout: "popup" })).toThrow(/browserOpenLayout/);
  });
});

describe("推理强度偏好", () => {
  it("缺省为空（模型默认），非法类型被拒绝，合法值保留", () => {
    expect(mergePreferences({}).reasoningEffort).toBe("");
    expect(mergePreferences({}).agentRepeatToolWarn).toBe(5);
    expect(mergePreferences({}).agentRepeatToolStop).toBe(30);
    const merged = mergePreferences({ reasoningEffort: "high" });
    expect(merged.reasoningEffort).toBe("high");
    expect(() => mergePreferences({ reasoningEffort: 123 })).toThrow(/偏好配置非法/);
  });
});
