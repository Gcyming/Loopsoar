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
- 内置工具：`file_read`
- 浏览器工具：`browser_snapshot`（URL/标题/正文/可交互元素编号）、`browser_navigate`、
  `browser_click`（编号/CSS/`text=`）、`browser_type`、`browser_scroll`、`web_fetch`
- MCP：stdio + Streamable HTTP（`/mcp` JSON-RPC，兼容 SSE 响应、`mcp-session-id`），
  生命周期（5s 握手、帧翻转重试、能力门控、工具刷新、超时/错误分类、重连退避）
- 技能：SKILL.md 容错解析 + CJK 2-gram 打分 + Top-3 注入（隔离，不注册工具）
- 扩展：清单扫描/本地示例（**运行时加载尚未实现**）

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

## 三、未完成 / 已知问题（下次继续）

### 高优先
1. **本轮新增 UI 待验收**：ToolCard、Markdown 表格、中断横幅已实现且测试/构建通过，
   但最后一次 E2E 截图停留在历史消息，未能拍到表格/卡片最终效果 —— 需要重跑：
   - 关闭"恢复上次会话"或用干净数据目录
   - `pnpm dev` 后发一条会触发工具的请求（或 mock `MOCK_TOOL_NAME=browser_snapshot`）
2. **会话渲染继续对齐 slime**：终端输出卡（等宽终端样式）、网址卡细节、
   展开/收起、渐入渐出、时间线完整度（slime `ChatPanel.tsx` 的 TimelineNode/PlanCard/LiveStatusLine 逐块对照）
3. **扩展运行时**（用户点名"最重要"）：子进程 worker + 工具桥接 + 超时/崩溃隔离；
   先写 ADR（放在 `docs/decisions/`），再落代码，禁止动 contracts/core/shell 分层
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

## 五、本次存档对应改动
- 请求上限可配置（contracts/core Preferences + ChatService getAgentLimits + 设置·通用）
- 工具卡片 ToolCard（参数摘要/状态/展开输出/URL 链接卡）
- 中断原因横幅（done.status/reason → 气泡内展示）
- Markdown 表格渲染（GFM 表格）
- 打开技能/扩展目录前自动创建目录 + 失败日志
- mock 上游支持 MOCK_TOOL_NAME / MOCK_TOOL_ARGS / MOCK_REQ 日志；E2E 可配 chatDelay / NAV_WAIT_MS / HOLD_MS
- 新增截图：`docs/screenshots/gui-44-browser-tool.png`（AI 浏览器工具闭环）、
  `gui-45-tables.png`（待重新验收）
