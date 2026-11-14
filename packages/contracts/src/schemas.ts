import { z } from "zod";

/**
 * Named Zod schemas for each channel request payload.
 * Used by gen/ipc.ts for z.infer mapping.
 */
export const AgentModeSchema = z.enum(["build", "plan"]);

/**
 * 会话 ID 契约（单一产地）：同时约束 IPC 入参与落盘文件名。
 * 只允许字母数字开头 + [A-Za-z0-9._-]（禁止路径分隔符，禁止 "." / ".."），
 * 防止 `path.join(dir, \`${id}.json\`)` 被注入穿越路径。
 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export const SessionIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(SESSION_ID_RE, "会话 ID 含非法字符（仅允许字母数字与 . _ -，且不能以符号开头）");
export const ChatStreamSchema = z.object({
  message: z.string(),
  sessionId: SessionIdSchema.optional(),
  /** build=允许执行工具；plan=只读规划（仅放行只读工具）。 */
  mode: AgentModeSchema.optional(),
  /** 推理等级（如 low/medium/high）；由模型参数声明支持值。 */
  reasoningEffort: z.string().max(30).optional(),
});
export const ChatSteerSchema = z.object({
  /** 运行中注入的引导（轮次边界生效，不打断当前输出）。 */
  message: z.string().min(1).max(4000),
  sessionId: SessionIdSchema.optional(),
  /** 客户端生成的引导 id：UI 用它与主进程注入回执对账（同 id 重复提交按覆盖处理）。 */
  steerId: z.string().min(1).max(64).optional(),
});
/**
 * 引导投递结果：accepted=false 时 reason 说明原因（UI 据此保留待发卡，本轮收尾后继续投递）。
 * · no-running 当前没有运行中的回复 · full 队列已满（8 条）· empty 文本为空 · duplicate 同一 id 已在队列
 */
export const ChatSteerResultSchema = z.object({
  accepted: z.boolean(),
  steerId: z.string().optional(),
  reason: z.enum(["no-running", "full", "empty", "duplicate"]).optional(),
});
/** 撤销一条尚未注入的引导（待发卡的「修改 / 撤销删除」动作）。 */
export const ChatSteerCancelSchema = z.object({
  steerId: z.string().min(1).max(64),
  sessionId: SessionIdSchema.optional(),
});
/** 思考时间线节点（持久化用；字段宽进严出，未知字段丢弃）。 */
export const TimelineStepSchema = z.object({
  kind: z.enum(["think", "body", "tool", "plan", "todo", "steer"]),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  detail: z.string().optional(),
  result: z.string().optional(),
  ok: z.boolean().optional(),
  state: z.enum(["running", "done"]).optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  items: z.array(z.object({
    id: z.string(),
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed"]),
  })).max(100).optional(),
});

export const ReadImageSchema = z.object({ path: z.string().min(1).max(2000) });

/** 剪贴板粘贴图片落盘：base64 解码后仅允许图片 MIME/扩名，写入数据目录 pasted-images/。 */
export const SaveImageSchema = z.object({
  dataBase64: z.string().min(1).max(12_000_000),
  mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).optional(),
  name: z.string().max(120).optional(),
});

export const ChatSaveTimelineSchema = z.object({
  sessionId: SessionIdSchema.optional(),
  timeline: z.array(TimelineStepSchema).max(600),
});

export const ChatRollbackSchema = z.object({
  /** 截断到第 N 条持久化消息（保留 [0, keepCount)），用于消息回滚。 */
  keepCount: z.number().int().min(0).max(10_000),
  sessionId: SessionIdSchema.optional(),
});
export const ChatStopSchema = z.object({ sessionId: SessionIdSchema });
export const ChatSendSchema = z.object({ message: z.string(), sessionId: SessionIdSchema.optional() });
/**
 * 会话级「浏览器控制」开关（第二阶段 · 功能1）：
 * 关闭（默认）= browser_* 工具对模型不可见（不进 toolSchemas）且不可执行；
 * 开启 = 按原有权限策略 / 敏感步骤确认流可用。
 * 注意：web_fetch 属于「网络权限域」，不随本开关变化（语义不混用）。
 */
export const BrowserControlSchema = z.object({
  sessionId: SessionIdSchema,
  enabled: z.boolean(),
});
export const PermRespondSchema = z.object({ requestId: z.string(), choice: z.enum(["allow-once", "allow-session", "deny"]) });
export const FileReadSchema = z.object({
  path: z.string().min(1).max(2000),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  /** 目标会话：按会话工作根（工作区/worktree）约束路径；缺省=活动工作区。 */
  sessionId: SessionIdSchema.optional(),
});
export const FileWriteSchema = z.object({
  path: z.string().min(1).max(2000),
  content: z.string(),
  sessionId: SessionIdSchema.optional(),
});
export const BrowserNavigateSchema = z.object({ url: z.string() });
export const BrowserNewTabSchema = z.object({ url: z.string().optional() });
export const BrowserTabIdSchema = z.object({ tabId: z.string().min(1) });
/** 删除会话时一并关闭该会话名下的全部网页（工作区 > 会话 > 网页）。 */
export const BrowserSessionIdSchema = z.object({ sessionId: z.string().min(1).max(128) });
export const BrowserSetOverlaySchema = z.object({ open: z.boolean() });
export const BrowserTabRefSchema = z.object({ tabId: z.string().optional() });
/** 开发者工具开关（缺省作用于当前会话活动标签）。 */
export const BrowserDevToolsSchema = BrowserTabRefSchema;
/** 历史/快捷入口缺图标时，按页面 URL 回抓站点 favicon（主进程抓取并转 data URL）。 */
export const BrowserResolveFaviconSchema = z.object({ url: z.string().min(1).max(4096) });
/** 浏览器扩展安装：path=本地未打包扩展目录；url=Chrome 应用商店链接或 32 位扩展 ID。 */
/** 底部开发者工具面板：open=开合；height=面板高度（缺省沿用上次）。 */
export const BrowserDevToolsPanelSchema = z.object({ open: z.boolean(), height: z.number().int().min(120).max(1200).optional() });
export const BrowserInstallExtensionSchema = z.object({
  path: z.string().min(1).max(4096).optional(),
  url: z.string().min(1).max(4096).optional(),
});
export const BrowserDownloadActionSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["cancel", "open", "showInFolder", "remove"]),
});
export const ProviderModelSchema = z.object({
  id: z.string().min(1).max(200),
  selected: z.boolean().optional(),
  contextWindow: z.number().int().min(0).max(10_000_000).optional(),
  maxOutput: z.number().int().min(0).max(1_000_000).optional(),
  vision: z.boolean().optional(),
  thinking: z.boolean().optional(),
  thinkingEfforts: z.array(z.string().max(30)).max(10).optional(),
  /** 输入模态（模型卡/上游元数据）：text/image/audio/video。 */
  inputModalities: z.array(z.enum(["text", "image", "audio", "video"])).max(4).optional(),
  /** 是否支持函数/工具调用。 */
  functionCalling: z.boolean().optional(),
  /** 是否支持结构化输出（JSON Schema / response_format）。 */
  structuredOutput: z.boolean().optional(),
});
export const ProviderItemSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  provider: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(200),
  apiFormat: z.enum(["auto", "openai", "anthropic"]).optional(),
  rpm: z.number().int().min(1).max(1_000_000).optional(),
  /** 自定义请求头（如代理鉴权 / 特殊 UA）；键值均为字符串，最多 30 条。 */
  headers: z.record(z.string().max(120), z.string().max(2000)).refine((value) => Object.keys(value).length <= 30, { message: "请求头最多 30 条" }).optional(),
  models: z.array(ProviderModelSchema).max(500).optional(),
});
export const ProviderItemIdSchema = z.object({ id: z.string().min(1).max(64) });
export const SessionRefSchema = z.object({ sessionId: SessionIdSchema });
/** 工作区：挂载一个本地项目文件夹；会话归属于工作区，工具根目录取自会话工作区/worktree。 */
export const WorkspaceIdSchema = z.object({ id: z.string().min(1).max(64) });
export const WorkspaceCreateSchema = z.object({
  /** 不传则弹系统选择文件夹对话框。 */
  root: z.string().min(1).max(1024).optional(),
  name: z.string().min(1).max(60).optional(),
});
export const WorkspaceStatusSchema = z.object({ id: z.string().min(1).max(64).optional() });
/** 新建会话：workspaceId=null 表示暂不归属工作区（首次对话时自动落到默认工作区）。 */
export const BindSessionWorkspaceSchema = z.object({
  sessionId: z.string().min(1).max(120).optional(),
  workspaceId: z.string().min(1).max(128),
});
export const NewSessionSchema = z.object({ workspaceId: z.string().min(1).max(128).nullable().optional() });
export const WorktreeSessionSchema = z.object({ sessionId: z.string().min(1).max(120) });
export const WorktreeRemoveSchema = z.object({
  sessionId: z.string().min(1).max(120),
  force: z.boolean().optional(),
  deleteBranch: z.boolean().optional(),
});
export const WorktreeMergeSchema = z.object({
  sessionId: z.string().min(1).max(120),
  message: z.string().max(500).optional(),
});
export const ExtensionToggleSchema = z.object({ id: z.string().min(1).max(120), enabled: z.boolean() });
export const ExtensionIdSchema = z.object({ id: z.string().min(1).max(120) });
export const SkillIdSchema = z.object({ id: z.string().min(1).max(120) });
export const SkillToggleSchema = z.object({ id: z.string().min(1).max(120), enabled: z.boolean() });
export const McpServerIdSchema = z.object({ id: z.string().min(1).max(120) });
export const ApiKeySchema = z.object({
  apiKey: z.string().min(8).max(500),
  providerId: z.string().min(1).max(64).optional(),
});
export const ProviderRefSchema = z.object({ providerId: z.string().min(1).max(64).optional() });
export const McpServerSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  transport: z.enum(["stdio", "http"]).optional(),
  command: z.string().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  env: z.record(z.string().max(2000)).optional(),
  url: z.string().url().max(2000).optional(),
  headers: z.record(z.string().max(2000)).optional(),
  enabled: z.boolean().optional(),
});
/* ───────────────────────── 终端（持久会话，P0 安全门 #2 配套） ───────────────────────── */

/** 终端配置档：不同解释器/工具链环境（cmd / PowerShell / Git Bash / Python / Node / C++）。 */
export const TerminalProfileKeySchema = z.enum(["cmd", "powershell", "gitbash", "python", "node", "cpp"]);

/** 终端实例 ID（主进程签发，UI 只回传；格式固定便于校验与日志排查）。 */
export const TerminalIdSchema = z.string().min(4).max(64).regex(/^term-[A-Za-z0-9_-]+$/);

export const TerminalOpenSchema = z.object({
  sessionId: SessionIdSchema.optional(),
  profile: TerminalProfileKeySchema,
  /** 初始工作目录（必须落在当前会话工作根内；缺省=会话工作根）。 */
  cwd: z.string().max(1024).optional(),
});
export const TerminalInputSchema = z.object({
  terminalId: TerminalIdSchema,
  /** 原始输入（整行命令/按键）；上限 16KB 防止灌爆主进程。 */
  data: z.string().min(1).max(16384),
});
export const TerminalRunSchema = z.object({
  terminalId: TerminalIdSchema,
  command: z.string().min(1).max(8000),
});
export const TerminalInterruptSchema = z.object({ terminalId: TerminalIdSchema });

/* ───────────────────────── 询问用户（ask_user 工具） ───────────────────────── */

export const AskRespondSchema = z.object({
  requestId: z.string().min(1).max(120),
  /** 用户回答（自由文本或所选选项文案）；取消时缺省。 */
  answer: z.string().max(4000).optional(),
  cancelled: z.boolean().optional(),
});

/* ───────────────────────── Agent-Loop（ADR-0010 接线） ───────────────────────── */

export const LoopSetActiveSchema = z.object({ id: z.string().min(1).max(64) });

/* ───────────────────────── 会话压缩（/compact） ───────────────────────── */

/* ───────────────────────── 浏览器工具栏浮层（独立窗口渲染） ───────────────────────── */

/** 浮层种类：更多菜单 / 收藏夹 / 历史记录 / 下载。 */
export const PopoverKindSchema = z.enum(["more", "bookmarks", "history", "downloads", "workspaces"]);

/** 锚点矩形（相对主窗口内容区的 CSS px；主进程换算为屏幕坐标并做边缘翻转/夹取）。 */
export const PopoverAnchorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(1).max(4000),
  height: z.number().finite().min(1).max(4000),
});

export const OpenChromePopoverSchema = z.object({
  kind: PopoverKindSchema,
  anchor: PopoverAnchorSchema,
  /** 界面语言（浮层独立窗口直接按该语言渲染，避免再等偏好异步加载）。 */
  lang: z.enum(["zh-CN", "en-US"]).optional(),
});

/** 浮层内动作：由主进程转发给主窗口渲染层执行（openPage/navigate/savePage/openSettings…）。 */
export const ChromePopoverActionSchema = z.object({
  action: z.string().min(1).max(40),
  payload: z.unknown().optional(),
});

/* ───────────────────────── Agent 会话栏独立窗口（真·小窗化） ───────────────────────── */

/** 打开会话栏独立窗口：可指定要展示的会话（缺省 = 当前会话）。 */
export const OpenAgentWindowSchema = z.object({
  sessionId: z.string().max(128).optional(),
});

/** 图标模式下拖动小窗图标：dx/dy 为屏幕坐标增量（CSS px）。 */
export const MoveAgentWindowSchema = z.object({
  dx: z.number().finite().min(-10000).max(10000),
  dy: z.number().finite().min(-10000).max(10000),
  /** 普通态 Agent 窗口拖动会话阶段：start 记录起点，move 累加位移，end 结束（图标拖动忽略）。 */
  phase: z.enum(["start", "move", "end"]).optional(),
});

export const ChatCompactSchema = z.object({
  sessionId: SessionIdSchema.optional(),
  /** false=只预览（默认）；true=真的把压缩结果写回会话持久化。 */
  apply: z.boolean().optional(),
});

/* ───────────────────────── 书签（浏览器功能面 MVP） ───────────────────────── */

export const BookmarkAddSchema = z.object({
  url: z.string().url().max(2000),
  title: z.string().max(300).optional(),
});
export const BookmarkRemoveSchema = z.object({ id: z.string().min(1).max(120) });

/* ───────────────────────── 页面保存（全文保存） ───────────────────────── */

export const SavePageSchema = z.object({ tabId: z.string().min(1).max(120).optional() });
export const TerminalCloseSchema = z.object({ terminalId: TerminalIdSchema });
export const TerminalHistorySchema = z.object({ terminalId: TerminalIdSchema });

/** 底部面板（全宽终端）占用的高度：原生网页视图必须让出，避免被 DOM 面板遮挡。 */
export const BrowserBottomInsetSchema = z.object({
  bottom: z.number().int().min(0).max(2000),
});

// 收起态宽度可以是 48（图标条）：下限不能沿用拖拽宽度 240，否则收起后原生视图仍让出 240px
export const BrowserSidebarWidthSchema = z.object({
  width: z.number().int().min(0).max(720),
  /** true = 原生网页视图用与 DOM 相同的曲线/时长平滑过渡（收起/展开侧栏、窗口化时保持同拍）。 */
  animate: z.boolean().optional(),
});
export const SettingsListModelsSchema = z.object({
  provider: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  model: z.string().max(200),
  apiFormat: z.enum(["auto", "openai", "anthropic"]).optional(),
  /** 表单里刚输入、尚未保存的密钥（仅本次探测使用，不落盘不回显）。 */
  apiKey: z.string().max(500).optional(),
  /** 探测模型列表时的自定义请求头（仅本次探测使用，不落盘）。 */
  headers: z.record(z.string().max(120), z.string().max(2000)).refine((value) => Object.keys(value).length <= 30, { message: "请求头最多 30 条" }).optional(),
});
export const PickPathSchema = z.object({
  kind: z.enum(["file", "directory"]),
  title: z.string().max(120).optional(),
});
export const BrowserScreenshotSchema = z.object({ selector: z.string().optional() });

/**
 * Provider（模型服务商）配置：只包含非机密字段。
 * 为什么 apiKey 不在此 schema：密钥不落盘（前期准备 §4 安全门：apiKey 加密存储前先走环境变量），
 * 配置通道只负责 baseUrl/model/provider 三个可公开字段。
 */
export const SettingsProviderSchema = z.object({
  provider: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(200),
  /** 测试连接：被测供应商的 id（据此取该供应商自己的密钥；缺省会按 provider+baseUrl 匹配）。 */
  id: z.string().max(200).optional(),
  /** 测试连接：表单里刚输入、尚未保存的密钥（只用于本次探测，不落盘、不回显）。 */
  apiKey: z.string().max(2000).optional(),
  /** 测试连接所用端点协议（auto 按 baseUrl 推断；anthropic 走 /messages）。 */
  apiFormat: z.enum(["auto", "openai", "anthropic"]).optional(),
  /** 测试连接时的自定义请求头（模板与聊天一致；不落盘）。 */
  headers: z.record(z.string().max(120), z.string().max(2000)).refine((value) => Object.keys(value).length <= 30, { message: "请求头最多 30 条" }).optional(),
});

/** 通用偏好（设置 · 通用）。 */
export const PreferencesSchema = z.object({
  language: z.enum(["zh-CN", "en-US"]),
  /** 广告/追踪请求拦截（webRequest 层；默认开启，可在设置·通用关闭）。 */
  adBlockEnabled: z.boolean().optional(),
  /** 动效强度：full=全部；reduced=弱化；off=关闭（无障碍）。 */
  animations: z.enum(["full", "reduced", "off"]),
  /** 启动时恢复上次会话（当前为占位开关，会话持久化接入后生效）。 */
  restoreSession: z.boolean(),
  searchEngine: z.enum(["bing", "google", "baidu"]),
  /** 下载目录（空 = 用户下载文件夹）。 */
  downloadDir: z.string().max(1024).optional(),
  /** 工作区根（空 = 启动目录）；影响规则查找与沙箱根。 */
  workspaceRoot: z.string().max(1024).optional(),
  /** 记忆库文件路径（空 = 默认数据目录下 memory/memory.json）。 */
  memoryStorePath: z.string().max(1024).optional(),
  /** 会话结束时自动从对话抽取记忆。 */
  memoryAutoCapture: z.boolean(),
  /** 右侧 Agent 面板宽度（可拖拽调整，持久化）。 */
  sidebarWidth: z.number().int().min(240).max(720),
  /** Vibecoding 模式侧栏宽度（独立于标准宽度；约标准最小宽度的一半~3/5）。 */
  vibeSidebarWidth: z.number().int().min(100).max(720).optional(),
  /** 界面主题：soft=柔和无框（默认）/ classic=旧版条框观感。 */
  theme: z.enum(["soft", "classic"]).optional(),
  /** 右侧会话栏模式：docked=常驻 / collapsed=收起成图标条 / float=小窗化浮动卡片。 */
  sidebarMode: z.enum(["docked", "collapsed", "float"]).optional(),
  /**
   * Agent 打开网页时的窗口布局（浏览器控制开启的会话，Agent 第一次打开网页前生效）：
   * ask=每次会话询问一次（默认，弹窗里解释两种布局并给选择）；
   * docked=自动把会话收齐到右侧、恢复常规布局（网页占主区）；
   * agentWindow=自动把会话变为小窗（独立 Agent 窗口，ADR-0020）；
   * keep=不动当前布局，也不询问。
   */
  // 首启向导选一次，之后在设置里改；不再有「每次询问」策略（用户决定 m00974）。
    browserOpenLayout: z.enum(["docked", "agentWindow", "keep"]).optional(),
  /** Agent 单次任务最多请求轮数。 */
  agentMaxRounds: z.number().int().min(1).max(500).optional(),
  /** Agent 单次任务最多工具调用次数。 */
  agentMaxToolCalls: z.number().int().min(1).max(2000).optional(),
  /** 相同工具+参数重复调用的提醒阈值（默认 5）。 */
  agentRepeatToolWarn: z.number().int().min(2).max(50).optional(),
  /** 相同工具+参数重复调用的停止阈值（默认 30）。 */
  agentRepeatToolStop: z.number().int().min(3).max(200).optional(),
  /** 推理强度（空 = 模型默认；取值随模型，持久化到偏好以便重启保持）。 */
  reasoningEffort: z.string().max(64).optional(),
  /** 当前 Agent-Loop id（缺省 = 内置 loop）；自定义 loop 接线后持久化选择。 */
  loopId: z.string().max(64).optional(),
  /** 敏感步骤（登录/支付/不可撤销操作）是否始终强制人工确认（默认 true，写死规则兜底）。 */
  sensitiveAlwaysConfirm: z.boolean().optional(),
});

/** 通用偏好的推断类型（契约单源）：core 的默认值/合并与 UI 的 types.d.ts 都消费这一份。 */
export type PreferencesData = z.infer<typeof PreferencesSchema>;

/** 权限策略（设置 · 权限）：工具类别的默认决策。 */
export const PermissionsSchema = z.object({
  read: z.enum(["allow", "confirm", "deny"]),
  write: z.enum(["allow", "confirm", "deny"]),
  terminal: z.enum(["allow", "confirm", "deny"]),
  network: z.enum(["allow", "confirm", "deny"]),
  /**
   * 浏览器操作（Agent 操控内嵌浏览器）：策略层独立档，比 network 更具体，默认 allow。
   * 必须写进契约：handleTrusted 用本 schema 校验后把 **parsed.data**（z.object 会剥掉未声明字段）交给 handler，
   * 漏了这里，UI 选的 browser=confirm/deny 会在 IPC 边界被静默丢掉、回落默认值。
   */
  browser: z.enum(["allow", "confirm", "deny"]),
  /** 额外授权的工作目录（沙箱根之外）。 */
  workspaceRoots: z.array(z.string().max(1024)).max(20),
  /** 危险命令/敏感路径始终二次确认（不随 allow 放行）。 */
  confirmDangerousAlways: z.boolean(),
});

/** 规则文件（设置 · 规则）：AGENTS.md 约定（项目根逐级向上 + 全局规则）。 */
/** 规则条目（逐条增删，替代原先的「两个大文本框」）。 */
export const RuleEntrySchema = z.object({
  /** 全局规则的文件名（AGENTS.md 风格）；项目规则固定名。新建时缺省。 */
  name: z.string().min(1).max(64).optional(),
  scope: z.enum(["global", "workspace"]),
  enabled: z.boolean(),
  content: z.string().max(32768),
});

export const RulesPayloadSchema = z.object({
  /** 当前全量条目（upsert 语义：按 name+scope 匹配）。 */
  entries: z.array(RuleEntrySchema).max(30),
  /** 需要删除的条目键（scope:name）。 */
  deleted: z.array(z.string().max(80)).max(30).optional(),
});

/** 记忆条目（设置 · 记忆 / 自动汇总）。 */
export const MemoryAddSchema = z.object({
  content: z.string().min(1).max(5000),
  category: z.string().min(1).max(40),
  tags: z.array(z.string().max(24)).max(10).optional(),
  importance: z.number().int().min(1).max(10).optional(),
});
export const MemoryUpdateSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1).max(5000).optional(),
  category: z.string().min(1).max(40).optional(),
  tags: z.array(z.string().max(24)).max(10).optional(),
  importance: z.number().int().min(1).max(10).optional(),
});
export const MemoryDeleteSchema = z.object({ id: z.string().min(1) });

/**
 * ChannelBinding defines the structure of a communication channel.
 * domain: The domain/category of the channel (e.g., "chat", "perm")
 * method: The method/action name (e.g., "stream", "read")
 * request: Zod schema for the request payload, or null if no request payload
 * sensitive: Whether the channel is sensitive (requires special handling)
 */
export type ChannelBinding = {
  domain: string;
  method: string;
  request: z.ZodTypeAny | null; // Zod schema for request payload, or null
  sensitive: boolean;
};

/**
 * CHANNEL_BINDINGS: All supported communication channels.
 * 12 channels, all marked sensitive (true).
 * Each channel has a domain, method, request schema (or null), and sensitive flag.
 */
export const CHANNEL_BINDINGS: Record<string, ChannelBinding> = {
  "chat:stream": {
    domain: "chat",
    method: "stream",
    request: ChatStreamSchema,
    sensitive: true,
  },
  "chat:steer": {
    domain: "chat",
    method: "steer",
    request: ChatSteerSchema,
    sensitive: true,
  },
  "chat:steerCancel": {
    domain: "chat",
    method: "steerCancel",
    request: ChatSteerCancelSchema,
    sensitive: true,
  },
  "chat:rollback": {
    domain: "chat",
    method: "rollback",
    request: ChatRollbackSchema,
    sensitive: true,
  },
  "fs:readImage": {
    domain: "fs",
    method: "readImage",
    request: ReadImageSchema,
    sensitive: true,
  },
  "fs:saveImage": {
    domain: "fs",
    method: "saveImage",
    request: SaveImageSchema,
    sensitive: true,
  },
  "chat:saveTimeline": {
    domain: "chat",
    method: "saveTimeline",
    request: ChatSaveTimelineSchema,
    sensitive: true,
  },
  "chat:stop": {
    domain: "chat",
    method: "stop",
    request: ChatStopSchema,
    sensitive: true,
  },
  "chat:send": {
    domain: "chat",
    method: "send",
    request: ChatSendSchema,
    sensitive: true,
  },
  "perm:respond": {
    domain: "perm",
    method: "respond",
    request: PermRespondSchema,
    sensitive: true,
  },
  "file:read": {
    domain: "workspace",
    method: "read",
    request: FileReadSchema,
    sensitive: true,
  },
  "file:write": {
    domain: "workspace",
    method: "write",
    request: FileWriteSchema,
    sensitive: true,
  },
  "agents:list": {
    domain: "agents",
    method: "list",
    request: null,
    sensitive: true,
  },
  "app:version": {
    domain: "runtime",
    method: "version",
    request: null,
    sensitive: true,
  },
  "boot:status": {
    domain: "runtime",
    method: "status",
    request: null,
    sensitive: true,
  },
  "browser:navigate": {
    domain: "browser",
    method: "navigate",
    request: BrowserNavigateSchema,
    sensitive: true,
  },
  "browser:screenshot": {
    domain: "browser",
    method: "screenshot",
    request: BrowserScreenshotSchema,
    sensitive: true,
  },
  "browser:snapshot": {
    domain: "browser",
    method: "snapshot",
    request: null,
    sensitive: true,
  },
  "browser:newTab": {
    domain: "browser",
    method: "newTab",
    request: BrowserNewTabSchema,
    sensitive: true,
  },
  "browser:closeTab": {
    domain: "browser",
    method: "closeTab",
    request: BrowserTabIdSchema,
    sensitive: true,
  },
  "browser:closeSessionTabs": {
    domain: "browser",
    method: "closeSessionTabs",
    request: BrowserSessionIdSchema,
    sensitive: true,
  },
  "browser:selectTab": {
    domain: "browser",
    method: "selectTab",
    request: BrowserTabIdSchema,
    sensitive: true,
  },
  "browser:resolveFavicon": {
    domain: "browser",
    method: "resolveFavicon",
    request: BrowserResolveFaviconSchema,
    sensitive: true,
  },
  "browser:listTabs": {
    domain: "browser",
    method: "listTabs",
    request: null,
    sensitive: true,
  },
  "browser:setOverlay": {
    domain: "browser",
    method: "setOverlay",
    request: BrowserSetOverlaySchema,
    sensitive: true,
  },
  "settings:listModels": {
    domain: "settings",
    method: "listModels",
    request: SettingsListModelsSchema,
    sensitive: true,
  },
  "dialog:pickPath": {
    domain: "dialog",
    method: "pickPath",
    request: PickPathSchema,
    sensitive: true,
  },
  "browser:setSidebarWidth": {
    domain: "browser",
    method: "setSidebarWidth",
    request: BrowserSidebarWidthSchema,
    sensitive: true,
  },
  "browser:setBottomInset": {
    domain: "browser",
    method: "setBottomInset",
    request: BrowserBottomInsetSchema,
    sensitive: true,
  },
  "memory:list": {
    domain: "memory",
    method: "list",
    request: null,
    sensitive: true,
  },
  "memory:add": {
    domain: "memory",
    method: "add",
    request: MemoryAddSchema,
    sensitive: true,
  },
  "memory:update": {
    domain: "memory",
    method: "update",
    request: MemoryUpdateSchema,
    sensitive: true,
  },
  "memory:delete": {
    domain: "memory",
    method: "delete",
    request: MemoryDeleteSchema,
    sensitive: true,
  },
  "memory:stats": {
    domain: "memory",
    method: "stats",
    request: null,
    sensitive: true,
  },
  "memory:clear": {
    domain: "memory",
    method: "clear",
    request: null,
    sensitive: true,
  },
  "chat:history": {
    domain: "chat",
    method: "history",
    request: null,
    sensitive: true,
  },
  "settings:getProvider": {
    domain: "settings",
    method: "getProvider",
    request: null,
    sensitive: true,
  },
  "settings:setProvider": {
    domain: "settings",
    method: "setProvider",
    request: SettingsProviderSchema,
    sensitive: true,
  },
  "window:minimize": {
    domain: "window",
    method: "minimize",
    request: null,
    sensitive: true,
  },
  "window:maximize": {
    domain: "window",
    method: "maximize",
    request: null,
    sensitive: true,
  },
  "window:close": {
    domain: "window",
    method: "close",
    request: null,
    sensitive: true,
  },
  "window:state": {
    domain: "window",
    method: "state",
    request: null,
    sensitive: true,
  },
  "settings:getPreferences": {
    domain: "settings",
    method: "getPreferences",
    request: null,
    sensitive: true,
  },
  "settings:setPreferences": {
    domain: "settings",
    method: "setPreferences",
    request: PreferencesSchema,
    sensitive: true,
  },
  "settings:getPermissions": {
    domain: "settings",
    method: "getPermissions",
    request: null,
    sensitive: true,
  },
  "settings:setPermissions": {
    domain: "settings",
    method: "setPermissions",
    request: PermissionsSchema,
    sensitive: true,
  },
  "settings:clearProvider": {
    domain: "settings",
    method: "clearProvider",
    request: null,
    sensitive: true,
  },
  "settings:testProvider": {
    domain: "settings",
    method: "testProvider",
    request: SettingsProviderSchema,
    sensitive: true,
  },
  "settings:getRules": {
    domain: "settings",
    method: "getRules",
    request: null,
    sensitive: true,
  },
  "settings:setRules": {
    domain: "settings",
    method: "setRules",
    request: RulesPayloadSchema,
    sensitive: true,
  },
  "settings:diagnostics": {
    domain: "settings",
    method: "diagnostics",
    request: null,
    sensitive: true,
  },
  "settings:about": {
    domain: "settings",
    method: "about",
    request: null,
    sensitive: true,
  },
  "browser:back": {
    domain: "browser",
    method: "back",
    request: BrowserTabRefSchema,
    sensitive: true,
  },
  "browser:forward": {
    domain: "browser",
    method: "forward",
    request: BrowserTabRefSchema,
    sensitive: true,
  },
  "browser:reload": {
    domain: "browser",
    method: "reload",
    request: BrowserTabRefSchema,
    sensitive: true,
  },
  "browser:setDevToolsPanel": {
    domain: "browser",
    method: "setDevToolsPanel",
    request: BrowserDevToolsPanelSchema,
    sensitive: true,
  },
  "browser:toggleDevTools": {
    domain: "browser",
    method: "toggleDevTools",
    request: BrowserDevToolsSchema,
    sensitive: true,
  },
  "browser:listExtensions": {
    domain: "browser",
    method: "listExtensions",
    request: null,
    sensitive: true,
  },
  "browser:installExtension": {
    domain: "browser",
    method: "installExtension",
    request: BrowserInstallExtensionSchema,
    sensitive: true,
  },
  "browser:removeExtension": {
    domain: "browser",
    method: "removeExtension",
    request: z.object({ id: z.string().min(1).max(64) }),
    sensitive: true,
  },
  "browser:history": {
    domain: "browser",
    method: "history",
    request: BrowserTabRefSchema,
    sensitive: true,
  },
  /** 删除选中的全局历史条目（urls 为 list() 里的 url；批量、幂等）。 */
  "browser:historyRemove": {
    domain: "browser",
    method: "historyRemove",
    request: z.object({ urls: z.array(z.string().min(1).max(4096)).min(1).max(500) }),
    sensitive: true,
  },
  "browser:downloads": {
    domain: "browser",
    method: "downloads",
    request: null,
    sensitive: true,
  },
  "browser:downloadAction": {
    domain: "browser",
    method: "downloadAction",
    request: BrowserDownloadActionSchema,
    sensitive: true,
  },
  "settings:setApiKey": {
    domain: "settings",
    method: "setApiKey",
    request: ApiKeySchema,
    sensitive: true,
  },
  "settings:clearApiKey": {
    domain: "settings",
    method: "clearApiKey",
    request: ProviderRefSchema,
    sensitive: true,
  },
  "settings:listProviders": {
    domain: "settings",
    method: "listProviders",
    request: null,
    sensitive: true,
  },
  "settings:upsertProvider": {
    domain: "settings",
    method: "upsertProvider",
    request: ProviderItemSchema,
    sensitive: true,
  },
  "settings:removeProvider": {
    domain: "settings",
    method: "removeProvider",
    request: ProviderItemIdSchema,
    sensitive: true,
  },
  "settings:setActiveProvider": {
    domain: "settings",
    method: "setActiveProvider",
    request: ProviderItemIdSchema,
    sensitive: true,
  },
  "chat:sessions": {
    domain: "chat",
    method: "sessions",
    request: null,
    sensitive: true,
  },
  "chat:newSession": {
    domain: "chat",
    method: "newSession",
    request: NewSessionSchema,
    sensitive: true,
  },
  "chat:switchSession": {
    domain: "chat",
    method: "switchSession",
    request: SessionRefSchema,
    sensitive: true,
  },
  "chat:deleteSession": {
    domain: "chat",
    method: "deleteSession",
    request: SessionRefSchema,
    sensitive: true,
  },

  /* ── 会话级浏览器控制（功能1：关闭时 browser_* 工具对模型不可见） ── */
  "chat:setBrowserControl": {
    domain: "chat",
    method: "setBrowserControl",
    request: BrowserControlSchema,
    sensitive: true,
  },
  "workspace:list": {
    domain: "workspace",
    method: "list",
    request: null,
    sensitive: true,
  },
  "workspace:create": {
    domain: "workspace",
    method: "create",
    request: WorkspaceCreateSchema,
    sensitive: true,
  },
  "workspace:bindSession": {
    domain: "workspace",
    method: "bindSession",
    request: BindSessionWorkspaceSchema,
    sensitive: true,
  },
  "workspace:select": {
    domain: "workspace",
    method: "select",
    request: WorkspaceIdSchema,
    sensitive: true,
  },
  /** 重命名工作区（仅改显示名，不动磁盘目录）。 */
  "workspace:rename": {
    domain: "workspace",
    method: "rename",
    request: z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(64) }),
    sensitive: true,
  },
  /** 在系统文件管理器中打开工作区根目录。 */
  "workspace:openFolder": {
    domain: "workspace",
    method: "openFolder",
    request: z.object({ id: z.string().min(1).max(128) }),
    sensitive: true,
  },
  "workspace:remove": {
    domain: "workspace",
    method: "remove",
    request: WorkspaceIdSchema,
    sensitive: true,
  },
  "workspace:status": {
    domain: "workspace",
    method: "status",
    request: WorkspaceStatusSchema,
    sensitive: true,
  },
  "worktree:create": {
    domain: "worktree",
    method: "create",
    request: WorktreeSessionSchema,
    sensitive: true,
  },
  "worktree:remove": {
    domain: "worktree",
    method: "remove",
    request: WorktreeRemoveSchema,
    sensitive: true,
  },
  "worktree:diff": {
    domain: "worktree",
    method: "diff",
    request: WorktreeSessionSchema,
    sensitive: true,
  },
  "worktree:merge": {
    domain: "worktree",
    method: "merge",
    request: WorktreeMergeSchema,
    sensitive: true,
  },
  "extensions:list": {
    domain: "extensions",
    method: "list",
    request: null,
    sensitive: true,
  },
  "extensions:setEnabled": {
    domain: "extensions",
    method: "setEnabled",
    request: ExtensionToggleSchema,
    sensitive: true,
  },
  "extensions:remove": {
    domain: "extensions",
    method: "remove",
    request: ExtensionIdSchema,
    sensitive: true,
  },
  "extensions:start": {
    domain: "extensions",
    method: "start",
    request: ExtensionIdSchema,
    sensitive: true,
  },
  "extensions:stop": {
    domain: "extensions",
    method: "stop",
    request: ExtensionIdSchema,
    sensitive: true,
  },
  "extensions:openDir": {
    domain: "extensions",
    method: "openDir",
    request: null,
    sensitive: true,
  },
  "skills:list": {
    domain: "skills",
    method: "list",
    request: null,
    sensitive: true,
  },
  "skills:reload": {
    domain: "skills",
    method: "reload",
    request: null,
    sensitive: true,
  },
  "skills:setEnabled": {
    domain: "skills",
    method: "setEnabled",
    request: SkillToggleSchema,
    sensitive: true,
  },
  "skills:openDir": {
    domain: "skills",
    method: "openDir",
    request: null,
    sensitive: true,
  },
  "mcp:list": {
    domain: "mcp",
    method: "list",
    request: null,
    sensitive: true,
  },
  "mcp:add": {
    domain: "mcp",
    method: "add",
    request: McpServerSchema,
    sensitive: true,
  },
  "mcp:remove": {
    domain: "mcp",
    method: "remove",
    request: McpServerIdSchema,
    sensitive: true,
  },
  "mcp:connect": {
    domain: "mcp",
    method: "connect",
    request: McpServerIdSchema,
    sensitive: true,
  },
  "mcp:disconnect": {
    domain: "mcp",
    method: "disconnect",
    request: McpServerIdSchema,
    sensitive: true,
  },

  /* ── 终端（持久会话） ── */
  "terminal:profiles": {
    domain: "terminal",
    method: "profiles",
    request: null,
    sensitive: true,
  },
  "terminal:list": {
    domain: "terminal",
    method: "list",
    request: null,
    sensitive: true,
  },
  "terminal:open": {
    domain: "terminal",
    method: "open",
    request: TerminalOpenSchema,
    sensitive: true,
  },
  "terminal:input": {
    domain: "terminal",
    method: "input",
    request: TerminalInputSchema,
    sensitive: true,
  },
  "terminal:run": {
    domain: "terminal",
    method: "run",
    request: TerminalRunSchema,
    sensitive: true,
  },
  "terminal:interrupt": {
    domain: "terminal",
    method: "interrupt",
    request: TerminalInterruptSchema,
    sensitive: true,
  },
  "terminal:close": {
    domain: "terminal",
    method: "close",
    request: TerminalCloseSchema,
    sensitive: true,
  },

  /* ── 询问用户（Agent 工具） ── */
  "ask:respond": {
    domain: "ask",
    method: "respond",
    request: AskRespondSchema,
    sensitive: true,
  },

  /* ── 浏览器工具栏浮层（独立子窗口渲染；不遮挡原生网页视图） ── */
  "ui:openPopover": {
    domain: "ui",
    method: "openPopover",
    request: OpenChromePopoverSchema,
    sensitive: true,
  },
  /**
   * 原子 toggle：已打开则关闭，否则打开。
   * 为什么需要：浮层是独立子窗口，点击触发按钮会让子窗口失焦→触发 blur→关闭，
   * 等渲染层 click 回调再判断「当前是否打开」时状态已被清掉 → 关→开连闪（用户 m02263）。
   * 把判断放到主进程，避免跨窗口事件竞态。
   */
  "ui:togglePopover": {
    domain: "ui",
    method: "togglePopover",
    request: OpenChromePopoverSchema,
    sensitive: true,
  },
  "ui:closePopover": {
    domain: "ui",
    method: "closePopover",
    request: null,
    sensitive: true,
  },
  "ui:popoverAction": {
    domain: "ui",
    method: "popoverAction",
    request: ChromePopoverActionSchema,
    sensitive: true,
  },

  /* ── Agent 会话栏独立窗口（真·窗口化：独立 BrowserWindow，可拖动/缩放/最小化） ── */
  "ui:openAgentWindow": {
    domain: "ui",
    method: "openAgentWindow",
    request: OpenAgentWindowSchema,
    sensitive: true,
  },
  "ui:closeAgentWindow": {
    domain: "ui",
    method: "closeAgentWindow",
    request: null,
    sensitive: true,
  },
  "ui:minimizeAgentWindow": {
    domain: "ui",
    method: "minimizeAgentWindow",
    request: null,
    sensitive: true,
  },
  /** 拖动普通态 Agent 窗口（自绘标题栏拖拽；只允许 Agent 窗口自身调用）。 */
  "ui:dragAgentWindow": {
    domain: "ui",
    method: "dragAgentWindow",
    request: MoveAgentWindowSchema,
    sensitive: true,
  },
  /** 图标模式下还原小窗（点击图标按钮 → 只允许 Agent 窗口自身调用）。 */
  "ui:restoreAgentWindow": {
    domain: "ui",
    method: "restoreAgentWindow",
    request: null,
    sensitive: true,
  },
  /** 图标模式下拖动小窗（只允许 Agent 窗口自身调用）。 */
  "ui:moveAgentWindow": {
    domain: "ui",
    method: "moveAgentWindow",
    request: MoveAgentWindowSchema,
    sensitive: true,
  },

  /* ── 会话压缩（/compact，真实压缩持久化） ── */
  "chat:compact": {
    domain: "chat",
    method: "compact",
    request: ChatCompactSchema,
    sensitive: true,
  },

  /* ── Agent-Loop（ADR-0010：内置 loop + 安全回退 + 选择） ── */
  "loop:list": {
    domain: "loop",
    method: "list",
    request: null,
    sensitive: true,
  },
  "loop:setActive": {
    domain: "loop",
    method: "setActive",
    request: LoopSetActiveSchema,
    sensitive: true,
  },
  "loop:reload": {
    domain: "loop",
    method: "reload",
    request: null,
    sensitive: true,
  },

  /* ── 书签 ── */
  "bookmarks:list": {
    domain: "bookmarks",
    method: "list",
    request: null,
    sensitive: true,
  },
  "bookmarks:add": {
    domain: "bookmarks",
    method: "add",
    request: BookmarkAddSchema,
    sensitive: true,
  },
  "bookmarks:remove": {
    domain: "bookmarks",
    method: "remove",
    request: BookmarkRemoveSchema,
    sensitive: true,
  },

  /* ── 页面保存（全文保存） ── */
  "browser:savePage": {
    domain: "browser",
    method: "savePage",
    request: SavePageSchema,
    sensitive: true,
  },
  "terminal:history": {
    domain: "terminal",
    method: "history",
    request: TerminalHistorySchema,
    sensitive: true,
  },
  "terminal:diagnose": {
    domain: "terminal",
    method: "diagnose",
    request: null,
    sensitive: true,
  },
};

 /**
  * EVENTS: List of all event names used in the system.
  * These are used for event bus and logging.
  */
export const EVENTS = [
  "chat:stream:chunk",
  "chat:stream:reasoning",
  "chat:stream:tool",
  "chat:stream:tool_start",
  "chat:stream:progress",
  "chat:stream:done",
  "chat:stream:error",
  "chat:stream:heartbeat",
  "chat:steer:applied",
  "perm:request",
  "boot:ready",
  "browser:tabs",
  "browser:downloads",
  "memory:updated",
  "extensions:updated",
  "skills:updated",
  "mcp:updated",
  "terminal:data",
  "terminal:exit",
  "terminal:state",
  "ask:user",
  "loop:fallback",
  "loop:changed",
  "chrome:popoverAction",
  "chrome:popoverClosed",
  "chrome:dismissPopovers",
  "chrome:devToolsPanel",
  /**
   * Agent 正在操控浏览器的实时活动（{ sessionId?, tool, phase: "start" | "end" }）。
   * 渲染层据此：① 当前会话只在动作期间显示浏览器边框呼吸灯；② 把操作中的标签切到可见。
   * 注意：跨会话只更新「该会话正在忙」的状态，绝不切走用户正在看的会话（会话隔离）。
   */
  "chrome:agentActivity",
  "chrome:agentWindowClosed",
  "chrome:agentWindowIconMode",
  "chrome:agentWindowTransition",
  /**
   * Agent 首次打开网页前的「会话窗口布局」安排（第二阶段 Slice E · 功能②）：
   * 壳层询问/记忆完成后推送 { mode: "docked" | "agentWindow"; sessionId?; reason? }，
   * 渲染层据此执行真正的窗口动作（收小窗 / 恢复右侧常驻）。
   */
  "chrome:applyLayout",
  "chat:compacted",
] as const;

/**
 * Type for event names (string literal union).
 */
export type EventName = typeof EVENTS[number];

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
];