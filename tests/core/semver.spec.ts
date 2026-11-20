import { describe, expect, it } from "vitest";
import {
  compareSemVer,
  isValidRange,
  isValidSemVer,
  maxSatisfying,
  parseSemVer,
  satisfies,
} from "../../packages/core/src/semver.ts";

describe("SemVer 2.0（零依赖实现）", () => {
  it("解析与比较：数字段按数值、预发布按标识符规则", () => {
    expect(parseSemVer("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseSemVer("v1.2.3")).toBeNull();
    expect(parseSemVer("1.2")).toBeNull();
    expect(compareSemVer(parseSemVer("1.10.0")!, parseSemVer("1.9.9")!)).toBeGreaterThan(0);
    expect(compareSemVer(parseSemVer("1.0.0-alpha")!, parseSemVer("1.0.0")!)).toBeLessThan(0);
    expect(compareSemVer(parseSemVer("1.0.0-alpha.2")!, parseSemVer("1.0.0-alpha.10")!)).toBeLessThan(0);
    expect(compareSemVer(parseSemVer("1.0.0-alpha.1")!, parseSemVer("1.0.0-alpha.beta")!)).toBeLessThan(0);
    expect(isValidSemVer("01.2.3")).toBe(false);
  });

  it("caret/tilde/通配/比较符", () => {
    expect(satisfies("1.2.9", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("0.2.5", "^0.2.0")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfies("1.9.0", "1.x")).toBe(true);
    expect(satisfies("2.0.0", "1.x")).toBe(false);
    expect(satisfies("1.2.3", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfies("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfies("2.0.0", "1.2.3 || 2.0.0")).toBe(true);
    expect(satisfies("1.5.0", "1.2.3 - 2.0.0")).toBe(true);
    expect(satisfies("2.0.1", "1.2.3 - 2.0.0")).toBe(false);
  });

  it("预发布语义：默认不匹配，显式预发布范围可匹配", () => {
    expect(satisfies("1.2.3-beta.2", "^1.2.0")).toBe(false);
    expect(satisfies("1.2.3-beta.2", ">=1.2.3-beta.1 <1.2.3")).toBe(true);
    expect(satisfies("1.2.3-beta.1", ">=1.2.3-beta.2 <1.2.3")).toBe(false);
  });

  it("非法范围 fail-closed，maxSatisfying 取最高兼容版本", () => {
    expect(isValidRange("^1.2.0")).toBe(true);
    expect(isValidRange("x.2.3")).toBe(false);
    expect(isValidRange("=>1.0.0")).toBe(false);
    expect(satisfies("1.0.0", "not-a-range")).toBe(false);
    expect(maxSatisfying(["1.0.0", "1.2.0", "2.0.0", "1.3.0-beta"], "^1.0.0")).toBe("1.2.0");
    expect(maxSatisfying(["2.0.0"], "^1.0.0")).toBeNull();
  });
});
