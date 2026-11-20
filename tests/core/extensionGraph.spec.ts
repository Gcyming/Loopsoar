import { describe, expect, it } from "vitest";
import { dependencyClosure, resolveExtensionGraph } from "../../packages/core/src/extensionGraph.ts";

describe("扩展依赖图", () => {
  it("依赖优先排序，dependents 反向索引", () => {
    const graph = resolveExtensionGraph([
      { id: "app", version: "1.0.0", dependencies: { lib: "^1.0.0" } },
      { id: "lib", version: "1.2.0" },
      { id: "extra", version: "0.1.0" },
    ]);
    expect(graph.issues).toEqual([]);
    expect(graph.order.indexOf("lib")).toBeLessThan(graph.order.indexOf("app"));
    expect(graph.dependents.lib).toEqual(["app"]);
    expect(graph.blocked).toEqual([]);
    expect(dependencyClosure("app", graph, [
      { id: "app", version: "1.0.0", dependencies: { lib: "^1.0.0" } },
      { id: "lib", version: "1.2.0" },
    ])).toEqual(["lib", "app"]);
  });

  it("缺失依赖与版本不满足 → 自身及依赖链 blocked", () => {
    const missing = resolveExtensionGraph([{ id: "app", version: "1.0.0", dependencies: { ghost: "^1.0.0" } }]);
    expect(missing.issues.map((issue) => issue.code)).toContain("missing-dependency");
    expect(missing.blocked).toContain("app");

    const mismatch = resolveExtensionGraph([
      { id: "app", version: "1.0.0", dependencies: { lib: "^2.0.0" } },
      { id: "lib", version: "1.0.0" },
    ]);
    expect(mismatch.issues.map((issue) => issue.code)).toContain("dependency-version");
    expect(mismatch.blocked).toContain("app");
  });

  it("循环依赖被识别并全部阻断", () => {
    const graph = resolveExtensionGraph([
      { id: "a", version: "1.0.0", dependencies: { b: "^1.0.0" } },
      { id: "b", version: "1.0.0", dependencies: { a: "^1.0.0" } },
      { id: "c", version: "1.0.0", dependencies: { a: "^1.0.0" } },
    ]);
    expect(graph.cycles.length).toBeGreaterThan(0);
    expect(graph.blocked).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("依赖者被阻断会向上传播；自身依赖与重复 id 也报错", () => {
    const graph = resolveExtensionGraph([
      { id: "a", version: "1.0.0", dependencies: { a: "^1.0.0" } },
      { id: "b", version: "1.0.0", dependencies: { a: "^1.0.0" } },
      { id: "b", version: "1.1.0" },
    ]);
    expect(graph.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["self-dependency", "duplicate"]));
    expect(graph.blocked).toContain("b");
  });
});
