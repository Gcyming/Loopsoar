/**
 * Chromium 启动开关（必须在 app ready 之前生效）。
 *
 * 两个开关各自有明确理由：
 *   · --lang：原生 UI 语言跟随设置；运行时切换下次启动生效。
 *   · disable-features=CalculateNativeWinOcclusion：Windows 原生遮挡检测会把「被别的窗口盖住」
 *     的网页判成 hidden，Chromium 随即丢弃注入的输入事件，Agent 点击/按键会静默失效；
 *     浏览器自动化要求网页在后台仍可交互。只影响本应用，不改变用户看到的窗口行为。
 *
 * 抽成模块：入口是组合根，这类「启动开关」属于可单测的纯编排。
 */
export interface ChromiumSwitchTarget {
  appendSwitch(name: string, value: string): void;
}

export function applyChromiumSwitches(options: {
  target: ChromiumSwitchTarget;
  /** 读取设置里的界面语言（失败返回 undefined）。 */
  language: () => string | undefined;
  warn?: (message: string, error: unknown) => void;
}): void {
  try {
    const language = options.language();
    if (language) options.target.appendSwitch("lang", language);
    options.target.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  } catch (error) {
    options.warn?.("[Loopsoar] 设置 Chromium 开关失败", error);
  }
}
