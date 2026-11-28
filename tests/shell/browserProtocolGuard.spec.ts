import { describe, expect, it } from "vitest";
import { isInTabNavigationAllowed } from "../../packages/shell/src/main/electronBrowser.ts";

describe("标签页内允许的导航协议", () => {
  it("http/https/空白页放行", () => {
    expect(isInTabNavigationAllowed("https://douyin.com")).toBe(true);
    expect(isInTabNavigationAllowed("http://localhost:3000/")).toBe(true);
    expect(isInTabNavigationAllowed("about:blank")).toBe(true);
    expect(isInTabNavigationAllowed("blob:https://a.example/123")).toBe(true);
  });

  it("自定义协议一律拦截（否则交给 Windows 会弹「没有可打开的应用」）", () => {
    expect(isInTabNavigationAllowed("bitbrowser://open?id=1")).toBe(false);
    expect(isInTabNavigationAllowed("mailto:someone@example.com")).toBe(false);
    expect(isInTabNavigationAllowed("file:///C:/Windows/win.ini")).toBe(false);
    expect(isInTabNavigationAllowed("javascript:alert(1)")).toBe(false);
  });

  it("空串与非法串不阻断（交给 Chromium 自己报错）", () => {
    expect(isInTabNavigationAllowed("")).toBe(true);
    expect(isInTabNavigationAllowed("不是网址")).toBe(true);
  });
});
