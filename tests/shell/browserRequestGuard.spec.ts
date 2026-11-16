/**
 * 浏览器请求守卫（packages/shell/src/main/browserRequestGuard.ts）：表驱动 URL 策略 + DNS 校验缓存。
 * 纯逻辑测试：不启 electron、不联网（DNS 解析全部用注入桩）。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  browserRequestHost,
  createBrowserRequestChecker,
  createBrowserRequestPolicy,
  isLoopbackTarget,
  setAgentTabPredicate,
  shouldBlockAgentLoopback,
} from "../../packages/shell/src/main/browserRequestGuard.ts";

describe("浏览器请求策略 · 协议与主机名", () => {
  const policy = createBrowserRequestPolicy();

  it.each([
    // 允许：常规公网 http/https/ws/wss
    ["https://example.com/", "allow"],
    ["http://example.com/path?a=1", "allow"],
    ["https://example.com:8080/api", "allow"],
    ["ws://example.com/socket", "allow"],
    ["wss://example.com/socket", "allow"],
    // 拦截：非标准 scheme
    ["ftp://example.com/file", "block"],
    ["file:///C:/Windows/win.ini", "block"],
    ["data:text/html,<script>", "block"],
    ["javascript:alert(1)", "block"],
    // DevTools 前端 / 扩展内部资源：放行（否则 F12 与扩展资源会被误杀）
    ["devtools://devtools/bundled/inspector.html", "allow"],
    ["chrome-extension://abcdefghijklmnop/page.html", "allow"],
    // 拦截：内部主机名
    ["http://localhost/", "allow"], // 默认放行回环（E2E/本地页面）
    ["http://metadata.google.internal/", "block"],
    ["http://printer.local/", "block"],
    ["http://intranet/", "block"],
    ["http://user:pw@example.com/", "block"],
    // 拦截：私网/保留 IP
    ["http://10.0.0.1/", "block"],
    ["http://172.16.0.1/", "block"],
    ["http://192.168.1.5/", "block"],
    ["http://169.254.169.254/latest/meta-data", "block"],
    ["http://100.64.0.1/", "block"],
    ["http://[::1]/", "allow"],
    ["http://[fe80::1]/", "block"],
    ["http://[fd00::1]/", "block"],
    ["http://127.0.0.1:5173/", "allow"],
    ["http://127.0.0.1:11434/v1", "allow"],
  ])("%s → %s", (url, expected) => {
    expect(policy(url).action).toBe(expected);
  });

  it("拦截结果带可读原因", () => {
    const blocked = policy("http://192.168.1.5/");
    expect(blocked.action).toBe("block");
    expect(blocked.reason).toMatch(/私网|保留/);

    const scheme = policy("ftp://example.com/");
    expect(scheme.reason).toMatch(/协议/);

    const hostname = policy("http://intranet/");
    expect(hostname.reason).toMatch(/内部主机名/);
  });

  it("无法解析的 URL → 拦截（fail-closed）", () => {
    expect(policy("::not a url::").action).toBe("block");
    expect(policy("").action).toBe("block");
  });

  it("allowLoopback=false 时回环也拦截", () => {
    const strict = createBrowserRequestPolicy({ allowLoopback: false });
    expect(strict("http://127.0.0.1:5173/").action).toBe("block");
    expect(strict("http://localhost:3000/").action).toBe("block");
    expect(strict("http://[::1]/").action).toBe("block");
    expect(strict("https://example.com/").action).toBe("allow");
  });

  it("browserRequestHost 只提取 host（不泄露查询参数）", () => {
    expect(browserRequestHost("https://example.com/a?token=secret")).toBe("example.com");
    expect(browserRequestHost("http://[::1]:8080/")).toBe("[::1]");
    expect(browserRequestHost("not a url")).toBe("(无法解析的 URL)");
  });
});

describe("浏览器请求策略 · LOOPSOAR_STRICT_NET=1 严格模式", () => {
  const previous = process.env.LOOPSOAR_STRICT_NET;
  afterEach(() => {
    if (previous === undefined) delete process.env.LOOPSOAR_STRICT_NET;
    else process.env.LOOPSOAR_STRICT_NET = previous;
  });

  it("严格模式不再放行回环", () => {
    process.env.LOOPSOAR_STRICT_NET = "1";
    const policy = createBrowserRequestPolicy();
    expect(policy("http://127.0.0.1:5173/").action).toBe("block");
    expect(policy("http://localhost:11434/v1").action).toBe("block");
    expect(policy("http://[::1]/").action).toBe("block");
    expect(policy("https://example.com/").action).toBe("allow");
  });
});

describe("浏览器请求校验器 · DNS 校验与缓存", () => {
  const publicResolver = (calls: string[], ips: string[]) => async (host: string): Promise<string[]> => {
    calls.push(host);
    return ips;
  };

  it("策略层已拦截的 URL 不触发 DNS 解析", async () => {
    const calls: string[] = [];
    const check = createBrowserRequestChecker({ resolveIps: publicResolver(calls, ["10.0.0.1"]) });
    const decision = await check("http://intranet/");
    expect(decision.action).toBe("block");
    expect(calls).toHaveLength(0);
  });

  it("域名解析到私网/保留 IP → 拦截", async () => {
    const calls: string[] = [];
    const check = createBrowserRequestChecker({ resolveIps: publicResolver(calls, ["192.168.1.5"]) });
    const decision = await check("http://evil.example.com/");
    expect(decision.action).toBe("block");
    expect(decision.reason).toMatch(/私网|保留/);
    expect(calls).toEqual(["evil.example.com"]);
  });

  it("域名解析到公网 IP → 放行", async () => {
    const check = createBrowserRequestChecker({ resolveIps: async () => ["93.184.216.34"] });
    await expect(check("https://example.com/")).resolves.toEqual({ action: "allow" });
  });

  it("解析为空 / 解析抛错 / 返回非法地址 → 拦截（fail-closed）", async () => {
    const empty = createBrowserRequestChecker({ resolveIps: async () => [] });
    expect((await empty("https://nope.example.com/")).action).toBe("block");

    const thrown = createBrowserRequestChecker({
      resolveIps: async () => {
        throw new Error("dns down");
      },
    });
    expect((await thrown("https://nope.example.com/")).action).toBe("block");

    const malformed = createBrowserRequestChecker({ resolveIps: async () => ["not-an-ip"] });
    expect((await malformed("https://nope.example.com/")).action).toBe("block");
  });

  it("IP 字面量不触发 DNS 解析", async () => {
    const calls: string[] = [];
    const check = createBrowserRequestChecker({ resolveIps: publicResolver(calls, ["10.0.0.1"]) });
    expect((await check("http://8.8.8.8/")).action).toBe("allow");
    expect(calls).toHaveLength(0);
  });

  it("回环 DNS 结果：默认放行；策略禁止回环时拦截", async () => {
    const allow = createBrowserRequestChecker({ resolveIps: async () => ["127.0.0.1"] });
    expect((await allow("http://dev.example.com:5173/")).action).toBe("allow");

    const strict = createBrowserRequestChecker({
      resolveIps: async () => ["127.0.0.1"],
      policy: createBrowserRequestPolicy({ allowLoopback: false }),
    });
    const decision = await strict("http://dev.example.com:5173/");
    expect(decision.action).toBe("block");
    expect(decision.reason).toMatch(/回环/);
  });

  it("混有回环与公网的解析结果 → 拦截（疑似 DNS 重绑定）", async () => {
    const check = createBrowserRequestChecker({ resolveIps: async () => ["127.0.0.1", "93.184.216.34"] });
    const decision = await check("http://evil.example.com/");
    expect(decision.action).toBe("block");
    expect(decision.reason).toMatch(/重绑定|混有/);
  });

  it("同一主机在 TTL 内只解析一次（缓存生效）", async () => {
    const calls: string[] = [];
    const check = createBrowserRequestChecker({ resolveIps: publicResolver(calls, ["93.184.216.34"]) });
    await check("https://example.com/a");
    await check("https://example.com/b");
    expect(calls).toEqual(["example.com"]);
  });

  it("TTL 过期后重新解析", async () => {
    const calls: string[] = [];
    const check = createBrowserRequestChecker({ resolveIps: publicResolver(calls, ["93.184.216.34"]), cacheTtlMs: 0 });
    await check("https://example.com/a");
    await check("https://example.com/b");
    expect(calls).toHaveLength(2);
  });

  it("缓存条目上限生效（LRU 淘汰最旧主机）", async () => {
    const calls: string[] = [];
    const check = createBrowserRequestChecker({
      resolveIps: publicResolver(calls, ["93.184.216.34"]),
      maxCacheEntries: 2,
    });
    await check("https://a.example.com/");
    await check("https://b.example.com/");
    await check("https://c.example.com/"); // 淘汰 a
    await check("https://b.example.com/"); // 命中缓存
    await check("https://a.example.com/"); // a 已被淘汰，需重新解析
    expect(calls).toEqual(["a.example.com", "b.example.com", "c.example.com", "a.example.com"]);
  });

  it("拦截结果同样进缓存（避免同一恶意域名反复解析）", async () => {
    const calls: string[] = [];
    const check = createBrowserRequestChecker({ resolveIps: publicResolver(calls, ["10.0.0.1"]) });
    expect((await check("http://evil.example.com/")).action).toBe("block");
    expect((await check("http://evil.example.com/x")).action).toBe("block");
    expect(calls).toHaveLength(1);
  });
});

describe("Agent 标签回环策略（P0：与 web_fetch 的 allowLoopback:false 对齐）", () => {
  afterEach(() => {
    setAgentTabPredicate(null);
    delete process.env.LOOPSOAR_ALLOW_LOOPBACK;
  });

  it("isLoopbackTarget 识别回环 IP/主机名，公网地址不算", () => {
    expect(isLoopbackTarget("http://127.0.0.1:11434/")).toBe(true);
    expect(isLoopbackTarget("http://localhost:5173/app")).toBe(true);
    expect(isLoopbackTarget("http://[::1]:8080/")).toBe(true);
    expect(isLoopbackTarget("https://example.com/")).toBe(false);
    expect(isLoopbackTarget("不是 URL")).toBe(false);
  });

  it("Agent 标签访问回环被拦；用户标签仍可浏览 localhost", () => {
    setAgentTabPredicate((id) => id === 7);
    // Agent 标签（7）+ 回环 → 拦
    expect(shouldBlockAgentLoopback({ webContentsId: 7, url: "http://127.0.0.1:11434/", allowed: false })).toBe(true);
    // 用户标签（8）→ 放行
    expect(shouldBlockAgentLoopback({ webContentsId: 8, url: "http://127.0.0.1:11434/", allowed: false })).toBe(false);
    // Agent 标签访问公网 → 放行
    expect(shouldBlockAgentLoopback({ webContentsId: 7, url: "https://example.com/", allowed: false })).toBe(false);
  });

  it("显式放开（LOOPSOAR_ALLOW_LOOPBACK=1）时 Agent 也可访问回环", () => {
    setAgentTabPredicate(() => true);
    expect(shouldBlockAgentLoopback({ webContentsId: 7, url: "http://127.0.0.1:11434/", allowed: true })).toBe(false);
    process.env.LOOPSOAR_ALLOW_LOOPBACK = "1";
    expect(shouldBlockAgentLoopback({ webContentsId: 7, url: "http://127.0.0.1:11434/" })).toBe(false);
  });

  it("未注入判定时不影响任何请求（保持用户浏览能力）", () => {
    setAgentTabPredicate(null);
    expect(shouldBlockAgentLoopback({ webContentsId: 7, url: "http://127.0.0.1:11434/", allowed: false })).toBe(false);
  });
});
