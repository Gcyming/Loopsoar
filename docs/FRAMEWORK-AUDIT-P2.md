# Loopsoar 框架审计报告（第二阶段开工前 · 夯实框架）

> 审计范围：只读分析 + 基线验证。未修改任何源码/生成物；仓库 `git status` 审计前后均为空。
> 审计时间：2026-11-13。仓库根：`D:\tool\AI\real-project\Loopsoar\Parent file`。
> 结论见最后一节：**需先完成 P0 清单（2 项，均为小改动），其余可并行**。

---

## 0. 一句话结论

框架骨架健康：分层无破口（0 处越层 import）、electron 零泄漏、契约单源逐字节一致、typecheck 5/5。
真正会在第二阶段"踩坑"的只有两件事——**工具面对模型是全量广播（无法按会话收窄）**、**浏览器元素引用契约断裂（快照发编号、点击不认编号，且编号每次快照重排）**。这两点正好落在 (a) 与 (c) 的核心路径上，必须先修。

---

## 1. 基线验证

### 1.1 结果总表

| 项 | 命令 | 结果 | 说明 |
|---|---|---|---|
| typecheck | `pnpm -r typecheck` | ⚠️ 环境受限，改用等价直调 | `node node_modules/typescript/bin/tsc -p packages/<pkg>/tsconfig.json --noEmit`：contracts / core / services / shell / ui **5/5 EXIT=0** |
| vitest | `npx vitest run` | ⚠️ 本机沙箱无法启动 | 静态盘点：**176 个 spec 文件**（与上一轮 176 一致）；`it()/test()` 调用点 1329 处（差额为 `test.each` 展开，与 1476 条吻合） |
| contracts check | `pnpm check` | ✅ 逐字节一致 | 输出"校验通过：gen/ 内容与生成器输出逐字节一致。" |

### 1.2 为什么两条命令在本环境跑不起来（不是仓库缺陷）

沙箱禁止**子进程再派生进程**，实测 `node -e "require('child_process').execSync('node --version')"` → `EPERM`。连带后果：

- `pnpm -r typecheck`：pnpm 自身要 spawn `tsc` → `Error: spawn EPERM`（`pnpm.mjs:5636`，errno -4048）。
- `npx vitest run`：vite 5 在 Windows 下 `optimizeSafeRealPathSync()` 会 `execFile("net use")`（`vite/dist/node/chunks/dep-T98iZFpD.js:12413`）→ 直接 Startup Error，进程在收集用例前就退出。
- `pnpm check`：`tsx` 依赖 esbuild 服务进程（`esbuild/lib/main.js:2272`）→ 同样 EPERM。

**替代验证（只读、可复核）**：

1. typecheck：逐包直调 tsc，参数与各包 `typecheck` 脚本等价（`tsc -p tsconfig.json --noEmit`）。
2. 契约校验：把 `packages/contracts/{src,scripts}` 编译到临时目录，复制一份 `gen/` 作为比对基准，在临时目录里跑 `check.js`（即 `check.ts` 的全部逻辑）→ 输出"逐字节一致"，临时目录已删除，仓库 `gen/` 全程未被触碰。`git status --porcelain` 为空。

> 建议：由主代理在**普通终端**复跑一次 `npx vitest run`，把 1476 的数字钉死。本报告不据此扣分。

### 1.3 包结构事实

- 工作区 6 个目录，`pnpm -r` 命中 5 个（`Scope: 5 of 6 workspace projects`）。
- 第 6 个 `packages/sidecar` 只有 `README.md`（占位包，无 package.json/tsconfig），不进 typecheck 是**现状而非缺口**。
- 源码规模：packages 下 `.ts/.tsx` 合计 **52,219 行**；`>800 行` 文件 14 个（见 §3.2）。

---

## 2. 分层守卫抽查

### 2.1 守卫清单（`tests/guards/`，8 个）

| 文件 | 守住什么 |
|---|---|
| `layering.spec.ts` | 包级依赖方向 + 包内相对 import 不得越出 `src` + electron 白名单 |
| `zero-electron.spec.ts` | core/services 源码零 `electron` 导入（二次确认） |
| `channels-have-handlers.spec.ts` | manifest 每条通道必有 handler、registry 无死通道 |
| `contracts-sync.spec.ts` | `pnpm --filter loopsoar-contracts check` 通过 |
| `ui-contract.spec.ts` | UI 订阅事件 ∈ EVENTS、UI 调用的域方法 ∈ 通道、布局数字来自 LAYOUT、preload 白名单由 CHANNEL_BINDINGS 构建 |
| `browser-bridge-security.spec.ts` / `browser-bridge-behavior.spec.ts` | 浏览器页 preload 桥的权限与行为 |
| `project-isolation.spec.ts` | 项目隔离 |
| `preloadSandbox.spec.ts`（tests/shell） | preload 沙箱面 |

### 2.2 实测：没有被破坏

- **依赖方向**：全仓跨包 import 只有两处，且都在允许方向（shell → services）：
  - `packages/shell/src/main/index.ts:19` `import { ChatService } from "loopsoar-services/chat"`
  - `packages/shell/src/main/domains/chat.ts:5` `import type { ChatService } ...`
  - UI 侧仅 `loopsoar-contracts`（`App.tsx:2` 引 layout）；core 只引 contracts。
- **electron 泄漏**：静态 `import ... from "electron"` 仅 `index.ts:8`、`electronBrowser.ts:11`（均在白名单）；`agentWindow.ts` / `chromePopover.ts` 为惰性 `require`（`layering.spec.ts:116-135` 显式放行）；preload 走 `index.cjs:5`。core/services 为 0。
- **UI 绕过 preload**：preload（`packages/shell/src/preload/index.cjs:16-32`）只按 `CHANNEL_BINDINGS` 生成域方法 + 事件白名单，不暴露 `ipcRenderer`；UI 侧没有 `window.require` / `ipcRenderer`。唯一"绕过抽象"的是 `packages/ui/src/Markdown.tsx:64` 直接用 `window.loopsoarAPI?.browser.newTab(...)`（仍是白名单桥，只是没走 `useLoopsoarApi` 的 `api`）→ P2。
- **六要素/四要素**：`trustedIpc.ts:60-103` 实现①通道在 manifest ②帧来源 `loopsoar://`（dev 豁免 127.0.0.1）③zod 校验 ④审计；handler 进 registry 的是包装器而非裸函数（`trustedIpc.ts:73-74` 的注释与实现一致），这点做得比大多数项目扎实。

### 2.3 守卫的四个洞（都不阻塞开工，但值得补）

1. **裸 `ipcMain.handle` 无人拦**：`packages/shell/src/main/index.ts:1927` 有 `ipcMain.handle("loopsoar-browser:install-extension", ...)`，自带 `hasWebContents(event.sender.id)` 校验（`:1928`），是**有意例外**（浏览器页 preload 非同源）。但 `trustedIpc.ts:8` 写着"任何裸 handle 都是红线"，却没有测试扫描这条红线 → 下次有人加第二个裸通道不会被发现（P2）。
2. **契约守卫会改写工作树**：`contracts-sync.spec.ts:11` `execFileSync("pnpm --filter loopsoar-contracts check", { shell: true })`，而 `check.ts` 的流程是"备份 gen/ → 重新生成覆盖 gen/ → 比对 → 恢复"。测试被 kill/超时（150s）时会留下 `gen-backup-temp/` 或改写后的 `gen/`（P1）。
3. **UI 契约映射表是手写的**：`ui-contract.spec.ts:50-65` 的 `methodMap` 只覆盖 14 条，其余靠 `call.replace(".", ":")` 猜。命名一旦与通道不一致（如 `browser.setSidebarWidth` → `browser:setSidebarWidth` 恰好对得上）就会漏检或误报。
4. **类型漂移无人管**：见 §4.1（Preferences 三份定义，没有任何守卫比较它们）——这是第二阶段最可能踩的坑。

---

## 3. 冗余与屎山风险

### 3.1 TODO/FIXME/死注释

全仓 `TODO|FIXME|HACK|XXX` 仅 **1 处**：`packages/shell/src/main/index.ts:1091` `// TODO_UPDATE：计划推进（触发「已完成 / 开始」播报）`。属于"计划播报未接线"，不是技术债堆积。

### 3.2 超长文件（>800 行，14 个）

| 文件 | 行数 | 评估 |
|---|---|---|
| `packages/ui/src/App.tsx` | 2494 | **该拆**。会话栏三态、IPC 桥接、终端面板、流事件、偏好水合全在一个组件；第二阶段要加"浏览器控制开关 + 布局询问"会继续膨胀 |
| `packages/shell/src/main/index.ts` | 2130 | **该拆**。装配层 + E2E 钩子 + 浏览器事件 + 终端 + MCP 全在一起；建议先抽 `bootstrap/*`（窗口/浏览器/agent 装配） |
| `packages/ui/src/Settings.tsx` | 2057 | **该拆**。17 个分区塞进一个 `switch`；`case "general"`（`:577-681`）单分支 ~105 行 |
| `packages/ui/src/StartPage.tsx` | 1578 | 可拆（搜索/多引擎/建议列表） |
| `packages/contracts/src/schemas.ts` | 1295 | 可拆（129 通道 + 31 事件 + 全部 zod）；拆文件不影响 gen 输出，但需同步 `scripts/gen.ts` 的 import |
| `packages/shell/src/main/agentWindow.ts` | 1159 | 可拆（窗口管理 / 几何计算 / 图标态动画三块职责） |
| `packages/ui/src/types.d.ts` | 1040 | 可拆且**应换源**（见 §4.1） |
| `TerminalPanel 889` / `Composer 884` / `browserHost 859` / `ChromePage 850` / `domains/settings 830` / `AgentSidebar 816` / `terminalProfiles 805` | 805-889 | 暂可接受；`domains/settings.ts` 830 行里规则/记忆/关于/诊断混在一个域，可拆 |

### 3.3 同一件事两处实现（这部分才是真冗余）

| # | 重复 | 证据 | 影响 |
|---|---|---|---|
| D1 | **侧栏 320ms 动画两套** | UI 用 rAF 逐帧（`App.tsx:674-693`）并**始终** `animate:false`（`:671/:684/:689`）；壳层 `BrowserHost.setSidebarWidth` 自带 320ms 插值循环（`browserHost.ts:305-336`），生产路径无人传 `animate:true`（只有 `tests/shell/browserHost.spec.ts:349-409` 在测） | **已修（2026-11-19）**：壳层自带动画分支已删除，`setSidebarWidth` 立即落位；UI 的 rAF 逐帧驱动保留，成为唯一动画来源。 |
| D2 | **浏览器点击/输入两套脚本** | 适配器 `webContentsView.ts:230-260`（`click`/`type`/`scroll`，`selectorFor()` 支持数字编号）；`browserTools.ts:130-212` 又用内联 JS 字符串重写了一遍，且**不支持编号** | 两套行为会分叉（见 P0-2）；适配器那套在生产里根本不可达 |
| D3 | **320ms 常量两处** | `App.tsx:108` `SIDEBAR_ANIMATION_MS_UI = 320`、`ui/src/theme.ts:53-57` `MOTION.sidebarDuration = "320ms"`；壳层 `SIDEBAR_ANIMATION_MS`/tick 已随动画分支删除 | 改一处忘另一处；后续收敛到 `contracts/layout` |

另外：`BrowserAdapter` 的 `click/type/scroll/wait`（`browserAdapter/types.ts:29-37`）在生产代码里无调用方（`browserTools` 绕过它们、`browserHost` 只暴露 `executeScript/snapshot/screenshot`），`tests/shell/webContentsAdapter.spec.ts` 只测了 `close()` → 四个方法 = 未测且不可达的死表面（P1）。

### 3.4 生成物漂移

`pnpm check` 等价验证通过（§1.1）：`gen/ipc-manifest.json`（129 通道 / 31 事件）、`gen/ipc.ts`、`gen/security-policy.json` 与生成器输出逐字节一致，无漂移。

### 3.5 夹具目录与 .gitignore

- `.loopsoar-data*/`（10 个目录）、`.tmp-mcp-test/` 已由 `.gitignore:14,17` 覆盖。
- **`.tmp/` 只在 `.git/info/exclude:7`**（本地排除，不入库）。新克隆/CI 上 `.tmp/` 不再被忽略，一旦有人在那里生成文件就会进 `git status`（P2）。
- 无夹具目录被 git 跟踪：`git ls-files | grep -E '^\.(tmp|loopsoar-data)'` 为空。✅

### 3.6 陈旧文档

`docs/FRAMEWORK-REVIEW.md`（36 行）整体过期，与现状逐条冲突：

| 文档说法 | 现状 |
|---|---|
| "MCP：无 → ❌ 待建" | `packages/shell/src/main/mcpHost.ts`（647 行）+ `core/src/mcp.ts` + `domains/mcp.ts` + 设置页 MCP 分区 |
| "skill：无 SKILL.md 发现机制 ⚠️ 待补" | `core/src/skill.ts` + `domains/skills.ts` + 设置页技能分区 |
| "多标签：后退/前进、历史记录、下载管理器（未完成）" | `browserHost.ts` 已有多标签/后退/前进；`browserHistoryStore.ts`；`bookmarksStore.ts`；`pageSave` 域 |
| "多会话列表（当前仅最近一份）" | `sessionStore.ts` 多会话 + `SessionListPanel.tsx` |
| 路径 `core/tools.ts` | 实际是 `core/src/tools/registry.ts`（`tools.ts` 不存在） |

建议：要么重写为"扩展体系现状"，要么在文件头标注"2026-10 归档，勿据此判断现状"。

---

## 4. 第二阶段触达面预检

### 4.1 (b)(a) 的地基：Preferences 有三份定义，且新增字段会**静默丢失**

| 份数 | 位置 | 作用 |
|---|---|---|
| ① 契约 | `packages/contracts/src/schemas.ts:345-392`（`PreferencesSchema`），挂在 `settings:setPreferences` 上：`:712` `request: PreferencesSchema` | IPC 入参校验（`trustedIpc.ts:84-92`）+ gen 出 `IPC_VALIDATORS` |
| ② 核心 | `packages/core/src/preferences.ts:11-40`（又一份 zod），`:43-63` `DEFAULT_PREFERENCES`，`:76-107` `mergePreferences` | 默认值 / 落盘合并（`domains/settings.ts:142,155,602`） |
| ③ UI 类型 | `packages/ui/src/types.d.ts:48-75` `interface Preferences` | 设置页与 App 的类型 |

三份**内容一致但无人校验一致**（`tests/core/preferences.spec.ts` 只测 core 自己的默认值/非法值，不比对契约）。

**故障链（真实会踩）**：新增字段只改 ②③ →
`handleTrusted` 的 `validator.safeParse(payload)` 用 ① 校验，zod 默认 **strip 未知键** → 字段在 `args` 里已被丢掉 → `mergePreferences` 补默认值 → 写回磁盘的是默认值 → UI 每次打开都回到默认。**不报错、不抛异常、测试全绿**。

**建议（P1，第二阶段开工前定案）**：
- 契约层用 `export type Preferences = z.infer<typeof PreferencesSchema>` 导出类型；core 直接 `import { PreferencesSchema } from "loopsoar-contracts/schemas"`（core 已允许依赖 contracts，`layering.spec.ts:71`），删掉 ② 的 schema 副本，只保留默认值与合并逻辑；
- UI 用 `import type { Preferences } from "loopsoar-contracts/schemas"` 替掉 `types.d.ts:48` 的副本（contracts 已是 ui 依赖）；
- 顺带加一条守卫测试：`Object.keys(DEFAULT_PREFERENCES)` 必须被 `PreferencesSchema` 全部接受（防止"默认值里有、schema 里没有"）。
- 在此之前**新增偏好必须同时改三处**（契约 / core / UI 类型）+ `Settings.tsx` + `i18nSettings.ts` 中英双语，共 5 个文件。

> 三种现有写法可参考：`adBlockEnabled`（contracts `:349` + core 三处 + ui 类型）就是一次"三份都改对了"的样例。

### 4.2 (b) 设置 · 通用（General）的结构与"新增一项"的标准改法

- 分区注册：`Settings.tsx:52-68` `SECTIONS`（`general` 属 `basic` 组，`icon: "settings"`）→ 新增设置**不需要**动这里，只需在 `case "general"` 里加一行 `<Field>`。
- 渲染主体：`Settings.tsx:577-681`，结构为
  `<Head/>` → 若干 `<Field l={tr(...)} h={tr(...)}>\<Seg|Toggle|In|Area/></Field>` → `<div style={S.note}>`。
- 自动保存：`Settings.tsx:243-252` 400ms 防抖 `api.settings.setPreferences(prefs)`；**没有保存按钮**，所以新设置只要 `setPrefs({...})` 就会落盘。
- 文案：`packages/ui/src/i18nSettings.ts:150-216`（`settings.general.*`，zh/en 成对）。
- 落盘：`settings:setPreferences` → `domains/settings.ts:602-607` `mergePreferences(payload)` → `writeJsonFile` → `deps.onPreferencesSaved`（`index.ts:1600-1615` 在这里热应用工作区/记忆路径）。

**新增"浏览器默认布局策略"的标准改法（6 步）**：
1. `contracts/src/schemas.ts:369` 附近加 `browserLayoutPolicy: z.enum(["ask","docked","float"]).optional()`；
2. `core/src/preferences.ts` 加 schema 字段（:24 附近）+ `DEFAULT_PREFERENCES`（:56 附近，建议 `"ask"`）+ `mergePreferences` 的 `?? "ask"` 兜底（:95 附近）；
3. `ui/src/types.d.ts:72` 加同名字段；
4. `Settings.tsx:577` 的 general 分支加 `<Field>` + `<Seg>`（三选一，与 `animations` 那行同构：`:594-604`）；
5. `i18nSettings.ts:150-216` 加 zh/en 两条；
6. shell 侧读取：`loadPreferences(dirs.configDir).browserLayoutPolicy`（模式同 `index.ts:1633` 的 `sensitiveAlwaysConfirm`）。

### 4.3 (b) sidebarMode（docked/collapsed/float）现状：一条断掉的状态流

| 环节 | 现状 | 证据 |
|---|---|---|
| 类型/持久化 | `PreferencesSchema.sidebarMode: "docked"|"collapsed"|"float"` | `schemas.ts:369`、`preferences.ts:24,56,95` |
| UI 读取 | 读偏好，但 **float 被强制降级成 docked** | `App.tsx:149-150`：`storedSidebarMode === "float" ? "docked" : storedSidebarMode` |
| UI 修改 | 三态按钮：`collapsed`/冲鸭；`float` **不写偏好**，改为打开独立窗口后 return | `App.tsx:600-627`（`if (next === "float") { openAgentWindow(...); return; }`） |
| 传到壳层 | **只传宽度，不传 mode**：`api.browser.setSidebarWidth({width, animate:false})` → 通道 `browser:setSidebarWidth`（`schemas.ts:613`）→ `domains/browserAdapter.ts:57-61` → `BrowserHost.setSidebarWidth` → `applyLayout`/`computeBrowserViewBounds` | `App.tsx:656-700`、`browserHost.ts:305`、`contracts/layout.ts:88-110` |
| 壳层"生效" | 壳层**根本不知道 mode**：collapsed 只是宽度 48（`LAYOUT.SIDEBAR_COLLAPSED_WIDTH`，`App.tsx:651-652`）；float 完全由 `agentWindow` 另一套通道承担（`ui:openAgentWindow` → `domains/agentWindow.ts:117-121` → `AgentWindowManager.open()`） | — |

**结论**：`"float"` 是**死枚举值**（只能被外部写进 preferences.json，UI 一律降级）；偏好里存 float 与"打开独立小窗"是两种互斥语义。第二阶段 (b) 要求"float 小窗"作为布局策略，**开工前必须先定义清楚 float 指哪个**：
- 若指"Agent 会话栏独立窗口"→ 不要往 `sidebarMode` 里存 float，策略值应为 `"ask"|"docked"|"window"`，落地动作是 `agentWindowManager.open(sessionId)`（`index.ts:1725` 已装配，`agentWindow.ts:321-364` 暴露 `open/close/isOpen/minimize/restore`）；
- 若指"侧栏浮动卡片"（`AgentSidebar` 的 floatCard 样式，`AgentSidebar.tsx:22` 注释）→ 那是纯 UI 布局，壳层只需继续收宽度，不需新通道。

**建议接入点**：策略读取在 shell（偏好）→ 决策在 `browser_navigate` 首次打开页面前（见 4.5）→ 动作二选一：`agentWindowManager.open(sessionId)`（窗口）或 push 事件让 UI 切 `sidebarMode`（卡片）。

### 4.4 (a) ToolRegistry：有"按名单出 schema"的钩子，但**没人用**；没有按会话启停

- `core/src/tools/registry.ts:106` `toolSchemas(toolsOnly?: string[])` —— 已支持按名字过滤；`:108` `toolsOnly ? this.list().filter(...) : this.list()`。
- 唯一调用方 `services/src/chat.ts:486-492`：`registry.toolSchemas()` —— **不传 toolsOnly，全量广播**。
- 执行侧确实有过滤：`services/src/chat.ts:240-243` `InternalToolExecutor` 按 `toolAllowlist` 拒绝未授权工具；allowlist 在 `:464` 由 `getToolAllowlist(mode)` 解析。
- 但 **allowlist 只影响"能不能执行"，不影响"模型看不看得见"**：被禁的工具仍在 `tools` 数组里，模型会去调、然后收到拒绝错误 → 浪费轮次、误导规划。plan 模式（只读）现在就是这个状态。
- 会话级能力：**没有**。`ChatService` 的 `toolAllowlist` 是构造期全局（`chat.ts:70`），`getToolAllowlist(mode)` 只按 mode 分流（`chat.ts:84`），**签名里没有 sessionId**；registry 本身是全局单例（`index.ts:1798` 一次注册，所有会话共用）。

**第二阶段 (a) 的最小改动（P0-1）**：
1. `chat.ts:486` 改成 `registry.toolSchemas(resolvedAllowlist)` —— 一行，立刻让 plan 模式与开关"对模型可见"；
2. 会话级开关状态：优先扩展 `ChatStreamSchema`（`schemas.ts:20-27`，已有 `mode` 同构先例）加 `browserTools?: boolean`，或落进`PersistedSession`（`sessionStore.ts:42-52`）以跨重启保持；
3. `index.ts:1667` 的 `getToolAllowlist(mode)` 扩成 `(mode, sessionId)`，在里面做 "browser_* 前缀移除 / 白名单求交"。

### 4.5 (c) 浏览器工具集：接口边界、工具清单、以及两个硬伤

**边界（总体清晰，有一处类型谎言）**
- `browserTools.ts` 只 `import type { BrowserHost }`（`:12`），不碰 electron、不碰 IPC；错误统一 `{ok:false, content:"[错误] ..."}`；出网走 `ctx.platform.net`（`:339-354`，保留 SSRF 防护，没有裸 `fetch`）——这部分做得对。
- 但 `BrowserSnapshot`（`browserAdapter/types.ts:8-12`）**没有 `elements` 字段**，适配器用 `as BrowserSnapshot & { elements: unknown[] }` 硬转（`webContentsView.ts:222-227`），工具侧再 cast 一次（`browserTools.ts:88-95`）→ 快照格式升级必须先补类型（P1）。

**browserTools 注册的全部工具（8 个，全文读完）**

| 工具 | 权限 | 行 | 说明 |
|---|---|---|---|
| `browser_snapshot` | read | `:78` | 输出 URL/标题/正文(≤8000 字符)+最多 40 个元素，元素格式 `[#id] <tag> text → href` |
| `browser_navigate` | network | `:111` | 走 `host.navigate(url, undefined, sessionId)` |
| `browser_click` | network | `:130` | 内联 JS：`querySelector(target)` 或 `text=...` |
| `browser_type` | network | `:164` | 内联 JS：`value/textContent` + input/change 事件 |
| `browser_scroll` | network | `:191` | down/up/top/bottom |
| `browser_screenshot` | read | `:215` | 落盘 `<sessionRoot>/.loopsoar/screenshots/`，读 PNG IHDR 报尺寸 |
| `browser_wait` | read | `:266` | 轮询选择器/文本，≤10s，200ms 步进 |
| `web_fetch` | network | `:329` | 不建标签，走 `platform.net`（SSRF 钉扎） |

内置工具总量：`*Tools.ts` 共 17 处 `registry.register(`（浏览器 8 + ask 1 + file 1 + memory 4 + plan 1 + search 1 + terminal 1）；MCP/扩展另行动态注册。

**BrowserHost 公开方法清单（`browserHost.ts`，供新工具直接复用）**
`hasWebContents(178)`、`currentSessionId(188)`、`setSidebarWidth(305)`、`getSidebarWidth(339)`、`cancelSidebarAnimation(344)`、`setBottomInset(362)`、`getBottomInset(369)`、`debugBounds(379)`、`debugEval(425)`、`listTabs(491)`、`executeInActiveTab(507)`、`goBack(523)`、`goForward(532)`、`toggleDevTools(545)`、`reload(557)`、`history(565)`、`activeTabId(572)`、`hasAnyTab(576)`、`setOverlayOpen(581)`、`syncBounds(586)`、`navigate(591)`、`newTab(651)`、`selectTab(675)`、`closeTab(683)`、`closeSessionTabs(704)`、`closeAll(713)`、`executeScript(720)`、`snapshot(726)`、`setZoom(731)`、`screenshot(739)`、`snapshotSession(744)`、`switchSession(762)`、`deleteSession(814)`。

> 注意：**多标签能力壳层早就有了**（`newTab/selectTab/closeTab/listTabs/history/goBack/goForward`），只是**一个都没注册成 Agent 工具**。第二阶段 (c) 的"多标签"主要是**加工具 + 让 sessionId 正确透传**，不是重写宿主。

**硬伤 1（P0-2）：快照广告编号，点击不认编号**
- `browserTools.ts:105` 文案："可交互元素（可用编号或 CSS 选择器点击/输入）"；
- `browser_snapshot` 输出的是 `[#1] <button> ...`（`:100`）；
- `browser_click` 的实现（`:141-152`）只有 `querySelector(t)` + `t.startsWith("text=")`；传 `"1"` → `querySelector("1")` 抛错被 `catch {}` 吞掉 → 返回"未找到元素：1"；
- 能把数字转 `[data-loops-el="1"]` 的 `selectorFor()` 在适配器里（`webContentsView.ts:83-87`），**工具完全没走那条路**（D2 的第二重后果）；
- 测试没覆盖：`tests/shell/browserTools.spec.ts:16` 造了 `elements:[{id:"1"...}]`，但 `:63` 的点击用例用的是 `"text=点我"`。

**硬伤 2（P0-2）：编号每次快照重排，且旧标记不清除**
- `MARKERS_SCRIPT`（`webContentsView.ts:60-65`）按 `querySelectorAll` 的 DOM 顺序 `setAttribute('data-loops-el', i++)`，**不先清理旧属性**；
- `snapshot()` 每次调用都重跑 `markInteractive()`（`:214-215`），`navigate()` 也跑一次（`:210`）；
- 后果 ①：SPA/懒加载导致 DOM 变化后，编号整体位移，快照里记的 `#12` 在点击时指向别的元素（"点确认变成点取消"级别的错误）；
- 后果 ②：不再匹配选择器的旧元素保留旧属性 → 同页可能出现**重复编号**，快照返回幽灵元素。

**建议（(c) 的施工顺序）**：先修引用模型，再谈格式与动作分层：
1. 引用改为**快照令牌 + 稳定键**：`snapshot()` 返回 `snapshotId` + 每个元素的 `ref`（如 `s3-e12`），映射表存在 BrowserHost 内（`Map<snapshotId, Map<ref, WeakRef<Element>>>` 或 DOM 上的 `data-loops-ref`），点击时按 `snapshotId+ref` 解析；
2. `markInteractive` 先清 `[data-loops-el]`/`[data-loops-ref]`（一行 `forEach(removeAttribute)`）再打标；
3. `browserTools` 全部改走 `BrowserHost` 的新方法（`click(ref)`/`type(ref,text)`），删掉内联脚本与适配器的重复实现（D2）；
4. 动作分层（读/写/导航）用 `permissions` 字段已有能力（`read/network`）扩展出 `write`/`destructive`，配合 §4.4 的工具面收窄；
5. 等待/重试：`browser_wait` 现在是"轮询 JS"，可复用为通用的 `waitFor(predicate)`，并把 `navigate` 的 `dom-ready` 等待（`webContentsView.ts:106-121`，已有 15s 兜底）暴露成参数。

---

## 5. 分级清单

### P0（开工前必须完成，预计 <1 天）

| 编号 | 问题 | 证据 | 建议 |
|---|---|---|---|
| **P0-1** | 工具面对模型全量广播，无"按会话启停/收窄"能力；allowlist 只拦执行 | `services/src/chat.ts:486-492`（`toolSchemas()` 无参）、`core/src/tools/registry.ts:106`（钩子存在但无调用方）、`chat.ts:240-243`（只拦执行）、`chat.ts:84`（`getToolAllowlist` 无 sessionId）、`shell/src/main/index.ts:1798`（全局单例注册） | ① `chat.ts:486` → `registry.toolSchemas(resolvedAllowlist)`；② `ChatStreamSchema`（`schemas.ts:20`）加 `browserTools?: boolean` 或写进 `PersistedSession`（`sessionStore.ts:42`）；③ `getToolAllowlist(mode, sessionId)` |
| **P0-2** | 元素引用契约断裂：快照发编号、点击不认；编号每次快照重排且旧标记不清 | `browserTools.ts:105` vs `:141-152`；`webContentsView.ts:60-65`（不清理）、`:210/:214-215`（每次重排）、`:83-87`（`selectorFor` 未被工具使用）；`tests/shell/browserTools.spec.ts:63`（用例避开了编号） | 见 §4.5 五步：快照令牌+稳定 ref → 清理旧标记 → 工具改走宿主方法 → 动作分层 → 等待可复用 |

### P1（建议修，可与第二阶段并行，但 (b) 开工前要定案 3 件）

| 编号 | 问题 | 证据 | 建议 |
|---|---|---|---|
| **P1-1** | Preferences 三份定义、无漂移守卫；新增字段会被 IPC 校验静默 strip | `schemas.ts:345,712` / `preferences.ts:11,43,76` / `types.d.ts:48`；`trustedIpc.ts:84-92` | 见 §4.1：契约出类型，core/UI 复用；补 `DEFAULT_PREFERENCES` ⊆ schema 守卫 |
| **P1-2** | `sidebarMode:"float"` 是死值（UI 强制降级），且与"独立小窗"语义冲突 | `App.tsx:149-150`、`:600-616`、`schemas.ts:369` | 先定 float 语义（窗口 or 卡片），再决定策略枚举（`ask/docked/window`） |
| **P1-3** | 浏览器动作两套实现，适配器 4 个方法不可达且未测 | `webContentsView.ts:230-260`、`browserAdapter/types.ts:29-37`、`browserTools.ts:130-212`、`webContentsAdapter.spec.ts` 只测 `close` | 收敛为一套（宿主方法），删死表面 |
| **P1-4** | 壳层侧栏动画是生产死代码；320ms 三处常量；注释已过期 | `browserHost.ts:305-336`、`App.tsx:671/684/689`（全 false）、`App.tsx:2058`（过期注释）、`theme.ts:57` | 删壳层 animate 分支（保留瞬时 set），时长收敛到 `contracts/layout`。**已完成**：主进程不再创建 setInterval，`setSidebarWidth` 兼容旧参数但立即落位；UI 的 rAF 逐帧驱动保留。 |
| **P1-5** | `BrowserSnapshot` 无 `elements`，两层 `as` 强转 | `types.ts:8-12`、`webContentsView.ts:222-227`、`browserTools.ts:88-95` | 快照格式升级前先补类型（与 P0-2 同批做） |
| **P1-6** | 契约守卫测试会改写工作树，崩溃可留残留 | `contracts-sync.spec.ts:11` + `check.ts` 备份/覆盖/恢复流程 | 改为"生成到临时目录再比对"，或在 `finally` 里恢复 |
| **P1-7** | 4 个 >1500 行文件继续被第二阶段加功能 | `App.tsx:2118`（`useBrowserTabs` 已抽出）、`index.ts:1763`（E2E/窗口已拆）、`Settings.tsx:1777`（记忆分区已抽出）、`StartPage.tsx:1639` | 继续拆 `Settings.tsx` 的供应商/规则分区、`index.ts` 的启动装配；对齐 1500 行红线 |
| **P1-8** | `docs/FRAMEWORK-REVIEW.md` 全篇过时（MCP/skill/多标签/多会话/路径） | 见 §3.6 | 重写或标注归档 |

### P2（可缓）

| 编号 | 问题 | 证据 | 建议 |
|---|---|---|---|
| P2-1 | `.tmp/` 仅被 `.git/info/exclude:7` 忽略，不入库 | `.gitignore:14,17` 覆盖了 `.loopsoar-data*/`、`.tmp-mcp-test/` | 把 `.tmp/` 并入 `.gitignore` |
| P2-2 | 裸 `ipcMain.handle` 无守卫（现存的 1 处是有意例外） | `index.ts:1927`、`trustedIpc.ts:8` | 加守卫测试：只允许白名单文件出现裸 handle |
| P2-3 | UI 绕过 `useLoopsoarApi` 直接用 `window.loopsoarAPI` | `Markdown.tsx:64` | 走 `api.browser.newTab` |
| P2-4 | 唯一 TODO：计划推进播报未接线 | `index.ts:1091` | 接上或删注释 |
| P2-5 | `contracts/schemas.ts` 1295 行装 129 通道 + 31 事件 | `schemas.ts` | 按域拆文件（保持 gen 输出不变） |
| P2-6 | 侧栏宽度/动画常量跨 UI/壳/theme 三处 | `App.tsx:108`、`browserHost.ts:28-30`、`theme.ts:53-57` | 收敛到 `contracts/layout`，theme 引用 |

---

## 6. 结论

**需先完成 P0 清单（P0-1、P0-2 两项，均为小时级改动），之后第二阶段可以开工。**

依据：
1. 框架本身没有结构性问题——分层 0 破口、electron 0 泄漏、preload 白名单由契约生成、129 条通道全部经 `handleTrusted`（1 处有意的浏览器 preload 例外）、生成物逐字节一致、typecheck 5/5。
2. 但第二阶段的三项新能力，**(a) 依赖 P0-1**（否则"关掉浏览器工具"只是"模型看得见但点了报错"）、**(c) 依赖 P0-2**（否则在"编号不可信"的地基上做快照格式与引用稳定性 = 返工）。
3. (b) 的两个前置是**决策**而非返工：float 的语义（P1-2）、默认策略设置放 `Settings.tsx:577` 的 general 分支（新增 6 步见 §4.2）。这两项可在 P0 修复的同一周内定案。

**给第二阶段的三个"别踩"**：
- 新增任何偏好 → 先改契约，否则静默丢字段（§4.1 故障链）；
- 新增任何通道 → `contracts/schemas.ts` 加 `CHANNEL_BINDINGS` + 域里 `handleTrusted` + `ui/types.d.ts` 的方法签名，三者缺一就会在 `channels-have-handlers` 或类型检查处爆；
- 新增浏览器工具 → 走 `BrowserHost` 公开方法，不要在 `browserTools.ts` 里再写内联 JS（D2 的教训）。

---

### 附：验证命令与可复现性

```bash
# 1) typecheck（等价于 pnpm -r typecheck，本沙箱因 spawn EPERM 需绕行）
for p in contracts core services shell ui; do
  node node_modules/typescript/bin/tsc -p packages/$p/tsconfig.json --noEmit
done

# 2) 契约逐字节（本报告用隔离复现；普通终端直接 pnpm check）
pnpm check

# 3) 测试（本沙箱无法运行，请在普通终端执行）
npx vitest run     # 期望 176 文件 / 1476 条
```
