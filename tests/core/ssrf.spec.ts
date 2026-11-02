/**
 * SSRF 判据（packages/core/src/net/ssrf.ts）：
 * 15 段私网/保留 CIDR、IPv4/IPv6/IPv4-mapped、主机名黑名单、userinfo、回环开关、DNS 二次校验。
 * 纯函数测试：不联网、不起子进程。
 */
import { describe, expect, it } from "vitest";
import {
  assertPublicHttpUrl,
  assertPublicUrlWithDns,
  isBlockedHostname,
  isIpLiteral,
  isLoopbackHostname,
  isLoopbackIp,
  isPrivateOrReservedIp,
  normalizeIpLiteral,
  SsrfBlockedError,
} from "../../packages/core/src/net/ssrf.ts";
import type { IpResolver } from "../../packages/core/src/net/ssrf.ts";

describe("SSRF · 契约 15 段 CIDR（IPv4）", () => {
  it.each([
    // [IP, 是否私网/保留]
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["9.255.255.255", false],
    ["11.0.0.1", false],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.255.255", false],
    ["172.32.0.1", false],
    ["192.168.1.5", true],
    ["192.167.255.255", false],
    ["192.169.0.1", false],
    ["169.254.1.1", true],
    ["169.253.255.255", false],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["126.255.255.255", false],
    ["0.0.0.0", true],
    ["0.255.255.255", true],
    ["1.0.0.0", false],
    ["100.64.0.1", true],
    ["100.127.255.255", true],
    ["100.63.255.255", false],
    ["100.128.0.1", false],
    ["192.0.0.1", true],
    ["192.0.1.1", false],
    ["192.0.2.1", true],
    ["198.18.0.1", true],
    ["198.19.255.255", true],
    ["198.20.0.1", false],
    ["198.51.100.7", true],
    ["203.0.113.9", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["223.5.5.5", false],
  ])("%s → 危险=%s", (ip, expected) => {
    expect(isPrivateOrReservedIp(ip)).toBe(expected);
  });

  it("组播/保留尾段兜底拦截（契约 15 段之外）", () => {
    expect(isPrivateOrReservedIp("224.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("239.255.255.250")).toBe(true);
    expect(isPrivateOrReservedIp("240.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("255.255.255.255")).toBe(true);
  });

  it("非法 IP 串 fail-closed（视为危险）", () => {
    for (const bad of ["", "not-an-ip", "10.0.0", "10.0.0.256", "300.1.1.1", "::zz"]) {
      expect(isPrivateOrReservedIp(bad)).toBe(true);
    }
  });
});

describe("SSRF · IPv6 与映射地址", () => {
  it.each([
    ["::1", true],
    ["0:0:0:0:0:0:0:1", true],
    ["fc00::1", true],
    ["fdff:ffff::1", true],
    ["fe80::1", true],
    ["febf::1", true],
    ["2001:4860:4860::8888", false],
    ["2606:4700::1111", false],
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.1.2.3", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:8.8.8.8", false],
    ["::127.0.0.1", true], // 废弃的 IPv4-compatible 写法：按 IPv4 判定
    ["::", true], // unspecified 不是合法抓取目标
  ])("%s → 危险=%s", (ip, expected) => {
    expect(isPrivateOrReservedIp(ip)).toBe(expected);
  });

  it("带方括号与 zone id 的写法同样判定", () => {
    expect(isPrivateOrReservedIp("[::1]")).toBe(true);
    expect(isPrivateOrReservedIp("[fe80::1%25eth0]".replace("%25", "%"))).toBe(true);
  });

  it("自定义网段参数生效（默认参数可覆盖）", () => {
    const custom = [{ v: 4 as const, base: [1, 2, 3, 0] as const, prefix: 24 }];
    expect(isPrivateOrReservedIp("1.2.3.4", custom)).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8", custom)).toBe(false);
  });
});

describe("SSRF · 回环识别与 IP 字面量", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.8.8.8", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["8.8.8.8", false],
    ["::2", false],
    ["not-an-ip", false],
  ])("isLoopbackIp(%s) → %s", (ip, expected) => {
    expect(isLoopbackIp(ip)).toBe(expected);
  });

  it("IP 字面量分流（v4/v6/方括号）", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("intranet")).toBe(false);
  });

  it("normalizeIpLiteral 输出可直接用于连接（IPv6 压缩、不带方括号）", () => {
    expect(normalizeIpLiteral("::ffff:127.0.0.1")).toBe("::ffff:7f00:1");
    expect(normalizeIpLiteral("[0:0:0:0:0:0:0:1]")).toBe("::1");
    expect(normalizeIpLiteral("8.8.8.8")).toBe("8.8.8.8");
    expect(normalizeIpLiteral("nope")).toBeNull();
  });
});

describe("SSRF · 主机名黑名单", () => {
  it.each([
    ["localhost", true],
    ["localhost.", true],
    ["LOCALHOST", true],
    ["app.localhost", true],
    ["printer.local", true],
    ["metadata.google.internal", true],
    ["metadata", true],
    ["instance-data", true],
    ["intranet", true],
    ["example.com", false],
    ["api.openai.com", false],
    ["127.0.0.1", false], // IP 字面量交给 IP 判定
    ["[::1]", false],
  ])("isBlockedHostname(%s) → %s", (host, expected) => {
    expect(isBlockedHostname(host)).toBe(expected);
  });

  it("isLoopbackHostname 只认同回环名", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("x.localhost")).toBe(true);
    expect(isLoopbackHostname("localhost.example.com")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
  });
});

describe("SSRF · assertPublicHttpUrl（同步 URL 判据）", () => {
  const expectBlocked = (rawUrl: string, opts?: { allowLoopback?: boolean }): void => {
    expect(() => assertPublicHttpUrl(rawUrl, opts)).toThrow(SsrfBlockedError);
  };

  it("公网 http/https 放行（含常规端口）", () => {
    expect(assertPublicHttpUrl("https://example.com/")).toBeInstanceOf(URL);
    expect(assertPublicHttpUrl("http://example.com/a?b=1")).toBeInstanceOf(URL);
    expect(assertPublicHttpUrl("https://example.com:8080/api")).toBeInstanceOf(URL);
    expect(assertPublicHttpUrl("https://example.com:8443/api")).toBeInstanceOf(URL);
  });

  it("仅允许 http/https", () => {
    for (const bad of ["ftp://example.com/x", "file:///C:/secret.txt", "ws://example.com/s", "javascript:alert(1)"]) {
      expectBlocked(bad);
    }
  });

  it("拒绝 userinfo", () => {
    expectBlocked("http://user:pw@example.com/");
    expect(() => assertPublicHttpUrl("http://user:pw@example.com/")).toThrow(/userinfo/);
  });

  it("拒绝内部主机名与私网 IP", () => {
    for (const bad of [
      "http://localhost/",
      "http://intranet/",
      "http://printer.local/",
      "http://metadata.google.internal/",
      "http://10.0.0.1/",
      "http://192.168.1.5/",
      "http://169.254.169.254/latest/meta-data",
      "http://127.0.0.1:8080/",
      "http://[::1]:8080/",
      "http://[fe80::1]/",
    ]) {
      expectBlocked(bad);
    }
  });

  it("非白名单端口拒绝（公网目标）", () => {
    expectBlocked("https://example.com:3000/");
    expect(() => assertPublicHttpUrl("https://example.com:3000/")).toThrow(/端口/);
  });

  it("allowLoopback=true 时放行 127.0.0.1 / ::1 / localhost（任意端口）", () => {
    expect(assertPublicHttpUrl("http://127.0.0.1:11434/v1", { allowLoopback: true })).toBeInstanceOf(URL);
    expect(assertPublicHttpUrl("http://localhost:12345/", { allowLoopback: true })).toBeInstanceOf(URL);
    expect(assertPublicHttpUrl("http://[::1]:51234/", { allowLoopback: true })).toBeInstanceOf(URL);
    // 但其他私网仍拒绝（回环开的是"本机"，不是"内网"）
    expectBlocked("http://10.0.0.1/", { allowLoopback: true });
    expectBlocked("http://192.168.1.5/", { allowLoopback: true });
    expectBlocked("http://169.254.169.254/", { allowLoopback: true });
  });

  it("错误信息以「SSRF 拦截：」开头（可直接展示给用户）", () => {
    try {
      assertPublicHttpUrl("http://10.0.0.1/");
      throw new Error("应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      expect((err as Error).message).toMatch(/^SSRF 拦截：/);
    }
  });
});

describe("SSRF · assertPublicUrlWithDns（DNS 二次校验）", () => {
  const resolverOf = (ips: string[]): IpResolver => async () => ips;

  it("解析到私网/保留 IP → 拒绝（任一命中即拒）", async () => {
    await expect(assertPublicUrlWithDns("http://evil.example.com/", resolverOf(["10.1.2.3"]))).rejects.toThrow(/SSRF/);
    await expect(assertPublicUrlWithDns("http://evil.example.com/", resolverOf(["93.184.216.34", "192.168.1.5"]))).rejects.toThrow(
      /私网/,
    );
    await expect(assertPublicUrlWithDns("http://evil.example.com/", resolverOf(["::ffff:169.254.169.254"]))).rejects.toThrow(
      /私网/,
    );
  });

  it("解析结果为空 → 拒绝（fail-closed）", async () => {
    await expect(assertPublicUrlWithDns("http://nope.example.com/", resolverOf([]))).rejects.toThrow(/无法解析/);
    const throwing: IpResolver = async () => {
      throw new Error("dns down");
    };
    await expect(assertPublicUrlWithDns("http://nope.example.com/", throwing)).rejects.toThrow(/无法解析/);
  });

  it("公网 IP 放行并返回规范化 IP 列表", async () => {
    const result = await assertPublicUrlWithDns("http://example.com/", resolverOf(["93.184.216.34", "2606:2800:220:1::1"]));
    expect(result.url.hostname).toBe("example.com");
    expect(result.ips).toEqual(["93.184.216.34", "2606:2800:220:1::1"]);
  });

  it("回环解析：默认拒绝，allowLoopback=true 放行", async () => {
    await expect(assertPublicUrlWithDns("http://localhost:9999/", resolverOf(["127.0.0.1"]))).rejects.toThrow(/回环/);
    const allowed = await assertPublicUrlWithDns("http://localhost:9999/", resolverOf(["127.0.0.1"]), {
      allowLoopback: true,
    });
    expect(allowed.ips).toEqual(["127.0.0.1"]);
  });

  it("IP 字面量目标不做 DNS 解析，直接返回该 IP", async () => {
    let resolved = false;
    const resolver: IpResolver = async () => {
      resolved = true;
      return [];
    };
    const literal = await assertPublicUrlWithDns("http://8.8.8.8/", resolver);
    expect(resolved).toBe(false);
    expect(literal.ips).toEqual(["8.8.8.8"]);
  });
});
