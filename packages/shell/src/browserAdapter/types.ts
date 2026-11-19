/**
 * BrowserAdapter 接口（ADR-0003）：
 * 浏览器自动化能力的适配层。D0 spike 验证通过后冻结接口；
 * 任何底层实现（WebContentsView 主实现 / webview 兼容 / WebView2+CDP）
 * 都不得牵动 Agent 内核与工具语义。
 *
 * 第二阶段 Slice C（P0-2）：快照正式返回语义元素表，ref 只是显示别名，
 * 真正的句柄是页面内按稳定性打分算出的选择器（见 refs.ts）。
 */

/** 快照里的一个元素：语义描述 + 稳定句柄。 */
export interface BrowserElementSnapshot {
  /** 显示别名（e1..eN，按页面文档顺序；动作时可传 "e5" 或 "5"）。 */
  ref: string;
  /** 标签名（小写）。 */
  tag: string;
  /** 语义角色（button/link/textbox/heading/navigation…）。 */
  role: string;
  /** 可读名称（aria-label / 文本 / placeholder / alt …）。 */
  name: string;
  /** 当前值（textbox/combobox；密码框不回传）。 */
  value?: string;
  /** input 的 type（text/checkbox/submit…）。 */
  type?: string;
  /** 链接目标（a[href]，原样，可能是相对路径）。 */
  href?: string;
  /** 是否禁用。 */
  disabled?: boolean;
  /** 是否勾选（checkbox/radio）。 */
  checked?: boolean;
  /**
   * 稳定句柄：页面内按「唯一 id > name > aria-label > data-testid >
   * 精确文本（a/button，≤60 字符）> 结构路径 tag:nth-child 链」逐级回退得到。
   * 动作时由适配器查注册表得到，工具层不直接消费。
   */
  selector: string;
  /** 选择器来源（id / name / aria-label / data-testid / text / path；调试用）。 */
  selectorWhy?: string;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  /** 语义元素（可交互元素 + 标题/地标），按页面文档顺序。 */
  elements: BrowserElementSnapshot[];
  /** 快照代数：同一标签内单调递增（导航不清零，用于校验引用新鲜度）。 */
  snapshotGen?: number;
  /**
   * 元素总数（截断前）：elements 可能只含前 N 个，
   * 工具层据此提示「还有多少没显示」。
   */
  elementTotal?: number;
  /**
   * 标签注册表令牌：ref → 句柄的映射存在适配器侧，按此令牌索引。
   * 只在进程内回传给工具层（定位同一标签的注册表），不面向模型展示。
   */
  tabToken?: string;
  /**
   * 快照所属标签 id（BrowserHost 填充）。
   * ref 注册表按「会话 + 标签」绑定：工具层据此把令牌记到正确的标签上，
   * 用户手动切标签后旧引用才会被判定为 STALE_REF，而不是串到另一标签的元素上。
   */
  tabId?: string;
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
  /** 页面可访问性快照（语义元素 + 稳定句柄，元素优先于坐标） */
  snapshot(): Promise<BrowserSnapshot>;
  /** 截图（返回 base64 PNG） */
  screenshot(): Promise<string>;
  /** 在页面执行 JS 并取回 JSON-safe 结果 */
  executeJs(code: string): Promise<unknown>;
  /** 关闭当前视图 */
  close(): Promise<void>;
}
