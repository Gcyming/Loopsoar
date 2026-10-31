/**
 * 产物/引用纯逻辑：diff 标记编解码、行级 diff、产物与参考收集。
 */
import { describe, expect, it } from "vitest";
import {
  collectProducts,
  collectReferences,
  diffLines,
  diffStat,
  encodeDiffMarker,
  parseDiffResult,
} from "../../packages/ui/src/artifacts.ts";
import type { TimelineStep } from "../../packages/ui/src/timeline.ts";

describe("产物与 diff", () => {
  it("diff 标记可编解码，文本与数据分离", () => {
    const marker = encodeDiffMarker({ path: "src/a.ts", oldText: "a\nb", newText: "a\nc" });
    const parsed = parseDiffResult(`已写入 src/a.ts\n${marker}`);
    expect(parsed.clean).toContain("已写入");
    expect(parsed.clean).not.toContain("loops_diff");
    expect(parsed.diff).toMatchObject({ path: "src/a.ts", oldText: "a\nb", newText: "a\nc" });
  });

  it("行级 diff 标记增删，统计正确", () => {
    const lines = diffLines("keep\nold", "keep\nnew");
    expect(lines.some((l) => l.op === "-" && l.text === "old")).toBe(true);
    expect(lines.some((l) => l.op === "+" && l.text === "new")).toBe(true);
    const stat = diffStat(lines);
    expect(stat.add).toBe(1);
    expect(stat.del).toBe(1);
  });

  it("从时间线收集产物与参考内容（去重）", () => {
    const timeline: TimelineStep[] = [
      { kind: "tool", id: "1", name: "file_read", label: "file_read", detail: "src/a.ts", state: "done", result: "内容" },
      { kind: "tool", id: "2", name: "browser_navigate", label: "browser_navigate", detail: "https://example.com/x", state: "done", result: "ok" },
      {
        kind: "tool",
        id: "3",
        name: "file_write",
        label: "file_write",
        detail: "src/a.ts",
        state: "done",
        result: `已写入\n${encodeDiffMarker({ path: "src/a.ts", oldText: "旧", newText: "新" })}`,
      },
      { kind: "tool", id: "4", name: "file_read", label: "file_read", detail: "src/a.ts", state: "done" },
    ];
    const refs = collectReferences(timeline);
    expect(refs.files).toHaveLength(1);
    expect(refs.urls).toHaveLength(1);
    const products = collectProducts(timeline);
    expect(products).toHaveLength(1);
    expect(products[0].path).toBe("src/a.ts");
    expect(products[0].add).toBe(1);
  });
});
