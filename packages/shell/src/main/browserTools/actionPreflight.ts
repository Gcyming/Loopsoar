/**
 * 动作类工具的统一前置：首次动手时把当前用户页克隆进 Agent 工作区。
 *
 * 为什么在注册之后再做一次包装（而不是塞进每个工具）：这是**跨工具**的策略，
 * 不是某个工具的能力。写成后置包装，新增动作工具只要把名字加进 ACTION_TOOL_NAMES，
 * 不必在工具体里复制一段准备逻辑；只读工具（snapshot/screenshot/wait/tabs 读）不包装——
 * 看页面不是工作，不该克隆。
 */
import type { ToolRegistry } from "loopsoar-core/tools/registry";
import type { BrowserBackend } from "../browserBackend.js";
import { activeTabOf, withBrowserErrorCode, type BrowserToolEnv } from "./context.js";

/** 会改变页面或导航的工具：执行前必须先落到「本会话的任务页」。 */
export const ACTION_TOOL_NAMES = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_drag",
  "browser_press_key",
  "browser_scroll",
  "browser_hover",
  "browser_select",
  "browser_dismiss_popup",
  "browser_back",
  "browser_forward",
  "browser_reload",
] as const;

/**
 * 幂等安装动作前置准备。
 *
 * `browser_navigate` 用空白页克隆（导航会立刻改写 URL，克隆旧页没意义）；
 * 其余动作用当前页克隆（保留用户正在看的内容作为起点）。
 */
export function installActionPreflight(
  registry: ToolRegistry,
  browserHost: () => BrowserBackend | null,
  env: BrowserToolEnv,
): void {
  for (const name of ACTION_TOOL_NAMES) {
    const def = registry.get(name);
    if (!def) continue;
    const execute = def.execute;
    registry.register(
      {
        ...def,
        execute: async (ctx) => {
          const host = browserHost();
          if (host && typeof host.ensureAgentTab === "function") {
            // 快照可能落在「用户全局标签」（会话还没有自己的页）；此时 activeTabId(session) 为 null，
            // 但 bindings 记着令牌真正来自哪个标签，迁移必须以它为来源键。
            const fromTab = activeTabOf(host, ctx.sessionId) ?? env.bindings.lastTab(ctx.sessionId) ?? null;
            const adopted = await host
              .ensureAgentTab(ctx.sessionId, { blank: name === "browser_navigate" })
              .catch(() => null);
            // 首次动作会把用户页克隆成任务页；把快照令牌迁到克隆页，避免第一次点击必 STALE_REF。
            if (adopted && fromTab && adopted !== fromTab) {
              env.bindings.migrate(ctx.sessionId, fromTab, adopted);
            }
          }
          return withBrowserErrorCode(await execute(ctx));
        },
      },
      { force: true },
    );
  }
}
