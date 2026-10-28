/**
 * SSRF 检测：13 段私网 CIDR 命中 + 公网放行 + 协议白名单。
 */
import { describe, expect, it } from "vitest";
import { ssrfCheckIp, safeFetch } from "../../packages/core/src/websearch/index.ts";
import type { NetAdapter } from "../../packages/core/src/platform/types.ts";

describe("SSRF 防护", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.5", true],
    ["169.254.1.1", true],
    ["127.0.0.1", true],
    ["0.0.0.0", true],
    ["100.64.0.1", true],
    ["192.0.2.1", true],
    ["198.18.0.1", true],
    ["198.51.100.7", true],
    ["203.0.113.9", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["223.5.5.5", false],
  ])("IPv4 %s → %s", (ip, expected) => {
    expect(ssrfCheckIp(ip)).toBe(expected);
  });

  it.each([
    ["::1", true],
    ["fc00::1", true],
    ["fe80::1", true],
    ["2001:4860:4860::8888", false],
  ])("IPv6 %s → %s", (ip, expected) => {
    expect(ssrfCheckIp(ip)).toBe(expected);
  });

  it("非 http/https 协议被拒绝", async () => {
    await expect(safeFetch("ftp://example.com/x")).rejects.toThrow(/http/);
  });

  it("DNS 解析到私网 IP → 拒绝（注入 net 适配器）", async () => {
    const fakeNet: NetAdapter = {
      resolveIps: async () => ["10.1.2.3"],
      fetchText: async () => {
        throw new Error("不应到达 fetch");
      },
    };
    await expect(
      safeFetch("http://evil.example.com/", {}, { net: fakeNet }),
    ).rejects.toThrow(/SSRF/);
  });

  it("公网 IP 放行（fetch 正常调用）", async () => {
    let called = false;
    const fakeNet: NetAdapter = {
      resolveIps: async () => ["93.184.216.34"],
      fetchText: async () => {
        called = true;
        return { status: 200, finalUrl: "http://example.com/", text: "ok" };
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const r = await safeFetch("http://example.com/", {}, { net: fakeNet });
      expect(r.status).toBe(200);
      expect(called).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
