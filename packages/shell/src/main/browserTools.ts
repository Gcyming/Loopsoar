/**
 * 浏览器工具集（Agent 的"手和眼"）：把 BrowserHost 的适配层能力注册为工具。
 *
 * 设计约束：
 *   · 只依赖 BrowserHost 的公开方法（不 import electron）；无 IPC 变化；
 *   · 权限按类别声明：读取页面 read；浏览器动作（导航/点击/输入/按键/滚动/标签…）browser
 *     （策略层独立档，默认 allow：会话「浏览器控制」开关已是显式授权；登录/支付/不可撤销动作仍逐次强制确认）；
 *     直接抓取 URL 的 web_fetch 不是浏览器操控，保持 network（默认每次确认）；
 *   · 输出限制大小（模型上下文友好），错误返回 ok:false 而不是抛异常。
 *
 * 结构（P1-7 行数红线的拆分，工具文案与行为逐字不变）：
 *   · `browserTools/context.ts`        共用状态（快照绑定）与共用闭包（宿主解析/指针覆盖层）、纯函数；
 *   · `browserTools/nav.ts`            快照、导航、标签、前进后退刷新、等待；
 *   · `browserTools/interact.ts`       点击、输入、按键、选择、拖拽、悬停、滚动、关弹窗；
 *   · `browserTools/capture.ts`        截图、web_fetch；
 *   · `browserTools/actionPreflight.ts` 动作前的「任务页克隆」统一前置。
 * 本文件只保留注册入口与对外导出，保证既有调用点/测试零改动。
 */
import { installActionPreflight } from "./browserTools/actionPreflight.js";
import { registerCaptureTools } from "./browserTools/capture.js";
import { createBrowserToolEnv, type BrowserToolHooks } from "./browserTools/context.js";
import { registerInteractTools } from "./browserTools/interact.js";
import { registerNavTools } from "./browserTools/nav.js";
import type { BrowserBackend } from "./browserBackend.js";
import type { ToolRegistry } from "loopsoar-core/tools/registry";

export {
  BROWSER_ERROR_CODES,
  SnapshotBindings,
  describeFocusProbe,
  deriveBrowserErrorCode,
  sensitiveClickReason,
  withBrowserErrorCode,
  type BrowserToolError,
  type BrowserToolHooks,
} from "./browserTools/context.js";

/**
 * 注册浏览器工具集。
 * @param resolveSessionRoot 会话工作根解析（截图落盘 <root>/.loopsoar/screenshots/；缺省 process.cwd()）。
 *   作为可选第三参保持向后兼容（既有调用/测试只传前两个参数）。
 * @param hooks 可选钩子（缺省 = 行为与没有钩子时完全一致）。
 */
export function registerBrowserTools(
  registry: ToolRegistry,
  browserHost: () => BrowserBackend | null,
  resolveSessionRoot?: (sessionId?: string) => string,
  hooks?: BrowserToolHooks,
): void {
  const env = createBrowserToolEnv(registry, browserHost, resolveSessionRoot, hooks);
  registerNavTools(env);
  registerInteractTools(env);
  registerCaptureTools(env);
  installActionPreflight(registry, browserHost, env);
}
