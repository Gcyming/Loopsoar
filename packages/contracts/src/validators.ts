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
/**
 * 会话分支：把源会话的前 keepCount 条消息复制成一个新会话（从指定阶段另开一方向）。
 * 不继承运行态（allow-session 白名单、流、压缩状态），消息前缀逐条一致。
 */
export const ChatRenameSessionSchema = z.object({ sessionId: SessionIdSchema, title: z.string().min(1).max(80) });
export const ChatForkSchema = z.object({
  sessionId: SessionIdSchema.optional(),
  keepCount: z.number().int().min(0).max(10_000),
  title: z.string().min(1).max(80).optional(),
});
export const ChatStopSchema = z.object({ sessionId: SessionIdSchema });
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
export const BrowserNavigateSchema = z.object({ url: z.string() });
export const BrowserNewTabSchema = z.object({ url: z.string().optional() });
export const BrowserTabIdSchema = z.object({ tabId: z.string().min(1) });
/** 删除会话时一并关闭该会话名下的全部网页（工作区 > 会话 > 网页）。 */
export const BrowserSessionIdSchema = z.object({ sessionId: z.string().min(1).max(128) });
export const BrowserCornerColorSchema = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) });
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
}).superRefine((value, ctx) => {
  // 传输方式缺省按「有 url 即 http，否则 stdio」，与 core/mcp 的旧行为一致；
  // 校验必须放在契约层，否则 IPC 边界会放行 http 无 url / stdio 无 command 的配置。
  const transport = value.transport ?? (value.url ? "http" : "stdio");
  if (transport === "http" && !value.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "HTTP 传输需要 url" });
  }
  if (transport === "stdio" && !value.command) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stdio 传输需要 command" });
  }
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
export const PopoverKindSchema = z.enum(["more", "bookmarks", "history", "downloads", "workspaces", "workspace"]);

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
  /** 任务成功后自动生成低置信度技能候选（默认关闭；候选默认禁用，需人工启用）。 */
  skillAutoCandidate: z.boolean().optional(),
  /** 右侧 Agent 面板宽度（可拖拽调整，持久化）。 */
  sidebarWidth: z.number().int().min(240).max(720),
  /** Vibecoding 模式侧栏宽度（独立于标准宽度；约标准最小宽度的一半~3/5）。 */
  vibeSidebarWidth: z.number().int().min(100).max(720).optional(),
  /** 界面主题：soft=柔和无框（默认）/ classic=旧版条框观感。 */
  theme: z.enum(["soft", "classic"]).optional(),
  /** 右侧会话栏模式：docked=常驻 / collapsed=收起成图标条；小窗化是动作，不是持久化状态。 */
  sidebarMode: z.enum(["docked", "collapsed"]).optional(),
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

/** 权限策略的推断类型：UI/壳层/服务统一消费，禁止再手写一份。 */
export type Permissions = z.infer<typeof PermissionsSchema>;

/** 规则文件（设置 · 规则）：AGENTS.md 约定（项目根逐级向上 + 全局规则）。 */
/** 规则条目（逐条增删，替代原先的「两个大文本框」）。 */
export const RuleEntrySchema = z.object({
  /** 全局规则的文件名（AGENTS.md 风格）；项目规则固定名。新建时缺省。 */
  name: z.string().min(1).max(64).optional(),
  scope: z.enum(["global", "workspace"]),
  enabled: z.boolean(),
  content: z.string().max(32768),
  /** 项目规则所属工作区（未给 = 旧行为：settings.workspaceRoot）。 */
  workspaceId: z.string().min(1).max(80).optional(),
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
  /** 归属工作区（D1）；缺省 = default。 */
  workspaceId: z.string().min(1).max(120).optional(),
});
export const MemoryUpdateSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1).max(5000).optional(),
  category: z.string().min(1).max(40).optional(),
  tags: z.array(z.string().max(24)).max(10).optional(),
  importance: z.number().int().min(1).max(10).optional(),
});
export const MemoryDeleteSchema = z.object({ id: z.string().min(1) });

/** M4 时间回放：at = 回放时刻（毫秒时间戳）；缺省 = 现在。 */
/** 回顾命名（LLM）：apply=false 只出建议，true 才落库。 */
export const MemoryReviewSchema = z.object({ apply: z.boolean().optional() }).nullish();

/** 回顾合并：确认后按组合并（每组 2-3 个 id）。 */
export const MemoryMergeSchema = z
  .object({
    groups: z
      .array(z.object({ ids: z.array(z.string().min(1)).min(2).max(3), reason: z.string().max(80).optional() }))
      .max(12),
  })
  .optional();

export const MemoryGraphSchema = z.object({ at: z.number().int().nonnegative().optional() }).optional();

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
