# Loopsoar 核心架构与外围功能审计

- 日期：2026-11-17
- 范围：`packages/contracts`、`packages/core`、`packages/services`、`packages/shell`、`packages/ui`
- 方式：只读代码走查 + 类型检查 + 构建 + 全量单测 + 真实 Electron E2E
- 基线：typecheck 5/5；build 5/5；Vitest **222 文件 / 1,782 用例全部通过**；`gen/check` 逐字节一致；E2E 功能断言 `ok:true`
- 本轮结论：**核心骨架健康，但按 IDEA.md 的产品要求，整体约 6.5/10，尚未达标。**
- 本文既是审计记录，也是后续修补的执行清单。P0 修完后在文末“修补进度”更新。

---

## 0. 结论先说

问题不在“能不能跑”。项目能构建、能测试、浏览器闭环能工作，分层也基本正确。

不达标集中在四件事：

1. **插件生态只有 tools**：没有 commands / UI 贡献 / hooks / 生命周期，离“高兼容性插件生态”很远。
2. **浏览器引擎锁在 Electron shell**：`WebContentsView` 与主进程强绑定，无法无头运行，也无法替换成 Playwright/CDP 后端。
3. **安全语义有实际漏洞**：会话授权跨会话泄漏、loop 回退会重放工具副作用、扩展权限未真正执行。
4. **工具面与多模态仍有边界**：图片输入/视觉、Office/PDF 文本、Web 搜索已补；旧版二进制 Office、扫描件 OCR、版面/图表与多 Agent/子 Agent 仍是缺口。

最明显的“投资方向偏斜”：最近 12 个提交里 11 个集中在 rules/memory，第三阶段安全切片 A 没有动。规则系统做得越来越细，但上面四个产品缺口没有同步推进。

---

## 1. 代码地图与体量

只统计 `packages/*/src` 下的 `.ts/.tsx`（不含测试与 dist）：

| 包 | 行数 | 职责 | 判断 |
|---|---:|---|---|
| `contracts` | 2,100 | 共享类型、IPC 契约、生成物 | 健康；type-only 设计正确 |
| `core` | 10,570 | 平台无关内核：LLM、工具循环、沙箱、规则、loop、MCP、记忆 | 基本健康；工具循环与规则是核心资产 |
| `services` | 868 | 会话/轮次编排，注入平台端口 | 健康；薄而清晰 |
| `shell` | 26,118 | Electron 主进程：窗口、浏览器、文件、终端、扩展、IPC | 功能全，但过重；`index.ts` 2,906 行 |
| `ui` | 24,358 | React 界面 | 功能全，但巨型组件明显 |
| 合计 | **64,014** | | |

最大的几个文件：

| 文件 | 行数 | 风险 |
|---|---:|---|
| `packages/ui/src/App.tsx` | 2,984 | 状态、布局、会话、权限、浏览器面板全在一个组件 |
| `packages/ui/src/Settings.tsx` | 2,835 | 设置页巨型化；本轮已抽出 `settingsModel.ts` 纯模型/格式化（59 行），仍需按领域拆 container/hook |
| `packages/shell/src/main/index.ts` | 2,906 | 装配、IPC、生命周期、E2E 钩子全在一个入口 |
| `packages/ui/src/StartPage.tsx` | 1,639 | 启动页承担了过多产品逻辑 |
| `packages/shell/src/main/browserHost.ts` | 1,579 | 浏览器宿主与标签/视图/导航耦合 |
| `packages/contracts/src/schemas.ts` | 1,537 | 契约集中可接受，但已接近该拆分的临界点 |

**判断**：核心不是“冗余歪斜”，而是**外壳太厚、内核太薄**。真正需要长期复用的能力（loop、工具、权限、浏览器适配）应继续下沉到 core；Electron 细节应留在 shell。当前方向相反：越靠近产品的能力越往 shell/UI 里堆。

---

## 2. 已核实为健康的部分

这些不是“看起来像”，是代码与测试都能对上的：

1. **依赖方向正确**
   - `core` 不依赖 Electron；`tests/guards/zero-electron.spec.ts` 守着这条线。
   - `services` 通过 `ChatPlatform` / `ChatLoopRunner` / `ToolExecutor` 注入平台能力，不直接碰 shell。
   - `contracts` 以 type-only 为主，生成物入库并由 `gen/check` 校验。

2. **工具循环有真正的预算与中止语义**
   - 轮次、工具调用数、token、墙钟四道闸。
   - 外部 `AbortSignal` 能停；工具执行有静默检测；重复工具调用有提醒/停止阈值。
   - `ToolLoopOutcome` 区分 `done / budget / aborted / silent / no-progress / error`，不是假成功。

3. **沙箱是 fail-closed 的八步决策链**
   - `packages/core/src/sandbox.ts`：白名单 → 越界 → 异常检测 → deny → require approval → auto/session → 等级策略 → deny。
   - 未知工具名在装配完成后直接 deny。
   - 工作根按会话作用域传入，不靠改全局状态，避免并发串根。

4. **MCP 宿主是真的**
   - `packages/shell/src/main/mcpHost.ts` 有 stdio 子进程、工具发现、调用、超时与回收；测试覆盖 6 个用例。
   - 不是“配置文件里写了个 MCP 字段”那种假支持。

5. **浏览器闭环是真的**
   - `WebContentsView` 真实加载页面；快照带 `#eN` refs；点击/输入/按键/滚动可用；用户标签与 Agent 标签分离。
   - E2E 实测：导航 → 快照 → 点击「点我」→ 回灌结果，`userTabs=1 / agentTabs=1`。

6. **测试基线可信**
   - 222 个测试文件、1,782 个用例全绿；覆盖 core/services/shell/ui/guards。
   - 这不是“只有 happy path”的测试集，规则、沙箱、loop、MCP、浏览器工具列表都有专门用例。

---

## 3. P0：必须先修

### P0-1 会话白名单跨会话泄漏

**证据**

- `packages/core/src/sandbox.ts:71`：`sessionApprovals = new Map<string, Set<string>>()`，key 只有 `agentId`。
- `packages/core/src/sandbox.ts:90-93`：`approveToolForSession(agentId, toolName)` 没有 sessionId。
- `packages/core/src/sandbox.ts:204`：判定时只按 `agentId` 取白名单。
- `packages/services/src/chat.ts:354-360`：`checkPermission` 只传 `agentId/toolName/target/kind`，没传 `sessionId`。
- `packages/services/src/chat.ts:403`：`approveToolForSession(this.opts.agentId, toolCall.name)`，同样没传会话。
- UI 文案是“本会话总是允许”（`PermissionDialog`），但后端实际是“本 Agent 永久允许”。

**影响**

同一 Agent 在会话 A 点过“本会话允许”，会话 B 的同名工具会直接放行。对 `file_write`、`terminal_run` 这类工具，这是实际的跨会话权限提升。用户以为授权只到本会话，实际不是。

**根因**

`SandboxManager` 是进程级单例，会话维度没有进入 key；`PermissionReq` 也没有 `sessionId` 字段。

**修法**

1. `PermissionReq` 增加可选 `sessionId`。
2. `SandboxManager.sessionApprovals` 的 key 改为 `sessionId + "\0" + agentId`；无 sessionId 时保留旧的 agent 级 key（兼容单测/旧装配）。
3. `checkPermission` 用 `req.sessionId` 查白名单；`approveToolForSession` 增加可选第三参 `sessionId`。
4. `InternalToolExecutor` 在 `checkPermission` 和 `approveToolForSession` 都传 `this.opts.sessionId`。
5. 增加 `clearSessionApprovals(sessionId)`；`chat:deleteSession` 的 `onSessionDeleted` 里调用，删除会话即清授权。
6. 更新注释与测试：同会话允许、跨会话拒绝、删除会话后清空。

**验收**

- 新单测：A 会话 allow-session 后，A 放行、B 仍 `confirm`；`clearSessionApprovals(A)` 后 A 也回到 `confirm`。
- 全量测试不回归。
- 不需要 UI 改文案；文案本来就是对的，修完后端语义才对齐。

---

### P0-2 自定义 loop 回退会重放工具副作用

**证据**

- `packages/core/src/loop/loopRegistry.ts:5-6`：铁律②明确写“回退 builtin，用同一 ctx 重跑，工具结果不丢，任务继续”。
- `packages/core/src/loop/loopRegistry.ts:138-142`：runner 抛错/超时 → `fallbackFrom(def, ctx, ...)`。
- `packages/core/src/loop/loopRegistry.ts:178-179`：把**原始 ctx**交给 builtin 重跑。
- `packages/shell/src/main/loopRuntime.ts` 的 L2 声明式 loop 最终也是 `runToolLoop(...)`；L3 脚本 loop 通过 `runScriptLoop` 代理工具执行。
- `withTimeout` 只做 `Promise.race`，不向 runner 传中止信号；超时后 runner 可能还在跑。

**影响**

自定义 loop 如果已经执行了 `file_write` / `terminal_run` / 浏览器点击，然后抛错或超时，builtin 会从原始消息重新开始，可能：

- 重复写文件、重复执行命令；
- 重复提交表单/支付类点击；
- 与仍在运行的自定义 loop 并发操作同一资源。

这不是“任务继续”，是“副作用重放”。对浏览器 Agent 尤其危险。

**修法（本轮采用保守安全语义）**

1. `LoopRegistry.run` 为每次运行创建 `AbortController`，与外部 `ctx.signal` 联动；超时时先 `abort()`，让守规矩的 runner 停下。
2. 用包装后的 `executeTool` 统计本次运行实际执行了多少次工具。
3. 失败后：
   - **已执行过工具** → 不再自动回退。返回 `status:"error"`，原因写清“已执行 N 个工具，为避免重复副作用未回退；请重试或切回内置 loop”。
   - **未执行过工具**（静态校验、启动即抛错、纯规划超时）→ 仍回退 builtin，保留原有的安全兜底。
   - **外部用户中止** → 返回 `aborted`，不回退。
4. 回退时使用原始 ctx（不带已 abort 的内部 signal），避免 builtin 一启动就被中止。
5. 更新注释：铁律②从“任何失败都回退”改为“未产生副作用才自动回退；已产生副作用则停止并显式报错”。

**验收**

- 新单测：runner 先调用一次工具再抛错 → 返回 `error`、不调用 builtin、`fallbackLog()` 为空、原因含“已执行 1 个工具”。
- 新单测：runner 先调用工具再静默挂起 → 超时后返回 `error`、不回退，且 runner 收到 abort。
- 原单测：无工具调用的抛错/超时仍回退 builtin，`safeMode=true`，ctx 不丢。
- 全量测试不回归。

**后续（不在本轮）**

真正要“任务继续”而不是“停止”，需要工具结果日志（journal）：把已执行调用与结果写进可重放的上下文，builtin 从 journal 续跑，而不是从原始消息重跑。这是 P1 架构项，不应在 P0 里草率实现。

---

### P0-3 扩展权限没有真正执行

**证据**

- `packages/shell/src/main/extensionRuntime.ts:301-307`：注册扩展工具时直接 `permissions: def.permissions ?? {}`。
- `packages/services/src/chat.ts:247-254`：`kindOfTool({})` 返回 `"read"`；空权限被当成只读，L0 自动放行。
- `packages/core/src/extension.ts:27`：manifest 注释声称“留空表示纯声明式扩展（仅给 Agent 提供提示词/规则）”，但运行时在 `extensionRuntime.ts:161` 直接报错“未声明 main”；纯声明式并未实现。
- worker 以 `process.execPath` 启动，继承完整 Node 权限；manifest 的 `permissions` 只被展示，没有被用来限制任何东西。

**影响**

- 扩展可以声明空权限，工具却按 `read` 自动执行；如果工具内部做写操作，权限层完全看不见。
- manifest 写的 `["read"]` 不会阻止工具声明 `write`；授权模型是装饰性的。
- 第三方扩展代码本身仍有完整文件系统/网络/子进程权限。这是“进程隔离 ≠ 权限隔离”。

**本轮修法（把“装饰性权限”变成“可执行的授权交集”）**

1. 在 core 增加纯函数 `resolveExtensionToolPermissions(manifestPermissions, toolPermissions)`：
   - manifest 未声明权限 → 工具全部拒绝；
   - 工具未声明权限 → 拒绝；
   - 工具声明了 manifest 未授予的权限 → 拒绝该工具（fail-closed，不做静默降级）；
   - 通过 → 返回交集后的权限对象。
2. `ExtensionRuntime.registerTools` 使用该函数；被拒绝的工具写进 `run.conflicts`，状态 error 里可见原因，其余工具照常注册。
3. 修正“纯声明式扩展”的假承诺：manifest 注释、启动错误文案、UI 标签都改成“当前版本要求 main 入口”；不实现的能力不再对外宣称。
4. 文档明确边界：manifest permissions 只约束桥接工具，worker 仍是完整 Node 权限；安装第三方扩展 = 信任其代码。OS 级隔离（Node permission model / 容器 / WASM）列为 P1。

**验收**

- core 单测覆盖：未声明 manifest、工具空权限、工具越权、正常交集。
- shell 集成测试：manifest `["read"]` + 工具 `{write:true}` → 工具不注册、状态含“未授权”；正常 `["read"]` + `{read:true}` → 注册成功。
- 现有扩展测试更新 fixture 后全绿。

**后续（P1）**

- 给 worker 加 OS 级权限（首选 Node `--permission`，若 Windows/Electron 组合不支持则用受限子进程/容器）。
- 扩展安装时展示“将获得完整进程权限”的强提示，而不是只展示 `permissions` 数组。

**迁移影响（有意 breaking）**

现有未声明 `permissions` 的扩展，启动后工具会被全部拒绝；manifest 必须补 `permissions`，且每个工具要声明对应权限。这是把“装饰性权限”变成真授权必须付的代价，状态 error 会列出被拒绝的工具与原因。

---

## 4. P1：达标前应补

| # | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| P1-1 | ~~API key 明文落盘~~ **初版误判** | `packages/shell/src/main/secretStore.ts` 已用 Electron `safeStorage`（DPAPI/Keychain）；不可用时 AES-256-GCM + 机器绑定回退，启动日志 `secrets=os` | 已有实现与 13 个测试，不需重做 | 保持；后续只补“降级模式强提示” |
| P1-2 | 终端危险命令靠正则黑名单 | `core/tools/hard_rules.ts`、`rules/commandGuard.ts` | `r''m`、`${IFS}`、`bash -c` 等变形可绕过 | 改为 argv 解析 + 命令 allowlist/分级确认；黑名单只做补充 |
| P1-3 | 浏览器引擎不可替换 | `browserHost.ts` 直接依赖 Electron `WebContentsView` | 无法无头/服务器运行，无法用 Playwright/CDP 后端 | 定义 `BrowserBackend` 端口；Electron 与 Playwright 两个适配器 |
| P1-4 | 无多模态输入 | LLM 消息类型只有文本；附件走文本读取 | 不能看图/截图/PDF 版面 | 消息 content 支持 image parts；截图工具回灌图像；PDF 渲染/OCR |
| P1-5 | 单 Agent，无子 Agent/并行任务 | 只读子代理：独立 ChatService/独立历史，工具面收窄到只读 allowlist，60s 超时可中止；`delegate_parallel` 2–4 任务/≤3 并发；`delegate_tree` 预定义 3 层/12 节点；任务记录落盘、可回查、可 `subagent_resume` 重跑（非子会话恢复） | 仍无运行时动态再委派/子会话分叉恢复 | 后续补动态委派与子会话恢复 |
| P1-6 | 工具面偏窄（部分误判） | `shell/main/searchTools.ts` 已有内置 `web_search`；新增 `office_read` 统一读取 DOCX/XLSX/PPTX/ODF/RTF/CSV/TSV/PDF，`docx_read`/`xlsx_read`/`pdf_read` 保留 | 旧版二进制 .doc/.xls/.ppt、扫描件 OCR、版面/图表仍缺 | 已完成文本层；见 `docs/OFFICE-DOCUMENT-SUPPORT.md` |
| P1-7 | 技能只有“注入”，没有“生成/演化” | 技能扫描/注入存在；`skill_candidate` 写候选默认禁用，`skill_list`/`skill_read` 可查；设置·通用可选自动候选（默认关闭、每会话 10 分钟节流）；候选可修订、删除，同名自动候选不重复生成 | 仍需人工审阅决定是否启用 | 已完成候选生命周期；后续做技能效果评估 |
| P1-8 | 扩展生态只有 tools，且 worker 权限过大 | manifest 已加 `contributes.commands`（Composer 提示词命令）、`contributes.instructions`（启用后注入 volatile 段）与 `isolation:"node"` 第一层；UI/hooks 未做；默认 worker 仍是完整 Node 权限 | 离“高兼容性插件生态”最远；第三方扩展可越权读写 | 继续定 UI/hooks 协议；强隔离/容器化 |

---

## 5. P2：工程质量与体验

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P2-1 | UI 巨型组件 | `App.tsx` 2,984 行、`Settings.tsx` 2,835 行 | 按领域拆 container/hook；先拆权限、浏览器、会话列表；本轮已把设置页纯模型/格式化抽成 `settingsModel.ts` |
| P2-2 | 主包过大、无代码分割 | 原 `index-CDRREsyZ.js` 649.52 kB；已加 `manualChunks` → `index-wxKnb0O7.js` 424.17 kB + `react-vendor` 223.22 kB，>500 kB 警告消失 | 继续按路由/设置/终端/浏览器面板 dynamic import |
| P2-3 | shell 入口过重 | `main/index.ts` 2,864 行 | 把 E2E 钩子、IPC 注册、窗口生命周期拆文件；入口只做装配 |
| P2-4 | E2E 收尾不可靠 | 功能 `ok:true`，但 300s 后强杀 Electron、退出码 2；无 `GUI_SHOT_SAVED`，截图仍是 11/15 旧图 | 给 `capturePage()` 加超时；跑前删旧图；只在 mtime 更新后打印路径 |
| P2-5 | E2E 会话校验没绑定 eval 会话 | eval `sess-...y5ia`，verify `sess-...vtt9`；runner 按消息数选文件 | eval 返回 sessionId，verify 按 id 精确读取；分支需显式断言 |
| P2-6 | 规则/记忆提交集中，安全切片停滞 | 最近 12 提交 11 个 rules/memory | 设“安全/产品/规则”配额，避免单方向过度投资 |
| P2-7 | 限流 key 只有 agentId | `sandbox.ts` 的 writeHistory/terminalCount | 改为 session+agent，避免跨会话误伤/绕过 |

---

## 6. 外围功能实测矩阵

| 能力 | 状态 | 证据/限制 |
|---|---|---|
| 多厂商 LLM | ✅ | OpenAI 兼容 + Anthropic；mock/真实流式均有测试 |
| 流式输出/中止 | ✅ | `AbortSignal` 贯通 ChatService → ToolLoop → 工具 |
| 工具调用循环 | ✅ | 四道预算闸、重复检测、静默检测 |
| 权限确认 | ✅（P0-1 修复前有跨会话漏洞） | 弹窗、allow-once/allow-session/deny、敏感步骤强制确认 |
| 文件读写 | ✅ | 工作区越界拒绝；相对路径按会话根解析 |
| 终端 | ✅ | 前台/后台、日志、危险命令黑名单（可绕过，见 P1-2） |
| 浏览器 | ✅（Electron 内） | 导航/快照/refs/点击/输入/按键/滚动/多标签；无头不可用 |
| MCP | ✅（tools） | stdio 子进程；resources/prompts 未完整接入 |
| 扩展 | ⚠️ | 工具桥接可用；权限未执行（P0-3）；无 commands/UI/hooks |
| 技能 | ✅（注入） | 扫描/选择/注入；无自动生成 |
| 记忆 | ✅ | 会话记忆、检索、偏好；无跨设备同步 |
| 规则 | ✅（偏重） | 学习/体检/守卫/清单；投资比例失衡 |
| 多模态 | ❌ | 无图片输入/视觉/PDF 版面 |
| 子 Agent/并行 | ❌ | 单会话单轮 |
| 打包/更新 | ⚠️ | 构建通过；未见自动更新/签名链路核验 |

---

## 7. IDEA.md 七条对照

| 要求 | 分数 | 判断 |
|---|---:|---|
| 自研浏览器 Agent harness | 7.5/10 | 闭环真实可用；引擎锁 Electron，离“前沿智能浏览器”还有感知/视觉/无头差距 |
| 对标前沿 Agent 浏览器 | 6.5/10 | 基础操作齐；缺视觉 grounding、下载/上传/多窗口策略、站点技能 |
| 对标 codex/Claude/hermes/deepseek | 6/10 | 单 Agent、工具面窄、无多模态、无计划模式/子 Agent |
| 架构兼容性极高 | 7/10 | contracts/core/services 分层正确；shell/ui 巨型化拖累替换能力 |
| 稳固性极强 | 6.5/10 | 1,782 测试与预算/沙箱是硬资产；P0 安全语义与 E2E 收尾拉低 |
| 可自定义 loop | 6/10 | L2/L3 + 注册表 + 回退设计完整；回退重放是硬伤 |
| 兼容 skill/MCP | 6/10 | MCP tools + 技能注入可用；resources/prompts、技能演化缺失 |
| 高兼容性插件生态 | 4/10 | 只有 tools，权限装饰性，无 UI/commands/hooks/市场 |
| **加权总评** | **6.5/10** | **骨架健康，产品未达标** |

---

## 8. 修补顺序

### 第一批：P0（本轮执行）

- [x] P0-1 会话白名单按 `sessionId + agentId` 隔离；删除会话清空。
- [x] P0-2 loop 超时先 abort；已执行工具则不自动回退，返回显式错误。
- [x] P0-3 扩展工具权限与 manifest 取交集；未声明/越权 fail-closed；修正“纯声明式”文案。

### 第二批：P1（P0 全绿后）

- [x] P1-2 终端命令解析与分级：新增 `command_safety.ts` 词法/argv 语义层，覆盖引号拼接、转义、拆参数、sudo/env/timeout/xargs、bash -c/cmd /c/PowerShell 嵌套、Windows rd/del/Remove-Item；45 个 hard_rules 用例通过。
- [x] P1-1 API key 加密/钥匙串：审计误判，已有 `secretStore.ts`（safeStorage + AES-GCM 回退）与 13 个测试；本轮只核对，不改代码。
- [x] P1-4 图片输入 + 截图回灌：LLM content 支持 image parts，OpenAI/Anthropic 适配；当前用户轮 `【附件】图片` 转多模态；`browser_screenshot` 在视觉模型下把 PNG 作为工具图片注入当前轮（仅 1 张、解码后 ≤1.5MB，不写历史、不塞 UI IPC）；text-only 模型自动跳过，只回路径。PDF 版面/OCR 作为后续增量，不属于本轮文本读取。
- [~] P1-3 BrowserBackend 端口化（第一步）：新增 `browserBackend.ts`，工具层脱离 `BrowserHost` 类并加假后端测试；第二后端与生命周期迁移未做。
- [~] P1-5 子 Agent/任务树（第四步）：`delegate_research` 只读子代理（独立 `ChatService`/独立历史、只读 allowlist、60s 超时中止）；`delegate_parallel` 并行 2–4 个互不依赖的只读任务、最多 3 并发、逐任务独立超时、结果按任务顺序回灌；`delegate_tree` 支持预定义 3 层/12 节点任务树、深度优先回灌；`SubagentTaskStore` 落盘 `<dataDir>/subagents/<parent>/<task>.json`（含 `parentTaskId`），`subagent_tasks`/`subagent_read` 可回查，`subagent_resume` 可按记录重跑（新记录关联原任务；不是恢复子会话历史，任务树节点拒绝）；仍无运行时动态再委派/子会话分叉恢复。
- [x] P1-6 工具面补齐：`web_search` 已有；新增 `office_read` 统一读取 DOCX/DOCM、XLSX/XLSM、PPTX/PPTM、ODT/ODS/ODP/ODG、FODT/FODS/FODP、RTF、CSV/TSV（UTF-8/GBK/GB18030 自动回退）、PDF 文本层；新增 `office_convert`（LibreOffice/terminal 权限，旧版 .doc/.xls/.ppt 转 OOXML）；XLSX 还原常见日期/时间格式、PPTX 读取图表/图示缓存文本、PDF 按坐标聚合行距。ZIP 层加条目/解压上限、加密/zip64/压缩方法校验；XLSX 指定/全部工作表；旧版/加密 OOXML 给出可读提示；扫描 PDF OCR、视觉版面/图形坐标仍不内置。
- [x] P1-7 技能候选生成（完成）：`skill_candidate` 写入 `skills/<id>/SKILL.md` 并默认禁用，支持 `replaceId` 修订未启用候选；`skill_list`/`skill_read` 只读查看；设置·通用「自动技能候选（实验）」默认关闭，成功后（≥2 次工具调用、用户目标 ≥16 字、答复 ≥40 字）生成候选草稿，每会话 10 分钟最多一次，同名自动候选不重复生成；设置页可删除未启用候选（已启用拒绝），自动候选发 `skills:updated` 即时刷新。纯规则不额外调用模型；技能效果评估未做。
- [~] P1-8 扩展贡献点协议 / worker OS 隔离（第三步）：manifest 新增 `contributes.commands`（title/description/prompt，最多 32 条，纯声明式、无需 main）；已启用扩展的命令以 `/extId.commandId` 进入 Composer 斜杠面板，选中只填提示词、不执行扩展代码；新增 `contributes.instructions`（≤4,000 字符），仅启用扩展注入 ChatService volatile 段（总计 ≤12,000 字符），不提供工具/代码执行；`isolation:"node"` 保持 opt-in。UI/hooks 贡献点、命令执行型 API、强隔离/容器化仍未做。

### 第三批：P2

- [~] 拆 `App.tsx` / `Settings.tsx` / `main/index.ts`（第一步）：设置页纯模型/格式化抽成 `settingsModel.ts`；三大文件仍未按领域拆。
- [x] UI 代码分割与 manualChunks：React 拆出 `react-vendor`，主包 649.52 → 424.17 kB，>500 kB 警告消失。
- [x] E2E 收尾/截图/session 校验修复：指针窗口 capture 加超时并改 webContents；runner 按 eval sessionId + forkedFrom 校验；实跑 `GUI_SHOT_SAVED`、`sessionMatch:true`、退出码 0。
- [x] 限流 key 加 session 维度：`writeHistory`/`terminalCount` 改为 `sessionId\0agentId`，新增 A 满不影响 B 的用例。

**每一批的完成定义**：相关单测新增且通过 + 全量 `vitest` 通过 + `pnpm -r typecheck` 5/5 + 不引入新的构建警告。

---

## 9. E2E 证据的限定

这轮 E2E 的功能断言是可信的：

- `E2E_EVAL {"ok":true,...}`；
- 导航、带 refs 快照、点击 marker 全部为真；
- `userTabs:1 / agentTabs:1`；
- `E2E_SESSION_VERIFY` 通过。

初版运行时曾不能宣称“E2E 干净通过”：

- runner 300s 后强杀 Electron，退出码 2；
- 无 `GUI_SHOT_SAVED`，截图是旧图；
- `capturePage()` 无超时；
- verify 按消息数挑文件，不是按 eval id。

**P2-4/P2-5 修复后复跑**：根因是透明指针窗口的 `BrowserWindow.capturePage()` 先挂起。改为 `webContents.capturePage()` + 5s 超时后，实跑得到 `POINTER_SHOT_SKIPPED`（降级）→ `GUI_SHOT_SAVED` → `E2E_SESSION_VERIFY sessionMatch:true` → `Electron 退出码=0`。因此当前可以记作“功能 + 收尾都通过”；仍保留一条限制：指针浮层截图在超时后不产出，不影响主截图与退出。

---

## 10. 变更记录

- 2026-11-17：初版审计记录；只读，未修改源码。
- 2026-11-17：完成 P0 修补（P0-1 / P0-2 / P0-3），全量 **222 文件 / 1,791 用例**通过；typecheck 5/5、build 5/5。P0-3 仅覆盖工具桥接权限，worker OS 级隔离仍留 P1-8。
- 2026-11-17：P1-2 命令语义层、P1-3 BrowserBackend 端口第一步、P1-4 图片附件 + 视觉模型截图回灌、P1-5 只读子代理与并行委派、P1-6 Office/PDF 文本读取（DOCX/XLSX/PPTX/ODF/RTF/CSV/PDF）、P1-7 技能候选与技能库读取、P1-8 扩展 Node permission 隔离第一步、P2-2 UI 分包、P2-4/P2-5 E2E 收尾、P2-7 限流 key 完成、P2-1 设置页纯模型拆分第一步；P1-1/P1-6 的“缺失”经复核为误判。全量 **235 文件 / 1,863 用例**通过，typecheck 5/5，build 通过；E2E 退出码 0、sessionMatch:true。
- 2026-11-18：P1-5 子代理任务记录落盘（`SubagentTaskStore` + `subagent_tasks`/`subagent_read`）；P1-8 声明式 `contributes.commands` 进入 Composer 斜杠面板（只填 prompt，不执行代码；纯声明式扩展无需 main）。全量 **236 文件 / 1,868 用例**通过，typecheck 5/5，build 通过；E2E 退出码 0、sessionMatch:true。
- 2026-11-18：P1-5 增加预定义任务树 `delegate_tree`（3 层/12 节点、深度优先、`parentTaskId` 落盘）；P2-1 设置页技能分区拆为 `SkillsSection.tsx`（`Settings.tsx` 2,835 → 2,819 行）。全量 **236 文件 / 1,869 用例**通过，typecheck 5/5，build 通过；E2E 退出码 0、sessionMatch:true。
- 2026-11-18：P1-8 新增 `contributes.instructions`（仅启用扩展注入 volatile 段，单条 ≤4,000/合计 ≤12,000 字符）；P2-1 扩展分区拆为 `ExtensionsSection.tsx`（自取数据/监听运行态，`Settings.tsx` 2,819 → 2,646 行）。全量 **236 文件 / 1,870 用例**通过，typecheck 5/5，build 通过；E2E 退出码 0、sessionMatch:true。
- 2026-11-18：P1-7 自动候选生成后发 `skills:updated`，设置页技能列表即时刷新；P2-1 `App.tsx` 顶层样式抽成 `appStyles.ts`（2,985 → 2,920 行）。全量 **237 文件 / 1,874 用例**通过，typecheck 5/5，build 通过；E2E 退出码 0、sessionMatch:true。
- 2026-11-18：P1-7 完成候选生命周期：`replaceId` 修订未启用候选、同名自动候选不重复生成、设置页删除未启用候选（已启用拒绝）、`skills:remove` IPC。全量 **237 文件 / 1,876 用例**通过，typecheck 5/5，build 通过；E2E 退出码 0、sessionMatch:true。

## 11. 修补进度

| 项 | 状态 | 变更文件 | 验证 |
|---|---|---|---|
| P0-1 | ✅ 已完成 | `core/sandbox.ts`、`services/chat.ts`、`shell/main/index.ts`、`tests/core/sandbox.spec.ts`、`tests/services/chatBrowserPolicy.spec.ts` | 新增 A/B 会话隔离 + 删除清空用例；全量 1,791 用例通过 |
| P0-2 | ✅ 已完成 | `core/loop/loopRegistry.ts`、`shell/main/loopRuntime.ts`、`tests/core/loopRegistry.spec.ts` | 新增“执行工具后抛错/超时→不回退”用例；原“无工具失败→回退”用例仍通过 |
| P0-3 | ✅ 已完成（工具授权层） | `core/extension.ts`、`shell/main/extensionRuntime.ts`、`ui/i18nSettings.ts`、`ui/types.d.ts`、`tests/core/extension.spec.ts`、`tests/shell/extensionRuntime.spec.ts` | 新增 manifest∩工具权限、越权拒绝、空权限拒绝用例；真实 worker 集成测试通过 |

**P0-3 的边界**：本轮修的是“manifest 授权 ∩ 工具声明”的**工具桥接权限**，以及“空权限默认 read”的漏洞。扩展 worker 默认仍是完整 Node 权限；P1-8 已加 `isolation:"node"` 的 opt-in 第一层（Node permission model：只读扩展目录/worker 目录、写仅扩展目录、terminal 才允许子进程），但**不是默认开启**，也没有容器/网络/系统调用级强隔离，不能宣称“插件进程已完全隔离”。

### 11.1 P1 进度

| 项 | 状态 | 变更 / 证据 |
|---|---|---|
| P1-2 终端命令解析 | ✅ | 新增 `core/tools/command_safety.ts`：引号拼接、反斜杠转义、`; && \|` 分段、`sudo/env/timeout/xargs` 解包、`bash -c`/`cmd /c`/PowerShell 嵌套、Windows `rd`/`del`/`Remove-Item` 根路径；`hard_rules.ts` 保留 10 条正则做兜底。45 个 `hard_rules` 用例通过（含 `r''m`、`rm${IFS}-rf${IFS}/`、`rm -r -f /`、`rm --recursive --force /`、`sudo bash -c`、`xargs rm -rf /` 等变体）。 |
| P1-1 Key 加密 | ✅ 已有 | 初版审计误判。`secretStore.ts` 已用 `safeStorage`，不可用时 AES-256-GCM + 机器绑定回退；13 个测试通过。未改代码。 |
| P1-4 多模态 | ✅ | `LlmMessage.content` 支持 `text`/`image` parts；OpenAI 映射 `image_url` 数据 URL，Anthropic 映射 base64 image block；`ChatService` 从当前用户轮 `【附件】<图片路径>` 注入，壳层 `readImageDataUrl` 负责 6MB/扩展名白名单；`browser_screenshot` 对视觉模型回灌 PNG（仅 1 张/轮、解码后 ≤1.5MB，不写历史、不塞 UI IPC），text-only 模型只回路径。PDF 版面/OCR 作为后续增量。 |
| P1-3 BrowserBackend | 🟡 端口第一步 | 新增 `shell/main/browserBackend.ts`：工具层只依赖 `BrowserBackend`，不再依赖 `BrowserHost` 类；`BrowserHost` 直接满足接口，新增非 Electron 假后端测试可注册并执行 `browser_tabs`。**未做**：真正的第二后端（Playwright/CDP）与会话生命周期/视图布局迁移。 |
| P1-5 子 Agent | 🟡 第四步 | `delegate_research` + `delegate_parallel`（≤3 并发/逐任务超时/按序回灌）+ `delegate_tree`（预定义 3 层/12 节点、深度优先）；独立 `ChatService`/只读 allowlist；`SubagentTaskStore` 落盘并记录 `parentTaskId`，`subagent_tasks`/`subagent_read` 回查，`subagent_resume` 可重跑（新记录关联原任务，非子会话恢复）；仍无运行时动态再委派/子会话分叉恢复。 |
| P1-6 工具面 | ✅ | `web_search` 已有；`office_read` 统一读取 DOCX/XLSX/PPTX（OOXML）、ODT/ODS/ODP/ODG（OpenDocument）、Flat ODF、RTF、CSV/TSV、PDF 文本层；XLSX 可指定/全部工作表并还原常见日期；PPTX 读图表/图示文本；PDF 按坐标聚合行距；`office_convert` 可转换旧版 .doc/.xls/.ppt。扫描 OCR、视觉版面/图形坐标不内置，矩阵见 `docs/OFFICE-DOCUMENT-SUPPORT.md`。 |
| P1-7 技能候选 | ✅ | 手动候选 + 自动候选（默认关闭、10 分钟节流、同名不重复生成）；候选默认禁用，可修订/删除（已启用拒绝），设置页实时刷新；技能效果评估不在本期。 |
| P1-8 扩展生态/隔离 | 🟡 第三步 | `contributes.commands` 声明式命令已进入 Composer 斜杠面板（只填 prompt，不执行代码）；`contributes.instructions` 仅在扩展启用后注入 volatile 段（≤4k/合计 ≤12k）；`isolation:"node"` opt-in：Node permission model 只读扩展目录/worker 目录，`write` 才允许写扩展目录，`terminal` 才允许子进程。默认仍 `none`；UI/hooks 贡献点、命令执行型 API、强隔离未做。 |

### 11.2 P2 进度

| 项 | 状态 | 变更 / 证据 |
|---|---|---|
| P2-2 UI 分包 | ✅ | `vite.config.ts` 增加 `manualChunks`：`react-vendor` 223.22 kB，主包 424.17 kB；>500 kB 警告消失。 |
| P2-7 限流 key | ✅ | `writeHistory`/`terminalCount` 改为 `sessionId\0agentId`；新增“A 会话写满不误伤 B 会话”用例；会话删除时 `clearSessionApprovals` 一并清空限流历史，同 id 重建不继承计数。 |
| P2-4 E2E 收尾 | ✅ | 根因是透明指针窗口的 `BrowserWindow.capturePage()` 先挂起；改为 `webContents.capturePage()` + 5s 超时，主截图也用 `webContents.capturePage()`。实跑：`POINTER_SHOT_SKIPPED`（超时降级）→ `GUI_SHOT_SAVED` → `Electron 退出码=0`，新截图已落盘。 |
| P2-5 E2E 会话校验 | ✅ | runner 解析 `E2E_EVAL.sessionId`，verify 优先选 `forkedFrom.sessionId` 匹配的分支；最近实跑 `E2E_SESSION_VERIFY`：`sessionMatch:true`、`browserControl:true`、`messages:2`、`navigated/snapshotWithRefs/clickedMarker` 全真，且 `forkedFrom` 与 eval session 同源。 |
| P2-1/P2-3 拆巨型文件 | 🟡 第四步 | 设置页纯模型抽成 `settingsModel.ts`，技能/扩展分区抽成 `SkillsSection.tsx`/`ExtensionsSection.tsx`（`Settings.tsx` 2,894 → 2,646 行）；`App.tsx` 顶层样式抽成 `appStyles.ts`（2,985 → 2,920 行）；`main/index.ts` 仍未拆。 |

**本轮验证**：`npx vitest run` **237 文件 / 1,876 用例全部通过**；`pnpm -r typecheck` **5/5**；`pnpm build` 通过（UI 无 >500 kB 警告，`main.bundle.mjs` 含 pdfjs）；E2E **干净退出**：`E2E_EVAL ok:true`、`GUI_SHOT_SAVED`、`E2E_SESSION_VERIFY sessionMatch:true`、Electron 退出码 0。
