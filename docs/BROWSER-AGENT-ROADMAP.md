# 浏览器 Agent / Harness 剩余路线图

> 日期：2026-11-20（最后校准）；起点基线：`1f14816`（253 文件 / 1960 用例，历史值）；当前全量基线：**282 文件 / 2117 用例**，详见 §4。
> 目标：自研浏览器 Agent harness，功能面对标前沿 Agent 浏览器与 Codex / Claude / Hermes / DeepSeek 一类 harness；架构可扩展、运行稳固、loop 可自定义、兼容 skills / MCP，并具备插件生态。
> 本文只记录“还差什么”和验收口径；不把已完成的非分发收口重新列成待办。

---

## 1. 当前定位

**已经有的：**

- 20 个 `browser_*` 工具：导航、快照、点击、输入、按键、选择、拖拽、悬停、滚动、标签、前进/后退/刷新、弹窗关闭、截图、等待、下载、Cookie、诊断、上传。
- DOM 快照 + 稳定 ref（`#eN`）+ 标签级令牌；导航/切标签会失配为 `STALE_REF`。
- 真实鼠标/键盘事件（`sendInputEvent`），Agent 覆盖层光标/高亮/涟漪。
- Agent 标签与用户标签隔离；敏感点击二次确认；Agent 回环 SSRF 拦截。
- 截图可回灌视觉模型（模型声明支持图片时）。
- L2 声明式 / L3 脚本 loop；技能；MCP 工具；混合记忆；上下文压缩；只读子代理；worktree；权限审批。
- 强契约分层与 ADR-0147 两档棘轮（默认档 1400；组合根登记，只降不升）；当前 282 文件 / 2117 用例全绿。

**当前定位一句话：** 架构良好、单机单 Agent 的桌面工作台，不是“可被别人二次开发的浏览器 Agent 平台”。

---

## 2. 差距矩阵

| 维度 | 当前覆盖 | 主要缺口 |
| --- | --- | --- |
| 浏览器 Agent | ~85% | **20 个工具**；30 任务评测本地同进程 29/30（1 项下载环境跳过），GitHub Actions clean runner 已实跑 **30/30**；CI 10 核心门禁已实跑 **10/10**，每日 30 任务全量已接入 |
| Harness 对标 | ~94% | 后台终端任务、可写子代理、跨进程恢复、checkpoint、trace 落盘 + 可视化面板/成本估算、MCP resources/prompts/roots/sampling、技能 allowed-tools + 资源包导入均已就位；仍缺 headless/SDK（属架构拆分）与 MCP OAuth；`roots` 在 MCP 工具调用期间按 `ctx.sessionId` 回答，无上下文回退活动会话，连接仍按 server 共享（并发严格隔离未做） |
| 架构稳固性 | ~95% | 3 个组合根登记：`index.ts:1413`、`memoryService.ts:1449`、`App.tsx:1468`；其余默认档 ≤1400；故障注入（10）/并发（13）/迁移（17）测试已补；仍缺 `AppBody` 拆分与 headless/SDK |
| 插件生态 | ~97% | API v2、semver/依赖图、Ed25519 签名/信任、安装/更新/回滚/静态市场、富 UI/事件钩子、四档认证、目录签名/撤销列表/过期/灰度通道/发布 CLI 已落地；仍缺自动更新轮询、中心化审核与评分、企业 SSO/审计 |

**自评约 90%（百分比是主观估计，不是可计算指标）。** 浏览器可靠性与插件生态的六个缺口均已闭环；剩余主要是自动更新/中心化运营/企业能力与 headless/SDK。

---

## 3. 剩余工作流（全量）

### P0 — 浏览器 Agent 可对标（本轮优先）

1. **视觉-动作闭环**
   - `browser_click` 支持 `{ x, y }`（CSS 像素、当前视口坐标）。
   - 点击前用 `elementFromPoint` 读取真实元素文案/尺寸；敏感动作同样二次确认。
   - 真实 `sendInputEvent`；不可用时回退脚本点击，并明确标注降级。
   - 动作后返回 URL/标题/加载态/是否导航；不伪造“已生效”。

2. **快照可读性与完整性**
   - 快照头带 `snapshot` 代数与 `complete` 标记。
   - 大页面支持 `view: "skeleton"`（地标/标题/关键控件），降低上下文噪声。
   - 保留 `maxChars`、元素上限与省略提示；不把截断当完整。

3. **动作失败语义**
   - 统一错误码；`STALE_REF` / `TARGET_MOVED` / `CLICK_FAILED` / `INVALID_ARGS` 可行动。
   - 返回投递语义：已投递未验证（`delivered_unverified`）与可安全重试（`retry=safe`）分开。
   - 不自动重放有副作用的动作。

4. **浏览器评测**
   - [x] 30 个任务级用例：搜索、表单、弹窗、多标签、SPA、下载/上传、敏感确认（`scripts/browser-agent-tasks.json`，30 个；页面是本地真实浏览器夹具，不是公网站点）。
   - [x] 指标：成功率、步数、延迟、错误码分布（`scripts/browser-agent-eval.mjs` 产出 markdown 报告）。
   - [x] 进 CI 或发布前门禁：`.github/workflows/browser-agent-eval.yml`（10 个核心任务，xvfb + mock 模型，失败即红；已在 GitHub Actions clean runner 实跑 10/10）；全量 30 任务同日定时/手动，实跑 30/30。

5. **架构前置**
   - 拆分已完成（ADR-0147）：`browserTools.ts` 1495 → 55（`browserTools/` 五模块）、`browserHost.ts` 1498 → 1132（`browserViewLayout.ts`）、`index.ts` 1500 → 1414（`taskForks.ts`）、`refs.ts` 1496 → 1400（`userLock.ts`）；其余源码默认档 ≤1400。
   - 新能力优先落到独立模块；组合根登记后只降不升，加一行必须先移出一行。

### P1 — Harness 对标

6. **完整子代理**
   - [x] 可写子代理 `delegate_work`：读写文件、终端、浏览器、联网；权限确认转发到父会话；禁止递归委派/回滚父检查点/改自身配置。
   - [x] 只读子代理 + 并行 + 树形（`delegate_research` / `delegate_parallel` / `delegate_tree`）。
   - [x] 子代理恢复：`subagent_resume` 从落盘任务记录读历史，按原 kind 选可写/只读模式，`parentTaskId` 串起任务树；应用重启（新 store 实例）已由单测覆盖。
7. **Plan/Act + checkpoint**
   - [x] Plan 模式（只读工具过滤 + 计划工具）。
   - [x] 会话级回滚：`checkpoint_list` / `checkpoint_restore`，按回合快照 `file_write` 的旧内容；工作区边界复核。
   - [x] 后台任务：`terminal_background` / `terminal_output` / `terminal_kill` / `terminal_tasks`，继承前台安全判定（危险命令 fail-closed、cwd 限会话工作根、输出环形缓冲、退出时杀进程树）。
   - [ ] headless/SDK：需要把 Electron 依赖从 services 剥离，属于架构总收口，按计划留到最后。
8. **MCP 全能力**：
   - [x] resources / prompts：`mcp_resources` / `mcp_read_resource` / `mcp_prompts` / `mcp_get_prompt`（能力未声明时给可行动错误）。
   - [x] roots：initialize 声明；MCP 工具调用期间按 `ctx.sessionId` 回答工作区，无调用上下文回退活动会话。MCP 连接仍按 server 共享，并发调用无法做到严格 per-session 隔离。
   - [x] sampling：注入 LLM 时才声明能力，服务端反向请求走当前供应商模型；未注入时明确 -32601。
   - [x] 重连：指数退避 + 工具集刷新（既有实现，回归通过）。
   - [ ] OAuth：仅支持静态 `headers`（Bearer）；完整 OAuth 2.1（资源元数据、动态注册、PKCE 回环）未做，需要真实授权服务器才能验证。
9. **技能兼容**：渐进披露、`allowed-tools`、脚本/资源包、导入 Claude/Hermes 风格技能。
   - [x] 渐进披露：未命中只给清单，命中注入正文（截断 12k），`skill_list` / `skill_read` 支持按需读取。
   - [x] `allowed-tools`：兼容 `allowed-tools: [a, b]` 与逗号串两种写法；命中技能时按声明收窄本轮工具面（多技能取并集，交集为空则保留原名单）。
   - [x] `allowedTools` 在 `skill_read` 中展示，便于审阅。
   - [x] 资源包安装器 / 一键导入外部技能目录：设置 → 技能 → 「从文件夹导入」（目录选择 + `skills:import`）；复制 SKILL.md 与 scripts/references/assets，先临时目录再 rename，不跟随符号链接，300 文件 / 12MB / 12 层上限；同名需确认覆盖；模型侧另提供 `skill_import` 工具。
10. **可观测性**：trace、usage/成本、模型路由、失败诊断面板。
    - [x] 工具轨迹落盘（`traceStore.ts`）+ 回读工具 `trace_summary` / `trace_read`（参数脱敏、不存完整输出、2MB 轮转）。
    - [x] 可视化 trace 面板 + 成本估算：`settings:traces` 只读通道 + `TraceSection`（回合/工具/失败/tokens/成本、Top 工具表、最近事件）；`pricing.ts` 内置参考价，仅在 input/output 拆分齐全时估算，明确标注「参考价、非账单」。

### P2 — 插件生态（已完成）

11. **版本化插件 API**：
    - [x] `apiVersion`（宿主 2.0 / 旧版 1.0 兼容）+ worker `protocol` 协商；声明 events 但 worker 只支持 v1 → 启动失败，不静默降级。
    - [x] 零依赖 SemVer 2.0：caret/tilde/通配/比较符/连字符/`||`/预发布语义 + 非法范围 fail-closed。
    - [x] `dependencies` 拓扑排序/环检测/缺失/版本校验；启用自动拉依赖闭包，禁用级联禁用依赖者。
12. **信任与隔离**：
    - [x] Ed25519 清单签名 + 全量包摘要（路径+长度+内容）；信任库持久化、指纹由公钥重算、拒绝伪造。
    - [x] `warn`（默认）/`strict` 策略；strict 下未信任签名连启用都不允许；无效签名任何策略都 blocked。
    - [x] 权限仍取 manifest ∩ 工具声明；事件钩子只能「否决」不能放行，安全边界不外包给扩展。
13. **市场与生命周期**：
    - [x] 目录/ZIP 安装 → `.staging` 校验 → `.backups` → 原子替换，失败还原；同版本需 force，降级默认拒绝。
    - [x] 回滚到上一备份（重跑签名/摘要/兼容校验）；市场静态 registry + sha256 + 64MB 上限 + 每跳重定向的协议/元数据地址校验（不是完整私网 SSRF 沙箱）。
    - [x] 富 UI `views`（`loopsoar-ext://` + 沙箱 iframe + 严格 CSP）、`turn.start/turn.end/tool.before/tool.after` 生命周期事件、按 viewId 路由的视图消息。
    - [x] 兼容性认证四档（certified/compatible/unverified/blocked）在设置页可视化。
    - [x] 市场目录 Ed25519 签名（可配置公钥强制 trusted）、`expiresAt` 过期拒绝、stable/beta 通道、撤销列表持久化并强制 blocked/停 worker；密钥可撤销且保留审计记录。
    - [x] 零服务器发布链：`pnpm market:keygen/build/sign/verify` 从 zip 目录生成 `sha256`/`size`/`latest` 并签名目录，`market:verify` 可进 CI。
    - [x] 真机富 UI 验收：`pnpm e2e:extension` 打开沙箱 iframe、收到 ready/resize、worker 回包 ok；截图 `e2e-evidence/p2-extension-panel.png`。
    - [x] 验证：`tests/core/{semver,extensionCompat,extensionGraph,extensionSignature,registrySignature}.spec.ts`、
      `tests/shell/{extensionTrust,zip,extensionInstaller,extensionProtocol,extensionMarket,extensionExample}.spec.ts`；全量 **282 文件 / 2117 用例**通过。

---

## 4. 浏览器 Agent 本轮 DoD

- [x] `browser_click` 支持坐标点击；坐标点击与 ref/CSS/text 点击共用同一套敏感确认和错误码。
- [x] 坐标点击有元素探测；空白/越界返回可行动错误，不静默成功。
- [x] 真实鼠标不可用时回退脚本点击并显式提示。
- [x] `browser_snapshot` 输出 `complete` 与 `view`；大页面支持 `skeleton`。
- [x] 点击结果包含 URL/标题/加载态/是否导航，并标注 `delivered_unverified`；不把“已点击”说成“已生效”。
- [x] 新增单测覆盖：坐标点击、敏感坐标点击、越界/参数冲突、降级、skeleton、complete。
- [x] 状态面补齐：`browser_downloads`（list/wait）、`browser_cookies`（只返回元数据）、`browser_diagnostics`（console/network）、`browser_upload`（CSS file input + 会话根目录校验）。
- [x] `pnpm -r typecheck`（5/5）、`npx vitest run`（**282 文件 / 2117 用例**）、`pnpm check`、`pnpm build`（5/5）全绿。

**本轮之后仍未做的浏览器维度：**

- [x] `--root` 子树下钻：快照返回 `parentIndex`，`browser_snapshot` 的 `root` 解析到同代 ref 的子树（2026-11-20）。
- [x] 30 任务评测接 CI 全量：脚本可跑真实 Electron 并产出报告（`node scripts/browser-agent-eval.mjs --all`）；CI 已分 10 核心（PR/push，实跑 10/10）与 30 全量（每日/手动，clean runner 实跑 30/30），同进程运行。

---

## 5. 对 `vercel-labs/agent-desktop` 的借鉴

仓库：<https://github.com/vercel-labs/agent-desktop>（Apache-2.0，Computer use CLI / C library）。

**值得借鉴的：**

1. **显式坐标点击**：`mouse-click --xy` 与 ref 点击并存；坐标点击会说明“不证明哪个应用收到输入”。
2. **快照完整性**：`complete` / `truncated` / `nodes_observed`，超预算返回部分树而不是空错误。
3. **快照作用域 ref**：ref 属于某次快照；过期返回 `STALE_REF`，多候选返回 `AMBIGUOUS_TARGET`；不静默落到相似元素。
4. **动作投递语义**：`delivery=delivered_verified | delivered_unverified | not_delivered`，`retry=safe | unsafe`；有副作用失败不盲目重试。
5. **动作后观察**：等待原始窗口/进程的 selector 状态，而不是只看全局页面；观察结果单独报告。
6. **密集页面策略**：`snapshot --skeleton` 先看地图，再 `--root` 下钻。
7. **工具即 CLI / MCP**：同一套命令暴露为 CLI 与 MCP；错误码、退出码、JSON envelope 一致。
8. **版本化技能**：二进制自带 `skills get desktop/platform`，技能与版本同源。
9. **会话/trace/cursor overlay**：动作可追踪，光标可解释。

**本地化取舍：**

- 不引入 Rust / 原生依赖；只借语义与交互模式。
- 不复制 61 个桌面命令；只补浏览器 Agent 缺的坐标动作、完整性、投递语义。
- 不直接引入其 C ABI / 沙箱；Loopsoar 已有自己的 ToolRegistry 与权限层。
- 先做坐标点击 + 快照完整性 + 投递语义；上传/下载/Cookie 等另立切片。

---

## 6. 建议顺序

1. 提交四维工作树并统一文档基线（本地提交，不混入证据截图）。
2. 已修掉审计发现的质量缺口：`taskForks` fake 复用真实语义、P2 E2E 的 `forkMatch` 与扩展 E2E 的 `ready+resize` 都变成硬断言、MCP roots 已传入工具调用会话；市场 SSRF 仍按「协议/元数据地址校验」的收窄表述，不宣称完整私网沙箱。
3. 把 30 任务全量评测接入 CI（已完成：clean runner 全量 30/30，push 核心 10/10），再处理 headless/SDK 与 MCP OAuth。
4. 最后才进入服务端运营项（自动更新、中心化审核、企业能力）；没有浏览器杀手能力之前不做市场扩张。
