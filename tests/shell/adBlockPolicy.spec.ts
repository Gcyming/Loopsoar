/**
 * 广告/追踪请求拦截（packages/shell/src/main/browserRequestGuard.ts）：
 * 契约后缀/片段匹配、默认开关、动态关闭、与 SSRF 拦截的优先级。
 * 纯函数 + 假 DNS，不联网、不启 Electron。
 */
import { describe, expect, it } from "vitest";
import {
  AD_BLOCK_HOST_SUFFIXES,
  AD_BLOCK_URL_PATTERNS,
} from "../../packages/contracts/src/security-policy.ts";
import {
  createBrowserRequestChecker,
  createBrowserRequestPolicy,
  matchAdBlockUrl,
} from "../../packages/shell/src/main/browserRequestGuard.ts";

describe("广告拦截 · 域名后缀匹配", () => {
  it("契约中的每个后缀：根域名与子域都命中", () => {
    for (const suffix of AD_BLOCK_HOST_SUFFIXES) {
      expect(matchAdBlockUrl(`https://${suffix}/x`), suffix).toEqual({ kind: "host", detail: suffix });
      expect(matchAdBlockUrl(`https://sub.${suffix}/x`), `sub.${suffix}`).toEqual({ kind: "host", detail: suffix });
    }
  });

  it("常见广告/追踪域名命中（含子域）", () => {
    for (const host of [
      "doubleclick.net",
      "ads.doubleclick.net",
      "securepubads.g.doubleclick.net",
      "www.googletagmanager.com",
      "www.google-analytics.com",
      "amazon-adsystem.com",
      "static.criteo.net",
      "ib.adnxs.com",
    ]) {
      const match = matchAdBlockUrl(`https://${host}/anything.js`);
      expect(match?.kind, host).toBe("host");
    }
  });

  it("不做无边界误杀（notdoubleclick.net / 后缀出现在前缀里不算）", () => {
    expect(matchAdBlockUrl("https://notdoubleclick.net/x")).toBeNull();
    expect(matchAdBlockUrl("https://doubleclick.net.example.com/x")).toBeNull();
    expect(matchAdBlockUrl("https://example.com/x")).toBeNull();
  });
});

describe("广告拦截 · URL 片段匹配", () => {
  it("契约中的每个片段都能命中对应的 URL", () => {
    for (const pattern of AD_BLOCK_URL_PATTERNS) {
      const match = matchAdBlockUrl(`https://cdn.example.com${pattern}banner.js`);
      expect(match, pattern).toEqual({ kind: "url", detail: pattern });
    }
  });

  it("查询串参与匹配（/collect?v=）", () => {
    const match = matchAdBlockUrl("https://stats.example.com/collect?v=1&t=pageview");
    expect(match).toEqual({ kind: "url", detail: "/collect?v=" });
  });

  it("普通公网路径不误杀", () => {
    for (const url of [
      "https://example.com/",
      "https://example.com/news/2026/02/02.html",
      "https://example.com/api?format=json",
      "https://example.com/download/collect",
    ]) {
      expect(matchAdBlockUrl(url), url).toBeNull();
    }
  });

  it("IP 字面量/非常规 scheme/无法解析的 URL 不参与广告判定", () => {
    expect(matchAdBlockUrl("http://1.2.3.4/ads/x")).toBeNull();
    expect(matchAdBlockUrl("http://[::1]/ads/x")).toBeNull();
    expect(matchAdBlockUrl("ftp://doubleclick.net/x")).toBeNull();
    expect(matchAdBlockUrl("not a url")).toBeNull();
    expect(matchAdBlockUrl("")).toBeNull();
  });
});

describe("广告拦截 · createBrowserRequestPolicy 开关", () => {
  it("默认开启：广告/追踪请求被拦截并标注 kind=adblock", () => {
    const policy = createBrowserRequestPolicy();
    const hostDecision = policy("https://ads.doubleclick.net/pixel.gif");
    expect(hostDecision.action).toBe("block");
    expect(hostDecision.kind).toBe("adblock");
    expect(hostDecision.reason).toMatch(/广告\/追踪/);

    const urlDecision = policy("https://www.example.com/gtag/js?id=G-1");
    expect(urlDecision.action).toBe("block");
    expect(urlDecision.kind).toBe("adblock");

    // 正常公网页面不受影响
    expect(policy("https://example.com/")).toEqual({ action: "allow" });
  });

  it("adBlock=false 完全跳过广告判定；adBlock=()=>false 同理", () => {
    const fixed = createBrowserRequestPolicy({ adBlock: false });
    expect(fixed("https://ads.doubleclick.net/x").action).toBe("allow");

    const dynamic = createBrowserRequestPolicy({ adBlock: () => false });
    expect(dynamic("https://ads.doubleclick.net/x").action).toBe("allow");
  });

  it("动态开关：函数每次请求读取最新值（设置改完即时生效）", () => {
    let enabled = true;
    const policy = createBrowserRequestPolicy({ adBlock: () => enabled });
    expect(policy("https://ads.doubleclick.net/x").action).toBe("block");
    enabled = false;
    expect(policy("https://ads.doubleclick.net/x").action).toBe("allow");
    enabled = true;
    expect(policy("https://ads.doubleclick.net/x").action).toBe("block");
  });

  it("SSRF 拦截优先于广告拦截（内网地址的 reason 不是广告原因）", () => {
    const policy = createBrowserRequestPolicy();
    const decision = policy("http://192.168.1.5/ads/x");
    expect(decision.action).toBe("block");
    expect(decision.kind).toBeUndefined();
    expect(decision.reason).toMatch(/私网|保留/);
  });

  it("回环放行不受广告规则影响（localhost 不在后缀表，且回环在广告判定之前放行）", () => {
    const policy = createBrowserRequestPolicy();
    expect(policy("http://127.0.0.1:5173/").action).toBe("allow");
    expect(policy("http://localhost:3000/analytics.js").action).toBe("allow");
  });
});

describe("广告拦截 · checker 集成", () => {
  it("广告请求在同步策略层就被拦截，不触发 DNS 解析", async () => {
    const calls: string[] = [];
    const check = createBrowserRequestChecker({
      resolveIps: async (host) => {
        calls.push(host);
        return ["93.184.216.34"];
      },
    });
    const decision = await check("https://ads.doubleclick.net/track");
    expect(decision.action).toBe("block");
    expect(decision.kind).toBe("adblock");
    expect(calls).toHaveLength(0);
  });

  it("adBlock=false 时广告域名进入 DNS 校验并放行（公网 IP）", async () => {
    const calls: string[] = [];
    const check = createBrowserRequestChecker({
      resolveIps: async (host) => {
        calls.push(host);
        return ["93.184.216.34"];
      },
      adBlock: false,
    });
    const decision = await check("https://ads.doubleclick.net/track");
    expect(decision).toEqual({ action: "allow" });
    expect(calls).toEqual(["ads.doubleclick.net"]);
  });

  it("注入自定义 policy 时 checker 的 adBlock 选项不生效（policy 优先）", async () => {
    const policy = createBrowserRequestPolicy({ adBlock: false });
    const check = createBrowserRequestChecker({
      resolveIps: async () => ["93.184.216.34"],
      policy,
      adBlock: true,
    });
    expect((await check("https://ads.doubleclick.net/track")).action).toBe("allow");
  });
});
