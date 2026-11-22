import { describe, expect, it } from "vitest";
import { officeKindForFile } from "../../packages/shell/src/main/officeNative.ts";

describe("Office 原生导出：格式路由", () => {
  it("把微软 Office 格式分派到对应应用", () => {
    expect(officeKindForFile("C:/课程/第五章.ppt")).toBe("powerpoint");
    expect(officeKindForFile("C:/课程/第五章.PPTX")).toBe("powerpoint");
    expect(officeKindForFile("C:/实验/报告.doc")).toBe("word");
    expect(officeKindForFile("C:/实验/报告.docx")).toBe("word");
    expect(officeKindForFile("C:/实验/数据.xls")).toBe("excel");
    expect(officeKindForFile("C:/实验/数据.xlsx")).toBe("excel");
  });

  it("OpenDocument/PDF/未知格式不走原生 Office（交给 LibreOffice 或直接预览）", () => {
    expect(officeKindForFile("C:/课程/讲义.odp")).toBeNull();
    expect(officeKindForFile("C:/课程/讲义.odt")).toBeNull();
    expect(officeKindForFile("C:/课程/讲义.pdf")).toBeNull();
    expect(officeKindForFile("C:/课程/readme.txt")).toBeNull();
  });
});
