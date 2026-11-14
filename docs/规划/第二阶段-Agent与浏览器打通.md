# 第二阶段规划：Agent 与浏览器打通（AI 自动浏览器）

> 定稿：2026-11-13。输入：用户第二阶段指令；《框架审计 P2》（`docs/FRAMEWORK-AUDIT-P2.md`）；《Agent 浏览器操作：理论与方法综述》（`docs/research/agent-browser-survey.md`，已完成：342 行 / 30 条来源；**第 8 节 14 条设计原则是切片 C/D/G 的规格基准**，第 7 节基准数字供 ADR 引用）。
> 总原则：**安全、稳定 > 自由度**；核心架构清晰，宁缺毋滥；底层编码尽量委派给官方 deepseek-v4.1-flash（推理档 max），Lead 负责设计、审查与验收。

## 一、目标（用户指令拆解）

1. **会话级「浏览器控制」开关**：vibecoding 输入框「+」菜单里的点击开关（对标 slime 的「联网搜索」位）。开启 = 用户可直接用自然语言指挥 Agent 操控内嵌浏览器；关闭（默认）= 浏览器工具对模型**不可见**（不只是执行拦截）。
2. **Agent 开网页前布局询问**：浏览器控制开启的会话里，Agent 第一次要打开网页前问用户一次——「会话收到右侧（常规布局）」还是「变为小窗（独立 Agent 窗口，ADR-0020）」。默认策略放 **设置→通用**；询问窗内把两种安排解释清楚。
3. **浏览器工具集升级（use browser 通道）**：稳定元素引用（快照→动作闭环）、多标签暴露、动作扩展（按键/下拉/悬停/前后退）、动作后反馈摘要；把 Agent 与浏览器的隔阂彻底打通。

## 二、开工前夯实（审计结论落地）

- 基线：typecheck 5/5 ✅（tsc 直跑等价验证）；gen/check 逐字节一致 ✅；全量 vitest 由 Lead 复跑钉死（记录见文末）。
- **P0-1 工具面全量广播**（模型看得见全部工具，allowlist 只拦执行）→ Slice A 修复：resolvedAllowlist 传进 `registry.toolSchemas()`，这是会话级开关的前置。
- **P0-2 元素引用契约断裂**（快照广告 [#id] 但 click 不认、每次快照重排编号）→ Slice C 修复：快照令牌 + 稳定 ref，与工具升级合并。
- **P1 偏好三份定义**（contracts / core / ui types）→ Slice B 先统一为 contracts z.infer 单源，之后新增设置字段只改一处。
- **P1 sidebarMode float 死值** → 本阶段明确语义：**float = 独立 Agent 窗口（ADR-0020）**；布局询问的「小窗」走既有 openAgentWindow 路径，不复活「侧栏浮动卡片」形态。
- **P1 浏览器动作两套实现**（适配器动作生产不可达 + browserTools 内联重写）→ Slice D 收口为单一实现路径。
- **P1 FRAMEWORK-REVIEW.md 全篇过时** → Slice F 重写为现状版。
- **明确缓办（不静默丢弃，另立小提交跟进）**：>800 行 14 个文件的拆分、壳层 320ms 死动画路径、`.tmp` 入 .gitignore、Markdown.tsx 直用 window.loopsoarAPI。

## 三、切片计划（顺序执行，逐片验收；C/D 待调研落稿后启动）

| 切片 | 内容 | 主要触点（审计给出的接入点） | 验收 |
|---|---|---|---|
| A | P0-1 工具面过滤 + 功能1 会话级浏览器控制开关 | contracts/src/schemas.ts（`chat:setBrowserControl` 通道 + `BROWSER_AGENT_TOOLS` 常量单源）、services/src/chat.ts（:486 toolSchemas 传参、:84 getToolAllowlist 加 sessionId）、shell main/index.ts:1667 装配 + sessionStore（`PersistedSession.browserControl`）、ui Composer.tsx「+」菜单 + StartPage.tsx VibeControls「+」+ App.tsx + i18n | mock LLM 捕获 tools 随开关增减；跨重启保持；新会话默认关 |
| B | P1 偏好单源统一 + 功能2 的设置位 | contracts/schemas.ts:345（导出 z.infer）、core/preferences.ts、ui/types.d.ts:48 改为消费契约类型；Settings.tsx:577 general 分区新增「Agent 打开网页时的布局」选项（每次询问[默认]/总是右侧/总是小窗/保持不动）；i18nSettings.ts | 同一字段三处同源；读写 + 旧配置迁移单测 |
| C | P0-2 稳定元素引用 + 快照升级 | browserAdapter/webContentsView.ts（标记脚本重做：ref 注册表 + 清理 + selectorFor 接线 :83）、browserTools.ts snapshot/click/type、browserAdapter/types.ts（`BrowserSnapshot.elements` 正式化，去双重 as） | ref 跨 DOM 变化稳定；导航后旧 ref 拒绝；单测 |
| D | 动作扩展 + 多标签 + 反馈回路 + 动作实现收口 | browserTools.ts 新增 `browser_tabs_list/new/select/close`、`browser_back/forward/reload`（BrowserHost :491-720 既有方法直接接线）、`browser_press_key/select/hover`；动作后返回 URL/标题/加载态摘要；适配器死动作收口 | 新工具单测；快照→动作→反馈闭环用例 |
| G | 浏览器交互权限档（调研补充：network 每次确认会让 AI 浏览器不可用） | core/permissions.ts + tools/registry.ts（ToolPermissions 增 `browser` 类）、services 决策接线、设置·权限分区新行（默认=跟随会话开关）、敏感步骤（登录/支付）强制确认不变 | 开关开启时交互类动作不再逐次弹窗；commit 级仍确认；单测 |
| E | 功能2 布局询问 | browserTools.ts `browser_navigate` 前置钩子（浏览器控制开启 + 该会话未问过 + 目标为打开新页）：AskBus 问一次 → 按 prefs 策略（ask/always-docked/always-float/keep）→ docked=写偏好侧栏常规、小窗=触发既有 openAgentWindow、取消=fail-closed 不导航；i18n 双语 + 解释文案 | 每会话只问一次；策略生效；取消不导航 |
| F | 文档收口 | ADR-0095~0099 按片追加、PROGRESS.md 更新、FRAMEWORK-REVIEW.md 重写 | 全绿 + 证据齐 |

**顺序依赖**：B 必须先于 E（E 读新偏好字段）；C 先于 D（D 的新动作消费 C 的 ref）；A 先于 C/D/E（开关决定工具面）。

## 四、安全与稳定红线（全程不变）

- fail-closed：开关默认关；布局询问超时/取消 = 不导航；敏感步骤（登录/支付/不可逆）继续强制人工确认；URL 继续走 normalizeNavigateUrl + browserRequestGuard。
- 单源纪律：新契约一律 contracts → `pnpm gen`；实现者不得手改 `gen/`、`dist/`。
- 观测面收敛：工具输出限幅（clip 沿用）、元素枚举上限、ref 表随导航失效。
- 不改内核四件（壳/引擎/护栏/宿主）语义；实现者验证 = 逐包 tsc 直跑 + 定向单测；**全量 vitest / build / gen-check 由 Lead 统一跑**（子代理沙箱无法 spawn pnpm）。
- 「浏览器控制」开关只门控 `browser_*` 工具；`web_fetch` 属网络权限域，不随开关（独立确认流），避免语义混淆。

## 五、验证与提交

- 每片验收：`pnpm -r typecheck` + 相关 spec 绿；阶段末 Lead 跑全量 `npx vitest run`、`pnpm gen && pnpm check`、`pnpm build`、真机 E2E（LOOPSOAR_E2E_* hooks，证据进 `e2e-evidence/`）。
- 提交：仓库根 = `Parent file`（外层 Loopsoar/.git 是空壳不动）；沿用现有提交信息风格；完成后 push origin master（网络不通则保留本地提交并告知用户）。

## 六、基线记录（Lead 复跑，2026-11-13 22:47）

- typecheck **5/5 绿**（Lead 直跑：`node node_modules/typescript/bin/tsc -p packages/<p>/tsconfig.json --noEmit`，contracts/core/services/shell/ui 全部 exit 0）。
- 契约一致性：审计以 tsc 编译 + check.js 等价验证 **gen/ 逐字节一致**（仓库 gen/ 未被触碰）。
- 全量 vitest：**176 文件 / 1478 tests 全绿（2026-11-13 23:00，22.4s，Lead 直跑）**。过程备注：最初会话沙箱拦截嵌套进程派生（spawn EPERM -4048，pnpm/vitest 均无法启动），随后会话文件策略放宽为不限制，Lead 直接复跑通过；审计的静态盘点（176 spec / 调用点与 1478 吻合）与该结果一致。后续每片验收由 Lead 直接复跑全量。
- 验证纪律同步：实现者（子代理）同样无法 spawn pnpm/vitest，只能直跑 tsc；所有 vitest 执行、pnpm gen 回填、build、真机 E2E 统一由 Lead 提权执行。

## 七、执行进度（滚动更新）

- **Slice A ✅**（2026-11-13 23:21 验收）：工具面过滤修 P0-1 + 会话级「浏览器控制」开关（Composer/VibeControls「+」菜单、持久化、草稿态先落库再发首条）；ADR-0095。vitest 180 文件 / 1500 tests、tsc 5/5、gen 逐字节一致、build 全绿。
- **Slice B ✅**（2026-11-13 23:47 验收）：偏好单源统一（contracts z.infer，消灭三份定义静默漂移）+ 设置·通用「Agent 打开网页时的窗口布局」(browserOpenLayout)；ADR-0096。vitest 180 文件 / 1503 tests、tsc 5/5、gen 逐字节一致、build 5/5。
- **下一步（暂缓，等待用户恢复）**：Slice C（P0-2 稳定元素引用 + 语义快照）→ D（动作扩展/多标签/动作后反馈）→ G（browser.interact 权限档）→ E（开网页布局询问）→ F（文档收口 + 真机 E2E）→ 提交推送。
- **当前工作树**：17 改 + 7 新增未提交（+485/−98）；外层 Loopsoar/.git 空壳未动；GitHub 直连 443 超时，提交保留本地、待网络恢复再 push。
- **恢复方式**：用户说「继续 / resume」后，Lead 恢复目标（goal resume）并自 Slice C 起继续。

## 八、第二阶段完成记录（2026-11-14）

**全部切片完成并验收**（每片均由 Lead 独立复跑全量测试 + 人工审 diff）：

| 切片 | 内容 | 验收 |
|---|---|---|
| A | 会话级「浏览器控制」开关（Composer/VibeControls「+」菜单）+ 工具面单次解析（修 P0-1） | vitest 180/1500、tsc 5/5、gen 一致、build 5/5 |
| B | 偏好单源统一（contracts z.infer）+ 设置·通用「Agent 打开网页时的窗口布局」 | vitest 180/1503 |
| C | 稳定元素引用 + 语义快照（DOM 零打标、页面内句柄、导航即失效、原生 setter、可行动失败码） | vitest 181/1524 |
| D | 多标签工具 + 按键/下拉/悬停 + 动作后状态增量 + 点击命中验证 + 标签级 ref | vitest 182/1562 |
| G | 浏览器操作权限档 `browser`（策略默认 allow；敏感步骤仍逐次确认；沙箱仍 network/L4） | vitest 183/1573 |
| E | 开网页前布局询问（纯函数决策 + 会话记忆 + fail-closed）+ 权限 chip 纳入 browser 档 | vitest 187/1605 |
| F | ADR-0095~0100、FRAMEWORK-REVIEW 重写、真机 E2E 脚本与证据 | **E2E ok=true**（见下） |

**真机端到端证据**（`e2e-evidence/p2-agent-browser.log` + `p2-agent-browser-window.png`）：
- `E2E_EVAL {"ok":true,"evidence":{"askDialogShown":true,"askDialogClosed":true,"navigated":true,"snapshotWithRefs":true,"clickedMarker":true}}`
- `E2E_SESSION_VERIFY {"browserControl":true,"browserLayoutChoice":"docked","navigated":true,"snapshotWithRefs":true,"clickedMarker":true}`
- 链路：mock LLM 驱动 Agent → `browser_navigate` → 布局询问在界面真实弹出并被点击回答 → `browser_snapshot` 拿到 `[#e1]/[#e2]` → `browser_click text=点我` → 页面真实显示「按钮已点击」→ 再快照确认。
- 复跑命令：`node scripts/e2e-p2-run.mjs`（自带本地页服务 + mock LLM + 独立数据目录）。

**基线（阶段末）**：typecheck 5/5、vitest **187 文件 / 1605 tests**、`pnpm gen && pnpm check` 逐字节一致、`pnpm build` 5/5。

