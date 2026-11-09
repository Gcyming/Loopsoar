/**
 * DNS 钉扎抓取（NodeNetAdapter.request）：同进程 127.0.0.1 HTTP 服务，不联网、不启子进程。
 * 覆盖：allowLoopback 开关、Host 头保持原主机名、3xx 逐跳校验、maxChars 截断、超时分类、fetchText 委托。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { NodeNetAdapter } from "../../packages/core/src/platform/node.ts";

const net = new NodeNetAdapter();
let server: http.Server;
let port = 0;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("hello-loopsoar");
      return;
    }
    if (url === "/echo") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, host: req.headers.host ?? "", body }));
      });
      return;
    }
    if (url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(5000));
      return;
    }
    if (url === "/target") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("target-hit");
      return;
    }
    if (url === "/redirect") {
      res.writeHead(302, { location: "/target" });
      res.end();
      return;
    }
    if (url === "/redirect-private") {
      res.writeHead(302, { location: "http://10.1.2.3/secret" });
      res.end();
      return;
    }
    if (url === "/redirect-loop") {
      res.writeHead(302, { location: "/redirect-loop" });
      res.end();
      return;
    }
    if (url === "/slow") {
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        try {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("late");
        } catch {
          // 客户端已超时断开：忽略
        }
      }, 1500);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  port = address.port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("NodeNetAdapter.request · 回环开关", () => {
  it("allowLoopback=false（默认）拒绝回环目标", async () => {
    await expect(net.request({ url: `${base}/ok`, timeoutMs: 5000 })).rejects.toThrow(/SSRF/);
  });

  it("allowLoopback=true 抓取成功（status/text/finalUrl/headers）", async () => {
    const response = await net.request({ url: `${base}/ok`, allowLoopback: true, timeoutMs: 5000 });
    expect(response.status).toBe(200);
    expect(response.text).toBe("hello-loopsoar");
    expect(response.finalUrl).toBe(`${base}/ok`);
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("localhost 域名：DNS 钉扎到已校验 IP，但 Host 头保持原主机名", async () => {
    const response = await net.request({ url: `http://localhost:${port}/echo`, allowLoopback: true, timeoutMs: 5000 });
    const echo = JSON.parse(response.text) as { method: string; host: string };
    expect(echo.method).toBe("GET");
    expect(echo.host).toBe(`localhost:${port}`);
  });

  it("POST 请求发送 body", async () => {
    const response = await net.request({
      url: `${base}/echo`,
      method: "POST",
      body: JSON.stringify({ ping: 1 }),
      allowLoopback: true,
      timeoutMs: 5000,
    });
    const echo = JSON.parse(response.text) as { method: string; body: string };
    expect(echo.method).toBe("POST");
    expect(echo.body).toBe('{"ping":1}');
  });
});

describe("NodeNetAdapter.request · 重定向与输出上限", () => {
  it("3xx 手动跟随（逐跳重新校验）", async () => {
    const response = await net.request({ url: `${base}/redirect`, allowLoopback: true, timeoutMs: 5000 });
    expect(response.text).toBe("target-hit");
    expect(response.finalUrl.endsWith("/target")).toBe(true);
  });

  it("重定向到私网 → 逐跳校验拦截", async () => {
    await expect(net.request({ url: `${base}/redirect-private`, allowLoopback: true, timeoutMs: 5000 })).rejects.toThrow(
      /SSRF/,
    );
  });

  it("重定向次数超过 MAX_REDIRECTS → 拒绝", async () => {
    await expect(net.request({ url: `${base}/redirect-loop`, allowLoopback: true, timeoutMs: 5000 })).rejects.toThrow(
      /重定向超过最大次数/,
    );
  });

  it("maxChars 截断响应体", async () => {
    const response = await net.request({ url: `${base}/big`, allowLoopback: true, maxChars: 10, timeoutMs: 5000 });
    expect(response.text.length).toBe(10);
    expect(response.text).toBe("xxxxxxxxxx");
  });

  it("超时返回可读错误", async () => {
    await expect(net.request({ url: `${base}/slow`, allowLoopback: true, timeoutMs: 200 })).rejects.toThrow(/超时/);
  });
});

describe("NodeNetAdapter · 其它接口", () => {
  it("fetchText 委托 request（且默认不放宽回环）", async () => {
    await expect(net.fetchText(`${base}/ok`, { timeoutMs: 5000 })).rejects.toThrow(/SSRF/);
    // 公网目标才会走到网络层；这里只断言回环默认被拒，不在测试里发起真实公网请求
  });

  it("resolveIps：本机回环可解析，未知域名返回空数组", async () => {
    const local = await net.resolveIps("localhost");
    expect(local.some((ip) => ip === "127.0.0.1" || ip === "::1")).toBe(true);
    const bogus = await net.resolveIps("no-such-host.invalid");
    // 正常 DNS：.invalid 必须 NXDOMAIN → 空数组。
    // 部分 VPN/代理会劫持 NXDOMAIN，把任意域名解析到保留网段（如 198.18.0.0/15、10/8、127/8）。
    // 安全断言：绝不能把未知域名解析成公网地址；保留网段属于本地劫持特征，放行。
    const reserved =
      /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|198\.(1[89])\.|::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;
    if (bogus.length > 0) {
      expect(
        bogus.every((ip) => reserved.test(ip)),
        `未知域名被解析到公网地址（DNS 劫持风险）：${bogus.join(", ")}`,
      ).toBe(true);
    }
  });

  it("公网目标非白名单端口在连接前就被拒（不发起真实网络请求）", async () => {
    await expect(net.request({ url: "http://example.com:3000/", timeoutMs: 3000 })).rejects.toThrow(/端口/);
  });
});
