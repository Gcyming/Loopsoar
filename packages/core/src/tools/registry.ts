/**
 * 工具注册表（§4.3 S4）
 * ToolPermissions / ToolDefinition / ToolContext / ToolResult 接口 + ToolRegistry 类
 */
import type { ZodTypeAny } from "zod";

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

  /**
   * 输出 OpenAI function 数组格式（P1 接真实 JSON Schema 转换）
   * 当前占位：直接输出 {type:"object", properties:{}, additionalProperties:false}
   */
  toolSchemas(toolsOnly?: string[]): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
    const defs = toolsOnly ? this.list().filter((d) => toolsOnly.includes(d.name)) : this.list();
    return defs.map((d) => {
      // 扩展工具直接带 JSON Schema；内置工具暂用占位（P1 再接 zod→JSON Schema）
      const parameters = d.parameters ?? { type: "object" as const, properties: {}, additionalProperties: false };
      return {
        type: "function" as const,
        function: {
          name: d.name,
          description: d.description || "",
          parameters,
        },
      };
    });
  }
}
