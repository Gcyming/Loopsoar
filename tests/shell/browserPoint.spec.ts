import { describe, expect, it } from "vitest";
import {
  buildPointClickScript,
  buildPointProbeScript,
  performPointClick,
  performPointProbe,
} from "../../packages/shell/src/main/browserPoint.ts";

describe("浏览器坐标动作", () => {
  it("探测脚本可编译，并区分 CSS / image 坐标空间", () => {
    const css = buildPointProbeScript(120, 90);
    const image = buildPointProbeScript(240, 180, "image");
    expect(() => new Function(css)).not.toThrow();
    expect(() => new Function(image)).not.toThrow();
    expect(css).toContain("elementFromPoint");
    expect(css).toContain("devicePixelRatio");
    expect(image).toContain("space === 'image'");
  });

  it("performPointProbe：透传命中的元素信息", async () => {
    const result = await performPointProbe(async () => ({
      ok: true,
      x: 12,
      y: 34,
      width: 20,
      height: 10,
      tag: "button",
      text: "提交",
    }), 12, 34);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("提交");
    expect(result.x).toBe(12);
  });

  it("performPointProbe：脚本失败/异常都转成可行动错误", async () => {
    const failed = await performPointProbe(async () => ({ ok: false, code: "NO_TARGET", message: "空白" }), 1, 1);
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe("NO_TARGET");
    const thrown = await performPointProbe(async () => {
      throw new Error("页面已销毁");
    }, 1, 1);
    expect(thrown.ok).toBe(false);
    expect(thrown.code).toBe("SCRIPT_ERROR");
    expect(thrown.message).toContain("页面已销毁");
  });

  it("performPointClick：成功/失败都不抛异常", async () => {
    const ok = await performPointClick(async () => ({ ok: true }), 10, 10);
    expect(ok.ok).toBe(true);
    const failed = await performPointClick(async () => ({ ok: false, message: "没有目标" }), 10, 10);
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("没有目标");
    expect(buildPointClickScript(10, 10)).toContain("el.click()");
  });
});
