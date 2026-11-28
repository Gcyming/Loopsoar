/**
 * 轻量 i18n（zh-CN / en-US）：词典 + 纯函数 t() + 可订阅的当前语言。
 *
 * 为什么不用第三方：需求只是「中英两套界面文案 + 即时切换」，i18next 这类库
 * 体积与复杂度都不划算。这里保持零依赖、纯函数可单测。
 *
 * 语言来源分两层（避免启动闪烁）：
 *   1. 渲染层缓存（localStorage 'loopsoar_lang'）：上次选择，供 getInitialLang() 兜底；
 *   2. 真正的单一产地是 preferences.language：App 加载偏好后调用 setLanguage() 覆盖，
 *      设置页切换语言时也直接调用 setLanguage()，所有 useLanguage() 组件即时重渲染。
 *
 * 约定：词典 key 用点分命名空间；`{name}` 占位符由 t() 的 params 替换。
 */
import * as React from "react";
import { SETTINGS_I18N } from "./i18nSettings.js";
import { BROWSER_I18N } from "./i18nBrowser.js";
import { CHROME_PAGE_I18N } from "./i18nChrome.js";

export type Lang = "zh-CN" | "en-US";

export const DEFAULT_LANG: Lang = "zh-CN";
const STORAGE_KEY = "loopsoar_lang";

/** 词典：只覆盖已接入 i18n 的组件文案（不要求全站翻译）。 */
const DICT: Record<Lang, Record<string, string>> = {
  "zh-CN": {
    // 通用
    "common.back": "上一步",
    "common.next": "下一步",
    "common.skip": "跳过",

    // 标题栏
    "titlebar.minimize": "最小化",
    "titlebar.minimizeAgent": "最小化（收起为图标）",
    "titlebar.maximize": "最大化",
    "titlebar.restore": "还原",
    "titlebar.close": "关闭",

    // 上下文环
    "contextRing.title": "上下文消耗：{used} / {cap} tokens（{pct}%）",
    "contextRing.loading": " · 生成中，数值随输出推进",

    // 输入区
    "composer.placeholder": "输入消息（Enter 发送，Shift+Enter 换行；/ 打开命令，@ 引用文件）",
    "composer.send": "发送（Enter）",
    "composer.queueSend": "发送（运行中 = 先排队，本轮结束后自动发出）",
    "composer.stop": "停止生成",
    "composer.pause": "暂停",
    "composer.paused": "已暂停",
    "composer.running": "运行中",
    "composer.runningHint": "暂停会在当前步骤结束后生效",
    "composer.pausedHint": "恢复前确认期间是否有改动",
    "composer.terminate": "终止",
    "composer.noChanges": "无改动，继续",
    "composer.resumeQuestion": "暂停期间有改动吗？无改动可直接继续；有改动请写下，恢复后按新要求执行。",
    "composer.resumePlaceholder": "例如：不要提交订单，改为先把价格截图发我…",
    "composer.resumeWithChanges": "带改动继续",
    "composer.resumeSendHint": "⌘/Ctrl+Enter 发送",
    "composer.resumePlain": "已恢复运行",
    "composer.resumeChanged": "已注入改动并恢复运行",
    "composer.pauseUnavailable": "当前没有可暂停的运行任务",
    "composer.resumeUnavailable": "当前没有可恢复的运行任务",
    "composer.attachLabel": "附件",
    "composer.moreActions": "更多操作",
    "composer.modeTip": "模式：{detail}",
    "composer.modeBuildDetail": "Build 可执行工具",
    "composer.modePlanDetail": "Plan 只读规划",
    "composer.compactHint": "（空间不足，已折叠）",
    "composer.permChipTitle": "当前会话权限",
    "composer.permMenuTitle": "本会话工具权限",
    "composer.permOpenFull": "打开完整权限设置…",
    "composer.perm.read": "读取文件",
    "composer.perm.write": "写入文件",
    "composer.perm.terminal": "执行命令",
    "composer.perm.browser": "浏览器操作",
    "composer.perm.network": "网络访问",
    "composer.perm.allow": "允许",
    "composer.perm.confirm": "询问",
    "composer.perm.deny": "拒绝",
    "composer.permissionFallback": "权限",
    "composer.modelChipTitle": "选择模型：{model}",
    "composer.modelUnconfigured": "未配置模型",
    "composer.modelMenuTitle": "选择模型 · 跨供应商",
    "composer.modelMenuLoading": "加载中…",
    "composer.modelMenuEmpty": "还没有供应商，请先添加",
    "composer.modelMenuManage": "管理供应商 / 添加模型…",
    "composer.modelCurrent": "当前",
    "composer.modelPlanGo": "Go 订阅",
    "composer.modelPlanPayg": "按量付费",
    "composer.modelBadge.thinking": "推理",
    /** 输入模态含 image 时在模型菜单里的紧凑徽标（用户：图片输入能力要可见）。 */
    "composer.modelBadge.image": "图",
    "composer.effortSection": "推理等级",
    "composer.effortOff": "关闭推理",
    // 待发指令（引导/插入队列：slime ChatPanel 待发卡移植）
    "pendingSteers.title": "待发指令",
    "pendingSteers.badge": "待发",
    "pendingSteers.delivered": "已注入",
    "pendingSteers.deliveredHint": "已作为引导注入当前这轮 · 模型响应中",
    "pendingSteers.queuedHint": "排队中 · 本轮结束后自动发出；点「引导」可提前并入当前思考",
    "pendingSteers.edit": "修改（取回输入框）",
    "pendingSteers.insertNow": "引导（并入当前这轮思考，不打断）",
    "pendingSteers.remove": "撤销删除",
    "pendingSteers.expand": "展开全文",
    "pendingSteers.collapse": "收起",
    "pendingSteers.failedNotice": "投递失败：{reason}",
    "composer.planFoot": "Plan 模式：只读规划，不执行写操作",
    "composer.buildFoot": "Build 模式：可在权限范围内执行工具",
    "composer.pickFile": "选择要引用的文件",
    "composer.insertAttachment": "【附件】{path}【/附件】",
      "composer.attachmentsAdded": "已添加 {count} 个附件",
  "composer.removeAttachment": "移除附件",
    "composer.imageFailed": "粘贴图片失败：{error}",
    "composer.imageUnavailable": "当前环境不支持保存剪贴板图片（需要 Electron 外壳）",
    "composer.fileUnavailable": "当前环境无法选择文件（需要 Electron 外壳）",
    "composer.unknownCommand": "未知命令：{cmd}（输入 /help 查看可用命令）",
    "composer.commandUnwired": "命令 {cmd} 需要 App 接线后才能执行",
    "composer.commandTitle": "斜杠命令",
    "composer.commandHint": "↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭",
    "composer.commandEmpty": "没有匹配的命令",
    "composer.command.new.desc": "新建会话",
    "composer.command.clear.desc": "清除当前输入",
    "composer.command.stop.desc": "停止当前生成",
    "composer.command.settings.desc": "打开设置",
    "composer.command.compact.desc": "压缩上下文（保留最近原文）",
    "composer.command.help.desc": "查看可用命令",

    // ask_user 弹窗
    "ask.title": "Agent 需要你的回答",
    "ask.cancel": "取消回答",
    "ask.submit": "提交回答",
    "ask.hintCtrl": "Ctrl+Enter 提交 · Esc 取消",
    "ask.hintOptions": "点击上方选项回答 · Esc 取消",
    "ask.hintNumberKeys": "点选项或按数字键 1-8 快速回答 · Esc 取消",
    "ask.hintMulti": "可多选：点击切换，确认后提交",
    "ask.hintOnlyCancel": "Agent 本次未开放自由文本，也没有给出选项：只能取消。",
    "ask.placeholderOptions": "或输入自定义回答…",
    "ask.placeholderFree": "输入你的回答…",
    "ask.ariaFree": "自由文本回答（Ctrl+Enter 提交）",
    "ask.ariaOptions": "可选回答",
    "ask.optionTitle": "点击即用此选项回答",
    "ask.recommended": "推荐",
    "ask.skip": "跳过，先继续",
    "ask.confirmChoices": "确认选择（{count}）",
    "ask.sensitiveTitle": "敏感操作确认",
    "ask.sensitiveConfirm": "确认执行",
    "ask.sensitiveCancel": "取消",
    "ask.countdown": "剩余 {seconds} 秒",
    "ask.expired": "已超时，未执行",
    "ask.pendingOther": "另一个会话正在等待你的确认 · 点击前往",

    // 终端面板
    "terminal.panelLabel": "终端面板",
    "terminal.resizeLabel": "调整终端面板高度：拖动或方向键，Home 最小、End 最大",
    "terminal.resizeTitle": "拖动调整终端高度",
    "terminal.profilesGroup": "终端配置档（点击新建对应终端）",
    "terminal.probing": "探测终端环境…",
    "terminal.noProfiles": "未探测到终端配置档",
    "terminal.closePanel": "关闭终端面板",
    "terminal.state.starting": "启动中",
    "terminal.state.ready": "就绪",
    "terminal.state.exited": "已退出",
    "terminal.state.error": "错误",
    "terminal.stateTitle": "终端状态：{state}",
    "terminal.tabsLabel": "终端标签",
    "terminal.newTerminal": "新建终端",
    "terminal.newTerminalWith": "新建终端（{profile}）",
    "terminal.interrupt": "中断",
    "terminal.clear": "清屏",
    "terminal.closeTerminal": "关闭",
    "terminal.interruptTitle": "中断当前前台进程（Ctrl+C）",
    "terminal.clearTitle": "清屏（只清显示，主进程回放缓冲不变）",
    "terminal.closeTerminalTitle": "关闭当前终端（结束子进程树）",
    "terminal.emptyTitle": "当前会话还没有终端",
    "terminal.emptyHintAvailable": "选择上方配置档新建，或直接新建 {profile} 终端",
    "terminal.emptyHintNone": "本机未探测到可用终端环境（Windows 一般至少有 cmd / PowerShell）",
    "terminal.emptyHintLoading": "正在探测终端环境（首次探测可能需要几秒）…",
    "terminal.outputLabel": "终端输出（可滚动，上滚暂停自动跟随）",
    "terminal.jumpLatest": "↓ 回到最新",
    "terminal.placeholderNoTerminal": "先新建终端",
    "terminal.placeholderExited": "终端已退出，请关闭后新建",
    "terminal.placeholderRaw": "原始输入：Enter 原样发送，Ctrl+Enter 追加换行",
    "terminal.placeholderRun": "输入命令，Enter 执行",
    "terminal.raw": "原始",
    "terminal.rawTitle": "原始输入模式：直接写入进程 stdin（REPL 交互）。Enter 不自动追加换行，Ctrl+Enter / Shift+Enter 追加 \\n",
    "terminal.sendRaw": "发送原始输入",
    "terminal.sendRun": "执行命令",
    "terminal.ariaInputRaw": "终端原始输入（写入进程 stdin）",
    "terminal.ariaInputRun": "终端命令输入",
    "terminal.tabTitle": "{label} · {cwd}（{state}）",
    "terminal.profileTip": "{description}（点击新建终端）",
    "terminal.profileTipUnavailable": "{label} 不可用：{detail}",
    "terminal.notInstalled": "未检测到安装",
    "terminal.profileNewAria": "新建 {label} 终端",
    "terminal.profileNewAriaDisabled": "新建 {label} 终端（不可用）",
    "terminal.resizeValueText": "{height} 像素",
    "terminal.exit.bySignal": "被信号 {signal} 终止",
    "terminal.exit.bySignalUnknown": "被信号终止",
    "terminal.exit.byCode": "退出码 {code}",
    "terminal.exit.tombstone": "[进程已退出（{reason}）]",
    "terminal.errorNotice": "终端错误：{error}",
    "terminal.probeFailed": "终端环境探测失败",
    "terminal.notInShell": "未在 Electron shell 中运行，无法打开终端",
    "terminal.noProfilesAvailable": "没有可用的终端配置档",
    "terminal.profileUnavailable": "配置档「{label}」不可用",
    "terminal.openMissingInfo": "主进程未返回终端实例",
    "terminal.openFailed": "新建终端失败：{error}",
    "terminal.interruptSent": "已发送中断；若进程被结束，终端会显示「已退出」，可关闭后重开",
    "terminal.interruptMiss": "终端已退出或不存在",
    "terminal.cleared": "已清屏（只清显示，主进程回放缓冲不变）",
    "terminal.exitedCannotType": "终端已退出，请关闭后新建",
    "terminal.inputFailed": "原始输入发送失败",
    "terminal.runFailed": "命令执行失败",

    // 首次向导
    "onboarding.title": "欢迎使用 Loopsoar",
    "onboarding.stepOf": "第 {current} / {total} 步",
    "onboarding.welcome.title": "欢迎使用 Loopsoar",
    "onboarding.welcome.desc": "浏览器优先的本地 AI Agent：在同一个窗口里浏览网页、与 Agent 对话、在授权范围内执行工具。",
    "onboarding.welcome.b1": "左侧是浏览器：输入网址或搜索，回车即可。",
    "onboarding.welcome.b2": "右侧是 Agent 对话：读写文件、执行命令、操控网页。",
    "onboarding.welcome.b3": "数据与密钥全部留在本机，不上传云端。",
    "onboarding.layout.title": "Agent 打开网页时，窗口怎么摆？",
  "onboarding.layout.desc": "开启「浏览器控制」后，Agent 可以直接操作网页。这里选一次默认布局，之后它打开网页会自动按此安排窗口——不会再每次弹窗询问。",
  "onboarding.layout.docked.name": "收齐到右侧（常规布局）",
  "onboarding.layout.docked.desc": "网页占据主区域，会话栏停靠在窗口右侧，适合边看边聊。",
  "onboarding.layout.agentWindow.name": "独立小窗（Agent 窗口）",
  "onboarding.layout.agentWindow.desc": "会话独立成一个小窗浮在桌面上，主窗口的网页铺满，适合专注浏览。",
  "onboarding.layout.footer": "之后想改：设置 · 通用 → Agent 打开网页时的窗口布局。",
  "onboarding.provider.title": "先配置一个模型供应商",
    "onboarding.provider.desc": "Loopsoar 支持 OpenAI 兼容接口与 Anthropic 接口；API Key 只保存在本机。",
    "onboarding.provider.open": "打开供应商设置",
    "onboarding.provider.hint": "也可以稍后随时在「设置 → 供应商」里配置。",
    "onboarding.capability.title": "技能、工作区与终端",
    "onboarding.capability.desc": "把常用流程沉淀为技能；挂载项目文件夹作为工作区；底部状态栏可打开持久终端。",
    "onboarding.capability.skills": "浏览技能",
    "onboarding.capability.workspace": "挂载项目文件夹作为工作区（右侧「工作区」按钮）",
    "onboarding.capability.footer": "这些能力都可以随时在设置中调整。",
    "onboarding.done.start": "开始使用",

    // 设置 · 关于
    "settings.about.onboarding": "重新打开新手引导",
    "settings.about.onboardingHint": "重新查看功能定位与初始配置步骤",
    "settings.about.data.title": "数据与诊断",
    "settings.about.data.hint": "备份包含设置、会话与记忆；诊断包只含日志、版本与运行信息，不含 API Key 与会话正文。",
    "settings.about.data.open": "打开数据目录",
    "settings.about.data.backup": "导出数据备份",
    "settings.about.data.diagnostics": "导出诊断包",
    "settings.about.data.opened": "已在文件管理器中打开数据目录。",
    "settings.about.data.canceled": "已取消。",
    "settings.about.data.done": "已导出 {files} 个文件到：{path}",
    "settings.about.data.failed": "操作失败：{error}",
    "settings.general.memoryBackend": "记忆向量后端",
    "settings.general.memoryBackendHint": "Flat 为内置实现（默认）；SQLite-vec 使用随包原生模块，加载失败会自动回退 Flat（重启后生效）。",
    "settings.about.license": "许可协议",
    "settings.about.privacy": "隐私说明",
    "settings.about.update.title": "自动更新",
    "settings.about.update.hint": "启动后自动检查新版本；下载与安装都需要你确认。",
    "settings.about.update.disabled": "当前构建不支持自动更新（开发态或非 Windows）。",
    "settings.about.update.latest": "已是最新版本（{version}）。",
    "settings.about.update.available": "发现新版本 {version}。",
    "settings.about.update.downloading": "正在下载更新…… {percent}%",
    "settings.about.update.downloaded": "新版本 {version} 已下载，重启后安装。",
    "settings.about.update.error": "更新检查失败：{error}",
    "settings.about.update.check": "检查更新",
    "settings.about.update.download": "下载更新",
    "settings.about.update.install": "重启并安装",
  },
  "en-US": {
    // Common
    "common.back": "Back",
    "common.next": "Next",
    "common.skip": "Skip",

    // Title bar
    "titlebar.minimize": "Minimize",
    "titlebar.minimizeAgent": "Minimize (collapse to icon)",
    "titlebar.maximize": "Maximize",
    "titlebar.restore": "Restore",
    "titlebar.close": "Close",

    // Context ring
    "contextRing.title": "Context usage: {used} / {cap} tokens ({pct}%)",
    "contextRing.loading": " · generating; value grows with output",

    // Composer
    "composer.placeholder": "Type a message (Enter to send, Shift+Enter for newline; / for commands, @ to reference a file)",
    "composer.send": "Send (Enter)",
    "composer.queueSend": "Send (while running = queued, sent after this round)",
    "composer.stop": "Stop generating",
    "composer.pause": "Pause",
    "composer.paused": "Paused",
    "composer.running": "Running",
    "composer.runningHint": "Pause takes effect after the current step",
    "composer.pausedHint": "Confirm whether anything changed before resuming",
    "composer.terminate": "Terminate",
    "composer.noChanges": "No changes, resume",
    "composer.resumeQuestion": "Anything changed while paused? Resume directly if not; otherwise write the change and it will apply after resuming.",
    "composer.resumePlaceholder": "e.g. don't submit the order; screenshot the price and send it to me first…",
    "composer.resumeWithChanges": "Resume with changes",
    "composer.resumeSendHint": "⌘/Ctrl+Enter to send",
    "composer.resumePlain": "Resumed",
    "composer.resumeChanged": "Changes injected; resumed",
    "composer.pauseUnavailable": "No running task to pause",
    "composer.resumeUnavailable": "No running task to resume",
    "composer.attachLabel": "Attach",
    "composer.moreActions": "More actions",
    "composer.modeTip": "Mode: {detail}",
    "composer.modeBuildDetail": "Build — tools enabled",
    "composer.modePlanDetail": "Plan — read-only planning",
    "composer.compactHint": " (collapsed: not enough space)",
    "composer.permChipTitle": "Session permissions",
    "composer.permMenuTitle": "Session tool permissions",
    "composer.permOpenFull": "Open full permission settings…",
    "composer.perm.read": "Read files",
    "composer.perm.write": "Write files",
    "composer.perm.terminal": "Run commands",
    "composer.perm.browser": "Browser actions",
    "composer.perm.network": "Network access",
    "composer.perm.allow": "Allow",
    "composer.perm.confirm": "Ask",
    "composer.perm.deny": "Deny",
    "composer.permissionFallback": "Permissions",
    "composer.modelChipTitle": "Choose model: {model}",
    "composer.modelUnconfigured": "No model configured",
    "composer.modelMenuTitle": "Choose model · across providers",
    "composer.modelMenuLoading": "Loading…",
    "composer.modelMenuEmpty": "No provider yet — add one first",
    "composer.modelMenuManage": "Manage providers / add models…",
    "composer.modelCurrent": "current",
    "composer.modelPlanGo": "Go plan",
    "composer.modelPlanPayg": "Pay-as-you-go",
    "composer.modelBadge.thinking": "reasoning",
    "composer.modelBadge.image": "IMG",
    "composer.effortSection": "Reasoning effort",
    "composer.effortOff": "Disable reasoning",
    // Pending instructions (steer/insert queue ported from slime)
    "pendingSteers.title": "Pending instructions",
    "pendingSteers.badge": "Pending",
    "pendingSteers.delivered": "Injected",
    "pendingSteers.deliveredHint": "Steering injected into this round · model responding",
    "pendingSteers.queuedHint": "Queued · sent automatically after this round; click Steer to merge it into the current round early",
    "pendingSteers.edit": "Edit (move back to the composer)",
    "pendingSteers.insertNow": "Steer into this round (no interruption)",
    "pendingSteers.remove": "Discard",
    "pendingSteers.expand": "Show full text",
    "pendingSteers.collapse": "Collapse",
    "pendingSteers.failedNotice": "Delivery failed: {reason}",
    "composer.planFoot": "Plan mode: read-only planning, no writes",
    "composer.buildFoot": "Build mode: tools run within your permissions",
    "composer.pickFile": "Pick a file to reference",
    "composer.insertAttachment": "[Attachment] {path}[/Attachment]",
      "composer.attachmentsAdded": "Attached {count} file(s)",
  "composer.removeAttachment": "Remove attachment",
    "composer.imageFailed": "Failed to paste image: {error}",
    "composer.imageUnavailable": "Pasting images needs the Electron shell",
    "composer.fileUnavailable": "File picking needs the Electron shell",
    "composer.unknownCommand": "Unknown command: {cmd} (type /help for available commands)",
    "composer.commandUnwired": "Command {cmd} needs App wiring to run",
    "composer.commandTitle": "Slash commands",
    "composer.commandHint": "↑↓ select · Enter run · Tab complete · Esc close",
    "composer.commandEmpty": "No matching command",
    "composer.command.new.desc": "Start a new session",
    "composer.command.clear.desc": "Clear current input",
    "composer.command.stop.desc": "Stop the current generation",
    "composer.command.settings.desc": "Open settings",
    "composer.command.compact.desc": "Compact the context (keeps recent messages)",
    "composer.command.help.desc": "Show available commands",

    // ask_user dialog
    "ask.title": "The agent needs your answer",
    "ask.cancel": "Cancel answer",
    "ask.submit": "Submit answer",
    "ask.hintCtrl": "Ctrl+Enter to submit · Esc to cancel",
    "ask.hintOptions": "Pick an option above · Esc to cancel",
    "ask.hintNumberKeys": "Click an option or press 1-8 · Esc to cancel",
    "ask.hintMulti": "Multi-select: click to toggle, then confirm",
    "ask.hintOnlyCancel": "The agent allows neither free text nor options this time: you can only cancel.",
    "ask.placeholderOptions": "Or type a custom answer…",
    "ask.placeholderFree": "Type your answer…",
    "ask.ariaFree": "Free-text answer (Ctrl+Enter to submit)",
    "ask.ariaOptions": "Answer options",
    "ask.optionTitle": "Click to answer with this option",
    "ask.recommended": "Recommended",
    "ask.skip": "Skip and continue",
    "ask.confirmChoices": "Confirm ({count})",
    "ask.sensitiveTitle": "Confirm sensitive action",
    "ask.sensitiveConfirm": "Confirm",
    "ask.sensitiveCancel": "Cancel",
    "ask.countdown": "{seconds}s left",
    "ask.expired": "Expired — nothing was executed",
    "ask.pendingOther": "Another session is waiting for your confirmation · Click to open",

    // Terminal panel
    "terminal.panelLabel": "Terminal panel",
    "terminal.resizeLabel": "Resize terminal panel: drag or arrow keys, Home min, End max",
    "terminal.resizeTitle": "Drag to resize terminal",
    "terminal.profilesGroup": "Terminal profiles (click to open one)",
    "terminal.probing": "Detecting terminal environments…",
    "terminal.noProfiles": "No terminal profile detected",
    "terminal.closePanel": "Close terminal panel",
    "terminal.state.starting": "Starting",
    "terminal.state.ready": "Ready",
    "terminal.state.exited": "Exited",
    "terminal.state.error": "Error",
    "terminal.stateTitle": "Terminal state: {state}",
    "terminal.tabsLabel": "Terminal tabs",
    "terminal.newTerminal": "New terminal",
    "terminal.newTerminalWith": "New terminal ({profile})",
    "terminal.interrupt": "Interrupt",
    "terminal.clear": "Clear",
    "terminal.closeTerminal": "Close",
    "terminal.interruptTitle": "Interrupt the foreground process (Ctrl+C)",
    "terminal.clearTitle": "Clear the screen (main-process replay buffer is kept)",
    "terminal.closeTerminalTitle": "Close this terminal (kill its process tree)",
    "terminal.emptyTitle": "No terminal in this session yet",
    "terminal.emptyHintAvailable": "Pick a profile above, or create a {profile} terminal",
    "terminal.emptyHintNone": "No usable terminal environment found (Windows usually has cmd / PowerShell)",
    "terminal.emptyHintLoading": "Detecting terminal environments (first run may take a few seconds)…",
    "terminal.outputLabel": "Terminal output (scrollable; scrolling up pauses auto-follow)",
    "terminal.jumpLatest": "↓ Jump to latest",
    "terminal.placeholderNoTerminal": "Create a terminal first",
    "terminal.placeholderExited": "Terminal exited — close and create a new one",
    "terminal.placeholderRaw": "Raw input: Enter sends as-is, Ctrl+Enter appends a newline",
    "terminal.placeholderRun": "Type a command, Enter to run",
    "terminal.raw": "Raw",
    "terminal.rawTitle": "Raw input mode: writes directly to the process stdin (REPL). Enter does not append a newline; Ctrl+Enter / Shift+Enter appends \\n",
    "terminal.sendRaw": "Send raw input",
    "terminal.sendRun": "Run command",
    "terminal.ariaInputRaw": "Terminal raw input (writes to process stdin)",
    "terminal.ariaInputRun": "Terminal command input",
    "terminal.tabTitle": "{label} · {cwd} ({state})",
    "terminal.profileTip": "{description} (click to open one)",
    "terminal.profileTipUnavailable": "{label} unavailable: {detail}",
    "terminal.notInstalled": "not installed",
    "terminal.profileNewAria": "New {label} terminal",
    "terminal.profileNewAriaDisabled": "New {label} terminal (unavailable)",
    "terminal.resizeValueText": "{height} px",
    "terminal.exit.bySignal": "terminated by signal {signal}",
    "terminal.exit.bySignalUnknown": "terminated by signal",
    "terminal.exit.byCode": "exit code {code}",
    "terminal.exit.tombstone": "[process exited ({reason})]",
    "terminal.errorNotice": "Terminal error: {error}",
    "terminal.probeFailed": "Failed to detect terminal environments",
    "terminal.notInShell": "Opening a terminal needs the Electron shell",
    "terminal.noProfilesAvailable": "No terminal profile available",
    "terminal.profileUnavailable": "Profile \"{label}\" is unavailable",
    "terminal.openMissingInfo": "The main process did not return a terminal instance",
    "terminal.openFailed": "Failed to open terminal: {error}",
    "terminal.interruptSent": "Interrupt sent; if the process was killed the terminal shows \"Exited\" — close and reopen it",
    "terminal.interruptMiss": "Terminal already exited or missing",
    "terminal.cleared": "Screen cleared (the main-process replay buffer is kept)",
    "terminal.exitedCannotType": "Terminal exited — close and create a new one",
    "terminal.inputFailed": "Failed to send raw input",
    "terminal.runFailed": "Failed to run command",

    // Onboarding
    "onboarding.title": "Welcome to Loopsoar",
    "onboarding.stepOf": "Step {current} of {total}",
    "onboarding.welcome.title": "Welcome to Loopsoar",
    "onboarding.welcome.desc": "A browser-first local AI agent: browse, chat with the agent, and run tools within your permissions — all in one window.",
    "onboarding.welcome.b1": "The browser is on the left: type a URL or search and hit Enter.",
    "onboarding.welcome.b2": "The agent chat is on the right: it can read/write files, run commands and drive the page.",
    "onboarding.welcome.b3": "Your data and API keys stay on this machine.",
    "onboarding.layout.title": "How should windows arrange when the agent opens a page?",
  "onboarding.layout.desc": "With browser control on, the agent can operate pages directly. Pick a default layout once here; the agent will arrange windows this way when it opens a page — no more per-page prompts.",
  "onboarding.layout.docked.name": "Dock to the right (regular layout)",
  "onboarding.layout.docked.desc": "The page fills the main area and the session panel docks on the right — good for browsing while chatting.",
  "onboarding.layout.agentWindow.name": "Floating agent window",
  "onboarding.layout.agentWindow.desc": "The session becomes a small floating window and the page fills the main window — good for focused browsing.",
  "onboarding.layout.footer": "Change it later in Settings → General → Window layout when the agent opens a page.",
  "onboarding.provider.title": "Configure a model provider",
    "onboarding.provider.desc": "Loopsoar supports OpenAI-compatible and Anthropic APIs; API keys are stored locally.",
    "onboarding.provider.open": "Open provider settings",
    "onboarding.provider.hint": "You can also do this later in Settings → Providers.",
    "onboarding.capability.title": "Skills, workspaces and terminals",
    "onboarding.capability.desc": "Turn repeatable workflows into skills; mount a project folder as a workspace; open a persistent terminal from the status bar.",
    "onboarding.capability.skills": "Browse skills",
    "onboarding.capability.workspace": "Mount a project folder as a workspace (workspace button on the right)",
    "onboarding.capability.footer": "All of this can be adjusted in settings anytime.",
    "onboarding.done.start": "Get started",

    // Settings · About
    "settings.about.onboarding": "Open the getting-started guide",
    "settings.about.onboardingHint": "Revisit the product intro and initial setup steps",
    "settings.about.data.title": "Data & diagnostics",
    "settings.about.data.hint": "Backups include settings, sessions and memory. Diagnostic bundles contain logs, version and runtime info only — no API keys or chat content.",
    "settings.about.data.open": "Open data folder",
    "settings.about.data.backup": "Export data backup",
    "settings.about.data.diagnostics": "Export diagnostics",
    "settings.about.data.opened": "Opened the data folder in your file manager.",
    "settings.about.data.canceled": "Canceled.",
    "settings.about.data.done": "Exported {files} files to: {path}",
    "settings.about.data.failed": "Failed: {error}",
    "settings.general.memoryBackend": "Memory vector backend",
    "settings.general.memoryBackendHint": "Flat is the built-in default. SQLite-vec loads the bundled native module and falls back to Flat automatically if it fails (takes effect after restart).",
    "settings.about.license": "License",
    "settings.about.privacy": "Privacy",
    "settings.about.update.title": "Automatic updates",
    "settings.about.update.hint": "Loopsoar checks for updates after launch; downloading and installing both require your confirmation.",
    "settings.about.update.disabled": "Automatic updates are unavailable in this build (dev mode or non-Windows).",
    "settings.about.update.latest": "You're up to date ({version}).",
    "settings.about.update.available": "Version {version} is available.",
    "settings.about.update.downloading": "Downloading update… {percent}%",
    "settings.about.update.downloaded": "Version {version} is ready. Restart to install.",
    "settings.about.update.error": "Update check failed: {error}",
    "settings.about.update.check": "Check for updates",
    "settings.about.update.download": "Download update",
    "settings.about.update.install": "Restart and install",
  },
};

/**
 * 合并按归属拆分的词典（Settings 与浏览器/通用组件各自维护自己的文件，
 * 避免多人同时改本文件冲突）。key 同名时后者覆盖前者（以拆分文件为准）。
 */
for (const [key, entry] of Object.entries({ ...SETTINGS_I18N, ...BROWSER_I18N, ...CHROME_PAGE_I18N })) {
  DICT["zh-CN"][key] = entry.zh;
  DICT["en-US"][key] = entry.en;
}

/** 读取上次缓存的界面语言（App 会用 preferences.language 覆盖；这里只做启动兜底）。 */
export function getInitialLang(): Lang {
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === "zh-CN" || raw === "en-US") return raw;
    } catch {
      // 隐私模式等：用默认语言
    }
  }
  return DEFAULT_LANG;
}

let currentLang: Lang = getInitialLang();
const listeners = new Set<(lang: Lang) => void>();

/** 当前语言（非 React 场景用；组件里请用 useLanguage/useT）。 */
export function getLanguage(): Lang {
  return currentLang;
}

/** 设置当前语言：标准化 → 持久化缓存 → 通知订阅者（即时生效）。 */
export function setLanguage(next: unknown): Lang {
  const lang: Lang = next === "en-US" ? "en-US" : "zh-CN";
  if (lang === currentLang) return currentLang;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // 忽略（隐私模式）
  }
  for (const listener of [...listeners]) listener(lang);
  return currentLang;
}

/** 订阅语言变化，返回退订函数。 */
export function onLanguageChange(listener: (lang: Lang) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 订阅（useSyncExternalStore）：语言变化时组件即时重渲染。 */
const subscribe = (onStoreChange: () => void): (() => void) => onLanguageChange(onStoreChange);

export function useLanguage(): Lang {
  return React.useSyncExternalStore(
    subscribe,
    () => currentLang,
    () => DEFAULT_LANG,
  );
}

/**
 * 纯函数翻译：t(lang, "composer.send") / t(lang, "terminal.stateTitle", { state: "就绪" })。
 * 缺失 key 时按 zh-CN → key 本身兜底（不抛错、不显示 undefined）。
 */
export function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const table = DICT[lang] ?? DICT[DEFAULT_LANG];
  const template = table[key] ?? DICT[DEFAULT_LANG][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** 组件用：随语言变化的翻译函数（返回 stable-ish callback，语言切换即换实现）。 */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const lang = useLanguage();
  return React.useCallback(
    (key: string, params?: Record<string, string | number>) => t(lang, key, params),
    [lang],
  );
}

/** 供测试/诊断：词典覆盖的语言与 key 数量。 */
export const I18N_LANGS: readonly Lang[] = ["zh-CN", "en-US"];
export function dictSize(lang: Lang): number {
  return Object.keys(DICT[lang] ?? {}).length;
}
