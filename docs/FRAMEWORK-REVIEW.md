# 框架灵活性审查（面向「扩展 / 插件化 / skill / MCP / 浏览器智能体」）

> **归档提示（2026-11-19）**：本文是 2026-11-14 的能力盘点，保留作历史脉络；任务编号、行数与“缺口”结论可能已过时。
> 当前状态以 [FRAMEWORK-AUDIT-P2.md](./FRAMEWORK-AUDIT-P2.md) 为准：P0/P1/P2 全部闭环，全源码 <=1500 行。

> 最近重写：2026-11-14（第二阶段 Slice F）。上一版停留在 2026-10 月的骨架期，结论已全部过时——本文按**当前代码**重写，作为「框架还缺什么」的唯一口径。
> 相关文档：`docs/decisions/ADR.md`（活文档）、`docs/FRAMEWORK-AUDIT-P2.md`（第二阶段开工前审计）、`docs/research/agent-browser-survey.md`（Agent 浏览器操作调研）、`docs/规划/第二阶段-Agent与浏览器打通.md`（第二阶段切片计划）。

## 一、现状盘点（v0.2 骨架 + 第二阶段）

| 能力 | 当前实现 | 结论 |
|---|---|---|
| 契约单源 | `packages/contracts`：zod schema + `pnpm gen` 生成 `gen/ipc.ts`（通道绑定表）、`gen/ipc-manifest.json`、`gen/security-policy.json`；`pnpm check` 逐字节校验 | ✅ 成体系；新增 IPC 必须走 contracts → gen，有契约同步守卫 |
| 受信 IPC | `handleTrusted` 四要素（sender 校验/域绑定/schema 校验/超时），preload 白名单由 CHANNEL_BINDINGS 生成，不暴露 ipcRenderer | ✅ 129+ 通道全部受控 |
| 分层 | contracts → core（纯逻辑，禁 electron）→ services（chat/tool loop，无 electron）→ shell（main 域，electron 仅 index.ts/electronBrowser.ts）→ ui（React，只用 window.loopsoarAPI） | ✅ 有守卫测试（layering / zero-electron / channels） |
| 偏好/权限 | **契约单源**（第二阶段 Slice B 统一）：`PreferencesSchema` + `z.infer` 类型，core 只留默认值与合并行为，UI 直接消费推断类型 | ✅ 三份定义静默漂移的坑已消灭 |
| 工具注册表 | `core/tools/registry`：ToolDefinition（zod schema → JSON Schema）+ 四+一类权限声明 + 会话级工具面过滤（`resolveToolSurface`） | ✅ 新工具零改壳层；可见面=执行闸同源 |
| 权限模型 | 三层：① 会话开关（是否授权，如「浏览器控制」）② 策略档（allow/confirm/deny，含 `browser` 独立档）③ 敏感步骤写死确认（登录/支付/不可撤销）；沙箱 L0–L5 分级独立 | ✅ 安全与可用性分层，不再「每步弹窗」 |
| Agent / 子代理 | `core/agent` AgentRegistry + BUILTIN_AGENT，工具白名单按 Agent 解析 | ✅ 加 Agent = 加配置 |
| Agent-Loop | 可插拔 loop（L1 参数化 / L2 声明式 / L3 脚本），安全模式回退内置 loop | ✅ ADR-0010 已落地 |
| 技能 | `core/skill`：SKILL.md 容错解析 + CJK 2-gram 打分 + Top-3 注入；**只注入提示词，不执行技能内代码** | ✅ 已实现（旧审查误记为「待补」） |
| MCP | `shell/src/main/mcpHost`：stdio + Streamable HTTP，握手超时/帧翻转/能力门控/工具刷新/重连退避/进程树清理 | ✅ 已实现（旧审查误记为「无」） |
| 扩展 | 每扩展独立子进程 worker，工具以 `ext__<id>__<tool>` 注册，权限声明映射进同一沙箱 | ✅ ADR-0008 |
| 浏览器平台 | 多标签（会话级 tab group）、历史、书签、下载、favicon、DevTools 面板、Chrome/Edge 扩展安装、请求守卫 | ✅ 第一阶段收口（ADR-0086~0094） |
| **Agent ↔ 浏览器** | 快照语义树 + 稳定元素引用（DOM 零打标、导航即失效）+ 14 个浏览器工具（快照/导航/点击/输入/滚动/截图/等待/标签/前进后退刷新/按键/下拉/悬停）+ 动作后状态增量 + 点击命中验证 + 可行动失败码 | ✅ 第二阶段核心（ADR-0095~0099） |
| 记忆 | flat hybrid（ADR-0007），按会话/全局注入 | 🟡 工作区级记忆待做（第三阶段） |

## 二、不可破的约束（新增能力仍须遵守）

1. **一切新能力 = contracts 通道 → gen → core 纯逻辑 → shell 域 → UI**；不得在 UI 里直连 IPC 或 fs。
2. **插件/扩展只能拿到注册表**（工具/命令/资源），不得直接碰 electron / fs；权限沿用同一套类别声明与沙箱。
3. **skill / MCP / 扩展都是「能力来源」**，统一映射进 ToolRegistry，不新增第二套调用链。
4. **安全三道闸不许合并**：会话授权（开关）、策略档（权限）、敏感步骤（逐次确认）。任何「为了流畅而绕过敏感确认」的改动都属于回归。
5. **可见面 = 执行闸**：任何工具过滤都必须同时作用于 `registry.toolSchemas()` 与执行器（P0-1 的教训）。

## 三、已知技术债（按优先级，均已在审计/计划中登记）

| 级别 | 项 | 现状 | 建议 |
|---|---|---|---|
| P1 | 超大文件 | App.tsx ~2.5k、main/index.ts ~2.2k、Settings.tsx ~2.1k、StartPage.tsx ~1.6k、schemas.ts ~1.3k | 按域拆（会话流/设置分区/浏览器工具装配）；禁止继续往里堆 |
| P1 | 壳层侧栏动画死路径 | `BrowserHost.setSidebarWidth(animate:true)` 逐帧插值仅测试使用，UI 全传 false（rAF 驱动） | 评估删除或标注「仅测试/兼容」 |
| P2 | `.tmp/` 未入 .gitignore | 只在 `.git/info/exclude` | 补进 .gitignore（夹具目录已隔离） |
| P2 | Markdown.tsx 直用 window.loopsoarAPI | 单点 | 收敛到 useLoopsoarApi() |
| P2 | 守卫缺口 | 裸 ipcMain.handle 无扫描；contracts-sync 备份/恢复非原子；ui-contract methodMap 手写 | 补扫描守卫；生成 methodMap |
| P2 | DevTools 前端英文 | Electron 内置 | 已知边界，暂不处理 |

## 四、下一阶段（第三阶段）建议入口

1. **工作区级记忆**（ADR-0094 遗留）：召回/写入按 workspace 隔离，会话删除时的记忆保留策略。
2. **浏览器 Agent 的观测面扩展**：`browser_find`（局部检索，省 token）、console/network 观察、`wait_for` 条件化（visible/clickable/url/networkidle）——调研 §8-3/§8-8 已给设计。
3. **L3 逃生舱**（evaluate/CDP）：默认不注册，独立权限 + 每次确认；先做审计与回放。
4. **trace / 回放**：每步动作（工具、参数摘要、前后 URL、截图引用、耗时、错误）落盘，支持人工接管（调研 §8-14）。
5. **大文件拆分与守卫补强**（上表 P1/P2）。

## 五、结论

框架骨架**足够灵活**，第二阶段又补上了「工具面同源」「偏好单源」「权限分层」「浏览器闭环」四块地基：现在新增一部能力（新工具、新供应商、新扩展、新循环）都只需要在既有层里加一个文件 + 一条契约，不需要动内核。真正需要警惕的不是「框架不够灵活」，而是**实现者绕过分层与三道安全闸**——守卫测试与本文的约束清单就是防线。
