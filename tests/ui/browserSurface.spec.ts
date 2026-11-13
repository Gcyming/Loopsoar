/**
 * 浏览器加载/失败页分类（BrowserSurface 纯函数）。
 *
 * Chromium net error code → 用户可理解类别；-3 由 shell 过滤，分类器仍按 generic 兜底。
 */
import { describe, expect, it } from "vitest";
import { classifyLoadFailure, type BrowserLoadFailureInfo } from "../../packages/ui/src/browserFailure.ts";

function failure(partial: Partial<BrowserLoadFailureInfo>): BrowserLoadFailureInfo {
  return { code: 0, description: "", url: "https://example.com/", ...partial };
}

describe("classifyLoadFailure", () => {
  it("按 Chromium net error 分类：离线/域名/拒绝/超时/证书/拦截", () => {
    expect(classifyLoadFailure(failure({ code: -106, description: "ERR_INTERNET_DISCONNECTED" }))).toBe("offline");
    expect(classifyLoadFailure(failure({ code: -105, description: "ERR_NAME_NOT_RESOLVED" }))).toBe("dns");
    expect(classifyLoadFailure(failure({ code: -102, description: "ERR_CONNECTION_REFUSED" }))).toBe("refused");
    expect(classifyLoadFailure(failure({ code: -7, description: "ERR_TIMED_OUT" }))).toBe("timeout");
    expect(classifyLoadFailure(failure({ code: -202, description: "ERR_CERT_AUTHORITY_INVALID" }))).toBe("ssl");
    expect(classifyLoadFailure(failure({ code: -20, description: "ERR_BLOCKED_BY_CLIENT" }))).toBe("blocked");
  });

  it("未知错误归入 generic；描述可兜底分类", () => {
    expect(classifyLoadFailure(failure({ code: -999 }))).toBe("generic");
    expect(classifyLoadFailure(failure({ code: 0, description: "net::ERR_NAME_NOT_RESOLVED" }))).toBe("dns");
    expect(classifyLoadFailure(failure({ code: 0, description: "ERR_TIMEOUT" }))).toBe("timeout");
  });
});
