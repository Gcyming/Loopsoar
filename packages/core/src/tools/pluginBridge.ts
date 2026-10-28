/**
 * 插件工具桥（ADR-0011）：把 PluginHost 登记的工具贡献装配进 ToolRegistry。
 * 为什么单独一层：host 只管「贡献登记」，registry 只管「执行语义」；
 * 桥负责三件事——权限映射、schema 兜底、冲突 fail-closed（同名不静默覆盖）。
 * 生命周期：bridge 返回 dispose()，插件卸载时调用即从注册表精确撤销（卸载即恢复）。
 */
import { z, type ZodTypeAny } from "zod";
import type { PluginHost } from "../plugin/host.js";
import type {
  ToolDefinition,
  ToolPermissions,
  ToolRegistry,
  ToolResult,
} from "./registry.js";

/** 插件工具的可执行规格（schema/execute 由插件提供；缺省时用空 schema + 兜底拒绝执行器）。 */
export interface PluginToolSpec {
  name: string;
  description: string;
  permissions: Record<string, boolean>;
  schema?: ZodTypeAny;
  execute?: (
    args: unknown,
    ctx: { agentId: string; sessionId?: string },
  ) => Promise<ToolResult>;
}

export interface BridgeResult {
  registered: string[];
  errors: { name: string; reason: string }[];
  /** 撤销全部已桥接工具（插件卸载时调用）。 */
  dispose: () => void;
}

function toPermissions(p?: Record<string, boolean>): ToolPermissions {
  return {
    read: Boolean(p?.read),
    write: Boolean(p?.write),
    terminal: Boolean(p?.terminal),
    network: Boolean(p?.network),
  };
}

/**
 * 桥接某插件的全部工具贡献。
 * @param fallbackExecutor 插件未提供 execute 时的统一执行器（例如转发到插件脚本）
 */
export function bridgePluginTools(
  registry: ToolRegistry,
  host: PluginHost,
  pluginName: string,
  fallbackExecutor?: PluginToolSpec["execute"],
): BridgeResult {
  const result: BridgeResult = { registered: [], errors: [], dispose: () => {} };
  const contributions = host.toolsProvider(pluginName) as PluginToolSpec[] | null;
  if (!contributions) return result; // 未声明工具贡献 → 无操作（不是错误）

  for (const c of contributions) {
    try {
      if (registry.has(c.name)) {
        throw new Error("工具名已在注册表中（fail-closed：需显式 force 覆盖，不允许静默顶替）");
      }
      const execute =
        c.execute ??
        fallbackExecutor ??
        (async (): Promise<ToolResult> => ({
          ok: false,
          content: "[错误] 插件工具缺少执行器（插件未提供 execute，且未注入 fallbackExecutor）",
          error: "no-executor",
        }));
      const def: ToolDefinition = {
        name: c.name,
        description: c.description ?? "",
        permissions: toPermissions(c.permissions),
        schema: c.schema ?? z.object({}),
        execute: async (ctx) =>
          execute(ctx.params, { agentId: ctx.agentId, sessionId: ctx.sessionId }),
      };
      registry.register(def);
      result.registered.push(c.name);
    } catch (err) {
      result.errors.push({
        name: c.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  result.dispose = (): void => {
    for (const name of result.registered) registry.unregister(name);
    result.registered = [];
  };
  return result;
}
