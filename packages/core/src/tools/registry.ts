/**
 * 工具注册表（§4.3 S4）
 * ToolPermissions / ToolDefinition / ToolContext / ToolResult 接口 + ToolRegistry 类
 */
import type { ZodTypeAny } from "zod";
import { EMPTY_TOOL_PARAMETERS, zodToJsonSchema, type JsonSchemaWarning } from "./jsonSchema.js";

export interface ToolPermissions {
  read?: boolean;
  write?: boolean;
  terminal?: boolean;
  network?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  permissions: ToolPermissions;
  schema: ZodTypeAny;
  /** 显式 JSON Schema（扩展工具等非 zod 声明来源；优先于 schema 推导）。 */
  parameters?: unknown;
  execute(ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  agentId: string;
  sessionId?: string;
  platform: any;
  params: unknown;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  error?: string;
}

export class ToolRegistry {
  private store = new Map<string, ToolDefinition>();
  /** 最近一次 toolSchemas() 的 schema 降级记录（诊断用；每次调用重置）。 */
  private schemaWarnings: { tool: string; warning: JsonSchemaWarning }[] = [];

  register(def: ToolDefinition, opts?: { force?: boolean }): void {
    if (this.store.has(def.name) && !opts?.force) {
      throw new Error(`工具已注册：${def.name}`);
    }
    this.store.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.store.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.store.values());
  }

  has(name: string): boolean {
    return this.store.has(name);
  }

  /** 精确撤销单个工具（插件卸载 / 桥接 dispose 用）；返回是否真的删除了。 */
  unregister(name: string): boolean {
    return this.store.delete(name);
  }

  clear(): void {
    this.store.clear();
  }

  /** 最近一次 toolSchemas() 中发生的 schema 降级（未知 zod 类型/畸形 schema）。 */
  getSchemaWarnings(): ReadonlyArray<{ tool: string; warning: JsonSchemaWarning }> {
    return this.schemaWarnings;
  }

  /**
   * 取工具参数的 JSON Schema：显式 `parameters`（扩展工具自带 JSON Schema）优先，
   * 否则由 zod schema 转换（见 tools/jsonSchema.ts）。
   * 转换异常一律 fail-closed 回退空 object——坏 schema 不能拖垮整轮对话。
   */
  private parametersFor(def: ToolDefinition): unknown {
    if (def.parameters !== undefined) return def.parameters;
    try {
      const { schema, warnings } = zodToJsonSchema(def.schema);
      for (const warning of warnings) this.schemaWarnings.push({ tool: def.name, warning });
      return schema;
    } catch (err) {
      this.schemaWarnings.push({
        tool: def.name,
        warning: {
          path: "$",
          typeName: "unknown",
          reason: `zod→JSON Schema 转换异常（已回退空 object）：${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return { ...EMPTY_TOOL_PARAMETERS, properties: {} };
    }
  }

  /**
   * 输出 OpenAI function 数组格式。
   * parameters 优先用工具显式声明的 JSON Schema（扩展工具），否则由 zod schema 转换；
   * 内置工具的参数（类型/必填/枚举/边界）因此对模型可见（P2-1）。
   */
  toolSchemas(toolsOnly?: string[]): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
    this.schemaWarnings = [];
    const defs = toolsOnly ? this.list().filter((d) => toolsOnly.includes(d.name)) : this.list();
    return defs.map((d) => ({
      type: "function" as const,
      function: {
        name: d.name,
        description: d.description || "",
        parameters: this.parametersFor(d),
      },
    }));
  }
}
