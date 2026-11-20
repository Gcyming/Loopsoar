/**
 * 契约层入口（稳定 import 路径）。
 *
 * 实现按职责拆分：
 *   · validators.ts       —— 所有 zod schema 与 ChannelBinding 类型
 *   · channels/           —— 通道绑定按域拆分，index.ts 恢复原始键序
 *   · events.ts           —— 事件名清单
 *
 * 生成器、壳层、core、UI 仍统一从 `loopsoar-contracts/schemas` 导入；
 * 拆分不改变任何导出名、通道顺序或生成物字节。
 */
export * from "./validators.js";
export { CHANNEL_BINDINGS } from "./channels/index.js";
export { EVENTS, type EventName } from "./events.js";

/**
 * Agent 浏览器工具名单（单一产地，第二阶段 Slice A）。
 *
 * 会话「浏览器控制」关闭时，这里的工具既不出现在 `registry.toolSchemas()`
 * 的模型可见面，也无法通过执行闸（两道闸用同一份名单）。
 *
 * 约束：shell/main/browserTools.ts 的注册名必须与本名单一致（有守卫测试兜底）；
 * 第二阶段 Slice D 已扩展到动作/多标签面：browser_tabs（list/new/select/close）、
 * browser_back / browser_forward / browser_reload、browser_press_key / browser_select /
 * browser_hover —— 新增浏览器工具必须同时加到这里，否则开关关了它仍然可见。
 * 注意：web_fetch 属网络权限域，不得加入本名单。
 */
export const BROWSER_AGENT_TOOLS: readonly string[] = [
  "browser_snapshot",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_screenshot",
  "browser_wait",
  "browser_tabs",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_press_key",
  "browser_select",
  "browser_hover",
  "browser_drag",
  "browser_dismiss_popup",
  "browser_downloads",
  "browser_cookies",
  "browser_diagnostics",
  "browser_upload",
];
