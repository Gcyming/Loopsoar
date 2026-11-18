import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import {
  convertLegacyOffice,
  findSoffice,
  legacyTarget,
  registerOfficeConvertTools,
} from "../../packages/shell/src/main/officeConvert.ts";

const saved = process.env.LOOPSOAR_SOFFICE;
afterEach(() => {
  if (saved === undefined) delete process.env.LOOPSOAR_SOFFICE;
  else process.env.LOOPSOAR_SOFFICE = saved;
});

describe("旧版 Office 转换（P1-6 补口）", () => {
  it("只映射 .doc/.xls/.ppt", () => {
    expect(legacyTarget(".doc")).toBe("docx");
    expect(legacyTarget(".XLS")).toBe("xlsx");
    expect(legacyTarget(".ppt")).toBe("pptx");
    expect(legacyTarget(".docx")).toBeNull();
  });

  it("优先使用 LOOPSOAR_SOFFICE", () => {
    const fake = path.join(os.tmpdir(), "loopsoar-fake-soffice");
    fs.writeFileSync(fake, "");
    process.env.LOOPSOAR_SOFFICE = fake;
    expect(findSoffice()).toBe(fake);
    fs.rmSync(fake, { force: true });
  });

  it("找不到转换器时给出可读错误且清理临时目录", async () => {
    await expect(
      convertLegacyOffice("C:/tmp/missing.doc", { soffice: "C:/does-not-exist/soffice.exe" }),
    ).rejects.toThrow(/无法启动 LibreOffice|转换失败/);
  });

  it("office_convert 声明 terminal 权限且缺文件不抛异常", async () => {
    const registry = new ToolRegistry();
    registerOfficeConvertTools(registry);
    const tool = registry.get("office_convert")!;
    expect(tool.permissions.terminal).toBe(true);
    const result = await tool.execute({
      agentId: "test",
      sessionId: "s1",
      params: { path: "C:/tmp/definitely-missing.doc" },
      platform: {},
    });
    expect(result.ok).toBe(false);
  });
});
