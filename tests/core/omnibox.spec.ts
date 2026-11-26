/**
 * Omnibox 解析：URL vs 搜索词的判定、搜索引擎构造、安全边界（javascript/file 拒绝）。
 */
import { describe, expect, it } from "vitest";
import { buildSearchUrl, isLikelyUrl, resolveOmniboxInput } from "../../packages/contracts/src/omnibox.ts";

describe("buildSearchUrl", () => {
  it("按搜索引擎构造并正确编码", () => {
    expect(buildSearchUrl("天气 北京", "bing")).toBe("https://www.bing.com/search?q=%E5%A4%A9%E6%B0%94%20%E5%8C%97%E4%BA%AC");
    expect(buildSearchUrl("hello world", "google")).toBe("https://www.google.com/search?q=hello%20world");
    expect(buildSearchUrl("hello world", "baidu")).toBe("https://www.baidu.com/s?wd=hello%20world");
  });
});

describe("isLikelyUrl", () => {
  it("域名 / IP / localhost 判定为 URL", () => {
    expect(isLikelyUrl("github.com")).toBe(true);
    expect(isLikelyUrl("example.com/path?x=1")).toBe(true);
    expect(isLikelyUrl("localhost:3000")).toBe(true);
    expect(isLikelyUrl("127.0.0.1:8080")).toBe(true);
    expect(isLikelyUrl("https://example.com")).toBe(true);
  });

  it("含空格 / 纯词 / 中文判定为搜索", () => {
    expect(isLikelyUrl("hello world")).toBe(false);
    expect(isLikelyUrl("天气")).toBe(false);
    expect(isLikelyUrl("hello")).toBe(false);
  });
});

describe("resolveOmniboxInput", () => {
  it("中文/带空格 → 搜索（默认 bing）", () => {
    const r = resolveOmniboxInput("帮我搜索 今天的新闻");
    expect(r.kind).toBe("search");
    if (r.kind === "search") {
      expect(r.engine).toBe("bing");
      expect(r.url).toContain("bing.com/search?q=");
    }
  });

  it("尊重搜索引擎偏好", () => {
    const r = resolveOmniboxInput("loopsoar", "google");
    expect(r.kind).toBe("search");
    if (r.kind === "search") expect(r.url).toContain("google.com/search?q=loopsoar");
  });

  it("域名 → URL（补 https）", () => {
    const r = resolveOmniboxInput("github.com/loopsoar");
    expect(r).toEqual({ kind: "url", url: "https://github.com/loopsoar" });
  });

  it("显式 http/https → URL", () => {
    const r = resolveOmniboxInput("https://example.com/a?b=1");
    expect(r.kind).toBe("url");
    if (r.kind === "url") expect(r.url).toBe("https://example.com/a?b=1");
  });

  it("? 前缀强制搜索", () => {
    const r = resolveOmniboxInput("?github.com");
    expect(r.kind).toBe("search");
    if (r.kind === "search") expect(r.query).toBe("github.com");
  });

  it("危险协议必须被拒绝（不能借搜索入口绕过安全边界）", () => {
    expect(resolveOmniboxInput("javascript:alert(1)").kind).toBe("invalid");
    expect(resolveOmniboxInput("file:///C:/Windows/win.ini").kind).toBe("invalid");
    expect(resolveOmniboxInput("data:text/html,<h1>x</h1>").kind).toBe("invalid");
  });

  it("带冒号的搜索词按搜索处理（不能当未知协议拒绝）", () => {
    const r = resolveOmniboxInput("c: 语言");
    expect(r.kind).toBe("search");
    if (r.kind === "search") expect(r.query).toBe("c: 语言");
    expect(resolveOmniboxInput("note: 今天的安排").kind).toBe("search");
    // 无空格的未知协议仍然是非法（安全边界不放松）
    expect(resolveOmniboxInput("foo:bar").kind).toBe("invalid");
  });

  it("空输入非法", () => {
    expect(resolveOmniboxInput("   ").kind).toBe("invalid");
  });
});
