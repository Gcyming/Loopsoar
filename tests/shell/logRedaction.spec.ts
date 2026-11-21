/**
 * 日志脱敏回归测试（发布阶段 §4.4/§4.5）：崩溃日志与诊断输出不得出现明文密钥。
 */
import { describe, expect, it } from "vitest";
import { crashLogReplacer, redactDeep, redactText } from "../../packages/shell/src/main/logRedaction.js";

describe("redactText", () => {
  it("抹掉 sk- 形态的密钥", () => {
    expect(redactText("request failed key=sk-abcdefgh12345678")).toContain("sk-[redacted]");
    expect(redactText("request failed key=sk-abcdefgh12345678")).not.toContain("abcdefgh12345678");
  });

  it("抹掉 Bearer token", () => {
    const out = redactText("Authorization: Bearer abc.def.ghi12345678");
    expect(out).toContain("Bearer [redacted]");
    expect(out).not.toContain("abc.def.ghi12345678");
  });

  it("抹掉 apiKey= / token: 形式", () => {
    expect(redactText('{"apiKey":"super-secret-value"}')).not.toContain("super-secret-value");
    expect(redactText("password: hunter2hunter2")).not.toContain("hunter2hunter2");
  });

  it("普通文本原样保留", () => {
    expect(redactText("renderer crashed at loopsoar://app/index.html")).toBe("renderer crashed at loopsoar://app/index.html");
  });
});

describe("crashLogReplacer", () => {
  it("字段名是密钥时整值替换", () => {
    expect(crashLogReplacer("apiKey", "anything-here")).toBe("[redacted]");
    expect(crashLogReplacer("Authorization", "Bearer x")).toBe("[redacted]");
    expect(crashLogReplacer("url", "loopsoar://app")).toBe("loopsoar://app");
  });

  it("redactDeep：嵌套对象里的密钥也被抹掉", () => {
    const out = redactDeep({ headers: { authorization: "Bearer topsecret123" }, url: "sk-abcdefgh12345678" });
    const text = JSON.stringify(out);
    expect(text).not.toContain("topsecret123");
    expect(text).not.toContain("sk-abcdefgh12345678");
    expect(out.url).toBe("sk-[redacted]");
  });
});
