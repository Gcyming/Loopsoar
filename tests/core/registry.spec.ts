/**
 * 工具注册表：同名拒绝 / force 覆盖 / toolSchemas 形状。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, type ToolDefinition } from "../../packages/core/src/tools/registry.ts";

function def(name: string): ToolDefinition {
  return {
    name,
    description: `${name} 工具`,
    permissions: { read: true },
    schema: z.object({}),
    execute: async () => ({ ok: true, content: "" }),
  };
}

describe("工具注册表", () => {
  it("同名注册拒绝，force=true 覆盖", () => {
    const reg = new ToolRegistry();
    reg.register(def("file_read"));
    expect(() => reg.register(def("file_read"))).toThrow(/已注册/);
    reg.register(def("file_read"), { force: true });
    expect(reg.has("file_read")).toBe(true);
  });

  it("list/has/get/clear 语义", () => {
    const reg = new ToolRegistry();
    reg.register(def("a"));
    expect(reg.list().length).toBe(1);
    expect(reg.has("a")).toBe(true);
    expect(reg.get("missing")).toBeUndefined();
    reg.clear();
    expect(reg.list().length).toBe(0);
  });

  it("toolSchemas 输出 OpenAI function 形状", () => {
    const reg = new ToolRegistry();
    reg.register(def("file_read"));
    reg.register(def("file_write"));
    const schemas = reg.toolSchemas(["file_read"]);
    expect(schemas.length).toBe(1);
    expect(schemas[0].type).toBe("function");
    expect(schemas[0].function.name).toBe("file_read");
    expect(schemas[0].function.parameters).toMatchObject({ type: "object" });
  });
});
