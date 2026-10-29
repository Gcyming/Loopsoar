/** 错误清洗：多层转义 JSON → 可读一句话；超长截断。 */
import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../../packages/shell/src/main/domains/chat.ts";

describe("sanitizeErrorMessage", () => {
  it("提取嵌套 error.message（多层转义）", () => {
    const raw = String.raw`完成: error: HTTP 400: {\"error\":{\"message\":\"*** BadRequestError: tools[0].function: missing field name\"}}`;
    const cleaned = sanitizeErrorMessage(raw);
    expect(cleaned).toContain("tools[0].function");
    expect(cleaned).not.toContain("\\\"");
    expect(cleaned.length).toBeLessThanOrEqual(321);
  });

  it("普通文本去控制字符并折叠空白", () => {
    expect(sanitizeErrorMessage("  简单错误\n\n第二行 \t ")).toBe("简单错误 第二行");
  });

  it("超长错误截断到 320 字", () => {
    const cleaned = sanitizeErrorMessage("x".repeat(1000));
    expect(cleaned.length).toBe(321);
    expect(cleaned.endsWith("…")).toBe(true);
  });
});
