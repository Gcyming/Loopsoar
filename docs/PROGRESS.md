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

## 三、未完成 / 已知问题（下次继续）

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
- 只有 `main/index.ts` / `main/electronBrowser.ts` 可 import electron
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
