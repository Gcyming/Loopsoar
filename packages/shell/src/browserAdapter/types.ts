/**
 * BrowserAdapter 接口（ADR-0003）：
 * 浏览器自动化能力的适配层。D0 spike 验证通过后冻结接口；
 * 当前仅占位——任何底层实现（WebContentsView 主实现 / webview 兼容 / WebView2+CDP）
 * 都不得牵动 Agent 内核与工具语义。
 */

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
}

/** 页面加载失败（WebContents did-fail-load 的净化形状；用于渲染层分类错误页）。 */
export interface BrowserLoadFailure {
  code: number;
  description: string;
  /** 失败的目标 URL（Electron validatedURL）。 */
  url: string;
  isMainFrame: boolean;
}

export interface BrowserAdapter {
  /** 导航到 URL（等待 domcontentloaded） */
  navigate(url: string): Promise<{ url: string }>;
  /** 页面可访问性快照（元素编号优先于坐标） */
  snapshot(): Promise<BrowserSnapshot>;
  /** 按元素编号/选择器点击 */
  click(target: string): Promise<void>;
  /** 向元素输入文本 */
  type(target: string, text: string): Promise<void>;
  /** 滚动：down/up/top/bottom */
  scroll(dir: "down" | "up" | "top" | "bottom"): Promise<void>;
  /** 截图（返回 base64 PNG） */
  screenshot(): Promise<string>;
  /** 等待指定毫秒 */
  wait(ms: number): Promise<void>;
  /** 在页面执行 JS 并取回 JSON-safe 结果 */
  executeJs(code: string): Promise<unknown>;
  /** 页面缩放（可选：后端不支持时忽略）。 */
  setZoom?(factor: number): void;
  /** 关闭当前视图 */
  close(): Promise<void>;
}
