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

## 二·四十五、2026-11-05 第四十二次增量（卷轴按 slime wave 模式重做，沿用 Loopsoar 品牌配色）

用户反馈（第 11 轮追加）：「还是不对啊，我要的是第二张图这样的啊，你是听不懂吗？你给我去『pilot project』这个文件夹内好好翻翻 slime 的设计啊，那是我钦点的合格作品」「颜色不要错了啊，要贴合 loopsoar 的主题。」

- **根因**：前几版（ADR-0025~0027）都在「原极细双线」上叠动画，而参考作品的核心是**编织几何本身** —— 两股波长 46/53、相位差 π、反向摆动、视口上下明暗渐变、宽光晕；只调突起/压平荡漾永远不会变成那张图。
- **重做**（`packages/ui/src/TopicRail.tsx` 整文件重写）：
  1. **几何逐项移植 slime wave 模式**：`LEFT_ROOM=12 / RIGHT_ROOM=6`；`band()`（右侧 88% 带宽）；`shapeAt()`（悬停收拢 `wOsc` + 高斯 bulge 2.8 + dip 1.1 回弹）；`strokeWave()`（双股不同波长、反向 `key`）；`lineStyle()`（视口位置之上 lit、之下 dim 的竖直渐变，两端 `taper`）；画布 `contain:paint` 只放 canvas（host 上会裁掉左伸卡片）。
  2. **配色换成 Loopsoar 主题**：主股亚麻白 `244,239,230`（品牌亮色，宽 `W*0.13`）、辅股赭石 `216,141,86`（宽 `W*0.095`）；alpha / 光晕比例沿用 slime（0.95/0.58/0.10、0.55/0.36/0.13，光晕宽 ×1.5 / ×2.0）。不复刻 slime 的蓝白配色。
  3. **悬停突起**：`strength` 0.18/帧缓入、`uc` 0.22/帧跟随（进入约 150ms），离开自然收回；`onPointerMove` 立即重绘兜底 rAF 降频。
  4. **参数默认值改为 slime 出厂值**：`w12 / amp55 / lam0 46 / lam1 53 / spd1 / tap90`；localStorage 键升级 `loopsoar_rail_params_chat_v2` 并清理旧键，避免旧参数把新外观覆盖回细线；外观设置标签改为「主股波长（亚麻白）/ 辅股波长（赭石）」。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**。
- **真机 E2E 证据**：`docs/screenshots/e2e-round11-rail-wave.png`（静止：亚麻白 + 赭石双股编织）、`e2e-round11-rail-wave-hover.png`（`LOOPSOAR_E2E_HOVER_RAIL=1`：指针处收拢并鼓出单峰包络 + 悬停卡片「● 1 / 1 你：…」，日志 `[E2E] RAIL_HOVER moved` / `RAIL_TIP`）。
- **备注**：`contain:paint` 只能在 canvas、拖拽热区左侧多 10px（slime 的用户反馈坑）等细节一并保留；旧版细线/编织截图仅作为历史，不再作为当前外观证据。

## 二·四十六、2026-11-05 第四十三次增量（卷轴外观回退原版配色 + 突起坐标即时定位）

用户反馈（第 11 轮追加，附原版/当前对比图）：「我还是更喜欢原版配色……主要是我叫你调整鼠标放置位置的反馈显示，也没叫你全盘搬过来啊，原设计也有不少优秀的地方，不用全盘搬 slime 的。」「鼠标离开后似乎有多余的坐标记录，每次在我下一次鼠标放上去后，突起反馈总是从上一次移到当前鼠标放置位置。你优化一下，应该是直接出现在鼠标放置位置才对。」

- **结论**：ADR-0028 的「整块移植 slime 编织」属于过度移植。原版（细双股暖金波浪 + 视口提亮段 + 话题圆点 + 悬停局部高光）保留，只借鉴 slime 的**悬停突起**交互。
- **改动**：
  1. `packages/ui/src/TopicRail.tsx` 回退到 ADR-0027 外观（`git checkout 51a414a`）：暗线 rgba(200,128,74,0.30)、亮线 rgba(245,190,140,0.55)、视口段渐变提亮、圆点、悬停段高光，全部恢复；只保留「突起」的平滑包络（`waveDamp` 压平突起区荡漾、`bumpSigma`、`reach`）。
  2. **突起坐标即时定位（本次 bug 修复）**：`onPointerEnter` 现在会立刻把 `pointerYRef` 设为当前指针高度；回退后 `pointerPush` 直接使用 `pointerYRef`（没有二次平滑），因此下一次悬停的第一帧突起就出现在鼠标位置，不再从上次留下的坐标滑过来。
  3. `packages/ui/src/railParams.ts` 默认值恢复原版（w16 / amp48 / lam0 86 / lam1 112 / spd0.8 / tap130），存储键升级 `loopsoar_rail_params_chat_v3` 并清理 v1/v2 旧键（v2 里是 slime 编织参数，会覆盖原版外观）。
  4. `packages/ui/src/i18nSettings.ts` 标签/预览说明恢复「亮线波长 / 暗线波长」。
  5. E2E 钩子扩充：`LOOPSOAR_E2E_HOVER_RAIL=2` 时先悬停 45% → 移出轨道 → 在 75% 重新进入，用于捕捉「重新进入后突起位置」。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**。
- **真机 E2E 证据**：`docs/screenshots/e2e-round11-rail-restored.png`（静止：原版暖金双线 + 视口提亮）、`e2e-round11-rail-restored-hover.png`（悬停：原版外观 + 平滑突起 + 卡片）、`e2e-round11-rail-reenter.png`（`HOVER_RAIL=2`：离开后在 75% 重新进入；像素测量突起中心 y≈675，与重新进入的指针位置一致，日志 `RAIL_HOVER reenter`）。

## 二·四十七、2026-11-05 第四十四次增量（卷轴突起宽度固定：修复大窗口下「整条线被拉成大弯」）

用户反馈（附聊天区右缘截图）：「如图，怎么鼠标放上去后的反馈又崩了？」

- **根因**：ADR-0027/0029 的突起高斯宽度写成 `bumpSigma = Math.max(34, height * 0.06)`，会随轨道高度百分比缩放。窗口越大、轨道越高，突起越「长」：在接近最大化/高 DPI 的窗口里，高斯覆盖了轨道的很大一部分，视觉上整条线被缓慢拉成 S 形大弯，而不是指针处的一个局部鼓包。
- **修复**（`packages/ui/src/TopicRail.tsx`）：
  1. `bumpSigma` 固定为 **20px**，不再随 `height` 缩放 —— 任何窗口尺寸下，突起都只覆盖指针上下约 ±50px，不会变成整条线的大弯。
  2. `bumpReach = Math.max(12, Math.min(18, width))`，突起幅度限制在 12~18px。
  3. 形状改用 slime 的 bulge + dip（中心高斯外鼓、两翼轻微回缩，`BULGE=2.8 / DIP=1.1 / DIP_T=2.7`），把纯高斯的「折角/肘部」过渡成圆润的包。
  4. `waveDamp` 的窗口同步用固定 `bumpSigma`，突起区内两股线收拢成一条平滑曲线。
  5. 悬停高光段从「指针 ±46px」改为「指针 ±2.4×bumpSigma」，与突起范围对齐。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**。
- **真机 E2E 证据**：
  - `docs/screenshots/e2e-round11-rail-bump-fixed.png`（`LOOPSOAR_E2E_HOVER_RAIL=2`：45% 悬停 → 离开 → 75% 重新进入；截图显示突起位于 75% 指针处）。
  - `docs/screenshots/e2e-round11-rail-bump-fixed-crop.png`（右缘 4× 放大：局部圆润鼓包，不再是大弯）。
  - 像素测量：突起位移中心 y≈675（物理像素），与重新进入指针的物理位置 674.75 相差 <1px；位移峰值约 -18px（逻辑约 14.4px），突兀范围约 46 物理像素（阈值法），确认是**局部**突起且**即时定位**。
- **文档**：ADR-0030、E2E-SMOKE 第 23 节。

## 二·四十八、2026-11-05 第四十五次增量（卷轴突起幅度调小）

用户反馈（附聊天区右缘截图）：「很好，现在就剩最后一个问题了，如图，你给我把突起调小一点，你看，现在太大了。」

- **结论**：ADR-0030 把突起宽度固定为 20px / 峰值 16px 后，局部性正确，但幅度仍偏大（约一个轨道宽，视觉上会压到正文）。
- **改动**（`packages/ui/src/TopicRail.tsx`）：
  1. `bumpSigma` 20 → **16**（包更短）。
  2. `bumpReach` 改为 `Math.max(8, Math.min(12, width * 0.7))`，16px 轨道下峰值 **11.2px**（原 16px）。
  3. 形状仍为 bulge + dip，过渡保持圆润；高光段随 `±2.4×bumpSigma` 自动收短。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**。
- **真机 E2E 证据**：`docs/screenshots/e2e-round11-rail-bump-small.png`；像素测量峰值位移约 -14 物理像素（逻辑 11.2px），突起中心 y≈487 与指针位置一致；4× 放大见 `.tmp` 目视确认「轻微鼓包」。
- 文档：ADR-0031、E2E-SMOKE 第 24 节。

## 二·四十九、2026-11-05 第四十六次增量（卷轴凹陷防裁切 + 突起更紧凑可调 + 去掉拖拽提示）

用户反馈（附聊天区右缘截图）：「现在还有一点问题，你看哟便还有一点点凹陷在屏幕外，你看看能不能调整一下？然后把这个突起以及上下凹陷的部分调紧凑一点，看着更显眼（但不要调太多，调几个像素就够了，或者你干脆把这一整个调整参数开放在设置里，方便用户自己定制。）。最后把右侧的什么“拖拽调整位置”什么的提示给我去了，没必要。」

- **根因**：dip 向窗口右侧回弹的位移（约 4px）叠加悬停高光 12px 光晕，而基线距窗口右缘仅约 11px，canvas 右缘只留 8px 余量，导致凹陷末端/光晕在窗口右缘被裁切，看起来像「凹陷钻出屏幕」。
- **改动**：
  1. **防裁切**（`packages/ui/src/TopicRail.tsx`）：线基线左移 4px（`cx = BUMP_PAD + width/2 - 4`）；轨道右侧 `right` 3→4；悬停高光光晕 `shadowBlur` 12→8、线宽 2.4→2.2。dip 位移 + 光晕现在都留在窗口内，静态外观不变。
  2. **更紧凑/更显眼**：`bumpSigma` 16→**13**、`bumpReach` 11.2→**13**（默认值）；dip 收近（`DIP` 1.1→**0.75**、`DIP_T` 2.7→**2.2**），上下凹陷更贴突起、整体更「一眼可见」。
  3. **参数开放到设置**：`RailParams` 新增 `bumpReach`（悬停突起幅度，4–24px）与 `bumpSigma`（悬停突起宽度，8–32px）；`packages/ui/src/Settings.tsx` 外观页「卷轴参数」新增两个滑杆；`i18nSettings.ts` 新增对应中英文案；旧 v3 数据由 `normalizeRailParams` 自动补默认值，不重置用户已调参数。
  4. **删除拖拽提示**：移除 `.topic-rail` 的 `title="拖动卷轴滚动 · 悬停查看位置"` 原生 tooltip（用户认为没必要）。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**。
- **真机 E2E 证据**：`docs/screenshots/e2e-round11-rail-compact.png`（悬停：紧凑突起 + 凹陷完整不裁切 + 卡片）、`docs/screenshots/e2e-round11-rail-compact-crop.png`（右缘 4× 放大）、`docs/screenshots/e2e-round11-rail-settings.png`（设置 → 外观：新增两个突起滑杆）。像素测量：基线 x≈1683（窗口宽 1702，右侧留 19px），突起/凹陷整体保持在窗口内。
- 文档：ADR-0032、E2E-SMOKE 第 25 节。

## 二·五十、2026-11-05 第四十七次增量（卷轴悬停流动开关：交给用户选择）

用户反馈：「还差最后项就收工：首先是一个开关，鼠标悬置在卷轴上，卷轴是否停止“流动”的开关设置，现在都是直接停止的，我希望交由用户自行选择。」

- **现状**：`railParams.pause` 早已存在（设置→外观→卷轴参数里的「悬停时暂停荡漾」复选框），但默认值为 `true`，所以开箱即停；用户误以为写死。
- **改动**：
  1. **默认改为不暂停**：`DEFAULT_CHAT_RAIL.pause` true→**false**（悬停时波浪继续流动，是否停止交给用户选择）；旧 v3 数据不会重置（用户自己勾选过则保留）。
  2. **文案与说明更明确**：`i18nSettings.ts` 标签改为「悬停时暂停流动」，新增 `pauseHint` 说明「开关决定鼠标停在卷轴上时波浪是否停止流动；默认关闭（继续流动）。悬停突起与话题卡片不受影响。」，`Settings.tsx` 在复选框下方展示该说明。
  3. **逻辑抽成纯函数**：`packages/ui/src/railParams.ts` 新增 `shouldPauseWave(params, { reduced, hovering, dragging })`（reduced/拖拽/速度 0 始终暂停；悬停是否暂停只看用户 `pause` 设置），`TopicRail.tsx` 的 `frame()` 改用它，便于单测与后续扩展。
  4. **新增单测**：`tests/ui/railParams.spec.ts` 增加 3 个用例（默认不暂停、开启后悬停才暂停、reduced/拖拽/速度 0 始终暂停）。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1212 tests 全绿**。
- **真机 E2E 证据**：`docs/screenshots/e2e-round11-rail-pause-switch.png`（设置→外观：默认未勾选的「悬停时暂停流动」+ 说明文案）。
- 文档：ADR-0033、E2E-SMOKE 第 26 节。

## 二·五十一、2026-11-05 第四十八次增量（收紧网页/会话分区间隙 + 删除会话顶部阴影）

用户反馈（m04618）：「会话与网页两侧栏目看似只有一线之隔，实际上仔细一看，中间有相当大一段间距……改成符合直观逻辑直觉的，将会话栏宽度变大点。然后除去上方会话未滚动在最顶层时的阴影，我感觉不好看。」

- **间隙根因（三层叠加）**：
  1. 页框 `BROWSER_VIEW_INSET=8`（设计上的圆角面板留白）；
  2. `App.tsx` splitter 固定 `6px`；
  3. 侧栏 wrapper `padding-left: 8px`，同时 `AgentSidebar width={sidebarWidth - 16}` 又按「左右各 8px」预留、且 inner 用 `marginLeft:auto` 右对齐 —— 实际在 splitter 与内容之间留下 16–24px 空白带，内容反而被压窄。
- **改动**：
  1. `packages/contracts/src/layout.ts`：`SPLITTER_WIDTH` 6→**2**（契约是原生视图宽度的单一产地，DOM 同步改）；`App.tsx` 的 splitter 宽度改用 `LAYOUT.SPLITTER_WIDTH`，docked 侧栏 wrapper padding 归零（仅独立 Agent 窗口保留 8），`AgentSidebar width` 改为 `Math.max(240, sidebarWidth)` —— 内容铺满整列。视觉上网页卡片右缘到会话内容只剩「页框 8px 内缩 + 2px 热区」≈10px。
  2. 顶部阴影删除：`MessageList.tsx` 移除 `scroll-fade-mask is-top` 元素与 `atTop` state/`setAtTop` 调用，`index.html` 删除 `.scroll-fade-mask.is-top` 渐变规则；底部渐隐保留（「还有更多」提示仍需要）。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1212 tests 全绿**（同步更新 5 个布局测试文件的 splitter 期望：非收起态宽度 +4px）。
- **真机 E2E 证据**：`docs/screenshots/e2e-round12-gap.png`（1361×862 内容区的 1702×1078 截图）；DOM 探针 `E2E_EVAL`：`.browser-toolbar` 右缘 852.6、`.agent-sidebar` 左缘 854.6 → **gap=2px**；`.scroll-fade-mask.is-top` 查询为 `false`（元素已删）、底部 mask 正常隐藏。
- 文档：ADR-0034、E2E-SMOKE 第 27 节。

## 二·五十二、2026-11-05 第四十九次增量（网页面板右侧留白再收紧 + 会话内容右侧收窄）

用户反馈（m04745）：「当前会话与网页之间的空隙还可以再压缩一点点，然后把会话内容整体收窄一点（不要窄太多，几个像素都够了）不包括卷轴那里（你看用户与Agent的对话都与卷轴挤在一起了）以及对话以外的内容。」

- **改动**：
  1. `packages/contracts/src/layout.ts` 新增 `BROWSER_VIEW_INSET_RIGHT: 4`：网页面板右侧留白单独收窄到 4px（其它三边仍 8px），`computeBrowserViewBounds` 的宽度改为扣 `inset + insetRight`；`StartPage` 的 margin 同步为 `8px 4px 8px 8px`。视觉缝从 ADR-0034 的「8+2=10px」降到 **4+2=6px**。
  2. `packages/ui/src/MessageList.tsx` 的 `messageList` 右侧 padding 14→**20px**：对话气泡/代码块整体右收 6px，与卷轴脱开；卷轴是绝对定位不受影响，头部与输入框不在列表内，保持原宽。
- **验证基线**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1212 tests 全绿**（5 个布局测试文件的宽度期望再 +4px，修正高度 800 被误替换的 3 处）。
- **真机 E2E 证据**：`docs/screenshots/e2e-round12-gap2.png`；DOM 探针 `E2E_EVAL`：页框右缘 848.6、会话栏左缘 854.6 → **paneGap=6px**，splitter 热区 2px，`.chat-scroll` `padding-right: 20px`，`.scroll-fade-mask.is-top` 不存在。
- 文档：ADR-0035、E2E-SMOKE 第 28 节。

## 二·五十三、2026-11-05 第五十次增量（拖拽命中区对齐视觉交界 + 会话内容再收窄 4px）

用户反馈（m04830）：「左右侧会话与网页的比例拖拽调整的位置有点问题啊，正常应该是在如图的灰黑交界处，但鼠标悬置到能拖拽的位置却是在交界处右侧一点点……然后把会话内容整体再收窄一点点，现在还是与右侧卷轴有点拥挤。」

- **根因**：splitter 只有 2px 且在页框右侧 4px 留白之外 —— 视觉交界在「网页深色面板边缘」，命中区却在交界右侧 4px（用户看到的「悬停位置不对」）。
- **改动**：
  1. `App.tsx` 的 splitter 改为「净占位 2px、命中区 6px」：`width: LAYOUT.SPLITTER_WIDTH + 4` + `marginLeft: -4`（负 margin 把热区左缘拉到页框右缘），净 flex 占位不变 → 原生视图几何与布局数值完全不变；新增 `className="sidebar-splitter"` 便于 E2E 探针。
  2. `MessageList` 的 messageList 右侧 padding 20→**24px**：气泡/代码块再右收 4px；卷轴、头部、输入框不受影响。
- **验证基线**：`pnpm typecheck` 5/5、`vitest` **133 文件 / 1212 tests 全绿**（几何契约未变，无需改测试）。
- **真机 E2E 证据**：`docs/screenshots/e2e-round12-seam.png`；DOM 探针 `E2E_EVAL`：页框右缘 848.6、splitter 命中区左缘 848.6（`hitOffset=0`，宽 6px）、该点 `elementFromPoint` = `sidebar-splitter`、`.chat-scroll` 右 padding 24px。
- 文档：ADR-0036、E2E-SMOKE 第 29 节。

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

## 七、2026-11-09 增量（OpenCode Go / Zen 双计划端点与错误提示修复 + 底部错误提示去重）

- **用户报障**：opencode go/zen 都用不了（免费的与订阅的均 403）；底部重复的错误提示挡内容，要求删除。
- **真实原因**：① Loopsoar 存的 OpenCode Key（oc_…7lyv）所在工作区没有 Go 订阅（403 实测）；本机 DSH 的 OPENCODE_GO_API_KEY（oc_…DO2x）实测可用，已同步进 Loopsoar 加密密钥库；② 上一轮把 Go 端点误迁移到按量付费端点（Go Key 打按量付费端点 403 Model access is disabled），本次撤销；③ 默认模型停在免费模型 beam-free（地区限制 403 RegionError），启动时自动回退到 deepseek-v4.1-flash；④ 模型目录 /models 端点拼错（应为 /inference/go/v1/models 与 /inference/v1/models），且 OpenCode 富元数据未解析。
- **代码**：providerStore（Go/Zen 端点区分 + 免费默认模型回退，不删免费模型）、新增 providerModels.ts（模型目录端点解析）、settings:listModels 改用该解析、modelCapabilities（OpenCode limit/modalities/capabilities 解析）、upstreamError（Go 订阅/免费模型/地区/Model access disabled/缺 session/免费额度专项提示）、Settings（Go + Zen 两个预设）、useChatStreamEvents（done interrupted 与 stream error 不再弹底部重复提示，保留「已停止」）。
- **验证**：typecheck 5/5；全量 vitest 166 文件 / 1410 tests 全绿；真实上游：Go 端点 deepseek/glm 200、无 session 400、Go Key 打 Zen 403、免费模型 429/RegionError；Loopsoar core 客户端真实流式成功；真机 E2E（E2E_EVAL ok:true）：迁移后 opencode-go 保持 Go 端点、默认模型 deepseek-v4.1-flash、测试连接 200（2315ms/762ms）、获取模型列表 30 个且能力字段解析。
- **证据**：`e2e-evidence/opencode-fix.log`、`opencode-fix.png`、`opencode-live-probe.log`、`opencode-live-verify.log`；决策记录 ADR-0051。

## 八、2026-11-09 增量（去掉「默认模型 / 启用」概念：模型菜单全部可选）

- **用户报障**：模型只能在对应供应商的默认模型；「默认」是 slime 遗留赘项，要求删除，用户想用哪个用哪个。
- **根因**：模型菜单只展示 `selected !== false` 的模型 + 默认模型特例；「获取模型列表」只启用默认模型，其余新模型默认停用 → 拉回 40 个模型的 Zen 供应商菜单里只剩默认一个；设置里还有「默认模型」行、「默认」单选列、「启用」勾选列三处赘项，且 ADR-0051 的免费模型自动回退进一步覆盖用户选择。
- **改动**：`modelGroups.ts`（菜单展示全部模型、去掉 selected 过滤与默认特例；合并逻辑去掉 defaultModelId 自动启用）、`Settings.tsx`（删默认模型行/默认单选列/启用勾选列，provider.model 降级为“当前选用”，保存保留当前选择、新增取第一个）、`providerStore.ts`（删除免费模型自动回退，仅保留 zen 端点迁移）、i18n 文案与键清理（defaultModel/col.enable/col.default）。
- **验证**：typecheck 5/5；全量 vitest 166 文件 / 1412 tests 全绿；真机 E2E（E2E_EVAL ok:true）：模型菜单 72 项（Zen 40 + Go 30 + agnes/note 各 1），历史停用的 `claude-opus-5-5` 可见且点击成功切换（活动供应商 opencode-zen）；供应商页/编辑弹窗无默认模型文本、无默认单选、无启用表头，Zen 编辑弹窗 40 行模型全部列出。
- **证据**：`e2e-evidence/model-any.log`、`model-any.png`；决策记录 ADR-0052。

## 九、2026-11-09 增量（OpenCode 计划边界可视化 + 402 账户纠正）

- **用户报障**：`opencode-zen · deepseek-v4.1-flash` 报 HTTP 402 `Insufficient account funds`，但「我还有起码 40% 的额度」。
- **根因**：40% 是 `opencode-go` 供应商的 Go 套餐额度（Key oc_…DO2x）；`opencode-zen` 供应商用的是旧 Key（oc_…7lyv，按量付费余额为 0）。同名模型 `deepseek-v4.1-flash` 在两个目录都有，用户点到了 zen 组里的那个；模型菜单与供应商卡片都没有「哪种额度」标记，错误提示也只有泛化「余额不足」。
- **改动**：`modelGroups.ts` 新增 `openCodePlanLabel`（go/payg/null）与 `ModelGroup.plan`；Composer 模型菜单分组头显示「Go 订阅 / 按量付费」；Settings 供应商卡片显示「Go 订阅额度 / 按量付费余额」；`upstreamError.ts` 对 `Insufficient account funds` 与 `Model access is disabled` 给出指向 opencode-go 的具体提示；数据侧把活动供应商切回 `opencode-go`、模型设为 `deepseek-v4.1-flash`（legacy provider.json 同步）。不合并供应商、不自动跨计划切换（ADR-0043）。
- **验证**：typecheck 5/5；全量 vitest 166 文件 / 1415 tests 全绿；真机 E2E（E2E_EVAL ok:true）：活动 opencode-go + deepseek-v4.1-flash、测试连接 200/2759ms；模型菜单 72 项且「Go 订阅」「按量付费」徽标同时出现；点 opencode-go 组内 glm-5.3 切换成功；设置页两卡片分别显示两种额度徽标。
- **证据**：`e2e-evidence/plan-badges.log`、`plan-badges.png`；决策记录 ADR-0053。

## 十、2026-11-09 增量（恢复模型显示拨片 + 推理强度上移）

- **用户报障**：拨片开关没了、模型全开；改推理强度要翻到模型列表最底部。
- **说明**：ADR-0052 删「默认模型」时把「显示开关」也一并删了（语义误判）；本轮恢复拨片、但「默认模型」仍不恢复。
- **改动**：Settings 模型表恢复第一列拨片开关（`selected !== false` = 显示在模型菜单，新拉取模型默认打开）；modelGroups 菜单恢复按开关过滤（没有默认模型特例）；Composer 把「推理等级」区块从菜单底部移到顶部（标题下、模型分组前）；数据侧两个 OpenCode 供应商 30+40 个模型全部打开。
- **验证**：typecheck 5/5；全量 vitest 166 文件 / 1415 tests 全绿；真机 E2E（E2E_EVAL ok:true）：模型菜单 72 项、推理等级在第一个模型上方且开场可见、Zen 编辑弹窗 40 行=40 个拨片全部打开、点击可关闭、无默认单选/表头。
- **证据**：`e2e-evidence/toggles-effort.log`、`toggles-effort.png`；决策记录 ADR-0054。

## 十一、2026-11-09 增量（模型显示开关支持全选 / 取消全选）

- **需求**：用户要求「加个全选跟取消全选的拨片」（模型表 40 行逐个点太慢）。
- **改动**：Settings 模型表表头「显示」列内嵌主拨片（`data-testid="model-toggle-all"`，title「全选 / 取消全选（n/total）」）；全开时点击=全部关闭、否则=全部打开（部分开启点一下即全选）；只改 `selected` 显示状态，不改当前使用模型/参数；复用 `Toggle` 组件（新增可选 title/testId）。
- **验证**：typecheck 5/5；全量 vitest 166 文件 / 1416 tests 全绿；真机 E2E（E2E_EVAL ok:true）：40 行初始 40/40 开 → 点击全关 0/40 → 再点全开 40/40 → 单关 1 行后主拨片 39/40（关）→ 点主拨片恢复 40/40，title 含「全选 / 取消全选」。
- **证据**：`e2e-evidence/toggle-all.log`、`toggle-all.png`；决策记录 ADR-0055。

## 十二、2026-11-09 增量（模型表工具条重构 + 应用图标身份修复）

- **用户报障**（附 slime 弹窗截图）：① 供应商模型表「位置很丑」，要借鉴 slime 布局并加搜索栏（全选拨片塞在「显示」表头，72 模型要滚）；② slime 图标被换成 Loopsoar 图标、Loopsoar 图标变成 Electron 默认图标。
- **根因**：① 主拨片嵌在 `<th>` 内；模型表没有搜索。② slime 仓库（`D:\pilot project`）图标资产被覆盖成 Loopsoar/Quilt 品牌（5 个图标文件，`git status` 可见）；Loopsoar `iconPath()` 只探测 `__dirname/../../resources/icon.png`，dist 运行时解析到不存在的 `packages/resources` → Electron 默认图标；且从未 `app.setAppUserModelId(APP_ID)`，会话栏独立窗口也没传 icon。
- **改动**：`Settings.tsx` 新增 `modelToolbar`（主拨片 + 「全选 / 取消全选」+ 摘要「共 N 个 · 聊天界面只显示已启用（M 个）」）、表头恢复纯文本、`modelAddRow` 左侧模型 ID 搜索框（`data-testid="model-search"`）、`visibleModels` 按原始 idx 过滤回写、无匹配提示；i18n 三键（modelSummary/searchModels/noMatchingModels）。新增 `packages/shell/src/main/appIcon.ts` `resolveAppIconPath`（dist/src/打包/dev cwd 多候选，Windows 优先 ico），`index.ts` 接线 + `app.setAppUserModelId(APP_ID)`（win32）+ 启动日志 `[Loopsoar] appIcon=` + 会话栏窗口 icon；`agentWindow.ts` 支持 `icon` 传参。slime 仓库只 `git checkout` 恢复 5 个图标文件（其余 215 个未提交改动不动）。
- **验证**：typecheck 5/5；全量 vitest 167 文件 / 1422 tests 全绿；build/gen/check 通过；真机 E2E（`e2e-evidence/model-toolbar.log` E2E_EVAL ok:true，截图 `model-toolbar.png`）：主拨片在工具条不在 thead、title 40/40、搜索 deepseek 40→3 行、清空恢复、0/40↔40/40、无匹配提示正常；启动日志 `[Loopsoar] appIcon=...packages\shell\resources\icon.ico`。slime 证据 `e2e-evidence/slime-icons-restored.log`：5 个图标 md5 与 HEAD 一致，其余改动保持原样。
- **证据**：`e2e-evidence/model-toolbar.log`、`model-toolbar.png`、`slime-icons-restored.log`；决策记录 ADR-0056。

## 十三、2026-11-10 增量（密钥关联修复：去重迁移 / 测试用被测 Key / 保存即验证）

- **用户报障**：「我给的密钥都是有订阅的…这绝对是密钥方面的大问题」。复核确认是应用侧密钥关联 bug，不是用户记错。
- **根因**：① 旧版切模型 upsert 出重复供应商（副本 id 如 `opencode-go-2`），dedupe 合并只保留首条 id、**不迁移密钥** → 用户新 Key 留在孤儿副本，聊天按保留 id 取旧 Key，上游 403「无订阅」；② `testProvider` 永远用**活动供应商**的 Key，测别的供应商/切 Key 后测试都假 403（二次误判）；③ upsert 传入已合并的副本 id 会复活副本，继续制造孤儿；④ 保存 Key 后没有真实验证，用户分不清「Key 无效」与「Key 没生效」。实测数据：`providers.json` 只有 opencode-go，secrets 里 `opencode-go`=oc_…7lyv、`opencode-go-2`=oc_…DO2x（200）。
- **改动**：`SecretStore` 增加 `ids()/meta()`；`ProviderStore` 注入 `onAliases` 并在 `load()` 去重时回调，`upsert` 复用同端点现存 id（不复活副本）；`index.ts` 先建 SecretStore 再建 ProviderStore，`migrateAliasedSecrets`/`reconcileOrphanSecrets` 按 `updatedAt` 新者优先迁移（含历史孤儿后缀 id）；`testProvider` 密钥解析改为「表单刚输入 → 被测供应商自己的 → 环境变量」并扩展 schema `id/apiKey`；Settings 卡片/弹窗测试与保存后立即用刚输入 Key 验证（`keyVerified`/`keyVerifyFailed`）。
- **验证**：typecheck 5/5；全量 vitest 169 文件 / 1437 tests 全绿（新增迁移回调/复用/元信息/接线守卫 5 条/testProvider 回归）；真机 E2E `e2e-evidence/key-migration.log` E2E_EVAL ok:true：active=agnes-2 时编辑 opencode-go 粘贴 Key → 测试连接 200；保存后仍 3 条供应商、active=opencode-go、hint=oc_…DO2x、二次保存无副本。
- **数据修复**：真实数据 opencode-go Key 恢复为可用那把（备份 `secrets.enc.json.bak-keyfix`）；另一把 Key 在 Go 端点实测 403（上游账户事实，应用现在如实提示）。
- **证据**：`e2e-evidence/key-migration.log`、`key-migration.png`；决策记录 ADR-0057。

## 十四、2026-11-10 增量（列表/浮层：再点按钮收起 + 点外面收起 全局修复）

- **用户报障**：工具栏「更多」再次点击只闪烁不关闭；所有展开列表点击外面都收不起来（阴影已修好）。
- **根因**：① `PopoverApp.tsx` 模块加载时**无条件**给 `<html>` 打 `data-popover`，主窗口也静态 import 它 → 整页命中 `[data-popover]`，`usePopover` 把任何点击都当「点在浮层内」→ 所有内联菜单点外面永不收起（E2E 证实主窗口启动即有该属性、textContent 为整页）；② 工具栏浮层是独立子窗口，点击触发按钮先失焦关闭、渲染层 click 再判断时状态已清 → 关→开连闪；③ 点原生网页（WebContentsView）DOM 收不到事件，工具栏浮层不会被关。
- **改动**：`PopoverApp` 仅在 `?popover=` 窗口打标；`usePopover` 忽略 html/body 误标 + pointerdown/mousedown 双监听；契约新增 `ui:togglePopover`（主进程 `manager.isOpen()` 原子 close/open，返回 `{open}`），BrowserChrome 点击改调它并抑制 hover 重开；App 全局 pointerdown → `ui.closePopover()`（跳过 `[data-chrome-popover-trigger]` 触发按钮）；`onViewFocused` 同时关闭工具栏浮层 + 广播 dismiss；星标按钮点击也关预览。
- **验证**：typecheck 5/5；全量 vitest 170 文件 / 1443 tests 全绿（新增 popover-global-dismiss 守卫、更新工具栏守卫、`ui:togglePopover` 域单测）；真机 E2E：run1 模型菜单再点 chip 收起、点聊天区收起、「更多」双击后仅剩主窗口（不连闪）；run2「更多」打开后点聊天区 → 仅剩主窗口。证据 `e2e-evidence/popover-dismiss.log`、`popover-dismiss-outside.log`；决策 ADR-0058。

## 十五、2026-11-10 增量（小窗最小化→图标按钮 + 输入区左下角「+」）

- **用户需求**：① 移植 Slime 小窗语义——最小化缩成图标按钮、点击图标还原、关闭才恢复正常窗口；② 输入框左下角加圆形「+」，先放「附件」。
- **改动**：`agentWindow.ts` 新增 `AGENT_WINDOW_ICON_SIZE=56` 与 `computeAgentWindowIconBounds`；`minimize()` 改为缩成图标窗口（先降 minimumSize 再 setBounds，修复实测 343×483 伪图标），新增 `restore()`；`focus()/open()` 图标模式自动还原；`domains/agentWindow.ts` 最小化不再推 `chrome:agentWindowClosed`，新增 `ui:restoreAgentWindow`（仅 Agent 窗口可调）；`App.tsx` 监听 `chrome:agentWindowIconMode` 渲染 56px 图标视图（∞ logo，点击还原，可拖动），`TitleBar` 文案改「最小化（收起为图标）」；`Composer.tsx` chipRow 最左新增 26px 圆形「+」（`composer-plus`），菜单当前含「附件」，移除原附件 chip，接入 usePopover 互斥/点外收起。
- **验证**：typecheck 5/5；全量 vitest 170 文件 / 1444 tests 全绿；真机 E2E `e2e-evidence/agent-icon.log`：小窗 422×721 → 最小化后 57×57（内容 56）+ `[data-agent-icon]` logo → 点图标还原 424×723；「+」在最左、菜单含附件、点外收起；图标截图 `e2e-evidence/agent-icon-icon.png`。
- **记忆现状（回答用户问题）**：JSON 记忆库（默认 `<dataDir>/memory/memory.json`，设置·存储可改）；每轮助手回复后若 `memoryAutoCapture`（默认开）→ 规则启发式抽取（偏好/约定/项目/身份，≤5 条/轮）→ `store.write()` 五闸（跨 agent 指针、去重 0.75、合并 0.68、新增、建链 0.70、容量 2000 软归档）→ 落盘 + 向量索引（hash 256 维 FlatVectorIndex，可选 sqlite-vec / 外部 BGE-M3，失败降级 hash）；召回：每轮 `getMemoryFor(userMessage)` → `recallPrompt`（recallGate 廉价信号命中才检索）→ 词法 jaccard + 向量 + 标签/effectiveValue 排序取 top6 → 注入**本轮 user 消息末尾的 volatile 段**（不破坏 KV 前缀缓存）；显式工具 `memory_search/add/update/delete` 做确定性读写；设置·记忆页可看/改。
- **证据**：`e2e-evidence/agent-icon.log`、`agent-icon.png`、`agent-icon-icon.png`；决策 ADR-0059。

## 十六、2026-11-10 增量（图标窗单层化 + 可拖动 + 衔接动画，ADR-0060）

- **用户 m02794**：悬浮按钮还有大框、不能拖动、没有衔接动画，要求整段搬 Slime。
- **根因**：① 窗口本身不透明深色 + 渲染层整窗圆角底 + 内层 44px 带边框 button = 双层框；② 图标窗 56px 里可拖区只剩边缘（中间是还原按钮）；③ minimize/restore 直接 setBounds 跳变。
- **改动**：`agentWindow.ts` 创建参数改 `transparent:true / roundedCorners:false / hasShadow:false / backgroundColor:"rgba(0,0,0,0)"`；`index.html` 增加 `html[data-mini-icon]` 透明背景；`App.tsx` 图标态改为 logo.png 铺满 56×56（删内层 button），新增按 screen 增量的 pointer 拖动（4px 阈值区分点击/拖动）→ 新 IPC `ui:moveAgentWindow`（契约/域/类型同步，`withAgentSenderGuard`）→ `manager.moveBy` 工作区夹取；新增 `AGENT_WINDOW_ICON_ANIM_MS=180` + `animateToBounds`，minimize 先切图标再收缩、restore 先放大后恢复最小尺寸/可缩放（动画中 moveBy 忽略）。
- **验证**：typecheck 5/5；agentWindow 单测 44 全过；全量 vitest **170 文件 / 1445 tests 全绿**；E2E `e2e-evidence/agent-icon-frame4.log`：收缩中途 `259×424`（介于 422×720→56×56，证明动画生效）、拖动 `(1020,104)→(1095,159)` 且仍为图标、单击还原 `423×720`、`innerButton=false`、html 背景透明；截图 `agent-icon-frame4-icon.png` 单层圆角 ∞ 图标；证据 `agent-icon-frame4*.png`。

## 十七、2026-11-11 增量（悬浮窗圆角恢复 + GPU transform 衔接动画，ADR-0061）

- **用户 m03038**：① 悬浮窗成方边了；② 收起/展开掉帧非常严重。
- **根因**：① 透明窗口下 `html/body/#root` 仍铺不透明底色、App 根节点直角 → 四角是页面直角底色（Windows 透明无边框窗口没有 DWM 原生圆角）；② minimize/restore 用主进程逐帧 `setBounds` 缩放透明窗口，每帧重排整页大 UI + DWM 重合成；且动画起止切换视图整树卸载/挂载 → 卡顿。
- **改动**：`packages/ui/index.html`：`html[data-mini]` 底色改透明、新增 `html[data-mini-transition]` 透明规则、`.agent-mini-icon` 120ms 淡入 keyframes；`App.tsx`：小窗根节点加 `borderRadius:14 + overflow:hidden`（`appMiniShell`）、新增 `AgentTransitionOverlay`（截图 + `translate/scale` GPU transform）、过渡期间 `display:none` 隐藏真实 UI；`agentWindow.ts`：`minimize/restore` 有截图时不再逐帧 resize——发 `chrome:agentWindowTransition {phase,shot,durationMs,from,to}`，动画到点后一次性 setBounds（minimize 落图标 / restore 先瞬间跳到目标），截图失败保留旧 fallback；`onTransition` payload 增加 from/to；契约新增事件 `chrome:agentWindowTransition`（gen + types 同步）；`index.ts` 接线 `onTransition` 与 E2E 中途截图/诊断。
- **验证**：typecheck 5/5；`gen`/`check`/`build` 通过；agentWindow 单测 44 全过；全量 vitest **170 文件 / 1445 tests 全绿**；E2E `e2e-evidence/agent-icon-gpu2.log`：minimize 同时序 bounds 恒 420×722（无逐帧 resize），~277ms 一次落到 56×58；mid 截图显示快照缩到右上角；restore 中途 overlay+iconView、窗口 420×723；还原 420×724；四角 alpha=0，浅色合成图 `agent-icon-gpu2-corners.png` 可见 14px 圆角；图标 `agent-icon-gpu2-icon.png` 单层。

## 十八、2026-11-11 增量（收起/展开按 Slime float 重做：面板过渡 + 内容钉住裁切 + 图标淡入淡出，ADR-0062）

- **用户 m03326**：附 15s 录屏，认为收起/展开「非常烂」，要求直接去 Slime 抄作业（这些问题 Slime 都解决过）。
- **根因**：ADR-0061 是「截图 transform 缩放」且依赖 capturePage（点击后等截图才开始），restore 先换窗后发事件可能出现整窗闪烁；与 Slime「外框宽高过渡 + 内容钉尺寸裁切 + 淡入淡出」的观感不一致；180ms 也比 Slime 的 400ms 更快。
- **改动**：`App.tsx` 小窗内容包进 `[data-agent-panel]`（绝对定位/圆角/overflow hidden），内层 UI 尺寸在动画期间钉死（`agentFloatFreeze`），只过渡面板 `left/top/width/height`；minimize 窗口不动、400ms `cubic-bezier(0,0,0.2,1)` 收向图标矩形，内容透明度按面板宽度进度 smoothstep 淡出（Slime startFloatGeometryFade 同款）、图标 180ms ease 120ms delay 淡入，结束一次性 setBounds(icon)+notify；restore 先算图标∪目标舞台、setOpacity(0) 换窗、通知后面板从图标矩形展开、结束 setBounds(target)+notify；删除 `capturePage`/`iconTransitionShot`/`AgentTransitionOverlay` 快照链路；`AGENT_WINDOW_ICON_ANIM_MS=400`；事件 payload 改 `{phase,durationMs,from,to}`。
- **验证**：typecheck 5/5；`gen`/`check`/`build` 通过；agentWindow 单测 44 全过；全量 vitest **170 文件 / 1445 tests 全绿**；E2E `e2e-evidence/agent-float-final.log`：minimize 中途 panel 197×314、窗口 bounds 恒 420×722，结束 56×58；restore 中途 panel 279×464（舞台 488×723），结束 420×724；截图 `agent-float-final-mid.png`、`-restore-mid.png`、`-icon.png`。

## 十九、2026-11-11 增量（浏览器管理整页 / 搜索引擎 / 加载失败页）

- **用户诉求**（m03747，附 10 张截图）：历史页清除按钮不可用 + 要勾选式批量删除；空态去虚线并居中；顶栏删除保存/刷新、改页面互跳；设置删除通用里的「默认搜索引擎」、单开搜索引擎栏目（Chrome 式、仅 Bing/Google/百度）；地址栏左侧改引擎图标下拉、搜索后恢复放大镜；补齐加载页与各类连接失败页。
- **改动**：
  - 历史：`BrowserHistoryStore.remove(urls)` + 契约 `browser:historyRemove`；`ChromePage` 选择模式（行首勾选框 140ms 过渡、同宽操作条 fadeUp、全选/取消/删除、删除后重新拉取退出）；清除按钮改品牌赭石实底。
  - 空态/顶栏：`StateBox` 空态纯居中文字（无虚线框）；历史/下载/收藏顶栏改为 历史记录/下载内容/收藏夹/设置 页面跳转，删除保存页面与刷新。
  - 搜索引擎：偏好枚举改 `bing|google|baidu`（旧 duckduckgo 迁移 Bing）；`buildSearchUrl`/`searchUrlFor` 同步；设置新增「搜索引擎」分区（图标+名称+域名+单选）；地址栏新建页显示引擎图标下拉（`usePopover("browser-engine")`），有页面 URL 后恢复普通放大镜；新增 engine-*.svg。
  - 加载/失败页：adapter 增主框架 `did-start-navigation`/`did-stop-loading`/`did-fail-load`（过滤 -3 与非主框架）；`TabState.loading/loadFailure`；`applyLayout` 在加载/失败时隐藏原生视图；`BrowserSurface`（原 StartPage）实现加载页（logo 呼吸+不确定进度条+host）与分类错误页（离线/域名/拒绝/超时/证书/拦截/未知，含错误码、重试、返回）；分类函数在 `packages/ui/src/browserFailure.ts`。
- **验证**：typecheck 5/5；全量 vitest 171 文件 / 1449 tests 全绿；gen/check/build 通过；真机 E2E（种子 3 条历史）E2E_EVAL ok:true（详见 ADR-0063 验证段），证据 `e2e-evidence/final-ui.log`、`e2e-evidence/final-ui.png`。
- **决策记录**：ADR-0063。

## 二十、2026-11-11 增量（管理页左侧索引栏 + 批量操作条上移对齐）

- **用户 m04298（附图）**：① 全选那一行功能项要放列表最上方，且这一行「凸出来」、与记录不对齐；② 三个管理页（历史/下载/收藏）左侧要像 Edge 一样做搜索索引 + 分类，利用行左侧空白。
- **根因**：行控件 `width:100%` 但未 `box-sizing:border-box`，padding/border 让每行比容器宽 22px，操作条按容器宽 → 行「凸出」；操作条在列表下方且不同宽；列表满宽没有搜索/分类。
- **改动**：`ChromePage` 非设置页改为三栏 `bodySplit`（左 `aside` 216px：搜索框 + 分类列表；右 `contentCol` 滚动）；新增 `searchQuery`/`sideFilter` 状态与内存过滤（历史 全部/今天/昨天/更早；下载 全部/进行中/已完成/已取消/失败；收藏 全部/最近7天/更早），无匹配显示「没有匹配的内容」；切换页面重置搜索/分类/选择；批量操作条移入 `listWrap` 顶部、在列表行之前，`box-sizing:border-box` 统一到 listWrap/list/selectionBar/row/dlRow，全选只作用于当前可见行，筛选变化时清空已选。新增 `chromePage.filter.*`/`chromePage.search.*` i18n。
- **验证**：typecheck 5/5；全量 vitest 171 文件 / 1449 tests 全绿；gen/check/build 通过；真机 E2E E2E_EVAL ok:true：aside 搜索框 + 4 个分类；搜索 "zzz-not-found" 无行且显示「没有匹配的内容」、"example" 3 行；「更早」0 行；操作条在列表上方且与首行左右缘偏差 ≤1.5px；删除 3 条历史正常。截图 `e2e-evidence/final-ui-history.png`。
- **决策记录**：ADR-0064。

## 二十一、2026-11-11 增量（新建标签页重做 + Vibecoding 会话页）

- **用户 m04399（附 4 张参考图）**：启动要有「新建标签页」、关闭最后一个标签页=关闭浏览器；新标签页加搜索框（用设置里的搜索引擎）；搜索框上方做「搜索 / Vibecoding」拨片；Vibecoding 下输入栏 + 模型选择，发送后发送栏平滑下移、整页渐入为会话页。
- **改动**：App 启动补初始空白标签（`listTabs` 为空则 `newTab`）、`closeTab` 最后一个标签改调 `api.window.close()`；`BrowserTabs` 空 URL 标签显示「新建标签页」。`StartPage` 重构为 loading/error/ntp/chat 四态：搜索模式含品牌、滑块拨片（220ms）、引擎图标搜索框（提交走 `navigate` 用偏好引擎）、最近访问快捷入口（history 前 6）；Vibecoding 输入态含自动增高 textarea、模型胶囊（预载 modelGroups 分组下拉）、Enter 发送；发送后 `App.startVibe`（必要时新建会话再发）并切 chat 视图，`MessageList` 复用 + 底部发送栏（模型胶囊/发送/停止），CSS `vibeComposerDrop` 380ms + `vibePageIn` 260ms 做「发送栏下移、整页渐入」。新增 `browser.ntp.*` i18n 与 `vibePageIn`/`vibeComposerDrop` keyframes。
- **验证**：typecheck 5/5；全量 vitest 171 文件 / 1449 tests 全绿；gen/check/build 通过；真机 E2E（E2E_EVAL ok:true）：初始「新建标签页」标签、拨片、engine-bing 图标、搜索 → cn.bing.com/search?q=loopsoar%20agent、Vibecoding 输入 + 模型菜单 8 项、发送后 chat 视图 + composer-drop + 用户消息可见。截图 `e2e-evidence/ntp-search.png`、`ntp-vibe.png`、`ntp-chat.png`。
- **决策记录**：ADR-0065。

## 二十二、2026-11-11 增量（Vibecoding 会话页卷轴错位修复）

- **用户 m04564（截图）**：Vibecoding 会话页右侧卷轴拖拽条歪了、只有上半部分。
- **根因**：`VibeChatView` 在 `MessageList` 外又套了一层自建滚动容器，`MessageList` 的 `messageArea`（position:relative; flex:1）高度塌成内容高度；`TopicRail` 绝对定位 `top:6/bottom:6` 只在这个小高度内绘制 → 只显示上半截、外层再滚动视觉上更歪。
- **改动**：`chatScroll` 去掉 `overflowY:auto`，改为 `flex:1/minHeight:0/display:flex/flexDirection:column` 的纯布局容器，让 `MessageList` 直接作为 flex 子项撑满；删除外层「滚到底」effect（MessageList 自带跟随）；卷轴由 MessageList 内部 scroller 正常驱动。
- **验证**：typecheck 5/5；全量 vitest 171 文件 / 1449 tests 全绿；gen/check/build 通过；真机 E2E（E2E_EVAL ok:true）：`.topic-rail` 高度 > 400px、rail 底边与聊天区底边偏差 < 40px，发送栏下移与用户消息正常；截图 `e2e-evidence/ntp-chat.png` 卷轴贯穿整页。
- **决策记录**：ADR-0066。

## 二十三、2026-11-11 增量（模型菜单穿透拨片修复）

- **用户 m04624（截图）**：Vibecoding 输入态模型菜单展开后，上方「搜索 / Vibecoding」拨片文字穿透在菜单之上。
- **根因**：菜单挂在带 `animation: vibePageIn` 的 `.modeBody` 内，动画的 `transform` 创建局部层叠上下文，菜单 `z-index:60` 无法越过外层 `z-index:1` 的拨片按钮。
- **改动**：`VibeModelChip` 菜单改为 `createPortal` 到 `document.body`，`position:fixed` + 按胶囊 `getBoundingClientRect()` 计算 `left/bottom` + `zIndex:1000`；保留 `usePopover` 外部点击/Esc/互斥逻辑，portal 菜单带 `data-popover`。会话页紧凑胶囊复用同一实现。
- **验证**：typecheck 5/5；全量 vitest 171 文件 / 1449 tests 全绿；gen/check/build 通过；真机 E2E（E2E_EVAL ok:true）：重叠点 `elementsFromPoint` 最顶层属于菜单、菜单父节点为 body、8 个可选项；截图 `e2e-evidence/ntp-menu.png`。
- **决策记录**：ADR-0067。

## 二十四、2026-11-12 增量（Vibecoding 主页面控制条 + 会话工作区树/搜索 + 收起态会话竖条）

- **用户 m04698**：主页面直接会话缺推理强度等控制；工作区选择放进「+」（含新加工作区→原生文件夹选择器）；不在会话列表选则直接回话默认新会话；会话列表放右侧栏；Vibecoding 下侧栏按钮平滑变「会话列表」，展开为工作区→会话嵌套（默认展开）；侧栏收起时右侧空白列显示会话竖条（悬停标题、最下方加号、悬停约 1s 自动展开会话列表，列表顶部标题搜索按相关度/精确优先）。
- **改动**：
  - `StartPage.tsx`：新增 `VibeControls`（+ 工作区菜单 / 模型胶囊 / 推理 chip / Build·Plan），新标签页与服务页共用；工作区菜单用 portal 固定定位，含「新加工作区…」；推理菜单同款。
  - `App.tsx`：预载工作区；`selectWorkspaceForChat` / `addWorkspaceForChat`（workspace.create 原生选择器）；`pickedSessionRef` 实现「直接回话默认新会话，列表选过才续接」；`vibeModeActive` 状态；收起态悬停展开 `expandSidebarWithSessions`（380ms 后打开列表）；共享 `changeReasoningEffort`。
  - `SessionListPanel.tsx`（新）：搜索框 + 工作区→会话嵌套树（默认展开）+ 底部新建；`sessionSearch.ts` 纯函数评分（精确 1000/前缀/包含/预览/多 token）。
  - `AgentSidebar.tsx`：vibeMode 下会话按钮交叉淡入变「会话列表」；弹层换成 SessionListPanel（宽 340）；收起态 `sidebar-collapsed-rail`（会话首字头像+title、当前高亮、底部加号、悬停 1000ms 展开）。
  - i18n：`chat.sessionList*`、`browser.vibe.*` 键。
- **验证**：typecheck 5/5；全量 vitest 171 文件 / 1451 tests 全绿（新增 sessionSearch 2 条）；gen/check/build 通过；真机 E2E E2E_EVAL ok:true（控制条、工作区菜单、新加工作区入口、Build→Plan、直接发送会话 +1、侧栏会话列表按钮/搜索/工作区组/精确排序、收起竖条条目+标题+加号、悬停 1s 恢复并自动开列表）；截图 `e2e-evidence/vibe-controls.png`、`session-list.png`、`sidebar-collapsed.png`。
- **决策记录**：ADR-0068。

## 二十五、2026-11-12 增量（Vibecoding 圆形加号 + 胶囊统一 + 侧栏图标平滑切换 + 会话面板版式）

- **用户 m04963（附 4 图）**：① 左侧输入区加号要跟右侧输入区一致（更多操作/附件），其上加「工作区」（点击弹原生文件夹选择器）；常态只显示圆框加号；② 其他胶囊深浅不一、末尾有省略号，要统一；③ Vibecoding 下右侧边栏按钮要平滑变成列表图标（图二→图三），展开的会话列表按图四版式排（工作区标题 + 单行会话 + 右侧时间）。
- **改动**：
  - `StartPage.tsx`：`WorkspaceControl` → `PlusControl`（26px 圆形加号，同 `Composer` plusBtn）；菜单 = 工作区列表 + 新加工作区…（`workspace.create` 原生选择器）+ 更多操作/附件；新增 `onPickAttachment` 链路（与右侧输入区共用 App `pickAttachmentPath`），附件路径按 `composer.insertAttachment` 插入草稿。
  - 胶囊统一：单一 `controlChip`（24px、同边框/同半透明底、字号 11），模型/推理/模式共用；删除末尾 `more` 三点图标；模型文案改纯 model id。
  - `AgentSidebar.tsx`：`.sidebar-toggle` 星标 ↔ `list-details` 双层图标交叉淡入 + scale（180ms），Vibecoding 下平滑切换；会话 chip 保留文案交叉淡入。
  - `SessionListPanel.tsx`：工作区标题 12px 加粗非大写；会话行改单行（标题 + 右侧相对时间：刚刚/分钟前/小时前/天前/日期），搜索结果同样单行时间。
- **验证**：typecheck 5/5；全量 vitest 171 文件 / 1451 tests 全绿；gen/check/build 通过；真机 E2E E2E_EVAL ok:true：加号圆形且无文字、三胶囊同高同底且无尾随省略号、菜单含工作区/新加工作区/更多操作/附件、侧栏 toggle 双层图标列表层可见、会话面板工作区标题 12px 非大写、会话单行含相对时间；原有自动新会话/竖条悬停展开断言通过。截图 `e2e-evidence/vibe-controls.png`、`sidebar.png`、`sidebar-collapsed.png`；日志 `e2e-evidence/sidebar.log`。
- **决策记录**：ADR-0069。

## 二十六、2026-11-12 增量（Vibecoding 右栏改为会话列表 + 侧栏图标对齐/过渡修复）

- **用户 m05149（附两图）**：① 侧栏按钮从星标换列表图标时错位、没有过渡；② Vibecoding 页右栏依旧是聊天会话，要求「会话转移到左侧主页，右侧边栏在 Vibecoding 时变为会话列表」。
- **根因**：① `toggleIconLayer`/`toggleIconLayerOverlay` 样式键因插入锚点不匹配**未写入 styles** → 列表图标在文档流里被排在星标右侧 16px、且无 transition（E2E 实测 dx=14px）；② AgentSidebar 只改了 chip 文案，内容区仍渲染 `{children}`（聊天+输入框），与左栏 `VibeChatView` 重复。
- **改动**：
  - `AgentSidebar.tsx`：补全双层图标槽位样式（16×32 同槽位、opacity/transform 200ms 交叉淡入）；`vibeMode` 时头部标题改「会话列表」+ list 图标、隐藏复制按钮，跳过 workspaceBar/sessionBar/children，主体内嵌 `SessionListPanel`（inline 变体：占满高度、无内部标题、不抢焦点）。
  - `SessionListPanel.tsx`：新增 `inline` prop（flex:1、maxHeight none、搜索框 autoFocus=false、隐藏面板标题）。
  - `App.tsx`：`expandSidebarWithSessions` 在 `vibeModeActive` 时不再 `setSessionOpen(true)`（右栏已含列表，避免旧浮层弹出）；聊天仅左侧主页渲染。
- **验证**：typecheck 5/5；全量 vitest 171 文件 / 1451 tests 全绿；gen/check/build 通过；真机 E2E ok:true：图标双层同槽位（starLeft 1301 / listLeft 1300，dx=-2px）、列表层 opacity=1；Vibecoding 下侧栏标题含「会话列表」、侧栏无 textarea、内嵌会话面板直接可见；圆加号/胶囊统一/附件菜单/工作区/搜索/竖条悬停展开均仍通过。截图 `e2e-evidence/vibe-controls.png`、`sidebar.png`、`sidebar-collapsed.png`。
- **决策记录**：ADR-0070。

## 二十七、2026-11-12 增量（会话列表：标准箭头 + 悬浮操作 + 工作区菜单）

- **用户 m05281**：① 展开/收起换标准箭头（展开向下、收起向右、旋转过渡）；② 工作区/会话右侧改鼠标悬浮才显示的操作：工作区 = 更多 + 添加会话；会话 = 更多 + 删除/归档 + 置顶；参考 Edge/session 列表，归档可选；③ 细节自行按最佳实践。
- **改动**：
  - 新增 `packages/ui/public/icons/chevron-down.svg`、`pin.svg`（1024 viewBox + 居中守卫通过）；工作区分组头用 chevron `rotate(-90deg)` 收起过渡。
  - `packages/ui/src/SessionListPanel.tsx` 重构（时间/数量与操作同一位置互斥：平时显示时间/数量，hover 淡出并在同一位置显示操作按钮，不加深色底；高亮挂在整行）：工作区行 [more][add-session]、会话行 [more][pin][delete]；portal fixed 菜单（工作区 重命名/在文件夹显示/删除；会话 置顶·取消置顶/复制会话 ID/删除）；置顶 localStorage `loopsoar.pinned-sessions` + 置顶优先排序 + pin 标记；重命名改为标题行内联输入；悬浮操作默认隐藏、hover 淡入（CSS 在 `packages/ui/index.html`）。
  - 主进程新增 `workspace:rename`、`workspace:openFolder`（`domains/workspace.ts` + `WorkspaceStore.rename` + `shell.openPath` 注入），gen/preload/types 同步；App 新增 `renameWorkspace/removeWorkspace/openWorkspaceFolder/newSessionInWorkspace` 并注入 Sidebar/Panel。
  - i18n：`chat.pinSession/unpinSession/sessionMenu/copySessionId/sessionIdCopied/workspaceMenu/addSessionInWorkspace/renameWorkspace/revealWorkspace/removeWorkspace`。
- **验证**：typecheck 5/5；全量 vitest 173 文件 / 1455 tests 全绿（新增 sessionListActions 守卫 4 条）；gen/check/build 通过；真机 E2E E2E_EVAL ok:true（悬浮操作默认隐藏且按钮齐全、工作区/会话菜单文案、箭头 0°/-90°、工作区加号新建会话 +1）；截图 `e2e-evidence/sidebar-actions.png`、`sidebar.png`。
- **决策记录**：ADR-0071（归档未实现：harness 无归档概念，当前用删除+置顶覆盖，用户已允许）。

## 二十八、2026-11-12 增量（全屏侧栏可调 + Vibecoding 窄侧栏 + 退出键兜底）

- **用户 m05586**：① 全屏时右侧边栏比例无法调整；② Vibecoding 右侧栏最窄收窄到当前最小宽度约 1/2，会话列表不用那么宽；③ 搜索→Vibecoding 切换时侧栏平滑收缩到最窄，且 vibe 最大宽度不超过当前最小宽度 3/5；④ 右上角退出键总是失效。
- **根因**：全屏下 `min = round(视口宽×0.35)` 被夹到 720，而 `max = min(720, 视口宽-320)` 也是 720 → min===max 拖不动；vibe 复用标准宽度没有独立区间；退出键 `dismissAllPopovers()` 未兜异常、主进程只调一次 `win.close()` 无强制销毁。
- **改动**：
  - `contracts/layout.ts`：新增 `SIDEBAR_MIN_DRAG_RANGE=200`，`computeSidebarMinWidth` 保证与 max 之间至少留 200px；新增 `computeVibeSidebarBounds`（min=max(120, normalMin×0.5)，max=normalMin×0.6）与 `SIDEBAR_VIBE_*` 常量。
  - 偏好：新增可选 `vibeSidebarWidth`（100..720，contracts/core/types 同步）。
  - `App.tsx`：vibe 宽度独立 state/水合/夹紧/持久化；进入 vibe 时设为 vibe 最小宽度（wrapper 320ms + 原生视图 animate 同曲线平滑收缩）；splitter 按模式选区间；`AgentSidebar` 内容宽度去掉 240 硬下限。
  - 退出键：`TitleBar` 关窗 try/catch + `api.window.close()` 失败回退 `window.close()`；主进程 `window:close` try/catch + 800ms 后强制 `destroy()` 兜底。
  - 测试：`tests/core/sidebar-width.spec.ts` 更新为 9 条（全屏可调区间、vibe 区间、窄窗下限）。
- **验证**：typecheck 5/5；sidebar-width 9 条通过；全量 vitest 173 文件 / 1457 tests 全绿；E2E：普通窗口拖拽 717→477→720（区间 243px）、vibe 717→239→拖宽 286→239、切回 717、关闭键点击后应用退出；全屏路径由 1920/2560/3840 契约单测覆盖（沙箱下 Electron 全屏 E2E 会崩溃，未作门禁）。

## 二十九、2026-11-12 增量（会话小窗化/恢复/置顶/删除图标替换）

- **用户 m05830**：提供 `删除.svg`、`置顶.svg`、`退出小窗.svg`、`小窗化.svg`，要求替换会话的小窗化/恢复、置顶、删除图标。
- **改动**：
  - 资产：复制为用户图标库的 `float.svg`、`float-exit.svg`，覆盖 `pin.svg`，新增 `delete.svg`（delete 图形中心偏右 3.3%，加 `translate(-33.8 0)` 修正）。
  - `SessionListPanel`：置顶按钮/菜单沿用 `pin`（新资产）；会话删除（行内、菜单）与工作区删除菜单统一改用 `delete`（垃圾桶）。
  - `AgentSidebar`：小窗化按钮 `float` / 退出小窗 `float-exit`，文案改「退出小窗」；Agent 小窗 `TitleBar` 最小化=`float`、关闭=`float-exit`（对应小窗化/恢复）。
- **验证**：图标守卫（1024 viewBox/居中/引用存在）通过；typecheck 5/5；全量 vitest 173 文件 / 1457 tests 全绿；gen/check/build 通过；截图 `e2e-evidence/icons-rows.png`（置顶/删除）、`icons-actions.png`（小窗化 + 菜单删除）。
- **决策记录**：ADR-0073。

## 三十、2026-11-12 增量（会话行微调 + Vibecoding 隐藏小窗化 + Agent 小窗标题栏图标）

- **用户 m05915**：① 会话行内容略偏、右侧时间贴边，整体往左上挪几个像素；② Vibecoding 不需要小窗化（搜索侧专属），切换时让小窗化图标淡出消失；③ Agent 小窗标题栏图标太小：最小化改常规横杠，退出窗口化换成 `收起侧边栏.svg`。
- **改动**：
  - `SessionListPanel`：行 `padding "0 8px 2px 0"`、按钮 `4px 6px 6px`、悬浮操作 `right:6`、工作区标题左/上各收 1px、会话数右边距 10；时间不再贴边（实测右缘距 8px）。
  - `AgentSidebar`：小窗化按钮包 `sidebar-float-slot`，`vibeMode` 时宽 0/透明/不可点，过渡 width 240ms + opacity 220ms；离开 vibe 恢复。
  - `TitleBar`：Agent 小窗最小化 = `minimize`（横杠，14px），关闭（退出窗口化）= 新资产 `sidebar-collapse.svg`（收起侧边栏，14px）；新增图标资产。
- **验证**：typecheck 5/5；图标守卫通过；全量 vitest 173 文件 / 1457 tests 全绿；gen/check/build 通过；E2E `icons-tuning.log` ok:true（float slot 26→0→26、时间右缘距 8px、Agent 小窗打开），截图 `icons-tuned.png`、`icons-tuned-desktop.png`。
- **决策记录**：ADR-0074。

## 三十一、2026-11-12 增量（小窗内去小窗化 + 过渡内容冻结 + 头部按钮槽位淡出）

- **用户 m05992**：① 小窗化后 Agent 小窗里仍有「小窗化」按钮，冗余；② 非全屏小窗口切换搜索/Vibecoding 时收窄有几帧文字挤压换行；③ 变宽还原时文本从右侧被拉出、头部小变化按钮也从右侧飞出，希望只在原位淡入/滑出。
- **改动**：
  - `AgentSidebar` 新增 `embeddedInAgentWindow`（小窗内 `display:none` 小窗化槽位）与 `liveWidth`（拖拽/铺满时内容宽度实时跟手）；模式切换时 `frozenContentWidth` 冻结到 320ms+20ms 后再切换，避免过渡中提前换行。
  - 头部复制按钮与小窗化按钮改为固定槽位：`vibeMode` 时 width/opacity 过渡到 0（240/220ms），布局顺序不变，按钮原位淡出/淡入；`App` 传入 `liveWidth={sidebarDragging || miniWindow}`、`embeddedInAgentWindow={miniWindow}`。
- **验证**：typecheck 5/5；全量 vitest 173 文件 / 1457 tests 全绿；gen/check/build 通过；E2E `sidebar-freeze.log` ok:true（收缩中 inner 717/wrapper 503 → 结束 239；变宽中 inner 239/wrapper 525 → 结束 717；槽位 24/26→10/11→0→恢复；Agent 小窗打开且头部无小窗化）；截图 `sidebar-freeze.png`、`sidebar-freeze-desktop.png`。
- **决策记录**：ADR-0075。

## 三十二、2026-11-12 增量（撤销内容冻结，改 inner/wrapper 同曲线同步）

- **用户 m06058（截图）**：模式切换的几帧里侧栏严重变形——标题换行、正文变窄竖列、左侧大片空白，认为越调越烂。
- **根因**：ADR-0075 的「内容宽度冻结」在变宽时让 inner 保持旧窄宽度、wrapper 已展开 → 右侧窄内容 + 左侧空白。
- **改动**：撤销 frozenContentWidth 状态与定时器；`contentWidth = fill ? "100%" : width`；`.agent-sidebar-inner` 增加 `transition: width 320ms ease, opacity 320ms ease`（拖拽/铺满 liveWidth 时只保留 opacity，保证跟手）；与 wrapper 同曲线同帧变化。ADR-0075 的另两项（小窗内去小窗化、头部按钮槽位淡出）保留。
- **验证**：typecheck 5/5；全量 vitest 173 文件 / 1457 tests 全绿；gen/check/build 通过；E2E `sidebar-sync.log` ok:true：收缩中 inner/wrapper = 519/519（旧方案 717/503），结束 239/239；变宽中 525/525（旧 239/525），结束 717/717；槽位过渡和 Agent 小窗正常。截图 `sidebar-sync.png`。
- **决策记录**：ADR-0076（替代 ADR-0075 的内容冻结部分）。

## 三十三、2026-11-12 增量（模式切换内容遮罩，消除最后挤压帧）

- **用户 m06108（截图）**：搜索↔Vibecoding 切换仍能截到最后一帧挤压换行（标题两行、正文窄竖列）。
- **根因**：宽度连续动画 + 内容可见，中间宽度下文字必然真实重排；换行帧无法通过调整宽度曲线消除。
- **改动**：`AgentSidebar` 增加 `modeSwitching` 状态：`vibeMode` 变化时立即隐藏 inner（opacity 0，0ms）并禁止交互，宽度仍按 320ms 过渡；约 340ms 后解除，内容以 160ms 淡入（此时宽度已落定）。仅模式切换触发，拖拽/窗口缩放不遮罩。
- **验证**：typecheck 5/5；全量 vitest 173 文件 / 1457 tests 全绿；gen/check/build 通过；E2E `sidebar-mask.log` ok:true：收缩中 inner/wrapper=554/554、opacity 0，结束 239/239、opacity 1；变宽中 512/512、opacity 0，结束 717/717、opacity 1；槽位与 Agent 小窗检查保留。截图 `sidebar-mask.png`。
- **决策记录**：ADR-0077（沿用 ADR-0076 宽度同步、ADR-0075 小窗化/槽位）。

## 三十四、2026-11-12 增量（模式切换「概率性一帧」确定性修复：首帧遮罩 + NTP 等高）

- **用户 m06158（视频 `video_20261112_194344.mp4`）**：ADR-0077 遮罩后仍「没变化 / 还是有一帧问题」，后补充「现在好多了，但还是有概率发生」。
- **逐帧分析**：视频 30.5s/1080p/30fps；侧栏切换瞬间偶发旧宽度内容一帧；NTP 拨片实测切换时 top 407→365（Δ-42）、left +235，录屏相邻帧叠加形成重影。
- **根因**：① `AgentSidebar` 的 `modeSwitching` 在 `useEffect` 里设置（paint 之后）→ 概率性漏遮；② `StartPage` 的 `onVibeModeChange` 也在 `useEffect` 上报，App 的侧栏宽度/遮罩比模式切换晚一帧；③ NTP 内容垂直居中 + 两模式 body 高度不同（114 vs 199）→ 拨片整体上下跳 42px；④ `.vibe-page-in` 的 translateY(10px) 叠加位移。
- **改动**：`AgentSidebar` 与 `StartPage` 的相关 effect 均改 `React.useLayoutEffect`（paint 前提交遮罩与状态）；`.modeBody` 加 `minHeight: 204`（两模式等高，拨片 top 恒定 362）；`vibePageIn` 关键帧去掉 translateY，仅保留透明度。
- **验证**：typecheck 5/5；全量 vitest 173 文件 / 1457 tests 全绿；gen/check/build 通过；E2E `e2e-evidence/sidebar-firstframe.log` ok:true：连续 6 次切换，首帧 inner opacity 全 0、inner=wrapper（477/477、239/239）；拨片 top 切换前后均为 362。
- **决策记录**：ADR-0078（在 ADR-0077 的遮罩方案上做确定性加固）。

## 三十五、2026-11-12 增量（悬浮小窗/图标：独立 56px 图标窗口，消除闪烁/黑块/拖尾）

- **用户 m06420 / m06958（录屏）**：最小化后局部可点、图标↔小窗闪烁、恢复侧栏拖尾；后续仍闪烁并出现黑色像素方块。
- **根因**：① 隐藏内容的 `-webkit-app-region: drag` 是窗口级拖拽区，抢走图标点击；② 窗口 resize 与渲染层面板布局的跨进程竞态；③ **`setShape` 在 Windows 透明窗口上触发合成黑块/抽搐**（逐帧录屏确认）；④ 关闭逐帧移动透明重窗口造成拖尾。
- **改动**：新增静态 `packages/ui/public/icon.html`（透明 56px、只画 logo + 拖动/点击还原）与独立图标 BrowserWindow；打开 Agent 窗口时预创建隐藏；minimize 面板动画结束后 show 图标窗并同帧 hide Agent 大窗；restore 把 Agent 窗原点对齐到图标屏幕位置后 show/hide 切换并反向展开面板；拖动直接移动图标窗（moveAgentWindow）；关闭改原地淡出（普通态）/直接销毁两窗（图标态）；图标窗失败时保底保留大窗口。全程无 resize、无 setShape。
- **验证**：typecheck 5/5；全量 vitest 173 文件 / 1457 tests 全绿；gen/check/build 通过；E2E `e2e-evidence/agent-iconwin.log`：图标窗 (1632,225,56×57) visible + URL icon.html；拖动 +80/+60；点击后 Agent 窗 visible、图标窗 hidden、`isIconMode=false`，还原后窗口原点 (1356,277) 与拖动后图标位置精确对齐；打开时 Agent 窗口 focused=true。
- **决策记录**：ADR-0079。

## 三十六、2026-11-12 增量（Agent 小窗拖动：拖动会话固定起点尺寸，修复越拖越大）

- **用户 m07288**：「悬浮窗口怎么会随着拖动越变越大？有bug」。
- **根因**：拖动每帧读 `getBounds()` 再 `setBounds`；Windows 125% DPI 下 DIP↔物理像素取整误差逐帧累积（固定写 722 高仍 722→728 爬升）。原生 `-webkit-app-region: drag` 在透明无边框 Agent 窗口不生效（真机鼠标验证主窗口可拖、Agent 窗不动），只能显式 pointer+IPC 移动，误差因此暴露。
- **改动**：`ui:dragAgentWindow` 增加 `phase: start/move/end`；管理器维护拖动会话：begin 冻结起点位置、宽高取最近一次写入目标值（避免 getBounds 回报 724 造成每轮 +2px），move 用「起点 + 累计屏幕增量」且宽高固定起点值，end 清会话；未显式 begin 时首帧 dragBy 自动捕获；保留工作区夹取；图标态忽略。Agent 窗口恢复 `thickFrame:true`，拖动改用 setBounds（实测 setPosition 在 125% DPI 下每帧 +4~8px，弃用）。
- **验证**：typecheck 5/5；全量 vitest **173 文件 / 1461 tests 全绿**（新增 4 条拖动会话单测）；gen/check/build 通过；真机 E2E `e2e-evidence/agent-window-drag.log`：连续 5 次拖动 (1276,217)→(1476,367)，高度 721～722 之间 ±1 波动、无累积；真实鼠标拖动 (1276,217)→(1358,267)、尺寸 420×721→421×723，不再随拖动变大。
- **决策记录**：ADR-0080。

## 三十七、2026-11-13 增量（悬浮小窗头部收敛：会话列表图标 + Vibecoding 同款列表）

- **用户 m07603（截图）**：悬浮窗上方的会话切换/工作区切换排布不好；点工作区打开宽栏 WorkspacePanel，在 420px 小窗里挤成变形界面；要求换成 Vibecoding 的常规列表，左上角只保留一个会话列表图标，点击展开列表。
- **根因**：小窗复用了主侧栏完整头部 + workspaceBar + sessionBar，WorkspacePanel 双栏布局在窄窗放不下。
- **改动**：`AgentSidebar` 增加 mini 分支：头部只留 `list-details` 图标按钮（`data-testid="agent-mini-session-toggle"`，aria-pressed 开合）；去掉 mini 的 workspaceBar/sessionBar；列表打开时用 `SessionListPanel inline` 以浮动下拉层覆盖在对话之上（不替换界面，高度约为小窗内容区实时高度的 1/4、最小 120px，下方仍可见对话/输入区），再点图标 / 点外部 / Esc / 选会话或新建后自动收起；主窗口侧栏与 WorkspacePanel 不变。
- **验证**：typecheck 5/5；全量 vitest **173 文件 / 1461 tests 全绿**；gen/check/build 通过；真机 E2E `e2e-evidence/agent-session-list.log`：图标 aria-pressed false→true、列表浮层 + `session-search` 出现、workspace 条消失、3 条会话，对话仍在 DOM；再点一次或 Esc 收起并恢复输入框；截图 `e2e-evidence/agent-session-list-session-list.png`。
- **决策记录**：ADR-0081。

## 三十八、2026-11-13 增量（Vibecoding 侧栏切换判定修复：地址栏有 URL 时也切会话列表）

- **用户 m07821（截图）**：左侧 NTP 已切到 Vibecoding，地址栏仍是 douyin URL，右侧栏却还是聊天会话，未变成会话列表。
- **根因**：StartPage 上报条件 `!currentUrl && (mode==="chat" || tabMode==="vibe")`；NTP 在「地址栏有 URL、原生网页视图暂时隐藏」时 `!currentUrl` 为 false，App 的 `vibeModeActive` 一直 false，侧栏/宽度都不切换。
- **改动**：上报条件改为 `mode==="chat" || tabMode==="vibe"`，不再依赖 currentUrl；导航时既有 effect 会把 mode/tabMode 复位为 ntp/search，浏览网页不会误保持列表。
- **验证**：typecheck 5/5；全量 vitest **173 文件 / 1461 tests 全绿**；gen/check/build 通过；真机 E2E `e2e-evidence/vibe-sidebar-mode.log`：空白 NTP 点 Vibecoding → 侧栏变「会话列表」+ 列表出现；`browser.newTab(https://example.com)` 导航后恢复「Agent 对话」+ 列表消失。
- **决策记录**：ADR-0082。

## 三十九、2026-11-13 增量（Vibecoding 主页面承载会话正文：切换/选会话自动进会话页）

- **用户 m07865（截图）**：从搜索切到 Vibecoding 后左侧主页面仍是「今天想聊点什么？」初始页，右栏原会话内容没有移过来；点右栏对应会话也仍是初始页。
- **根因**：切拨片只设 `tabMode=vibe`（右栏变列表），StartPage 的 `mode` 仍为 `ntp`；只有发送消息才 `setMode("chat")`。从右栏选会话只更新 messages/currentSession，不改变 StartPage mode。
- **改动**：StartPage 增加 `useLayoutEffect`：`tabMode==="vibe" && messages.length>0 → setMode("chat")`；切拨片与从右栏选已有会话都会自动进会话页；空会话仍显示初始页；发送消息的 setMode 保留。
- **验证**：typecheck 5/5；全量 vitest **173 文件 / 1461 tests 全绿**；gen/check/build 通过；真机 E2E `e2e-evidence/vibe-main-chat.log`：搜索→Vibecoding 后主页面出现「你好」正文、右栏列表；点「hi」会话后主页面切换为 hi 正文（hasHi=true、hasHello=false）；截图 `e2e-evidence/vibe-main-chat.png`。
- **决策记录**：ADR-0083。

## 四十、2026-11-13 增量（会话绑定标签页、标签页绑定工作区：新标签/启动 = 新会话）

- **用户 m07920**：切到 Vibecoding 后回不到搜索；规定每次进入 Loopsoar、新建标签页都是新会话（除非主动进入会话）；会话绑定标签页、标签页绑定工作区，从 Vibecoding 回搜索可新建标签页或新建工作区。
- **根因**：StartPage 的 mode/tabMode 是全局单实例状态，新标签不重置；`newTab` 的「已是空白页只聚焦」守卫在 Vibecoding（URL 空）下拦住新建；新标签只加入当前会话标签组，没有新会话语义。
- **改动**：新增 `createFreshSessionAndTab()`（切工作区 → chat.newSession → 空标签组补空白标签 → 清空消息/输入/URL → freshSessionToken++）；`newTab/newSession/newSessionInWorkspace` 全走它；启动在 boot 完成后调用一次（每次进入=新会话）；StartPage 增加 resetToken 重置回搜索初始页；新加工作区后自动创建该工作区的新会话+标签页。
- **验证**：typecheck 5/5；全量 vitest **173 文件 / 1461 tests 全绿**；gen/check/build 通过；真机 E2E `e2e-evidence/session-tab-binding.log`：启动=新会话+1 空白标签+搜索 NTP；点「+」=新会话 ID+1 空白标签+搜索 NTP；主动选旧会话「你好」→ 切到该会话（主页仍搜索 NTP）；切 Vibecoding → 主页显示正文；再从 Vibecoding 点「+」→ 新会话+空白标签+回到搜索 NTP；截图 `e2e-evidence/session-tab-binding.png`。
- **决策记录**：ADR-0084。

## 四十一、2026-11-13 增量（新建会话不跳搜索 + 统一会话列表 + 输入框下工作区选择 + 默认工作区自动认领）

- **用户 m08041（截图 + 新增文件夹.svg）**：新建会话总跳搜索；搜索页侧栏工作区/会话改成悬浮窗式单图标列表；统一搜索页与悬浮窗的会话列表表示，并在搜索框下加「添加工作区」；新规则：新标签页/会话无工作区且用户未设置时，首次对话自动落默认工作区；输入框下加可展开工作区选择（列表底部添加工作区）。
- **改动**：`createFreshSessionAndTab` 增加 reset=search/keep（newTab/启动重置搜索页，newSession/newSessionInWorkspace 只回初始页保留 Vibecoding 模式）；搜索页侧栏去掉 workspaceBar/sessionBar，改单图标 + 同一套 SessionListPanel 浮层；SessionListPanel 搜索框下新增「添加工作区」（workspace-add.svg）；侧栏 Composer 与 Vibecoding 输入框下加工作区选择 chip（显示会话实际绑定工作区，未认领显示「选择工作区」）；新会话 workspaceId=null，首次 chat:send 自动落「默认工作区」；新增 `workspace:bindSession` IPC。
- **验证**：typecheck 5/5；全量 vitest **173 文件 / 1461 tests 全绿**；gen/check/build 通过；真机 E2E `e2e-evidence/ui-list-overhaul.log`：单图标/旧栏消失/浮层+添加工作区/两处工作区选择器存在；Vibecoding 点新建会话后右栏保留+初始页+不跳搜索；新会话 workspaceId null → 发送后等于默认工作区 id；截图 `e2e-evidence/ui-list-overhaul3.png`。
- **补充 4（m08473）**：工作区设置面板改为只读详情：点击只换右侧详情，不再设活跃/不动 lastUsedAt，列表不再重排、不影响输入框工作区选择；选中只保留背景高亮（去掉描边）。聊天输入区工作区按钮统一为品牌色胶囊（ochreSoft 底 + 0.55 描边、radius 999、height 26、字重 600，去 .chip 避透明边框覆盖）。E2E `e2e-evidence/workspace-panel.log`：orderUnchanged/activeUnchanged=true，选中行无边框仅高亮，详情随点击切换；composer chip 样式生效；截图 `e2e-evidence/workspace-panel.png`。
- **补充 3（m08444/m08446）**：工作区选择按钮补回 `borderRadius:999` 胶囊形（去 .chip 后曾变方框）；删除 Vibecoding 初始页输入框下方那行说明提示。E2E `e2e-evidence/workspace-pill.log`：107×26、radius 999px、提示不存在、菜单仍向下；截图 `e2e-evidence/workspace-pill.png`。
- **补充 2（m08395）**：工作区选择按钮改为品牌色高亮（ochreSoft 底 + 0.55 描边 + 品牌文字色、height 26、字重 600），并去掉 `.chip` 以避开 soft 主题的透明边框强规则；工作区菜单改为向下展开（`useFloatingMenu` 支持 direction，`FloatingMenu` 向下时按视口夹 `maxHeight`+滚动）。E2E `e2e-evidence/workspace-down.log`：border/背景/字重生效，`menu.top=611 ≥ picker.bottom=603`；截图 `e2e-evidence/workspace-down.png`。
- **补充（m08251/m08310/m08323）**：Vibecoding 输入框的工作区选择 row 移到输入框外（Fragment 兄弟节点、卡片下方**左对齐**）；工作区菜单「添加工作区」下方新增「更多」，点击打开详细 `WorkspacePanel`。E2E 几何断言 `outside=true` / `leftAligned=true`（box.left=202、picker.left=202、box.bottom=572 / picker.top=578），菜单项「更多」在「添加工作区」下方且点击后 `workspacePanelOpen=true`；证据 `e2e-evidence/workspace-more.log`、`workspace-more-menu.png`、`workspace-more.png`。
- **决策记录**：ADR-0085（修正 ADR-0084 的「新建会话」行为）。

## 四十二、2026-11-13 增量（浏览器平台收尾：favicon + F12 调试器 + 浏览器扩展 + 终端环境自检）

- **用户 m08518**：① 默认主页标签/历史记录头部网址 logo 抓不到；② 补浏览器插件（Chrome/Edge 等市场）适配；③ 补 F12 调试并跟上调试面板进度；④ 彻底完善终端系统、检查下方终端，并在设置里加入系统终端依赖检测；为未来自研搜索引擎做准备。
- **改动**：
  - favicon：webContents 监听 page-favicon-updated → 主进程抓取转 data URL（CSP/离线友好）→ TabState/HistoryEntry 携带 → 标签页/历史行/新标签快捷入口展示（缺失回退首字母）。
  - DevTools：新增 `browser:toggleDevTools`，每标签 detach 调试窗口；工具栏按钮 + F12 / Ctrl+Shift+I（网页内也生效）；请求守卫放行 devtools:/chrome-extension:/chrome: 且不做 DNS 解析（修复 ERR_BLOCKED_BY_CLIENT）。
  - 浏览器扩展：新增 `browserExtensions.ts`（本地目录安装、Chrome 商店 CRX 下载→CRX2/3 头→极简 ZIP 解包→loadExtension）、`browser:listExtensions/installExtension/removeExtension`、持久化目录与开机加载；设置新增「浏览器扩展」分区（商店链接、本地文件夹、列表、错误、卸载、兼容性说明）。
  - 终端：新增 `terminal:diagnose` + `terminalDiagnostics.ts`（复用 profiles 探测，额外 git/node/npm/pnpm/python/rg/curl；Windows npm/pnpm .cmd + python py 候选）；设置新增「终端环境」分区（平台/默认 shell/可用徽标/配置档表/工具表/安装提示/重新检测）。终端面板实测：6 配置档、新建 cmd、提示符 `D:\试验场>`、状态就绪。
- **验证**：typecheck 5/5；全量 vitest **175 文件 / 1472 tests 全绿**（新增 browserExtensions 8 条、faviconHistory 2 条、terminalDomain 通道数更新）；真机 E2E `e2e-evidence/browser-favicon.log`：tabFaviconOk/historyFaviconOk、扩展安装/内容脚本注入（loopsoar-extension-ok）/卸载、devtools open→close、terminal diagnose all、终端 echo 回放；`terminal-panel-live.log` 面板创建终端；截图 `browser-tab-favicon.png`、`history-favicon.png`、`settings-browser-extensions.png`、`settings-terminal-env.png`、`terminal-panel-live.png`。
- **研究记录**：`docs/research/browser-platform-stage.md`（Electron 扩展 API 子集/DevTools detach/favicon 抓取/终端探测；自研搜索引擎下一阶段建议）。
- **决策记录**：ADR-0086 favicon、ADR-0087 DevTools、ADR-0088 浏览器扩展、ADR-0089 终端环境自检。

## 四十三、2026-11-13 增量（调试面板停靠底部 + 状态栏交互 + 商店安装点击拦截 + 图标替换）

- **用户 m09003/m09029/m09137/m09249/m09223**：调试面板不要独立窗口，停靠到底部终端区域、点击向上展开，用「操作-调试」图标并把按钮移到终端左侧；harness 扩展/浏览器插件图标换指定 SVG；浏览器里点商店安装按钮无反应；状态栏两按钮间距太大；DevTools 汉化本轮先不做。
- **改动**：
  - 新增 `BrowserDevToolsPanel`：WebContentsView 作为 DevTools 画布，`setDevToolsWebContents + openDevTools({mode:"detach"})` 后停靠主窗口底部；契约 `browser:setDevToolsPanel` + 事件 `chrome:devToolsPanel`；面板高度随布局/resize 同步。
  - 状态栏与面板顺序调整：内容 → 状态栏 → 面板占位，占位 0→360 平滑过渡把状态栏顶成面板顶栏；调试按钮（`devtools.svg`）移到终端左侧，加「调试」文字并与终端组成 6px 间距按钮组。
  - 浏览器 preload：Chrome/Edge 商店详情页拦截「Add to Chrome/获取」点击 → 专用 IPC（校验 sender 必须属于浏览器标签）→ 扩展安装 → 页面 toast；设置页新增「打开 Chrome 商店 / 打开 Edge 商店」。
  - 图标替换：`devtools.svg`（操作-调试）、`extension-feature.svg`（扩展功能）、`browser-plugin.svg`（组件、插件）；设置导航「扩展」「浏览器扩展」同步换图标。
- **验证**：真机 E2E `e2e-evidence/devtools-panel3-window.png`（底部 DevTools、无独立窗、状态栏在面板顶端）；`E2E_STORE_INSTALL` 真实安装 Chrome 商店 Dark Reader 4.9.135；模拟商店页点击「Add to Chrome」→ preload 拦截（页面点击计数 0 + toast），截图 `e2e-evidence/store-click-fake.png`；设置截图 `settings-browser-extensions2.png`。
- **验证补记**：全量 vitest **176 文件 / 1476 tests 全绿**；typecheck 5/5、gen/check/build 通过。
- **决策记录**：ADR-0090（DevTools 底部面板/状态栏/商店拦截/图标；DevTools 汉化暂缓）。

## 四十四、2026-11-13 增量（会话按需创建 + 工作区箭头下拉 + favicon 回抓 + 图标居中）

- **用户 m09384**：① 设置「从商店安装」按钮语义重复；② 新建页不应自动跳转/新建会话，只有与 Agent 对话才算创建；③ 网页最左侧加工作区箭头下拉（向下展开），选择后新建页/会话都在该工作区活动；④ 会话/网页在工作区内活动，新建网页≠新建会话；对话前右侧只是无归属会话栏；只有完全没选工作区的新用户对话才落「未归属工作区」；⑤ bing/bilibili/douyin/baidu/Microsoft 等 favicon 抓不到；⑥ 标签页关闭按钮图标不居中，全局排查。
- **改动**：
  - `createFreshSessionAndTab` 改为草稿态，不再创建会话；启动/新建页/新建会话均为草稿；新增 `ensureSessionForSend`，首次发送才创建会话并绑定当前标签页/工作区；`send`/`startVibe` 先 ensure；切标签按 `tabSessionRef` 恢复会话，新页保持草稿。
  - `BrowserChrome` 最左侧新增工作区下拉（folder+chevron，向下展开 workspaces + 添加工作区）；选择只影响后续活动工作区；草稿态只 `workspace.select`，有会话才 `bindSession`；shell 移除 startStream 自动绑默认工作区，只有完全没选工作区时才未归属。
  - 新增 `browser:resolveFavicon` + `resolveFaviconForPage`（HTML link rel=icon → /favicon.ico → /favicon.png）；StartPage 快捷入口与 ChromePage 历史行缺图标时回抓并原地刷新。
  - 设置扩展安装区改为「打开 Chrome/Edge 商店 + 安装本地文件夹」主行、「或粘贴链接/ID」次行。
  - 全局 `.icon-btn{padding:0;line-height:0}` 修复图标不居中；E2E 验证标签关闭 close/icon 中心一致。
- **验证**：真机 E2E `e2e-evidence/turn51.png`：bing tab/history favicon 为 data URL；新建标签页 session 数不变；工作区菜单正常；选默认工作区后首次发送创建会话且归属该工作区；草稿态右侧无会话项、输入框可用。typecheck 5/5；全量 vitest **176 文件 / 1476 tests 全绿**；gen/check/build 通过；截图 `settings-browser-extensions3.png`。
- **决策记录**：ADR-0091。

## 四十五、2026-11-13 增量（工作区入口归位标题栏 + 设置内跳转直接生效）

- **用户 m09567**：① 工作区下拉位置错、和标签页/地址栏挤在一起很乱——应在顶部导航栏、标签页最左侧（Loopsoar 左上角）；② 设置里打开 Chrome/Edge 商店不是直接跳转，还要退出设置界面。
- **改动**：
  - 新增 `packages/ui/src/WorkspaceSwitcher.tsx`：标题栏 34×40 入口（**chevron-only**，用户 m09840 要求去掉文件夹图标），portal 菜单（fixed 锚定在标题栏下方），工作区列表 + 添加工作区；`usePopover("titlebar-workspace")` 统一收起。
  - `TitleBar` 新增 `tabsLeading` 插槽（渲染在标签页之前）；`App` 用 WorkspaceSwitcher 注入；删除 `BrowserChrome` 的工作区按钮/菜单/props（工具条不再挤入工作区）。
  - 设置跳转：`Settings.onOpenUrl` → `BrowserExtensionsSection` 商店按钮；`ChromePage` 透传；App 处理器关闭设置/整页遮罩后延迟 90ms 再 `browser.newTab({url})`，确保主进程在遮罩关闭后按新活动标签布局原生视图。
- **验证**：E2E `e2e-evidence/titlebar-workspace.png`：工作区入口 rect (0,0,34,40)、标签 left=40；菜单正常展开/选择生效。E2E 设置跳转（ChromePage 设置 → 浏览器扩展 → Edge 商店）：整页设置关闭、商店标签 active，窗口截图 `settings-chromepage-jump4-window.png` 直接显示商店页（本机网络错误页属预期）。typecheck 5/5、gen/check/build 通过；全量测试见下。
- **追加（m09840/m09866/m09937/m10007）**：工作区入口只留箭头（去 folder 图标）、30×30 与标签页齐高、箭头 18px；去掉边框，仅保留高光；按钮外层加 `data-popover-trigger` 修复「再次点击重复展开」；展开菜单不再使用透明副窗口（在视频网页上掉帧严重，已回退），改为 DOM 菜单 + 展开期间 `browser.setOverlay({open:true})` 临时隐藏原生视图。E2E：二次点击 `aria-expanded` true→false 且 0 副窗口；菜单矩形 (6,44,212,149)、按钮 (6,10,30,30) 与标签页齐高；点外部收起。
- **决策记录**：ADR-0092。

## 四十六、2026-11-13 增量（工作区菜单改独立浮层 + 有网页时侧栏动画掉帧修复）

- **用户 m10071**：① 点击左上角工作区后网页界面消失，不要这样（对卡顿也没帮助）；② 卡顿仅在有网页时出现，各栏目展开/收起掉帧极严重；③ 右侧竖条悬停自动展开可以，但不要连带展开工作区/会话列表；④ 工作区列表四周的渲染阴影不需要。
- **改动**：
  - **工作区菜单**：撤销「DOM 菜单 + 隐藏原生视图」，改为独立透明浮层子窗口（`PopoverApp` 的 `workspaces` 类型）；网页全程可见、菜单浮在最上层；浮层窗口 `hasShadow:false`、卡片 `box-shadow:none`（去阴影）。点击外部/Esc 关闭；动作经 `ui:popoverAction`（selectWorkspace/addWorkspace）回主窗口执行。
  - **再次点击重复展开**：`chromePopover.ts` 的 blur 处理中，若主窗口此刻已获得焦点则不立即关闭（改由 hover 轮询与 click 的 `togglePopover` 原子收起）；点其它应用仍立即关。`WorkspaceSwitcher` 监听 `chrome:popoverClosed` 复位高光态。
  - **悬停竖条**：`expandSidebarWithSessions` 只 `changeSidebarMode("docked")`，不再 `refreshSessions()+setSessionOpen(true)`，展开后不自动打开会话/工作区列表。
  - **掉帧修复（ADR-0093 初版）**：曾改为「不逐帧 resize 原生视图」，侧栏内容做遮罩；该观感被用户否掉，已由 m10244 追加修订恢复逐帧同步（保留活动标签/缓存优化，见文末追加）。
- **验证**：E2E `e2e-evidence/ws-popover-open.log`：仅 1 个额外浮层窗口、URL `?popover=workspaces`、菜单 3 项；`ws-popover-toggle.log`：连点两次 `aria-expanded` true→false、窗口回到 1 个；`sidebar-anim.log`：collapsed 48→展开中 wrapper 315/inner opacity 0→477；收起 477→210→48；`rail-hover.log`：悬停 1.5s 侧栏 48→477，但 `session-list-panel`/`data-popover` 均不存在。浮层截图 `ws-popover-window.png`（无阴影）。typecheck 5/5；全量 vitest **176 文件 / 1476 tests 全绿**；gen/check/build 通过。
- **追加（m10183）**：杜绝有网页时侧栏动画缝隙漏初始页——`StartPage hidden` 在已加载网页 + 侧栏宽度动画期间隐藏 DOM；延迟对齐定时器改为 ref 持有不可被无关重渲染取消；动画结束强制兜底同步原生视图宽度。E2E `ntp-leak.log`：展开 110ms `StartPage visibility=hidden`→477 visible；收起 110ms hidden→48 visible；窗口截图 `ntp-leak2-window.png` 无残影。
- **追加（m10244）**：恢复「左右同拍」动画——侧栏 DOM 与原生网页视图同曲线逐帧同步；性能优化保留：动画帧只更新活动标签、`lastBounds/lastVisible` 缓存避免重复 setBounds/setVisible、动画期间隐藏 DOM 起始页防残影。E2E 110ms 中间态 `sidebarW=293`、合成截图 `sync-mid-window.png` 两侧同拍。
- **最终（m10584/m10603）**：侧栏宽度动画改由渲染层 `requestAnimationFrame` 驱动（每帧 `browser.setSidebarWidth({animate:false})`），按 320ms 时间插值；主进程保留活动标签/几何缓存；不再用截图快照（避免闪帧/拉伸）。实测 DOM 每 ~16ms 平滑推进（`raf-anim.log`），原生视图同步跟随。主进程计时器按时间插值 + 帧数兜底。
- **决策记录**：ADR-0092 追加修订 2、ADR-0093（含最终修订）。

## 四十七、2026-11-13 增量（工作区 > 会话 > 网页：关闭语义与持久化修复）

- **用户 m10643**：① 关闭最后一个网页后程序退出没错，但下次启动又恢复了这个网页，应该是空白新建页；② 明确层级：工作区 > 会话 > 网页，网页与会话高度绑定但非一对一——关网页不删会话，删会话可关网页，工作区是母/源，记忆后续按工作区延伸。
- **修复/实现**：
  - `closeTab` 只剩最后一个标签时：先真正 `browser.closeTab(tabId)`，等待 560ms（主进程标签状态 400ms 防抖落盘）再 `window.close()`；下次启动从空 tabs 恢复为空白新标签页。
  - 删除会话：先 `browser.closeSessionTabs({sessionId})` 关闭该会话名下全部网页，再 `chat.deleteSession`。
  - 新增契约 `browser:closeSessionTabs` + `BrowserHost.closeSessionTabs(sessionId)`（关闭 group 内全部标签并移除 group）；`App` 接线；关闭单个网页维持原逻辑（不删会话）。
  - 单测新增 2 条：关闭会话下全部网页、关最后一张网页后会话仍可新建网页。
- **验证**：E2E 关闭最后标签 → 程序退出、会话 `browser` 字段清空；同数据目录重启 → 仅一张空白「新标签页」、NTP 可见（`e2e-evidence/close-last.log`、`relaunch-blank.log`）。全量 vitest **176 文件 / 1478 tests 全绿**；typecheck 5/5；gen/check/build 通过。
- **文档**：ADR-0094。

## 第二阶段完成（2026-11-14）

主题：**Agent 与浏览器彻底打通（AI 自动浏览器）+ 框架夯实**。文档入口：`docs/规划/第二阶段-Agent与浏览器打通.md`；决策：ADR-0095~0100；调研：`docs/research/agent-browser-survey.md`；审计：`docs/FRAMEWORK-AUDIT-P2.md`。

- **功能① 会话级「浏览器控制」开关**：输入框「+」菜单（侧栏 Composer 与 Vibecoding 输入框同款）+ 开启后的品牌色 chip；会话级持久化（缺省关，fail-closed）；关闭时 `browser_*` 对模型**不可见**且不可执行（工具面与执行闸同一份名单，顺带修掉审计 P0-1 的「全量广播」）。
- **功能② 开网页前布局询问**：Agent 在会话里第一次打开网页前询问一次「收到右侧（常规布局）/ 变为小窗（独立 Agent 窗口）」，询问窗里解释两种安排；设置·通用新增「Agent 打开网页时的窗口布局」（每次询问/总是右侧/总是小窗/保持不动）；取消/超时 = 不导航（fail-closed）；选择记在本会话。
- **Agent ↔ 浏览器闭环**：语义快照（`[快照 #gen | URL | 标题]` + 元素语义行）→ 稳定引用 `#eN`（DOM 零打标、页面内稳定性句柄、导航即失效）→ 14 个工具（快照/导航/点击/输入/滚动/截图/等待/标签/前进后退刷新/按键/下拉/悬停）→ 动作后状态增量（URL/标题/就绪/是否导航）→ 点击命中验证（`BLOCKED_BY_OVERLAY` + 遮挡元素）→ 可行动失败码（STALE_REF / ELEMENT_NOT_FOUND + 候选 / TYPE_NOT_EFFECTIVE …）。
- **权限模型分层**：会话开关=是否授权 → 权限策略 `browser` 档=是否询问（默认 allow）→ 敏感步骤（登录/支付/不可撤销）逐次强制确认；沙箱仍按 network/L4。
- **偏好单源**：contracts 的 `PreferencesSchema`+`z.infer` 为唯一产地，core 只留默认值与合并，UI 直接消费推断类型（消灭三份定义静默漂移）。

**验收**：typecheck 5/5、vitest **187 文件 / 1605 tests 全绿**、`pnpm gen && pnpm check` 逐字节一致、`pnpm build` 5/5、**真机 E2E ok=true**（`node scripts/e2e-p2-run.mjs`，证据 `e2e-evidence/p2-agent-browser.log` / `p2-agent-browser-window.png` / `p2-composer-menu.png`）。

## 二·四十五、2026-11-14 第二阶段 E2 增量（Agent 浏览器可视化 + 布局选择移入首启向导）

用户两条反馈驱动（m00802 / m00860 / m00974）：① Agent 操作浏览器时「根本看不到它在做什么」，要求虚拟光标与呼吸灯可见反馈，并强调**只有进入对应会话才出现对应浏览器内容**；② 「把那个 agent 操作浏览器时的选择页换到新用户时的弹窗那，这个设定只在用户第一次打开 loopsoar 时出现，以后想改直接去设置里面改就行，不要每次 agent 操作时都弹这个选项。」

- **页内虚拟光标**：`browserAdapter/refs.ts` 新增 `buildCursorScript`——closed shadow root 挂 `host[data-loopsoar-agent]`，指针 + 目标高亮 + 点击涟漪全部逐条 CSSOM 内联（不依赖页面 CSS），`pointer-events:none` 不遮挡命中，涟漪用 WAAPI；`performClick`/`performType` 动作前注入，`CURSOR_LEAD_MS=170` 让人眼先看到「要动哪里」。
- **窗口外侧呼吸灯**：contracts 新增 `chrome:agentActivity`（`{sessionId, tool, phase}`）；壳层给 `BROWSER_AGENT_TOOLS` 每个 `execute` 包 start/end；UI 仅在 `sessionId === 当前会话` 时点亮 `.agent-browser-glow`（inset 2px 双 ring、1.5s 脉动、尊重动效设置），并在 start 时跟随宿主活动标签；**跨会话事件一律不动界面**（会话隔离）。
- **截图守卫**：`browser_screenshot` 前隐藏浮层、之后恢复，Agent 不会把自己光标拍进证据图。
- **布局询问下线，改首启向导选一次**：`browserOpenLayout` 枚举收敛为 `docked|agentWindow|keep`（老配置 `ask` → `docked` 迁移）；删除 `browserLayoutChoice.ts`、会话记忆 `browserLayoutChoice`（`SessionStore` 字段/净化/setter）与其两个测试文件；壳层钩子只按偏好应用并`appliedLayoutBySession`去重；`Onboarding` 3→4 步，新增「Agent 打开网页时，窗口怎么摆？」两张卡片（各解释两种安排），完成时落库（与当前值相同则不写）；设置·通用同步改三选一。
- **验证**：typecheck 5/5、vitest **185 文件 / 1585 tests 全绿**（净 −20）、`pnpm gen && pnpm check` 逐字节一致、`pnpm build` 5/5。
- **会话级浏览器隔离（m01148）**：核查确认壳层早已按会话分组（`BrowserHost.groups`，可见性只在当前会话的活动标签上），真正的缺陷在 UI——`App.switchSession` 把「上一个会话的活动标签」改判给新会话，随后 `activeTabId` 副作用查不到映射就重置成草稿（看起来像会话串了/对话消失）。修正：切换后只把**该会话自己的活动标签**记到它名下；草稿重置收紧为「映射缺失且标签是空白页」。单测新增「后台会话动作只落在自己的 WebContents」；真机 `E2E_EVAL {"idsA":["tab-2"],"tabsB_before":[],"idsB":["tab-3"],"sharedTabIds":0,"backIdsA":["tab-2"]}`（A/B 各自标签组、切回 A 原样恢复）；证据 `e2e-evidence/p2-session-isolation.png`、`p2-session-switch.png`。ADR-0104。
- **真机 E2E（布局）**：`E2E_EVAL {"asks":0,"layouts":["agentWindow"],"closed":true,"prefs":"agentWindow"}` —— 向导里选「独立小窗」已落库，Agent 打开网页**零询问**、布局只应用一次；向导第 2 步 `cardHeight=70/70`、`aria-pressed` 正确。证据 `e2e-evidence/p2-onboarding-layout.png`、`p2-onb-behavior.png`、`p2-agent-glow.png`；调研 `docs/research/agent-browser-visualization.md`；决策 ADR-0102 / ADR-0103。


