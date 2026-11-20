/**
 * 浏览器工具活动广播（会话隔离）。
 *
 * 从 index.ts 抽出：index 已接近 1500 行守卫；这里只负责给浏览器工具套一层
 * start/end 事件，供渲染层显示呼吸灯/活动标签，不改变工具本身的返回。
 */
import type { ToolRegistry } from "loopsoar-core/tools/registry";

export function instrumentBrowserActivity(
  registry: ToolRegistry,
  toolNames: readonly string[],
  push: (channel: string, payload: unknown) => void,
): void {
  for (const toolName of toolNames) {
    const def = registry.get(toolName);
    if (!def) continue;
    const original = def.execute.bind(def);
    registry.register(
      {
        ...def,
        execute: async (ctx) => {
          push("chrome:agentActivity", { sessionId: ctx.sessionId, tool: toolName, phase: "start" });
          try {
            return await original(ctx);
          } finally {
            push("chrome:agentActivity", { sessionId: ctx.sessionId, tool: toolName, phase: "end" });
          }
        },
      },
      { force: true },
    );
  }
}
