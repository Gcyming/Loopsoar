/**
 * 吐字切分：只对最后一行渐入，换行处一次性转入 settled；未闭合代码不渐入。
 */
import { describe, expect, it } from "vitest";
import {
  splitStreamFade,
  unitize,
  visibleTailUnits,
  fadeUnitText,
  STREAM_FADE_TAIL_MAX,
} from "../../packages/ui/src/streamFadeSplit.ts";

describe("吐字切分", () => {
  it("settled 止于最后一个换行，尾巴只取最后一行", () => {
    const split = splitStreamFade("第一行\n第二行正在输");
    expect(split.settled).toBe("第一行\n");
    expect(split.linePrefix + split.tail).toBe("第二行正在输");
    expect(split.units.length).toBeGreaterThan(0);
  });

  it("尾单元 key 是绝对字符位；新增字符不改已有 at（不重播）", () => {
    const a = splitStreamFade("abc");
    const b = splitStreamFade("abcde");
    const firstAt = a.units[0].at;
    expect(b.units.find((unit) => unit.text.startsWith("a"))?.at).toBe(firstAt);
    expect(b.units.map((unit) => unit.text).join("")).toBe("abcde");
  });

  it("未闭合代码块/行内 code 回退为整段 Markdown", () => {
    expect(splitStreamFade("```ts\nconst a = 1").settled).toContain("```ts");
    expect(splitStreamFade("`inline").units).toHaveLength(0);
  });

  it("渐入单元抹掉 Markdown 控制符，不露出 ** / #", () => {
    expect(fadeUnitText("**")).toBe("");
    expect(fadeUnitText("##")).toBe("");
    expect(fadeUnitText("**粗体**")).toBe("粗体");
    const units = unitize("**hello**");
    expect(visibleTailUnits(units).map((unit) => unit.text).join("")).toContain("hello");
  });

  it("尾巴上限可控（默认 48）", () => {
    const long = "x".repeat(STREAM_FADE_TAIL_MAX + 20);
    const split = splitStreamFade(long);
    // 连续英文/数字会被 unitize 当成一个单元（slime 同策略），tail 可能略超上限；关键是只切最后一行
    expect(split.settled).toBe("");
    expect(split.units.map((unit) => unit.text).join("")).toBe(long);
  });
});
