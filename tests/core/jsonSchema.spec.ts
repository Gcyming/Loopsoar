/**
 * zod → JSON Schema 转换器（P2-1）：内置工具参数对模型可见。
 *
 * 覆盖：file_read / file_write / terminal_run / browser_* / todo_write 的等价 schema（不 import shell，
 * 保持纯 core 测试；shell 侧 schema 由各自单测负责）、可选字段不在 required、enum/regex/数值边界、
 * 未知类型降级、畸形 schema 不抛错、ToolRegistry.toolSchemas() 接线与 fail-closed。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ZodTypeAny } from "zod";
import {
  EMPTY_TOOL_PARAMETERS,
  zodToJsonSchema,
  zodToToolParameters,
  type JsonSchema,
} from "../../packages/core/src/tools/jsonSchema.ts";
import { ToolRegistry, type ToolDefinition } from "../../packages/core/src/tools/registry.ts";

/** 只要 parameters（丢弃 warnings）。 */
function params(schema: ZodTypeAny): JsonSchema {
  return zodToToolParameters(schema);
}

function toolDef(name: string, schema: ZodTypeAny, explicitParameters?: unknown): ToolDefinition {
  return {
    name,
    description: `${name} 工具`,
    permissions: { read: true },
    schema,
    ...(explicitParameters !== undefined ? { parameters: explicitParameters } : {}),
    execute: async () => ({ ok: true, content: "" }),
  };
}

describe("zod→JSON Schema：内置工具参数形状", () => {
  it("file_read：path 必填，offset/limit 可选（不进 required）", () => {
    const out = params(
      z.object({
        path: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      }),
    );
    expect(out).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("file_write：path/content 都必填且带长度边界", () => {
    const out = params(
      z.object({
        path: z.string().min(1).max(1000),
        content: z.string().max(2_000_000),
      }),
    );
    expect(out.properties?.path).toEqual({ type: "string", minLength: 1, maxLength: 1000 });
    expect(out.properties?.content).toEqual({ type: "string", maxLength: 2_000_000 });
    expect(out.required).toEqual(["path", "content"]);
  });

  it("terminal_run：command 必填，timeoutMs 可选且为整数边界", () => {
    const out = params(
      z.object({
        command: z.string().min(1).max(4000),
        timeoutMs: z.number().int().min(1000).max(120_000).optional(),
      }),
    );
    expect(out.properties?.command).toEqual({ type: "string", minLength: 1, maxLength: 4000 });
    expect(out.properties?.timeoutMs).toEqual({ type: "integer", minimum: 1000, maximum: 120_000 });
    expect(out.required).toEqual(["command"]);
  });

  it("browser_navigate / web_fetch：url 必填，.url() 映射 format=uri", () => {
    const navigate = params(z.object({ url: z.string().min(1).max(2000) }));
    expect(navigate.required).toEqual(["url"]);
    expect(navigate.properties?.url).toEqual({ type: "string", minLength: 1, maxLength: 2000 });

    const webFetch = params(
      z.object({
        url: z.string().url().max(2000),
        maxChars: z.number().int().min(200).max(30_000).optional(),
      }),
    );
    expect(webFetch.properties?.url).toEqual({ type: "string", format: "uri", maxLength: 2000 });
    expect(webFetch.required).toEqual(["url"]);
  });

  it("browser_scroll：enum 值完整保留，amount 可选", () => {
    const out = params(
      z.object({
        direction: z.enum(["down", "up", "top", "bottom"]),
        amount: z.number().int().min(100).max(5000).optional(),
      }),
    );
    expect(out.properties?.direction).toEqual({
      type: "string",
      enum: ["down", "up", "top", "bottom"],
    });
    expect(out.required).toEqual(["direction"]);
  });

  it("todo_write：嵌套对象数组（items[].status 枚举）", () => {
    const out = params(
      z.object({
        items: z
          .array(
            z.object({
              id: z.string(),
              content: z.string(),
              status: z.enum(["pending", "in_progress", "completed"]),
            }),
          )
          .min(1)
          .max(50),
      }),
    );
    const items = out.properties?.items;
    expect(items?.type).toBe("array");
    expect(items?.minItems).toBe(1);
    expect(items?.maxItems).toBe(50);
    expect(items?.items).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        content: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
      },
      required: ["id", "content", "status"],
      additionalProperties: false,
    });
    expect(out.required).toEqual(["items"]);
  });
});

describe("zod→JSON Schema：可选性与 required 语义", () => {
  it("Optional/Default 非必填；Nullable 仍必填（必须显式给 null）", () => {
    const out = params(
      z.object({
        a: z.string(),
        b: z.string().optional(),
        c: z.string().default("x"),
        d: z.string().nullable(),
        e: z.string().optional().nullable(),
      }),
    );
    expect(out.required).toEqual(["a", "d"]);
    expect(out.properties?.d).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(out.properties?.e).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  });

  it("全部可选时不输出 required 字段", () => {
    const out = params(z.object({ q: z.string().optional() }));
    expect(out).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      additionalProperties: false,
    });
    expect(out.required).toBeUndefined();
  });
});

describe("zod→JSON Schema：字符串/数值/数组边界", () => {
  it("regex → pattern；min/max 取最严格值", () => {
    const out = params(
      z.object({
        slug: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        title: z.string().min(2).min(7).max(64).max(32),
        code: z.string().length(3),
      }),
    );
    expect(out.properties?.slug).toEqual({ type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" });
    expect(out.properties?.title).toEqual({ type: "string", minLength: 7, maxLength: 32 });
    expect(out.properties?.code).toEqual({ type: "string", minLength: 3, maxLength: 3 });
  });

  it("数值：gt/lt → exclusiveMinimum/Maximum，int → integer，multipleOf", () => {
    const out = params(
      z.object({
        ratio: z.number().gt(0).lt(1),
        count: z.number().int().min(0),
        step: z.number().multipleOf(5),
      }),
    );
    expect(out.properties?.ratio).toEqual({
      type: "number",
      exclusiveMinimum: 0,
      exclusiveMaximum: 1,
    });
    expect(out.properties?.count).toEqual({ type: "integer", minimum: 0 });
    expect(out.properties?.step).toEqual({ type: "number", multipleOf: 5 });
  });

  it("数组：min/max/length 边界", () => {
    expect(params(z.object({ list: z.array(z.string()).min(1).max(50) })).properties?.list).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 50,
    });
    expect(params(z.object({ pair: z.array(z.number()).length(2) })).properties?.pair).toEqual({
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    });
  });

  it("union / record / literal", () => {
    const out = params(
      z.object({
        mode: z.union([z.literal("fast"), z.literal("slow")]),
        scores: z.record(z.string(), z.number()),
        version: z.literal(2),
      }),
    );
    expect(out.properties?.mode).toEqual({
      anyOf: [
        { enum: ["fast"], type: "string" },
        { enum: ["slow"], type: "string" },
      ],
    });
    expect(out.properties?.scores).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    });
    expect(out.properties?.version).toEqual({ enum: [2], type: "number" });
  });
});

describe("zod→JSON Schema：降级与容错（绝不抛错）", () => {
  it("未知类型降级 {type:'object'} 并带 warning（含路径与 typeName）", () => {
    const res = zodToJsonSchema(z.object({ when: z.date() }));
    expect(res.schema.properties?.when).toEqual({ type: "object" });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatchObject({ path: "when", typeName: "ZodDate" });
  });

  it("根不是 object → 降级为空 object 参数 + warning", () => {
    const res = zodToJsonSchema(z.string());
    expect(res.schema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(res.warnings[0]).toMatchObject({ path: "$", typeName: "root" });
  });

  it("非 zod / 畸形 schema（含 _def 取值抛错）不抛错", () => {
    const hostile = {
      get _def(): never {
        throw new Error("boom");
      },
    } as unknown as ZodTypeAny;

    expect(() => zodToJsonSchema(undefined as unknown as ZodTypeAny)).not.toThrow();
    expect(zodToJsonSchema(undefined as unknown as ZodTypeAny).schema).toEqual(EMPTY_TOOL_PARAMETERS);
    expect(() => zodToJsonSchema(hostile)).not.toThrow();
    expect(zodToJsonSchema(hostile).schema).toEqual(EMPTY_TOOL_PARAMETERS);
    expect(zodToJsonSchema(hostile).warnings.length).toBeGreaterThan(0);
  });

  it("ZodLazy 递归引用被截断（不栈溢出），普通 lazy 正常展开", () => {
    const Plain: ZodTypeAny = z.lazy(() => z.object({ q: z.string() }));
    expect(params(Plain)).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
      additionalProperties: false,
    });

    const Node: ZodTypeAny = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(Node).optional() }),
    );
    const res = zodToJsonSchema(Node);
    expect(res.schema.properties?.name).toEqual({ type: "string" });
    expect(res.schema.properties?.children).toEqual({ type: "array", items: { type: "object" } });
    expect(res.warnings.some((w) => w.reason.includes("递归"))).toBe(true);
  });

  it("ZodEffects（.refine()）按输入侧结构展开", () => {
    const out = params(z.object({ q: z.string().min(1).refine((v) => v.length <= 10) }));
    expect(out.properties?.q).toEqual({ type: "string", minLength: 1 });
    expect(out.required).toEqual(["q"]);
  });

  it("description 透传（属性级 + 根级）", () => {
    const out = params(
      z.object({ q: z.string().describe("查询词") }).describe("搜索参数"),
    );
    expect(out.properties?.q).toEqual({ type: "string", description: "查询词" });
    expect(out.description).toBe("搜索参数");
  });
});

describe("ToolRegistry.toolSchemas：接线与 fail-closed", () => {
  it("内置工具参数由 zod 真实转换（不再是空 object 占位）", () => {
    const reg = new ToolRegistry();
    reg.register(toolDef("file_read", z.object({ path: z.string(), offset: z.number().optional() })));
    reg.register(toolDef("terminal_run", z.object({ command: z.string().min(1) })));

    const schemas = reg.toolSchemas();
    expect(schemas).toHaveLength(2);
    expect(schemas[0].type).toBe("function");
    expect(schemas[0].function.name).toBe("file_read");
    expect(schemas[0].function.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    });
    expect(schemas[1].function.parameters).toMatchObject({ required: ["command"] });
    // 必须是可 JSON 序列化的纯数据（不能混入函数/undefined）
    expect(() => JSON.stringify(schemas)).not.toThrow();
    expect(reg.getSchemaWarnings()).toEqual([]);
  });

  it("显式 parameters（扩展工具 JSON Schema）优先，且 toolsOnly 过滤生效", () => {
    const explicit = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
      additionalProperties: false,
    };
    const reg = new ToolRegistry();
    reg.register(toolDef("ext__demo__search", z.object({ ignored: z.number() }), explicit));
    reg.register(toolDef("file_read", z.object({ path: z.string() })));

    expect(reg.toolSchemas(["ext__demo__search"])[0].function.parameters).toEqual(explicit);
    expect(reg.toolSchemas(["file_read"])).toHaveLength(1);
  });

  it("坏 schema fail-closed 回退空 object，不抛错且记录 warning", () => {
    const reg = new ToolRegistry();
    reg.register(toolDef("broken", undefined as unknown as ZodTypeAny));
    expect(() => reg.toolSchemas()).not.toThrow();
    expect(reg.toolSchemas()[0].function.parameters).toEqual(EMPTY_TOOL_PARAMETERS);
    expect(reg.getSchemaWarnings()[0]?.tool).toBe("broken");

    // warning 按次重置：移除坏工具后不再残留
    reg.unregister("broken");
    reg.toolSchemas();
    expect(reg.getSchemaWarnings()).toEqual([]);
  });
});
