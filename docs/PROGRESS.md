# Loopsoar 开发进度（2026-10-31 存档）

> 位置：`D:\tool\AI\real-project\Loopsoar\Parent file`（下文简称根目录）
> 参考项目：`D:\pilot project`（slime，只读参考；不得写入、不复制其架构代码）
> 分支：main；最近提交见 `git log --oneline -5`

## 一、当前可用能力（已验收）

### 平台骨架（不可破坏的"房梁"）
- `packages/contracts` 单一产地 → `pnpm gen` 生成 `gen/` → `pnpm check` 逐字节一致
- `packages/core`（纯逻辑，无 electron）→ `packages/services`（Chat/tool loop）→
  `packages/shell`（main 进程 domain，`handleTrusted` 四要素校验 + DI）→ `packages/ui`（React，preload 白名单 `window.loopsoarAPI`）
- 守卫测试：channels→handlers、electron 仅允许 `main/index.ts` / `main/electronBrowser.ts`、分层/隔离约束

### 供应商与模型
- 供应商：协议（自动/OpenAI/Anthropic）、Base URL、API Key（safeStorage + AES 双后端双写，跨重启可靠）、
  RPM、获取模型列表、模型参数表（上下文/输出/视觉/思考/推理等级）、启用/默认模型、预设（DeepSeek/OpenAI/OpenRouter/Agnes/本地）
- 密钥：`config/secrets.enc.json`（主密文 + `cipherFallback` 备份密文）；诊断见 设置→高级
- 模型请求：推理等级透传（OpenAI `reasoning_effort` / Anthropic thinking）、OpenAI 标准 tools 协议、
  Anthropic `/v1/messages`（含 tool_use/tool_result）

### Agent 与工具
- 工具循环：多轮工具对话（assistant(tool_calls)+tool 结果回灌），非正常收束带原因；
  上限可配置（设置→通用：Agent 请求轮数/工具调用次数，默认 40/100）
- 内置工具：`file_read`、`terminal_run`（工作区执行命令；30s 超时、输出上限、terminal 权限确认）
- 浏览器工具：`browser_snapshot`（URL/标题/正文/可交互元素编号）、`browser_navigate`、
  `browser_click`（编号/CSS/`text=`）、`browser_type`、`browser_scroll`、`web_fetch`
- MCP：stdio + Streamable HTTP（`/mcp` JSON-RPC，兼容 SSE 响应、`mcp-session-id`），
  生命周期（5s 握手、帧翻转重试、能力门控、工具刷新、超时/错误分类、重连退避）
- 技能：SKILL.md 容错解析 + CJK 2-gram 打分 + Top-3 注入（隔离，不注册工具）
- 扩展运行时：每个扩展独立子进程 worker（8s 启动/20s 调用超时、崩溃隔离、工具注销），
  工具以 `ext__<id>__<tool>` 注册进 ToolRegistry（携带 JSON Schema，权限仍走沙箱确认）；
  设置·扩展显示运行状态/工具清单，可启动/停止；ADR-0008

### 会话 UI（向 slime 对齐，进行中）
- 气泡/助手区块、头像、LiveStatus（正在思考/输出/等待上游、已用时、上下文%）、
  思考过程折叠、计划卡（PlanCard）、待办播报、上下文环、转向卡（steer）、回滚、重新生成、
  附件卡片、复制会话 Markdown、代码块复制、应用内链接打开、Markdown（标题/列表/引用/链接/粗斜体/代码块/**表格**）
- 卷轴式滚动条（TopicRail）：双股波浪线、拖动滚动、悬停衬托+气泡、外观设置页（宽度/振幅/波长/速度/渐隐/暂停/翻转）
- 发送即反馈（用户消息 + 助手占位立即出现，不等首字）
- 工具卡片（ToolCard）：参数摘要、状态、可展开参数/输出、URL 链接卡（**本轮新增，待人工验收**）

### 浏览器与系统
- 多标签 + 历史栈、下载、对话框、设置全覆盖（通用/外观/权限/供应商/规则/技能/记忆/扩展/MCP/存储/高级/关于）
- 搜索：omnibox URL/搜索词分流（Bing/Google/DuckDuckGo），安全协议白名单
- 原生视图：空标签隐藏（避免吞鼠标）、拖拽分栏时临时隐藏、侧栏最小宽度与挤压图标化

## 二、验证基线
```
pnpm -r typecheck   # 0 errors
npx vitest run      # 338 tests passed (46+ files)
pnpm build          # 6/6 Done
pnpm gen && pnpm check  # byte-identical
```
开发启动：`pnpm dev`（Electron，--no-sandbox）
本地 mock：`node scripts/mock-openai-server.mjs 19500`、`node scripts/mock-mcp-server.mjs`、
`node scripts/mock-mcp-http-server.mjs`、`node scripts/e2e-page-server.mjs 19443`
E2E hooks：`LOOPSOAR_E2E_OPEN`（settings&section=… / chat / model-menu）、`LOOPSOAR_E2E_SHOT`、
`LOOPSOAR_E2E_HOLD_MS`、`LOOPSOAR_E2E_NAV_URL`、`LOOPSOAR_E2E_NAV_WAIT_MS`、
`LOOPSOAR_E2E_HOVER_RAIL`、`LOOPSOAR_E2E_PLAN`、`LOOPSOAR_E2E_STEER`、`LOOPSOAR_E2E_SEARCH`、
`LOOPSOAR_E2E_SECRET_SET/DUMP`、`LOOPSOAR_LOOP_DEBUG`、`LOOPSOAR_MCP_DEBUG`
数据目录：默认 `%APPDATA%\loopsoar`（可用 `LOOPSOAR_DATA_DIR` 覆盖）

## 二·五、2026-10-31 第三轮增量
- 技能不再因大小被跳过：读取上限 2MB（超出读取前 2MB + warnings），正文注入上限 12000 字符并提示用 file_read 读全文；
  实测 112KB SKILL.md 正常安装（`gui-49-large-skill.png`）
- 扩展：工具名/描述上限放宽（200 / 20000），清单展示字段放宽；MCP 配置限制保持合理范围
- **上下文自动压缩（新实现）**：core/contextCompress —— 按模型 contextWindow 推导历史预算（50%，32K~600K 字符），
  超预算把早期消息压成确定性摘要（保留 system + 最近 14 条原文），不额外请求模型；ChatService 触发时发 progress 通知
- Agent 循环继续加固：相同工具+参数重复调用提示/5 次硬停（no-progress）；回灌上下文单条工具结果 20K 截断标注；
  空正文兜底（非 done 时写入「任务未完成：原因」，配合中断横幅，杜绝莫名空白）
- 测试：contextCompress 5 用例、大技能 2 用例、工具循环 2 用例

## 二·六、2026-10-31 第四轮增量（slime 时间线完整复现）
- 新增 `packages/ui/src/timeline.ts`（纯逻辑）：节点类型 think/body/tool/plan/todo/steer、
  连续段合并、按 think 边界分组（工作阶段）、规划去重与推进播报、工具分类/详情/失败判定
- 新增 `TimelineView.tsx`：思考过程卡（可折叠）→ 工作阶段分组（历史组折叠 / 流式恒展开）→
  思考摘要行+展开 Markdown / 穿插正文 / 工具卡（分类色点 + 分类徽标 + 详情链接 + 状态胶囊
  运行中呼吸 & 落定弹动 + 展开输出/终端块/URL 卡）/ 任务规划卡（进度+当前项+条目状态）/
  推进播报（完成划掉动画）/ 引导卡（用户 steer）
- 新增 `StreamFade.tsx`：吐字渐入（右→左 + 淡入，水位机制防重播）
- CSS：grid 0fr↔1fr 展开收起动画、fadeIn、呼吸/落定、划掉、终端块、reduced-motion 降级
- App 事件累积时间线：reasoning→think、chunk→body、tool_start→运行中工具、
  tool→落定/规划解析、done→自动收起思考卡；steer→引导卡
- 新事件 `chat:stream:tool_start`（tool_loop 执行前发出 + tool 结果携带 toolCallId），
  实时显示「执行中」呼吸状态
- 时间线持久化：contracts `TimelineStepSchema` + `chat:saveTimeline`；SessionStore.attachTimeline；
  重启/切会话恢复时间线（截图 gui-55）
- 新增 `todo_write` 规划工具（内存态清单，返回 Markdown checklist，供规划卡解析）
- 测试：timeline 6 用例 + tool_loop 防循环/截断用例；共 359 全绿
- 证据：gui-50-timeline.png、gui-51-timeline-plan.png、gui-55-timeline-restored.png

## 二·七、2026-10-31 第五轮增量（架构清理 + 产物/diff）
- 架构清理（ADR-0009）：删除旧版 ToolCard/PlanCard 与旧思考/工具/播报回退渲染；
  ChatMessage 移除 reasoning/tools/plan/announces 平行字段——**时间线成为唯一轨迹来源**
- 新增 `artifacts.ts`：diff 标记编解码（纯 JS base64）、行级 diff、产物收集、参考内容/网址收集
- 新增 `DiffBlock.tsx`（VS Code 风格 +/- 整行底色 + 统计）与 `ArtifactPanels.tsx`（产物卡/参考内容/访问来源）
- 新增 `file_write` 工具：工作区内写文件 + 内嵌 diff 标记（权限 write，父目录自动创建，防穿越）
- 修复沙箱核心缺陷：相对路径未按 workspaceRoot 解析 → 被误判「越出工作目录」拒绝（影响 file_write 等）
- 产物卡默认折叠、可展开 diff；正文/复制会剥离 diff 标记（模型复述工具结果时不泄漏 base64）
- 新增测试：artifacts 3 用例、fileTools 2 用例、沙箱相对路径 3 用例；共 362+ 全绿
- 证据：gui-56-diff-products.png

## 二·八、2026-10-31 第六轮增量（架构债：事件层与渲染器拆分）
- 新增 `chatStreamState.ts`：事件→消息状态的唯一纯函数层（applyChunk/Reasoning/ToolStart/ToolResult/
  Steer/Done/restore），App 事件 handler 只做接线；新增 6 个单测
- 新增 `Markdown.tsx`：唯一富文本渲染器（代码块/GFM 表格/列表/标题/引用/行内），App 删除第二份实现与样式
- 新增 `attachments.ts`：附件文本协议解析单一产地
- App.tsx：2863 → 2438 行；下一轮继续拆 `ChatMessageView`（目标 <1200 行红线）
- 测试：chatStreamState 6 用例；全量 373 全绿
- 证据：gui-57-architecture-refactor.png（重构后渲染无回归）

## 二·十、2026-10-31 第八轮增量（会话板块追平项）
- 新增 `MessageList.tsx`：滚动容器 + 自动滚底 + 卷轴 + 消息渲染，App 再瘦身（2155 行）
- 上下文自动压缩提示：progress 事件带 compressed 时写入消息 compressNote，正文前渲染「已自动压缩 N 条早期消息」
- E2E 工具运行态：新增 `LOOPSOAR_E2E_LIVE_TOOL` 合成 tool_start（不返回结果），验证「执行中」呼吸胶囊
- 证据：gui-59-live-tool.png（执行中状态 + 思考展开 + 流式正文 + LiveStatus）
- 会话板块追平清单：时间线/工具卡/规划/播报/引导/产物/diff/压缩提示/运行态 ✅；
  剩余：图片附件预览、压缩报告明细、App <1200 行拆分（顶栏/侧栏/输入区）

## 二·十一、2026-10-31 第九轮增量（图片附件 + E2E 文本注入）
- 图片附件缩略图：contracts `fs:readImage`（扩展名白名单 + 6MB 上限）→ shell imageRead → preload 自动生成
  `loopsoarAPI.fs.readImage`；用户消息的图片附件渲染真实缩略图（模块级缓存，失败回退文件 chip）
- E2E：`LOOPSOAR_E2E_CHAT_TEXT` 注入任意消息文本；`scrollTo=user` 定位用户气泡
- 测试：imageRead 3 用例；新增 domain 后守卫 channels-have-handlers 立刻发现漏装配（已补 registerFsDomain）
- 证据：gui-60-attachment-image.png（图片缩略图 + 正在思考/LiveStatus）
- 会话板块追平清单更新：图片附件 ✅；剩余压缩报告明细、App <1200 行拆分

## 二·十二、2026-10-31 第十轮增量（压缩报告 + 顶栏拆分）
- 上下文压缩报告明细：ChatService progress 带 beforeChars/afterChars；消息气泡内压缩提示显示
  「压缩 N 条 · A→B 字符 · 节省 X%」+ 保留策略说明
- 新增 `BrowserChrome.tsx`：后退/前进/刷新/历史 + 地址搜索 + 下载/快照/设置 + 标签栏；
  App.tsx 2194 → 2032 行（删除 14 个重复样式键）
- 证据：gui-61-chrome-refactor.png（顶栏/标签/时间线/运行态均正常）
- 剩余：Composer 拆分、思考组头去重、diff 折叠动效

## 二·十四、2026-10-31 第十二轮增量（时间线视觉微调）
- 思考摘要去重：组头已显示同一句时，摘要行改为「展开思考」操作提示（不再重复整句，也不再留空行）
- 证据：gui-63-timeline-dedupe.png
- App.tsx 当前 1647 行（已拆出 TitleBar/顶栏/消息列表/消息视图/输入区/时间线/产物/Markdown/事件层）

## 二·十五、会话板块验收（收尾）
- 新增 `docs/ACCEPTANCE-SESSION.md`：逐项对照 slime 会话区（消息/时间线/工具/规划/产物/附件/压缩/会话管理/架构），
  结论：主链路通过验收；差异集中团队协作、斜杠命令/剪贴板图片、右栏明细
- 验收截图：gui-64-session-acceptance.png（时间线 + 工具 diff + 规划卡）
- 基线：typecheck 0、376 tests、gen/check 一致、build 6/6

## 二·十六、2026-10-31 第十三次增量（UI 修复：网址绑定 / 菜单 / 持久化 / Markdown）
- 网址与网页强绑定：WebContents 增加 did-navigate/page-title-updated 回调 → BrowserHost 同步 URL/标题/历史；
  App 的 browser:tabs 事件按活动标签 URL 同步地址栏（仅 URL 变化时覆盖，避免打断输入）；AI 打开网页时地址栏同步
- 菜单浮层：新增 `popover.ts` 全局仲裁（同时只开一个、点击外部/Esc 收起、互斥）；Composer 权限/模型菜单、
  会话列表、历史/下载全部接入；底部操作项改 div 修复原生 button 白块
- 推理强度持久化：偏好新增 `reasoningEffort`（contracts/core/UI 类型三处同步），启动恢复、切换即保存；
  排查同类模型设置（模型选择本身已由 provider 配置持久化）
- Markdown 检修：连续行按软换行合并为段落（不再每行一段）、支持 `---/***/___` 分隔线、有序列表、
  `+/*/•` 无序列表；思考区/穿插正文去掉 pre-wrap；新增 Markdown 5 用例
- 证据：gui-65 模型菜单、gui-66 AI 导航后地址栏、gui-67 菜单互斥、gui-68 推理等级重启保持、gui-69 Markdown
- 测试：384 全绿（Markdown 5 + BrowserHost 2 + 偏好 1）

## 二·十七、2026-10-31 第十四次增量（UI 回归修复 + 请求头 + 页面缩放）
- 运行中发送选择：新增「编辑 / 直接引导 / 取消」浮层（编辑聚焦输入、直接引导立即 steer、取消保留文本）
- 自定义请求头：供应商配置新增 headers（contracts/providerStore/settings/UI 表单全链路；最多 30 条，
  聊天与模型探测共用；用于 opencode go 等需要网关鉴权的服务）
- 吐字重排：StreamFade 不再按尾部窗口切分（字符搬家导致末行回挤），整段走同一 Markdown，DOM 稳定
- 浮层遮挡：新增 AnchoredPopover（Portal + fixed 定位），权限/模型菜单不再被输入区裁切/覆盖
- 标签标题 [object Object]：page-title-updated 取 args[1]（Electron 签名 event,title,...）
- 页面比例：WebContentsView 支持 Ctrl + =/-/0 页面缩放（每个标签自己的 webContents 监听）
- 测试：389 全绿（providerStore 2、LLM headers 1、adapter 2、Markdown 5 等）
- 证据：gui-70 转向选择、gui-71 权限浮层、gui-72 请求头设置

## 二·十八、2026-10-31 第十五次增量（请求头模板：OpenCode Go 等客户端限制）
- contracts 新增 `headerTemplate.ts`（单一产地）：`{{sessionId}} / {{provider}} / {{model}} / {{requestId}} / {{timestamp}}`
  渲染、未知变量保留、保存前校验；UI 帮助与设置校验共用同一份变量清单
- 核心 LLM 客户端：默认 `User-Agent: Loopsoar/1.0`；新增 `resolveHeaders()` 每次请求解析（会话 ID/请求 ID 动态）
- ChatService：`getLlm(sessionId)` → 壳体按当前会话渲染请求头（x-opencode-session 每会话稳定）
- 模型列表探测 / 测试连接同样使用渲染后的请求头（带默认 UA）
- 设置页：请求头输入支持模板变量，未知变量保存时报错并列出可用变量
- 测试：395 全绿（headerTemplate 4、LLM 动态头/默认 UA 2 等）；真机验证 mock 服务收到
  `x-opencode-session: sess-…`、`User-Agent: Loopsoar/mock-chat`、`x-test-request: <uuid>`
- 证据：gui-73-header-template.png

## 二·十九、2026-10-31 第十六次增量（OpenCode Go 开箱可用）
- 内置供应商默认头：识别 opencode.ai/inference/go（或 provider=opencode-go）→ 自动附加
  `x-opencode-session: {{sessionId}}` 与 `User-Agent: Loopsoar/1.0`，用户自定义可覆盖
- 聊天、模型列表探测、测试连接三条路径统一应用默认头（此前测试通过/聊天失败不再发生）
- 设置页：自定义请求头改为全宽等宽输入框（此前窄栏被挤成白条，实际无法编辑）+ 占位示例；
  新增「OpenCode Go」快速填充预设（服务商/接口/OpenAI 协议/默认头/示例模型）
- 测试：398 全绿（providerDefaults 3 等）；截图 gui-74

## 二·二十、2026-11-01 第十七次增量（跨供应商模型菜单）
- 模型菜单改为按供应商分组展示全部已配置供应商（活动置顶、当前模型打勾、显示各供应商接口域名），
  不再只显示当前供应商；选择其他供应商模型会自动切换活跃供应商并更新模型
- 数据整备抽成纯逻辑 `modelGroups.ts`（默认模型必显示、停用模型隐藏、去重、活动置顶），3 用例
- 修复切模型产生重复供应商的旧 bug：`settings:setProvider` 在目标就是活跃供应商时原地改 model
  （新增 `isSameProviderTarget` 纯函数 + 用例）
- 测试：402 全绿；证据：gui-75（分组菜单）、gui-76（切到 opencode-go · glm-5.3）

## 二·二十一、2026-11-01 第十八次增量（提示/历史模型/顶栏浮层）
- 提示浮层自动消失：成功 4.5s、失败/中断 8s（不再需要手动点掉）
- 回复模型按消息记录：发送时快照 provider/model → 会话持久化（PersistedMessage/ChatHistoryMessage）
  → 历史恢复后再按各自模型展示；旧会话无记录则不显示（不再错误显示当前模型）
- 历史记录/下载浮层改用 AnchoredPopover（Portal + fixed + left 视口夹取），不再出现贴顶/脱位/被裁切
- 测试：404 全绿（session-model 2、chatStreamState 恢复模型断言）；证据：gui-77

## 二·二十二、2026-11-01 第十九次增量（地址栏 object / 防循环阈值 / 持久化加固）
- 地址栏 `[object Object]`：Electron did-navigate/did-navigate-in-page 参数为 (event, url)，
  改为取 args[1]（此前把 event 转字符串）
- 重复工具保护可配置：默认提醒 5、停止 30（原硬编码 2/5 过小）；设置·通用新增两项，
  贯通 preferences → ChatService → tool_loop；tool_loop 增加配置用例
- 持久化加固：
  - ProviderStore 启动时合并历史重复供应商（同 provider+baseUrl），保留首条 id、并入 headers/models/apiFormat/rpm
  - settings:setProvider 命中任意已有供应商时原地更新 model（不再丢请求头/模型清单/密钥关联）
  - 新增重复合并与「更新保留 headers/models」用例
- 测试：407 全绿；证据：gui-78（地址修复）、gui-79（阈值设置）

## 二·二十三、2026-11-01 第二十次增量（会话 UI 对齐 slime）
- 移植 slime 的「锁定最新」滚动跟随（去屎山、抽纯判据）：`scrollFollow.ts`
  · 滚轮上滚立即解锁（不受程序贴底抵消）；距离滞回 8/48px；内层代码块滚动不打扰外层
  · ResizeObserver + MutationObserver 驱动 rAF 贴底循环（折叠展开/图片增高也跟随）
  · 上翻后出现「回到最新」按钮，回底自动恢复；顶部/底部渐变遮罩
- 移植 slime 吐字切分：`streamFadeSplit.ts`（settled 止于换行、尾行渐入、未闭合代码回退）
  修复此前"末行被挤回上一行"的重排；原 StreamFade 换为 slime 同款三段行内流
- 助手回复布局对齐：32px 头像左列 + 名称行 + 悬停元信息（复制/模式/模型/耗时/思考开关）
  位于正文之前；思考与正文之间 `msg-body-divider` 分隔线；正文 15px
- 正文后置闸门：流式期间正文不开闸，只显示「正在思考/思考与工具调用进行中」+ 2px 光标；
  思考与穿插正文（13.5px）照常实时显示，轮次结束才揭晓完整正文（对齐 slime 的 GatedBody）
- 测试：415 全绿（scrollFollow 3、streamFadeSplit 5）；证据 gui-80/81/82

## 二·二十四、2026-11-01 第二十一次增量（切换会话修复 / 分隔条修复）
- 会话流按会话隔离（slime 同思路的本土化实现）：
  · App 增加 per-session 消息缓存与流元信息（activeId/startedAt/firstTokenAt/busy/stopping）
  · chat:stream:* 事件按 payload.sessionId 路由；后台会话继续写入自己的缓存，切回即恢复实时态
  · 切换会话/新建会话不再清空或串台；回切后流式状态、模型、停止按钮均正确
- 停止语义修复：
  · 删除 shell stop 里重复的 `done` 推送（服务自身已 emit 唯一 done）——「看似结束却仍在跑」的根因
  · UI 标记用户主动停止：abort 的 error 事件收束为「已停止」+ 中断原因，不再出现红色报错
- 侧栏分隔条：原生网页视图宽度让出 `SPLITTER_WIDTH=6px`（此前视图盖住分隔条，打开网页后无法拖拽）
- E2E：session-switch 模式（长流中切新会话再切回）证据 gui-84；停止 gui-85

## 二·二十五、2026-11-01 第二十二次增量（架构检查/整理）
- 新增 ADR-0013：会话流按会话隔离 + 会话 UI 纯模块化（含现状与下一轮准备清单）
- 抽出 `TitleBar.tsx`、`useLoopsoarApi.ts`；`SessionStreamMeta` 与工厂移入 `chatStreamState.ts`
- 删除未使用 ROLE_LABEL/roleColor 与遗留全局流 ref；App 1883 → 约 1760 行（仍高于 1200 红线，已登记下一步）
- 会话流元信息新增单测；全量 418 用例待跑

## 二·二十六、2026-11-01 第二十三次增量（会话即浏览器文件夹 + 持久化查证）
- 新增 ADR-0014：会话 = 浏览器的"文件夹"
  · BrowserHost 改为 sessionId → 标签组；只有当前会话的活动标签可见，其它会话页面保留但隐藏
  · 所有 browser_* 工具按 ToolContext.sessionId 操作自己会话的标签（后台 Agent 不串台）
  · 切会话只换可见组；新会话空标签；地址栏随会话清空/恢复
- 本地持久化：SessionStore 增加 browser: { tabs, activeIndex }（URL/标题/历史，不存正文）
  · 标签变化防抖落盘、退出前全量落盘；重启恢复最近会话的页面/活动标签（gui-88）
  · 启动改用 shell 的真实 currentId，修复"幽灵会话 ID"（之前 useRef 随机初始化）
- 测试：browserSessionHost（隔离/工具 sessionId/恢复/删除）、browserSessionState（净化），全量 423
- 研究文档 `docs/research/session-browser-persistence-cloudflare.md`：Cloudflare 免费可做，推荐 Workers+D1+GitHub OAuth Device Flow+客户端加密；Pages 只做静态/部署，不建议 GitHub 仓库当数据库。本轮只查证不实施。
- 证据 gui-87（切回 A 会话恢复页面）、gui-88（重启恢复）

## 二·二十七、2026-11-01 第二十四次增量（工作区 + 会话级 worktree）
- 新增 ADR-0015：工作区（挂载项目文件夹）+ 会话级 Git Worktree
- 工作区：WorkspaceStore（挂载/切换/删除/持久化）；会话 workspaceId；新会话继承活动工作区，切会话活动工作区跟随；旧会话自动补绑
- 会话工作根单一解析：worktree > 会话工作区 > 活动工作区；file_write / terminal_run / 沙箱权限按 ctx.sessionId 解析，后台会话不串根
- Worktree：`git worktree add -b loopsoar/<session>` 到 dataDir/worktrees；面板支持创建/diff/合并/清理；合并前主仓必须干净、冲突自动 abort；删除会话时自动清理 worktree
- UI：Agent 栏新增工作区 chip + 工作区面板（挂载文件夹、Git 状态、项目会话、当前会话 worktree、diff/合并/清理）；按钮全部使用主题样式
- 测试：workspaceStore / gitWorktree / workspaceRoot / fileTools 按会话根；全量 432 绿
- 查证 `docs/research/worktree-cloudflare.md`：Cloudflare Sandboxes 仅 Workers Paid，本地 worktree 不依赖云；云端执行器后置
- 证据 gui-89（工作区面板）、gui-90（worktree 创建）

## 二·二十八、2026-11-02 第二十五次增量（P0 安全门 + 持久多环境终端 + 工具参数 Schema）
- **ADR-0016：P0 安全门加固 + 持久多环境终端 + 工具参数单一转换**（本轮落地）
- 安全门（发布门 1/3 相关）：
  - `hard_rules` 真正接入终端：`terminal_run` 与持久终端 `run/input` 逐行过 `hardRuleCheck`+`classifyCommand`（此前终端参数名是 `command` 而沙箱只校验 `args.path`，规则永不触发）
  - SSRF/DNS 钉扎：新增 `core/net/ssrf`（15 段 CIDR/IPv4-mapped/IPv6/主机名黑名单/回环开关，fail-closed）；`NetAdapter.request` 用「校验后 IP 直连 + Host/TLS servername 保持原主机 + 手动逐跳重定向」实现钉扎；`web_fetch` 改走注入的 `platform.net.request`（删除裸 fetch）；浏览器 `webRequest.onBeforeRequest` 请求守卫（私网/保留地址/非 http(s) 拦截，回环可按 `LOOPSOAR_STRICT_NET=1` 收紧）；模型探测 `validateProbeTarget`（允许本地回环模型、拒绝其他私网/元数据）+ `testProvider` 支持 anthropic `/messages`
  - `file:read/write` IPC 增加会话工作根约束（worktree>会话工作区>活动工作区）+ 读取字节上限；`sessionId` 全链路净化（`SESSION_ID_RE`/`sanitizeSessionId`，落盘路径统一净化）
  - 沙箱改为「按会话作用域」判定：`checkPermission(req, { workspaceRoot })` 不再改写全局根；修复并发会话串根竞态
  - 退出清理：`createShutdownHandler` 幂等收尾 MCP/扩展子进程、终端会话、标签落盘、审计 flush（3s 超时兜底）
  - 审计落盘：`AuditFileLogger` → `<dataDir>/logs/audit-YYYYMMDD.jsonl`（5MB 轮转、保留 5 份、字段截断、全程不抛）
- **持久多环境终端**（新增终端子系统）：
  - 6 配置档：`cmd / powershell / gitbash / python / node / cpp`（探测+版本+不可用安装提示；C++ 探测 MSVC vswhere/vcvars64 与 MinGW g++/clang++）
  - `TerminalSessionManager`：每终端独立持久子进程（保留 cwd/env）、30ms 输出合流、512KB 环形回放、30min 空闲回收、8 并发上限、`taskkill /T /F` 进程树清理、环境变量白名单（剥离 API Key/TOKEN/LOOPSOAR_*）、cwd realpath 防 symlink 越界
  - IPC：`terminal:profiles/list/open/input/run/interrupt/close/history` + 事件 `terminal:data/exit/state`；应用内终端面板（配置档 chip/多标签/原始输入/中断/清屏/高度拖拽/ANSI 剥离/2 万行/自动滚底）
- **工具参数 JSON Schema**：新增零依赖 `zodToJsonSchema`（Object/String/Number/Enum/Array/Optional/Default/Nullable/Union/Record/Lazy/Effects，未知降级+warning），`ToolRegistry.toolSchemas()` 接线 → 模型首次能拿到真实工具参数（此前为空 object 占位）
- 验证基线：**typecheck 6/6、`pnpm gen`+`pnpm check` 逐字节一致、`pnpm build` 6/6、vitest 90 文件 / 686 tests 全绿**
- 已知遗留（后续阶段处理）：管道式终端 Ctrl+C 语义=杀进程树（无 PTY，终端变 exited）；PowerShell 管道中文编码；浏览器守卫对 data:/blob: 子资源偏严需真机观察；模型探测仍有 DNS-rebinding TOCTOU 窗口；E2E 真机冒烟待跑

## 二·二十九、2026-11-02 第二十六次增量（Agent 核心补完：Loop 接线 / 路由 / 过滤 / 记忆 / 新工具）
- **Agent-Loop 可插拔接线（ADR-0010 落地）**：`LoopRegistry` 真正接入 ChatService（`runLoop` 注入）；内置 `core-loop`（runner=runToolLoop）注册；自定义 loop 抛错/静态校验失败/静默超时 → 自动回退 builtin 用同一 ctx 重跑并推送 `loop:fallback`（界面可见）；`loop:list` / `loop:setActive` 通道 + 设置页「Agent Loop」选择器 + `preferences.loopId` 持久化（修复 core 重复 PreferencesSchema 丢字段问题）
- **每轮声称核验 + 强制工具轮**：tool_loop 新增 `verifyRound`（模型准备收束且整段未用工具时核验；可疑声称注入「请先用工具实际核实」并继续循环，默认最多 2 次强制轮）与长等待工具豁免（ask_user 10 分钟静默超时、心跳保持）
- **输出过滤接线**：ChatService 对正文/推理分别做跨 chunk 身份掩码（core/filter createStreamFilter），finalText 整体兜底；`filterOutput:false` 仅调试
- **模型路由降级链**：`routerLlm`（core ModelRouter + 供应商优先级 + 可重试错误才降级 + 30s 冷却 + 输出后不重放）+ index 装配为多供应商 target 链（active 最高优先级）
- **召回门控**：MemoryService.recallPrompt 接入 `shouldRecall` 四信号门控（无信号不注入，`recallGate:false` 可关）；新增 search/recallSignals
- **新工具**：`web_search`（Bing/DDG HTML 解析、走 SSRF 钉扎 net、去重/跳转链解码）、`memory_search/add/update/delete`（读工具 plan 可用、写按 L2 确认）、`ask_user`（挂起等待真人回答、超时/取消 fail-closed、独立 AskBus + `ask:respond` 通道 + 模态弹窗、Esc/选项/自由文本）
- **UI**：AskUserDialog（模态/焦点圈定/Esc 防误关）、设置页 Agent-Loop 选择器与回退原因展示、`loop:fallback` 全局提示
- 验证基线：**typecheck 6/6、`pnpm gen`+`pnpm check` 逐字节一致、`pnpm build` 6/6、vitest 99 文件 / 783 tests 全绿**

## 二·三十、2026-11-02 第二十七次增量（浏览器功能面补缺 + 质量守卫）
- **书签**：`BookmarksStore`（`<dataDir>/bookmarks.json`，原子写/损坏恢复/同 URL 去重/上限 500 淘汰最旧/仅 http(s)）+ `bookmarks:list/add/remove` 通道 + UI 星标（已收藏实心高亮）+ 书签列表浮层（导航/删除/空态）
- **广告拦截**：contracts 单一产地 `AD_BLOCK_HOST_SUFFIXES`（40 域名后缀）+ `AD_BLOCK_URL_PATTERNS`；`browserRequestGuard` 请求层判定（子域边界防误杀、reason/kind=adblock）；偏好 `adBlockEnabled`（默认开，设置·通用可关，每次请求读最新值）；拦截日志只打 host
- **页面保存**：`browser:savePage` + `saveActivePage`（executeScript 取 title+outerHTML、补 UTF-8 meta、文件名清洗/Windows 保留名、20MB 上限、同秒冲突序号）；UI 顶栏保存按钮 + 路径 toast
- **浏览器工具补齐**：`browser_screenshot`（滚动定位→capturePage→写会话工作根 `.loopsoar/screenshots/`，返回尺寸）、`browser_wait`（selector/text 轮询，默认 3s/上限 10s）
- **刷新语义修复**：顶栏刷新按钮改走 `browser:reload`（此前是重新 navigate，会重置历史）
- **快照面板化**：`browser.snapshot` 不再只弹 toast，`SnapshotPanel` 展示标题/URL/正文/可交互元素，复制正文/链接，Esc/遮罩关闭；快照期间隐藏原生视图、设置/工作区打开时让位、页面跳转自动收起
- **质量守卫（发布门 2/4 + 架构）**：
  - 新增 `tests/guards/layering.spec.ts`：contracts←core←services←shell←ui 依赖方向、包内相对 import 不越界、仅 index/electronBrowser/preload 可 import electron
  - 新增 `tests/guards/browser-bridge-security.spec.ts`：发布门 2 四攻击路径（preload 注入/IPC 冒用/window.open 逃逸/CDP 滥用）+ 视图安全基线 + 导航白名单
  - 新增 `tests/guards/plugin-permission-lifecycle.spec.ts`：插件装载→桥接→沙箱判定→会话授权→卸载精确撤销→未知工具拒绝（发布门 4）
  - 补测试：planTools（会话隔离/状态继承/参数校验）、attachments（附件协议）、railParams（参数夹紧）
  - 修复真实缺陷：`baseName` 只按 `/` 切分导致 Windows 路径整串返回；`todo_write` 运行时校验缺 max(50)（注册表 schema 不会自动校验执行参数）
- 验证基线：**typecheck 6/6、`pnpm gen`+`pnpm check` 逐字节一致、`pnpm build` 6/6、vitest 109 文件 / 867 tests 全绿**

## 二·三十一、2026-11-02 第二十八次增量（记忆升级 + App 拆分 + 体验/质量收尾）
- **记忆升级（ADR-0007 W5 基准完成）**：
  - `core/memory/vector.ts`（纯 TS 零依赖：确定性 hash embedding 256 维、FlatVectorIndex flat Float32Array、增量 upsert/remove/墓碑 compact/内存估算）+ `core/memory/retrieval.ts`（四阶段：召回门控→BM25 关键词候选→向量重排→融合阈值）
  - 第 5 闸「跨 agent 指针」：MemoryFact 增加 `agentId?/crossAgentLinks?`，同内容不同 agent 建立双向指针而不去重/合并；旧数据自动归一 loopsoar
  - `MemoryService` 混合检索：hash 索引默认 + 可注入/自动探测 `platform.embed`（llama-server BGE-M3），失败/超时/维度非法 fail-closed 降级；新增 `searchAsync/embeddingMode/vectorStats`，既有 API 不变；`memory_search` 可用时走语义检索
  - **W5 十万条实测**（`scripts/memory-bench.mjs` → `docs/research/memory-bench-ADR-0007.md`）：hybrid P95 **17.23ms**（P50 7.81，recall@5 90.2%）、裸向量 42.95ms、keyword-linear 43.19ms、倒排 4.12ms；索引内存 145.8MB；增量写入 ~3.9 万条/秒。结论：默认后端=纯 TS hybrid（满足 P95≤50ms、零原生依赖）；sqlite-vec/LanceDB 与 BGE-M3 语义质量留打包阶段复测（报告明确不宣称优劣）
- **App.tsx 拆分（架构债清偿）**：2064 → **1118 行**（红线 1200）；新增 `useChatStreamEvents`（启动数据 + 全部事件订阅）、`useE2eDeepLinks`、`AgentSidebar/BrowserMenus/StatusBar/PermissionDialog/Toast/StartPage/ids`；顺手删除死 state/函数与 32 个无引用 style；`ui-contract` 守卫改为扫描全部 ui/src 源码（拆分后不失效）
- **体验/易用性**：
  - 上下文环真正渲染到助手头部（有数据才显示）
  - i18n 基础：`i18n.ts` 中英词典各 163 key + `useLanguage/useT` 即时切换；已接入 Composer/TerminalPanel/AskUserDialog/TitleBar/Onboarding/ContextRing，设置语言即时生效
  - 首次启动向导（3 步：欢迎→供应商设置→技能/工作区/终端；可跳过；设置·关于可重开）
  - Composer 增强：剪贴板图片粘贴（新增 `fs:saveImage` 主进程落盘 6MB/白名单）、`@`/Ctrl+U 文件引用、斜杠命令面板（/new /clear /stop /settings /compact /help）
- **质量/发布门**：新增分层依赖守卫、浏览器桥四攻击路径守卫、插件权限生命周期端到端守卫；补 planTools/attachments/railParams/pastedImage 测试；新增 `docs/E2E-SMOKE.md`（真机冒烟清单）
- **真机冒烟**：Electron 启动通过（E2E 截图自动退出）；新标签页/书签/保存/快照/状态栏终端入口/Composer 提示均正常；设置·通用可见语言切换、广告拦截开关、Agent Loop 选择器（证据：`docs/screenshots/e2e-round3-main.png`、`e2e-round3-settings.png`）
- 验证基线：**typecheck 6/6、`pnpm gen`+`pnpm check` 逐字节一致、`pnpm build` 6/6、vitest 114 文件 / 915 tests 全绿**

## 二·三十二、2026-11-02 第二十九次增量（除打包外全部清零）
- **Gateway 真接线（OpenAI 兼容）**：`packages/gateway` 由占位改为真实服务（`/v1/chat/completions` 流式 SSE/非流式、tool_calls 透传、usage、`/v1/models`、`/healthz`、Bearer 鉴权、OpenAI 错误形状）；新增 shell `gatewayRuntime.ts`（headless Agent 装配：platform/registry/沙箱/Memory/ChatService，工作区隔离 `<dataDir>/gateway-workspace`，`x-loopsoar-session` 多轮复用）+ `domains/gateway.ts`（status/start/stop + `gateway:changed`，只监听 127.0.0.1）；真机 E2E：设置页启动 → `/healthz`、`/v1/models` 正常，配 mock 供应商后非流式返回完整回复、流式输出标准 OpenAI chunk。**打包注意**：gateway 内部 fastify 为 CJS，已改为 external + dist 编译产物（避免 ESM bundle 动态 require 崩溃）
- **插件体系产品化（ADR-0011）**：PluginStore（扫描/校验/启停落盘/builtin 只读）+ PluginRuntime（每插件独立子进程、JSON-RPC 工具桥接、权限透传、冲突 fail-closed、8s/20s 超时、env 白名单、崩溃隔离）+ `plugin:list/setEnabled/reload` + 设置·插件面板；真机 E2E：demo-plugin 独立子进程 ready、工具 `greet` 成功接入工具表并在面板展示
- **权限 L0–L5 形式化 + 敏感步骤写死规则**：core `SANDBOX_LEVELS/levelForTool` 与沙箱对齐；新增 `sensitiveSteps.ts`（登录/支付/不可撤销三类，覆盖 click/type/navigate/terminal_run，NFKC 归一化、URL 只看 host+path、误报口径明确）；执行器在类别策略之后、沙箱之前**强制确认**（即使权限 allow 也确认、不写会话白名单）；权限弹窗展示「敏感步骤」原因；设置页新增开关（默认开）；44 条单测
- **Agent-Loop L2/L3**：L2 声明式循环（JSON：提示追加/limits 只可收紧/工具白名单过滤+执行器二次拦截）；L3 脚本循环（子进程 worker + JSON-RPC 代理 `ctx.llm/executeTool/emit`、预算护栏、崩溃/超时/非法 outcome 自动回退 builtin）；`loop:reload` 重扫；设置页显示真实 kind
- **记忆后端最终裁决（ADR-0007 🟢）**：better-sqlite3 13 为 N-API prebuild（Electron 45 主进程实测加载通过，**无需 electron-rebuild**）；三路 10 万条实测：flat（默认）查询 P95 26.2ms/建索引 166.7ms/增量 83k/s 全面优于 sqlite-vec（64.1ms/808.6ms/80k/s）与 LanceDB（67.7ms/1751.6ms/18k/s，RSS +513MB）→ **默认 flat hybrid，sqlite-vec 显式可选，LanceDB 不纳入**；按用户决定不引入本地 BGE/onnxruntime
- **/compact 真压缩**：`chat:compact` 预览（不写盘）/ apply（写回「摘要 + 最近 14 条」并同步索引、push `chat:compacted`）；Composer `/compact` 接真实预览+确认+重载；未超预算幂等无副作用
- **全站 i18n 完成**：Settings（351 key）+ 15 个浏览器/会话组件（172 key）+ 插件面板（39 key），中英双语全覆盖、即时切换；真机 en-US 截图验证
- **真机 E2E（新增证据）**：6 个终端档全部启动（cmd/PowerShell/Git Bash/Python 3/Node.js/C++，C++ vcvars 会话提示符）；MSVC 编译运行 hello world 通过；广告拦截真实取消 doubleclick/googlesyndication；书签收藏持久化；页面保存落盘；快照面板；ask_user 弹窗→点击选项→Agent 继续；插件子进程 ready；Gateway 真实 HTTP/SSE；英文 UI
- **质量**：浏览器桥行为级用例（preload vm 沙箱/window.open handler/IPC 冒用/CDP 全仓断言）、品牌/webview/主题/popover 缺失测试、/compact 15 用例、插件 27 用例、gateway 29 用例、loop 39 用例、敏感步骤 44 用例
- 验证基线：**typecheck 6/6、gen/check 逐字节一致、build 6/6、vitest 133 文件 / 1106 tests 全绿**

## 二·三十三、2026-11-03 第三十次增量（用户反馈整理：扩展合并 / 网关删除 / 顶部精简 / 全局历史）
- **插件合并进扩展（去重）**：用户裁决「扩展与插件是同一概念」。核实两者链路完全同构（目录扫描→清单校验→启停持久化→独立子进程→JSON-RPC 工具桥接→registry），且扩展侧已是功能超集（设置面板/通道/i18n/工具权限/测试更完整）→ **删除插件子系统 8 个文件 + core plugin kernel + 3 个测试 + 契约 3 通道/1 事件 + UI 面板/i18n 40 key**；把插件独有能力并入扩展：worker **env 白名单**（不继承 API key/token）、工具名冲突 **fail-closed 且状态可见**、**入口越界/缺失双层守卫（扫描+运行时）**、callTimeoutMs/spawn 可注入。工具命名统一 `ext__<id>__<tool>`。结论：**不冲突，是重复建设，合并后无功能损失**（唯一差异 builtin 系统根在插件中从无数据来源，不构成回退）
- **Gateway 子系统整条删除**：用户判断为 slime 遗留测试项、在 Loopsoar 无实质作用。删除 `packages/gateway` 整包、shell `gatewayRuntime/domains/gateway`、`gateway:*` 3 通道 + `gateway:changed` 事件、`services/gateway.ts` 死模块、设置分区、测试、依赖/打包脚本/守卫引用；README/ISOLATION 同步；新增守卫断言「Gateway 不得复活」
- **顶部网址栏精简**：左侧只保留 后退/前进/刷新；**移除地址栏左侧历史记录图标**；地址栏内保留收藏星标；右侧只保留 **快照 + 更多(⋯)**；下载/保存页面/设置/收藏夹/历史记录全部收进「更多」菜单（键盘可达、Esc/点外关闭、焦点管理、aria 完整）
- **浮层遮挡修复**：新增 `chromeOverlayOpen`——浏览器工具栏任一浮层（更多/收藏夹/历史/下载）打开时隐藏原生 WebContentsView，菜单不再被网页覆盖（关闭通知 150ms 合并防闪烁）
- **历史记录改全局**：新增 `browserHistoryStore`（`<dataDir>/browser-history.json`，上限 500、同 URL 去重合并 visitCount/标题回填、原子写、损坏留证容错），跨标签/跨会话共享；后退/前进仍按标签栈；历史面板显示全局条目（标题优先、访问次数 tooltip）；零契约变更
- 真机 E2E：更多菜单浮于网页之上、全局历史面板跨会话显示 3 条（含标题）、顶部新布局截图
- 验证基线：**typecheck 5/5、gen/check 逐字节一致、build 5/5（gateway 已删）、vitest 126 文件 / 1062 tests 全绿、bundle 711KB**

## 二·三十四、2026-11-03 第三十一次增量（用户反馈整理轮：浮层架构 / 整页管理 / 自适应 / 历史）
- **工具栏浮层改独立子窗口（根除网页消失/遮挡）**：新增 `chromePopover.ts`（独立 BrowserWindow：parent/透明/无边框/跳过任务栏/同 preload 白名单；同一时刻一个；主窗口 resize/move/close、blur、Esc 自动关闭；hover 120ms 光标轮询关闭）+ `computePopoverBounds`（下方优先→翻转→四边 clamp，永不截断）+ `domains/chromePopover.ts`（ui:openPopover/closePopover/popoverAction，仅主窗口可开、动作转发 chrome:popoverAction）+ 37 测试；UI 侧 PopoverApp（more/bookmarks/history/downloads 预览，限 8/8/5 条 + 固定「查看更多」footer，键盘可达）；BrowserChrome 只保留 13 props，收藏星标/更多按钮 hover 250ms 或点击即弹出；**不再隐藏原生网页视图**
- **整页管理界面（ChromePage）**：历史/下载/收藏夹/设置四类整页（顶部返回栏、加载/空/错误态、下载实时刷新、书签删除、设置复用 Settings fullPage）；「查看更多」从浮层跳转整页，替代小弹窗塞长列表
- **应用内弹窗边缘截断修复**：`popoverPosition.ts` 纯函数 placePopover（翻转/夹取/maxHeight）+ AnchoredPopover 接入 + resize/scroll/ResizeObserver 重定位；AgentSidebar 会话菜单改 Portal + Popover；Composer 4 个菜单自动升级；18 用例矩阵（四边永不越界）
- **窗口自适应根因修复**：原只有 resize 单事件直连；补齐 50ms 防抖 + maximize/unmaximize/restore/enter/leave-full-screen 六事件统一 syncBounds；E2E 六步探针实测 `actual==bounds==page.innerWidth`（995→734→1682→734→1682→734，DPR 1.25）
- **历史记录为空根因修复**：记录逻辑本身正常；空是因启动恢复的旧标签有意不记录。新增 `BrowserHistoryStore.backfill`（启动恢复后补记；已有条目不增 visitCount/不刷时间、只补空标题）+ 13 测试；真机 E2E 日志 `{"added":0,"merged":1,"skipped":0}`，历史整页可见恢复的页面
- **清理**：BrowserChrome 11 个过渡 shim props 删除；旧历史/下载浮层调用链从 App 移除；layering 守卫白名单补 chromePopover（合法 Electron 子窗口管理器）
- 验证基线：**typecheck 5/5、gen/check 逐字节一致、build 5/5、vitest 129 文件 / 1130 tests 全绿、bundle 736KB**；真机 E2E 证据：`e2e-round5-popover-main-desktop.png`（网页可见+浮层浮于其上）、`e2e-round5-viewmore-page.png`（查看更多→整页）、`e2e-round5-global-history-page.png`（全局历史整页）、`e2e-round5-resize.png`

## 二·三十五、2026-11-03 第三十二次增量（视觉/布局：柔和无框主题 + 会话栏三态 + 全宽终端）
- **终端全宽底部 dock（VS Code 式）**：TerminalPanel 新增 `fullWidth` 模式（宽度 100%、上边缘横跨全宽拖拽手柄、工具栏/输出/输入横向铺满）；App 把终端从侧栏移到应用根布局底部（浏览器区+会话栏之下），开关 240ms 高度过渡；新增 `browser:setBottomInset` 通道 + `computeBrowserViewBounds({bottomInset})`，原生网页视图同步让出底部高度（真机探针 `bottomInset:260`、`actual.height == page.innerHeight`）；拖拽期间 `setOverlay` 隐藏原生视图避免事件被吞
- **会话栏三态（收起 / 小窗化）**：`docked` / `collapsed`（48px 图标条：Agent 图标+展开+会话切换+新建，内容常驻 DOM 淡出 320ms）/ `float`（8px 外边距、16px 圆角、浮阴影卡片）；头部新增收起/小窗两个按钮，模式持久化到 `preferences.sidebarMode`，原生视图宽度随生效宽度实时重算；收起/展开回到上一次非收起态
- **柔和无框双主题 + token 体系**：theme.ts 的 BRAND 全部改为 `var(--ls-…, fallback)`（内联样式自动跟随主题），新增 RADIUS/SHADOW/MOTION/applyTheme；index.html 定义 soft 默认 30 token + classic 覆盖 23 token（旧观感逐像素保留）+ 58 条无框化规则（去 1px 硬边、大圆角、明度分层、hover 不位移、统一缓动、主题切换 200ms、reduced-motion 降级），310 处颜色字面量收敛到 token；设置·外观新增 soft/classic 分段选择（默认 soft），切换即时生效
- **动效与减噪**：侧栏收起/展开、终端拉起/收起、浮层进出统一 120–450ms decelerate；会话栏头部/工作区分隔线移除、消息/输入区去硬框；参考 `D:\pilot project` 的 collapse/float 参数与「折叠内容常驻 DOM + 延迟 visibility」经验（未拷贝代码）
- **清理**：会话栏 i18n 补 7 个 key；theme.spec.ts 重写为双主题 token/对比度断言；删除会暴露本机桌面的 E2E 桌面截图（改为窗口级证据）
- **二次调优（用户反馈「没变化」）**：像素采样确认 soft 已生效但无框力度太弱 → soft token 再调（bg #0a0c10、3 级明度拉大、`--ls-border` 归零、圆角 10/14/20、阴影加深）+ 新增 soft 专属规则（会话栏改浮动卡片：docked 四周 8px 留白/圆角/阴影；header/工作区/会话条内部分隔线全去；chip 无边框；输入区去框、focus 才出品牌描边；应用底加极轻品牌光晕；终端全宽面板大圆角浮起）；真机截图确认观感明显变化
- 验证基线：**typecheck 5/5、gen/check 逐字节一致、build 5/5、vitest 130 文件 / 1150 tests 全绿、bundle 739KB**；真机截图：`e2e-round6-soft-default.png`、`e2e-round6-classic-theme.png`、`e2e-round6-sidebar-collapsed.png`、`e2e-round6-sidebar-float.png`、`e2e-round6-terminal-fullwidth.png`

## 二·三十六、2026-11-03 第三十三次增量（用户实机 bug 修复：收起/小窗/关标签音频）
- **收起后网页不铺满（根因）**：主进程 `BrowserHost.setSidebarWidth` 最小值锁死 240，IPC 契约 `BrowserSidebarWidthSchema` 也 `.min(240)` → 收起态传 48 被 zod 拒绝、即使到达也被夹回 240，原生 WebContentsView 仍让出 240px，表现为「左侧不铺满」；修复：契约下限改 0、宿主 clamp 改 0..720；真机 E2E 探针 `sidebarWidth:48`、`page.innerWidth=1146`（1200 窗口 = 1200-48-6），最大化/还原全部同步
- **小窗化没有任何效果（根因）**：原实现只是把同一列侧栏加 8px 外边距换皮，与常驻态几乎无差别；修复：改为真正的**浮动小窗**（`position:fixed`，右下角 10px/44px 定位，340×min(68vh,620px)，圆角 20px + 浮阴影），常驻态仍是整列浮动卡片，三态一眼可区分；浮窗内容/输入/滚动全部照常
- **关闭标签后音视频继续播放（根因）**：WebContentsView 适配器 `close()` 只调 `onClose` 回调而宿主未传（实际只从窗口 detach 视图），**WebContents 从未销毁**，正在播放的媒体继续出声；修复：`close()` 先 `setAudioMuted(true)` 再 `webContents.close()` 真正销毁；新增适配器测试 + BrowserHost closeTab 销毁断言
- 验证：vitest **130 文件 / 1152 tests 全绿**（新增 2 条音频/销毁用例）；真机 E2E：收起态原生视图宽度探针、小窗浮动态截图；截图 `e2e-round6-sidebar-collapsed.png`、`e2e-round6-sidebar-float.png` 已更新

## 二·三十七、2026-11-03 第三十四次增量（会话栏「真·窗口化」：独立 Agent 窗口）
- **诉求**：用户反馈「小窗化还是坏的，无法真正窗口化，参考 slime 都做差不多了」→ 不再做页内浮窗，改为独立顶层窗口。
- **主进程新模块**：`packages/shell/src/main/agentWindow.ts`（无 parent 顶层 BrowserWindow、frame:true、420×720、最小 340×480、可缩放/最大化、标题「Loopsoar · Agent 对话」、ready-to-show、单实例时聚焦已有窗口、用户关窗只回调一次、程序性 close/dispose 不推事件；惰性 require electron + 可注入假窗口便于单测）；`packages/shell/src/main/domains/agentWindow.ts` 注册 `ui:openAgentWindow`（仅主窗口可调，带 sessionId）/`ui:closeAgentWindow`（主窗口与小窗自身都可调），用户关窗或主动关闭都会 push `chrome:agentWindowClosed`。
- **小窗复用同一套 UI**：URL 为 `loopsoar://app/index.html?mini=1[&sessionId=…]`；App 识别 `mini=1` 后隐藏标题栏 / 浏览器网址栏 / 启动页 / 分隔条 / 状态栏，会话栏铺满整窗（四周 8px 留白、无边框），从根上区别于「主窗口里的浮窗」。
- **原生网页视图让位（根因修复）**：小窗打开时主窗口 `effectiveSidebarWidth = 0`，网页铺满；关窗（含在小窗内点「收回」）后侧栏恢复。排查发现 `useChatStreamEvents.ts` 挂载期会用偏好里的 sidebarWidth 直发 `browser:setSidebarWidth`，把 App 已发送的 0 覆盖回 419 → 删除该直发，原生视图宽度改由 `App.tsx` 的 `effectiveSidebarWidth` 单一来源同步。
- **生命周期**：主窗口关闭时同时关闭 Agent 窗口（否则 `window-all-closed` 不触发、进程残留成「只剩小窗」）；shutdown 时 dispose；layering 守卫按 chromePopover 同理由放行惰性 require electron；channels-have-handlers 守卫补假 manager 装配。
- **契约**：新增 `ui:openAgentWindow`、`ui:closeAgentWindow` 通道与 `chrome:agentWindowClosed` 事件（`pnpm gen/check` 逐字节一致）。
- **验证**：typecheck 5/5、gen/check 一致、build 5/5、vitest **131 文件 / 1176 tests 全绿**（agentWindow 24 条：窗口行为/事件语义/域守卫/参数归一化）；真机 E2E：点「小窗化」→ 独立窗口 422×720、URL 含 `?mini=1`、DOM `mini=1` 且 titlebar/chrome 均不存在、会话栏铺满；主窗口 `sidebarWidth:0`、网页视图宽度 1355 铺满；关窗后 `E2E_AGENT_WINDOW_RESTORED` 侧栏 `display:flex`、`sidebarWidth:419` 恢复；截图 `e2e-round8-agent-window-agent-window.png`、`e2e-round8-agent-window-main-fullwidth.png`。

## 二·三十八、2026-11-03 第三十五次增量（自绘窗口 chrome / 本地图标库 / 发送↔中断 / hover / slime 动效收敛）

用户五点诉求（第 9 轮）：① 独立 Agent 小窗不要系统标题栏，最小化/关闭换成定制图标；② 使用本地图标库，禁止 emoji 当图标；③ 发送后按钮变中断、输入内容则变回发送；④ 主界面窗口按钮 hover 无反馈；⑤ 按 slime 的动画实现根除「出现/收起位置反逻辑」。

- **独立 Agent 窗口去系统边框**：`agentWindow.ts` 改 `frame:false` + `titleBarStyle:"hidden"` + `roundedCorners:true`，自绘标题栏（`TitleBar variant="agent"`：品牌标 + 「Agent 对话」+ 仅最小化/关闭，`-webkit-app-region: drag` 拖动、双击不最大化）；新增契约通道 `ui:minimizeAgentWindow`（仅 Agent 窗口可调），最小化后主窗口恢复侧栏，保证仍有可见入口。
- **贴主窗口右缘 + 连贯滑入/滑出（根因）**：窗口不再交给 OS 默认放置。`computeAgentWindowBounds` 以主窗口 `contentBounds` 为基准：`x = right - 420 - 8`、`y = top + 118`，按所在显示器 `workArea` 四边夹取；打开时隐藏创建、首帧即 `target.x + 24`，200ms `cubic-bezier(0.2,0,0.2,1)` 滑入并淡入；关闭 160ms 滑出后销毁，`chrome:agentWindowClosed` 改到**窗口真正销毁后**推送（此前滑出前就推，导致主窗口侧栏提前展开）；主窗口 move/resize/maximize 等 7 类几何事件统一走 16ms 防抖 `reposition()`，小窗始终贴右缘。
- **发送 ↔ 中断单按钮**：删除 Composer 独立停止块与「运行中发送」询问弹窗；主按钮三态——`busy && 输入为空` → 红色停止图标（点击 `onStop` 立即中断，不置灰）；`busy && 有输入` → 发送图标（走 steer 转向）；`idle` → 发送。E2E 探针实测 `title/icon/bg` 随输入即时切换。
- **窗口按钮 hover 根因**：`TitleBar` 的 `styles.windowButton` 内联 `background:"transparent"` 覆盖了 `index.html` 的 `.win-btn:hover` → 移除内联背景/颜色，基类统一给 hover；关闭键 hover 变红（真机 `rgb(196,43,28)`/白字）；同时补标签页/chip/模型项 hover（chip 内联背景用 `!important` 覆盖）。
- **本地图标库替换 emoji**：从用户 `Loopsoar/icon/icon_fpbc119q3rk` 迁入 42 个 1024 viewBox SVG 到 `packages/ui/public/icons`（ASCII 命名 + `SOURCE.md` 映射表）：发送=`guide-arrow`、中断=`终止`、最小化=`minus`，另自绘 maximize/restore/checkbox 等；替换 ArtifactPanels/LiveStatus/Settings/TimelineView 中的 emoji 与几何符号；`Icon` 统一走 CSS mask + currentColor；新增 `tests/ui/icons.spec.ts`。
- **按 slime 规范收敛动效（根因，新增 `docs/design/sidebar-motion.md`）**：提炼 10 条不变式（右缘钉住、禁用 auto 宽过渡、px 目标宽 + `!important`、wrapper 与内容同曲线、独立退场类、内容常驻 DOM、预捕获时间驱动、CSS token 单一产地、与拖拽互斥等）；据此修复：DOM 侧栏与原生 WebContentsView 曲线同源 `cubic-bezier(0.2,0,0.2,1)`、同为 320ms（此前两套曲线 8–9px 不同拍）；`computeBrowserViewBounds` 仅在 docked 态扣 6px splitter（收起/窗口化不再留 DOM 缝）；侧栏外层删除 `display:none` 瞬切，改宽度+padding 过渡并右缘钉住；启动水合不播动画；删除 `.agent-sidebar-fade`/`[data-mode="float"]` 死 CSS；修正关闭事件时序与最小化语义。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5（ui 603.56 kB / gzip 176.59 kB）、`vitest` **132 文件 / 1205 tests 全绿**。
- **真机 E2E 证据**：无边框 Agent 窗口 422×722（`e2e-round9-agent-window-agent-window.png`）、主窗口网页铺满（`-main-fullwidth.png`）；滑入轨迹 `x 686→662`（200ms）、主窗口原生视图 `sidebarWidth 507→0` 逐帧插值；窗口按钮 hover（`e2e-round9-titlebar-hover-hover.png`）；Composer 生成中=停止图标（`e2e-round9-composer-stop.png`）、运行中输入后即变回发送（`e2e-round9-composer-typing.png`）。

## 二·三十九、2026-11-05 第三十六次增量（顶部标签行 + chrome 闭环外壳）

用户诉求（第 10 轮）：标签页移到最顶行、与窗口按钮同列；活动标签填充高亮、去掉白描边胶囊；网页/会话/顶部之间不要硬直角缝隙；网址栏只覆盖网页列、不延伸进会话栏；会话栏顶部按钮区与网址栏同底色并纵向拉长；输入框与周围底色区分；最后用同一块抬高外壳把工具条与会话栏连起来，让网页面板以圆角内缩成闭环。

- **标签页升到标题行**：`TitleBar` 新增 `tabs?: React.ReactNode` 插槽（main 变体 = 左侧标签 + `+`，中间拖动区，右侧最小化/最大化/关闭；agent 变体不变）。新增 `packages/ui/src/BrowserTabs.tsx`，`BrowserChrome` 删除独立 34px 标签栏与三个 tab 回调，只保留第二行导航工具条；`TITLE_BAR_HEIGHT` 36→**40**、删除 `TAB_BAR_HEIGHT`，原生视图顶部偏移同步为 `40 + 48 + inset`。
- **标签渲染改为 Chrome 式**：非活动标签透明底、无边框、次级文字色，仅 hover 变色；活动标签填充 `--ls-surface-raised`（与下一行工具条同色连成一片）+ 文字提亮，关闭键仅 hover 出现；`.tab-item` 基础规则统一放进 `index.html`（soft/classic 共用 token）。
- **chrome 闭环外壳（根因）**：`App` 结构改为 `workRow`（整块 `BRAND.inkRaised` 抬高面）= 左侧 `pageColumn`（工具条 + 网页面板）+ splitter + 右侧满高会话栏；`StatusBar` 也改 raised 并删除 borderTop，外框一直延伸到底。网页面板四边内缩 `BROWSER_VIEW_INSET=8`、圆角 `BROWSER_VIEW_RADIUS=14`，DOM 占位与原生 `WebContentsView` 同参数（`view.setBorderRadius(14)` + `computeBrowserViewBounds` 内缩），形成「深色门户嵌在抬高外壳里」的闭环。顶部工具条/会话栏/间隙共享同一底色，原先 splitter 6px + 侧栏左侧 8px 露出的应用底色暗缝被填满。
- **网址栏收窄与会话栏配色**：`BrowserChrome` 工具条背景 `BRAND.inkRaised`、地址栏只铺到网页列宽度（omnibox `maxWidth:720`、右侧动作区 `marginLeft:auto`），删除 borderBottom 硬线；会话栏 `background: BRAND.inkRaised`、`borderLeft:none`、header 高度 48 与第二行工具条同横带；soft 主题 `.agent-sidebar` 覆盖改为 `var(--ls-surface-raised)`、无边框无阴影。输入区：`Composer` 外层去 borderTop/透明，输入卡片 `BRAND.inkRaised` + 圆角 14，与周围形成对比。
- **窗口圆角**：`agentWindow` 的 `frame:false + roundedCorners:true` 保持，与外壳圆角视觉一致。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **132 文件 / 1205 tests 全绿**（layout-nav / core-layout / browserHost / agentWindow / historyBackfill 期望值全部按新几何更新：`x=8`、`y=96`、宽高各多扣 16、不再扣标签栏 34）。
- **真机 E2E 证据**：`docs/screenshots/e2e-round10-closed-frame.png`（顶行标签活动高亮无白框、工具条/会话栏同色连成闭环、网页面板圆角内缩；页面为本地 E2E 测试页）、`docs/screenshots/e2e-round10-panel-browser-view.png`（原生网页内容渲染截图）。像素采样：外壳 `rgb(23,27,34)`、omnibox 胶囊 `rgb(8,11,16)`、标题栏/状态栏 `rgb(10,12,16)`；几何探针 `bounds {x:8,y:96,width:978,height:724}`（1360×860、sidebar 360）。
- **已知限制（记录，不阻塞）**：`win.capturePage()` 不含原生 `WebContentsView`，窗口级截图里网页面板显示为占位；功能与几何以 `debugBounds` + `browser:view` 截图交叉验证。聊天区右缘的金色波浪线是「卷轴」自定义滚动条设计元素，不是渲染伪影。

## 二·四十、2026-11-05 第三十七次增量（星标折叠开关 + 地址栏随列伸缩 + 滚动条单一化）

用户诉求（第 11 轮）：① 收起/展开入口分散（一个在右上角左边、一个在右上角下面），要求改成同一个星标方块开关——收起时只显示方块，点击展开后方块变长方形、星标平滑左移、右侧渐入收起图标；② 收起后地址栏要随网页列变宽向右延伸，而不是一直很短；③ 会话右侧滚动条处又出现了原生上下箭头按钮，要求只保留波纹卷轴。

- **统一星标折叠开关（根因：两个反向按钮分散在两处）**：删除 `AgentSidebar` 收起态 rail 的全部按钮（星标方块下方的 `‹` 展开、会话切换、新建）与展开态 header 里的 `>` 收起按钮，改为两态共用的绝对定位 `.sidebar-toggle`：收起 = 32×32 圆角方块（仅 `agent` 星标）；展开 = 62×32 长方形，星标绝对 `left:8` 随容器左扩平滑左移，右侧让出的空间渐入 `forward` 收起箭头（opacity 延迟 90ms）；宽度 320ms `cubic-bezier(0.2,0,0.2,1)`。右缘 `right:8` 固定，所以视觉动作始终是「向右展开 / 向左收起」一个方向。点击收起→回到 `lastExpandedModeRef`（docked/float），展开→collapsed；`fill`（mini/独立 Agent 窗口）时隐藏（关闭由该窗口标题栏负责），header `paddingRight:78` 避免和绝对开关重叠。hover 放进 `index.html` 的 `.sidebar-toggle:hover`（内联 background 会压过 hover，与第 9 轮根因同类）。
- **地址栏随列伸缩（根因：第 10 轮遗留的静态上限）**：`BrowserChrome` 的 `omniboxWrap.maxWidth:720` 是第 10 轮「地址栏不要伸进会话栏」时加的 cap；但第 10 轮已把工具条裁进 `pageColumn`，cap 变成多余限制——侧栏收起后网页列变宽，地址栏却不跟着变长。删除该 cap，omnibox `flex:1` 填满网页列；新增 `.browser-toolbar` / `.browser-omnibox` 类便于探针与样式定位。
- **滚动条单一化（根因：soft 主题覆盖了基础隐藏规则）**：`index.html` 的 soft 主题块给 `.chat-scroll` 设了 `scrollbar-width:thin` + `scrollbar-color`，覆盖基础规则 `.chat-scroll { scrollbar-width:none }` 与 `::-webkit-scrollbar{width:0}`，于是原生 WebKit 滚动条（含上下箭头按钮）重新出现，与右侧 TopicRail 波纹卷轴叠在一起。删除该覆盖并留注释，聊天区只保留波浪卷轴。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **132 文件 / 1205 tests 全绿**。
- **真机 E2E 证据（DOM 探针 + 截图）**：展开态 `omni.w=667`、toggle `62×32`；点击后（900ms 落定）`mode=collapsed`、`omni.w=1132`、toggle `32×32`、`.chat-scroll` 滚动条厚度 = 0；展开动画采样 `32→47→62`（100ms/600ms 两点，连续无跳变）。截图 `e2e-round11-expanded.png`、`e2e-round11-collapsed.png`、`e2e-round11-toggle-mid.png`（动画中帧：长方形、星标在左、箭头渐入）。

## 二·四十一、2026-11-05 第三十八次增量（输入区独立色块 + 卷轴悬停卡片 + 数据目录绝对化）

用户诉求（第 11 轮追加）：「会话栏的输入框，我希望那个区域做成其他色块区分一下」，以及「如图，这个地方，鼠标放上去后的表现形式仍旧不是我要的样子，你给我仔细研究 "D:\pilot project" 的 slime 项目」——指向聊天区右缘波纹卷轴的悬停提示。

- **输入区独立色块**：`Composer` 外层从 `transparent` 改为 `BRAND.ink`（下沉一档，padding `10px 12px 8px`），输入卡片保持 `BRAND.inkRaised` + 1px 边框 + 圆角 14 —— 会话面是 raised、输入区是深色带、卡片再抬起，三段层次取代任何分隔线（soft 主题下分别为 `#171b22` / `#0a0c10` / `#171b22`）。
- **卷轴悬停卡片对齐 slime**：`TopicRail` 的 tip 由「单行 `百分比 · 标签 · 上下文%`」改为 slime 结构 `<i class="dot"/><span class="ord"/><span class="txt"/>`：左侧 6px 强调色圆点、`n / total` 等宽序号、话题标签（无标签时退回上下文百分比）；卡片 `right:22px` 悬浮在卷轴左外侧、跟随鼠标只动 `translate3d`（合成器属性，不触发布局），`display:none→flex` 显隐，样式全部改用主题变量（`--ls-surface-raised` / `--ls-border` / `--ls-accent`），最大宽 300、12.5px、圆角 8、阴影 `0 6px 22px rgba(0,0,0,.5)`。
- **启动崩溃修复（用户截图报错）**：`LOOPSOAR_DATA_DIR=.loopsoar-data` 这类相对路径会让 Electron `app.setPath("userData", …)` 抛 `Error: Path must be absolute`，主进程加载失败。新增无 Electron 依赖的 `packages/shell/src/main/dataDir.ts` 的 `resolveDataDir(override, appDataPath)`（trim + `path.resolve`；未设置才回落到 appData 下的品牌目录），`index.ts` 与 `pastedImage.ts` 共用同一归一化；`tests/shell/dataDir.spec.ts` 4 用例锁回归。真机复跑：相对路径启动日志 `dataDir=D:\…\.loopsoar-data-mock` 正常、截图保存成功。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**（新增 dataDir 4 用例）。
- **真机 E2E 证据**：`docs/screenshots/e2e-round11-composer.png`（mock LLM 对话 + 卷轴悬停：卡片显示「● 1 / 1 你：请用一句话介绍 Loopsoar 的卷轴设计」；输入区为深色带、卡片抬起；日志 `[E2E] RAIL_HOVER hovered`）。

## 二·四十二、2026-11-05 第三十九次增量（输入框本体色块 + slime 式双股编织卷轴）

用户诉求（第 11 轮追加修正）：「对于输入框，我希望变色的是输入框而非输入框周围」；并给出 slime 卷轴截图，要求卷轴做出 slime 的编织发光效果，而不只是改悬停卡片。

- **输入框本体色块（根因：上一轮把「周围整条」涂深，方向反了）**：`Composer` 外层去掉 `background: BRAND.ink` 深色带，恢复为会话栏底色；只把 `composerBox`（输入卡片）从 `BRAND.inkRaised` 下沉到 `BRAND.ink`（soft 主题 `#0a0c10`），保留 1px 边框 + 圆角 14 —— 现在变色的是输入框本体，周围与消息区同一平面。
- **slime 式双股编织卷轴（根因：旧实现只画两条细线 + 视口高亮段）**：`TopicRail.paint()` 重写为 slime 的 `strokeWave` 结构：两股线 `xAt(y, λ, φ, key)` 反相（φ=0/π）、反向（key=+1/-1）、不同波长（lam0/lam1），`sep = amp*taper(y)*(1-0.55*focusAt(y))` 形成编织麻花；每股一条主线 + 一条更宽的低 alpha 光晕（glow pass）；`lineStyle(rgb, aLit, aDim)` 沿纵向渐变（视口中心最亮、上下渐暗、两端乘 taper 渐隐）；新增 `scrollPhase = scrollTop*0.0105` 让滚动时波纹流动；悬停改为「捏拢 + 推开」（`focusAt` 高斯窗、`pointerPush`），删除旧的话题圆点与局部高光段。
- **配色遵循品牌约定**：亮股 `244,239,230`（linen）、暗股 `216,142,88`（ochre 亮一档），光晕同色低 alpha；不直接复制 slime 的蓝白配色（沿用「不照搬 slime 配色」的约定，仅借算法与交互）。
- **卷轴规整化（用户反馈「越来越乱」后的修正）**：首版两股用了不同波长（lam0=86 / lam1=112）且振幅放到 5px+、光晕 5px，结果两股不断漂移分离，看起来像 3～4 条乱线；改为两股**同一波长**（`lambda = min(lam0, lam1) ≈ 86`）、`key=±1` 反向，保证在 `y = n·λ/2` 处规律交叉；振幅收敛到 `≤ width/2-3`（默认约 2.9px）、主线 1.5～1.8px、光晕 3～3.8px 且透明度降到 0.10～0.15，x 夹取留 2px 安全边。现在是一条干净的 linen/ochre 双股麻花。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**。
- **真机 E2E 证据**：`docs/screenshots/e2e-round11-rail-braid.png`（静止态：规整双股麻花 + 输入框本体深色圆角块）、`docs/screenshots/e2e-round11-rail-braid-hover.png`（`LOOPSOAR_E2E_HOVER_RAIL=1`：悬停收拢 + 卡片「● 1 / 1 你：…」，日志 `[E2E] RAIL_HOVER hovered`）。

## 二·四十三、2026-11-05 第四十次增量（卷轴外观回退 + 悬停突起反馈）

用户反馈（第 11 轮追加）：「也不对啊，还不如如图原来那一版，主要是我说的鼠标放置时的反馈一点没变啊，我要的一直是第三张图 slime 那种鼠标放上去后的突起反馈啊，你给我把外观改回去，反馈做出来。」——即：① 双股麻花版外观不如原来的细金线，回退；② 悬停时要像 slime 一样在指针处鼓出「突起」，此前只是收拢，方向不对。

- **外观回退**：`packages/ui/src/TopicRail.tsx` 从 `1a4f641` 版本恢复「极细双股波浪线 + 视口提亮 + 话题圆点」的原始绘制，撤销 二·四十二 的粗编织（该版被评估为「越来越乱」，仅保留在 git 历史与旧截图中）。
- **悬停突起（根因：之前只做了「收拢」，是反向反馈）**：画布向轨道左侧扩出 `BUMP_PAD=30px`（canvas 宽度 `w+30`、`margin-left:-30px`、轨道热区宽度不变），`paint()` 里新增 `pointerPush(y) = -bumpAmt * max(8, width*0.75) * exp(-((y-ptrY)/(height*0.045))²/2)`：指针高度处整条线向聊天区一侧平滑鼓出，高斯窗保证上下连续；`frame()` 每帧把 `bumpRef` 向 0/1 目标做 0.16 线性缓动（进入约 150ms、离开自然收回），指针离开时保留最后 y 供回缩动画使用。视口提亮段/话题圆点同步使用带突起的 `xAt`。
- **验证基线**：typecheck 5/5、`pnpm check` 逐字节一致、build 5/5、vitest **133 文件 / 1209 tests 全绿**。
- **真机 E2E 证据**：`docs/screenshots/e2e-round11-rail-final.png`（静止态＝原始细线外观）、`e2e-round11-rail-bump.png`（`LOOPSOAR_E2E_HOVER_RAIL=1`：指针高度处明显鼓包 + 提亮段，日志 `[E2E] RAIL_HOVER hovered`）。

## 二·四十四、2026-11-05 第四十一次增量（卷轴突起平滑化 + 悬停卡片对比度）

用户反馈（第 11 轮追加）：「如图，不对啊，你测试的这样（第二张图）才差不多啊。」「不对，就是有问题。」——即实机悬停突起仍不像测试图里那种平滑鼓包。

- **排查（像素测量用户截图）**：用户截图里卷轴在指针高度确有 **-8.5 ~ -14px 的左移**（说明突起已生效、构建是新的），问题在**形状**而不是幅度：基础荡漾（两股 λ0/λ1 相位不同）叠加突起后，两条线在平移中心附近交叉，形成 S 形/打结感；同时悬停卡片背景用了 `--ls-surface-raised`，与会话面同色，soft 主题下 `--ls-border` 又是透明，导致卡片几乎不可见。
- **修复**（`packages/ui/src/TopicRail.tsx`、`packages/ui/index.html`）：
  1. **突起区压平荡漾**：新增 `waveDamp(y) = 1 - 0.85 * bumpAmt * exp(-((y-ptrY)/(bumpSigma*1.15))²/2)`，正弦项乘以它——指针处两股线重合成一条平滑外鼓曲线，离开后逐渐恢复波纹，不再打结。
  2. **高斯窗加宽**：`bumpSigma` 由 `max(26, height*0.045)` 改为 `max(34, height*0.06)`，窄窗口边缘也不过陡。
  3. **突起幅度略增**：`reach` 由 `max(8, width*0.75)` 改为 `max(10, width*0.9)`（16px 轨道约 14.4px）。
  4. **不依赖 rAF**：`onPointerMove` / `onPointerEnter` 更新状态后立即 `paint()`；系统减少动画（`reducedRef`）时把 `bumpRef` 直接置 0/1，避免 rAF 被降频/暂停时「悬停没反应」。
  5. **卡片对比度**：`.topic-rail-tip` 背景改 `var(--ls-bg)`（比会话面 raised 更暗）、描边改 `1px solid rgba(255,255,255,0.12)`，保留阴影/圆角，卡片一眼可见。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**。
- **真机 E2E 证据**：`docs/screenshots/e2e-round11-rail-smooth.png`（静止态外观不变）、`e2e-round11-rail-smooth-bump.png`（`LOOPSOAR_E2E_HOVER_RAIL=1`：突起为单一平滑包络、无 S 形打结；深色卡片显示「● 1 / 1 你：你好，请简单介绍一下你自己」，日志 `[E2E] RAIL_HOVER moved` 与 `RAIL_TIP`）。
- **备注**：E2E 合成鼠标偶发被下一帧的 pointerleave 清掉悬停状态（首次复跑 `RAIL_TIP display:none`，重跑正常），属合成输入时序抖动，不是功能回归；真机悬停稳定。

## 三、未完成 / 已知问题（下次继续）

### 0.1.0 后启动（已记录，不提前做）
- **Cloudflare + GitHub 产品化与免费跨设备同步**：官网/文档/下载（Pages、GitHub Releases、R2）、更新检查、Email Routing、Turnstile、免费同步 API（Workers + D1 + GitHub Device Flow + 客户端加密）、可选付费云端 worktree（Sandboxes 需 Workers Paid）。
  完整计划、域名分工、免费额度、前置授权与验收标准见
  `docs/规划/0.1.0后-Cloudflare-GitHub-产品化与同步.md`。
  **触发条件：Loopsoar 0.1.0 可安装版本完成后。此前不写部署代码、不申请付费。**

### 高优先
1. **本轮新增 UI 待验收**：ToolCard、Markdown 表格、中断横幅已实现且测试/构建通过，
   但最后一次 E2E 截图停留在历史消息，未能拍到表格/卡片最终效果 —— 需要重跑：
   - 关闭"恢复上次会话"或用干净数据目录
   - `pnpm dev` 后发一条会触发工具的请求（或 mock `MOCK_TOOL_NAME=browser_snapshot`）
2. **会话渲染继续对齐 slime**：时间线 + 产物/diff 已完成；剩余：
   终端输出卡细节（目前复用工具卡等宽输出）、网址卡、展开/收起与渐入渐出的更细动画、
   时间线完整度（逐块对照 slime `ChatPanel.tsx` 的 TimelineNode/PlanCard/LiveStatusLine）
3. ~~扩展运行时~~：已完成（ADR-0008 + 单测 + 真机 E2E `gui-46-extension-runtime.png`）；
   下一步可做：扩展安装引导（zip/目录）、签名与版本校验、市场
4. **打开技能/扩展目录报错修复未实测**：已在 shell 打开前 `mkdirSync`；
   若仍失败，把 设置→高级 diagnostics 与报错发出来
5. Agent 中断原因可视化：done 的 `status/reason` 已进气泡横幅，但需要一次真实失败/预算中断验证

### 中优先
6. MCP 权限确认体验（network 默认 confirm）：可加"本次允许/会话允许"更醒目提示，或默认 agent 权限策略说明
7. 会话历史：滚动/恢复时的竞态（曾出现 E2E 历史覆盖新消息），需保证恢复完成前不覆盖实时消息
8. 供应商定价/上下文档（slime 的模型价目）、外观页主题色板
9. 搜索体验（结果页 UI/历史搜索建议）

## 四、关键约定（必须保持）
- 依赖方向：contracts ← core ← services ← shell ← ui；禁止 shell→ui 反向依赖
- 所有 IPC：`packages/contracts/src/schemas.ts` 注册 channel（domain/method/request/sensitive）→
  `handleTrusted` 使用 → `pnpm gen` + `pnpm check`
- 只有 `main/index.ts` / `main/electronBrowser.ts` / `main/chromePopover.ts` / `main/agentWindow.ts` 可 import electron（后两者为必须建窗口的惰性 require，已由 layering 守卫显式允许）
- 三子系统隔离：扩展 `extensions/`+`extensions.json`、技能 `skills/`+`skills.json`、MCP `mcp.json`；
  通道前缀 `extensions:*`/`skills:*`/`mcp:*`
- 视觉：Loopsoar 品牌（深墨 #111318 / 亚麻白 #f4efe6 / 赭石 #c8763c），不直接复制 slime 配色
- 安全：apiKey 永不回传渲染层/不进日志；导航仅 http/https；工具按类别过权限与沙箱
- 提交前必跑：typecheck + vitest + build + `pnpm gen/check`

## 五、2026-10-31 增量（第二轮）
- 扩展运行时（ADR-0008）：子进程 worker + 工具桥接 + 超时/崩溃隔离 + 设置页运行状态/启停
- 修复动态工具被沙箱拒绝：MCP/扩展工具注册后回调 `syncKnownTools`（此前 MCP「权限拒绝：未知工具名」根因）
- 打开技能/扩展目录改用 explorer.exe（绕开 shell.openPath 的 Windows 访问错误），失败回传 UI
- 历史恢复竞态保护：只填充空会话，不覆盖实时消息
- Markdown 表格渲染验证通过（`gui-45-tables.png`）；工具卡片验证通过（`gui-44` / `gui-46`）
- 新增测试：`tests/shell/extensionRuntime.spec.ts`（3 用例，真实子进程）、`tests/shell/terminalTools.spec.ts`（3 用例）
- 新增 `terminal_run` 终端工具（Agent 可执行命令；terminal 权限默认确认，输出以工具卡展示）
- 截图：`gui-48-general-limits.png`（请求上限设置）、`gui-43-mcp-http.png`（MCP HTTP 表单）

## 六、第一轮存档对应改动
- 请求上限可配置（contracts/core Preferences + ChatService getAgentLimits + 设置·通用）
- 工具卡片 ToolCard（参数摘要/状态/展开输出/URL 链接卡）
- 中断原因横幅（done.status/reason → 气泡内展示）
- Markdown 表格渲染（GFM 表格）
- 打开技能/扩展目录前自动创建目录 + 失败日志
- mock 上游支持 MOCK_TOOL_NAME / MOCK_TOOL_ARGS / MOCK_REQ 日志；E2E 可配 chatDelay / NAV_WAIT_MS / HOLD_MS
- 新增截图：`docs/screenshots/gui-44-browser-tool.png`（AI 浏览器工具闭环）、
  `gui-45-tables.png`（待重新验收）
