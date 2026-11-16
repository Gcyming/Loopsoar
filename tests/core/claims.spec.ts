/**
 * 声称核验：完成动词 + 路径存在性；跳过代码块与 URL 残片。
 */
import { describe, expect, it } from "vitest";
import { auditClaims, CLAIM_VERBS } from "../../packages/core/src/claims.ts";

describe("声称核验", () => {
  it("CLAIM_VERBS 覆盖七类完成动词", () => {
    expect(CLAIM_VERBS.length).toBeGreaterThanOrEqual(7);
  });

  it("声称存在且文件真实存在 → 无「不存在」finding", async () => {
    const findings = await auditClaims("已保存到 C:/work/report.docx", async (p) => p === "C:/work/report.docx");
    // 实现会对每条声称产生核验记录；「存在问题」= verified 且 exists=false 的记录
    expect(findings.filter((f) => f.verified && !f.exists)).toEqual([]);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("声称存在但文件不存在 → 报 finding", async () => {
    const findings = await auditClaims("已生成 C:/work/missing.docx", async () => false);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].path).toContain("missing.docx");
  });

  it("fenced code block 内的路径被跳过", async () => {
    const text = "```\n已保存到 C:/work/example.docx\n```";
    const findings = await auditClaims(text, async () => false);
    expect(findings).toEqual([]);
  });

  it("URL/域名残片被跳过（agnes-ai.cn 不是本地路径）", async () => {
    const findings = await auditClaims("访问 https://agnes-ai.cn/abc 成功", async () => false);
    expect(findings).toEqual([]);
  });

  it("无完成动词 → 无 finding", async () => {
    const findings = await auditClaims("今天天气不错。", async () => false);
    expect(findings).toEqual([]);
  });

  it("纯文件名不被当成 URL 残片（report.md 必须进入核验）", async () => {
    // 回归：旧正则把 report.md / README.md 当域名残片跳过，
    // 导致最常见的「已保存到 report.md」声称永远不核验（诚实协议闭环失效）。
    const findings = await auditClaims("已保存到 report.md", async () => false);
    expect(findings.filter((f) => f.verified && !f.exists).length).toBe(1);
    expect(findings[0].path).toContain("report.md");
  });

  it("带路径的域名残片仍被跳过（example.com/out.txt）", async () => {
    const findings = await auditClaims("已保存到 example.com/out.txt", async () => false);
    expect(findings.filter((f) => f.verified)).toEqual([]);
    expect(findings[0]?.reason).toContain("URL");
  });
});
