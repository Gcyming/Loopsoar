/**
 * 浏览器分区 UA：必须是标准 Chrome，不能带 Electron/Loopsoar 标记。
 * 否则 CLisk 这类 WAF 会按「非浏览器客户端」直接 403（下载链接全挂）。
 */
import { describe, expect, it } from "vitest";
import { browserUserAgent } from "../../packages/shell/src/main/browserUserAgent.ts";

describe("browserUserAgent", () => {
  it("输出标准 Chrome UA，且不含 Electron/Loopsoar 标记", () => {
    const ua = browserUserAgent();
    expect(ua).toMatch(
      /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/537\.36$/,
    );
    expect(ua).not.toMatch(/Electron|Loopsoar/i);
  });
});
