/**
 * yaml-lite：frontmatter 子集的 round-trip 与容错。
 */
import { describe, expect, it } from "vitest";
import { dumpYaml, parseYamlLite, YamlLiteError } from "../../packages/core/src/memory/yamlLite.ts";

describe("yaml-lite（frontmatter 子集）", () => {
  it("dump → parse round-trip：标量、布尔、null、flow 列表、嵌套 map", () => {
    const source = {
      schema: 1,
      id: "m1",
      title: "记忆原点",
      importance: 9,
      archived: false,
      invalidated_at: null,
      tags: ["design", "memory"],
      links: ["[[m2]]", "[[m3|旧标题]]"],
      provenance: { trust: "user", session: "s1" },
    };
    const parsed = parseYamlLite(dumpYaml(source));
    expect(parsed).toMatchObject(source);
  });

  it("含冒号、井号、方括号的值会被引号包住并原样还原", () => {
    const tricky = { title: "Loopsoar: 记忆 #1", url: "https://example.com/a?b=c", flow: "[not a list]" };
    const parsed = parseYamlLite(dumpYaml(tricky));
    expect(parsed.title).toBe("Loopsoar: 记忆 #1");
    expect(parsed.url).toBe("https://example.com/a?b=c");
    expect(parsed.flow).toBe("[not a list]");
  });

  it("兼容手写：单引号、块列表、map 列表、注释与 CRLF", () => {
    const text = [
      "# 手写 YAML 允许注释",
      "title: '手写 & 记忆'",
      "tags:",
      "  - one",
      "  - two",
      "merge_trail:",
      "  - merged_at: 2026-11-01",
      "    reason: 重复",
      "  - merged_at: 2026-11-02",
      "    reason: '更长的重复' # 行尾注释",
      "empty:",
      "# 整行注释",
      "flag: true",
    ].join("\r\n");
    const parsed = parseYamlLite(text);
    expect(parsed.title).toBe("手写 & 记忆");
    expect(parsed.tags).toEqual(["one", "two"]);
    expect(parsed.merge_trail).toEqual([
      { merged_at: "2026-11-01", reason: "重复" },
      { merged_at: "2026-11-02", reason: "更长的重复" },
    ]);
    expect(parsed.empty).toBeNull();
    expect(parsed.flag).toBe(true);
  });

  it("空文本返回空对象；结构不合法抛 YamlLiteError", () => {
    expect(parseYamlLite("")).toEqual({});
    expect(() => parseYamlLite("这一行没有冒号")).toThrow(YamlLiteError);
  });

  it("同一对象两次 dump 结果一致（可进 git diff）", () => {
    const value = { a: 1, b: ["x", "y"], c: { d: "e:f" } };
    expect(dumpYaml(value)).toBe(dumpYaml(value));
  });
});
