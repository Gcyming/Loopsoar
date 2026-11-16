# Loopsoar 代码审计与清理报告（第三阶段开工前 · 2026-11-16）

> 触发：用户要求「从代码层面全面扫一遍，检查架构是否稳固、可自定义性高、有无 bug、功能是否连接正常；删去冗余结构、精简无用占位与早期弃用代码；为上一阶段收尾后正式进入第三阶段」。
> 方法：三维并行只读审计（contracts/IPC 接线、core 引擎、扩展与 Loop 体系）＋ 主代理自审（浏览器子系统、UI、壳层装配、文档一致性）＋ 机器化死代码扫描（module graph + `tsc --noUnusedLocals`）＋ 全量基线复跑。
> 口径：每条结论都有 `path:line` 证据；「已修」= 本轮已改代码并进测试；「待办」= 进入第三阶段台账。

---

## 0. 一句话结论

**骨架仍然稳固**（分层零破口、契约单源逐字节一致、191 测试文件全绿），但存在 **3 个 P0 级「安全承诺空转」缺陷**（声称核验被 URL 正则旁路、沙箱硬规则取不到终端命令、Anthropic 少算 prompt token 使 Token 闸失效），以及 **可自定义性的最大缺口：只有 tools 一类贡献点真正落地**。本轮已清掉 **1,100+ 行死代码/占位**、修掉 3 个 P0 与 6 个 P1/P2，并把剩余问题按第三阶段切片归档。

---

## 1. 基线（清理前后对比）

| 项 | 清理前 | 清理后 |
|---|---|---|
| typecheck | 5/5 ✅ | 5/5 ✅ |
| 全量 vitest | 196 文件 / 1645 用例 | **191 文件 / 1602 用例全绿**（净删 5 个只测死代码的 spec，新增 3 条回归用例） |
| `pnpm build` | 5/5 ✅ | 5/5 ✅ |
| `pnpm gen && pnpm check` | 逐字节一致 | 逐字节一致 |
| 源码规模 | 208 文件 / 58,758 行 | 199 文件 / 57,4xx 行（−9 文件 / −1,162 行） |

---

## 2. 架构稳固度评估

### 2.1 通过（不需要动）

1. **分层无破口**：contracts → core（零 electron）→ services → shell → ui，守卫测试（layering / zero-electron / channels-have-handlers / ui-contract / contracts-sync）在 CI 常跑；跨包 import 只有 `shell → services` 两处，方向正确。
2. **契约单源真的单源**：138 通道 = 138 个 `handleTrusted` = preload 生成的 138 个方法，DB 式对账无缺口；`IPC_VALIDATORS` 由 `CHANNEL_BINDINGS` 派生，结构上不可能漂移；`gen/` 与生成器逐字节一致。
3. **受信 IPC 四要素**（通道在 manifest / 帧来源 / zod 校验 / 审计）实现扎实，唯一裸 `ipcMain.handle`（浏览器扩展安装）有显式 `hasWebContents` 校验与注释。
4. **Agent-Loop 三档齐全**：builtin + L2 声明式（`<dataDir>/loops/*.json`）+ L3 脚本（子进程 JSON-RPC），静态校验、回退埋点、`loop:fallback` UI 提示都在。
5. **工具面 = 执行闸同源**（P0-1 的修复没有回退），会话级工具过滤同时作用于 `toolSchemas()` 与执行器。

### 2.2 结构性隐患（已登记，进第三阶段）

| 级别 | 问题 | 证据 |
|---|---|---|
| P1 | **可自定义性只有一类贡献点**：全仓无 PluginHost / registerContribution / `{label,dispose}` 作用域 / 逆序 dispose / 冲突裁决 / trust.json；13 个贡献点里只有 `tools` 有装载路径，loop 只认数据目录文件，`omnibox` / `agent-template` / theme 贡献均为 0 | `packages/shell/src/main/extensions.ts:20`、`packages/contracts/src/schemas.ts:197-254` |
| P1 | **扩展权限不是交集**：工具执行权限取 `def.permissions`，与清单 `manifest.permissions` 无任何约束关系 → 声明 read 的扩展可注册 write/terminal/network 工具 | `packages/shell/src/main/extensionRuntime.ts:304`、`packages/core/src/extension.ts:30` |
| P1 | **core 混入 Node 依赖**：`sandbox.ts` 直接 `import path from "node:path"`、类字段初始化 `process.cwd()`；`tool_loop.ts` 4 处读 `process.env.LOOPSOAR_LOOP_DEBUG`，与「core 零 node」自相矛盾 | `packages/core/src/sandbox.ts:13,69`、`packages/core/src/tool_loop.ts:303,525,534,599` |
| P1 | **core 子路径 exports 指向不存在的 `./src/*.js`**：`import("loopsoar-core/loop")` 实测 ERR_MODULE_NOT_FOUND；tsc 产物无法被 Node 直接加载，只有 esbuild bundle 能跑 | `packages/core/package.json:8,34-40` vs `tsconfig.base.json:outDir=dist` |
| P1 | 超大文件：`App.tsx` 2969 行、`main/index.ts` 2638 行（其中 E2E 钩子约 1,045 行）、`Settings.tsx` 2069 行、`StartPage.tsx` 1642 行、`browserHost.ts` 1553 行、`refs.ts` 1458 行 | — |

---

## 3. 本轮已执行的清理（可回滚，逐项做过引用检查）

**删除的整文件（9 个源文件 + 5 个只为它们存在的 spec）**

| 文件 | 行数 | 判定依据 |
|---|---|---|
| `packages/core/src/audit.ts` | 31 | `AuditLog` 全仓 0 生产引用；壳层有自己的 `trustedIpc.AuditEntry` + `auditFile` 串行落盘（两套审计模型并存） |
| `packages/core/src/router.ts` | 110 | `ModelRouter` 只被 `routerLlm` 与自身测试引用；ADR-0043 已裁决「不做跨供应商静默降级」 |
| `packages/shell/src/main/routerLlm.ts` | 216 | 降级链实现，0 import（被 ADR-0043 取代） |
| `packages/core/src/tools/policy.ts` | 24 | `classifyToolCall`/`explainDenial` 仅测试引用，与 `permissions.ts decisionFor` 重复 |
| `packages/services/src/engine.ts` | 71 | `LoopsoarEngine` 是「能力占位/心智占位」假实现，0 引用 |
| `packages/core/src/platform/web.ts` | 82 | 11 个方法全 throw 的 web stub，`createWebPlatformStub` 0 引用（ADR-0004 后置能力，需要时只留 interface） |
| `packages/shell/src/shared/ipc.ts` | 16 | 0 importer；其 `channelName()` 与 `buildPreloadWhitelist` 均无人调用 |
| `packages/shell/src/browserAdapter/backends/webview.ts` | 24 | `<webview>` 兼容后端只有 throw，仅自身 spec 引用 |
| `packages/sidecar/README.md` | 17 | 占位包：无 `package.json`、不在 `pnpm -r` 的 5 包内、无任何 import |
| 测试：`tests/core/{audit,router,policy,webviewBackend}.spec.ts`、`tests/shell/routerLlm.spec.ts` | 约 500 | 只测上述死代码 |

同时清理：
- **死导出/死分支 15 处**（`tsc --noUnusedLocals` 逐条核实）：`tool_loop.ts` 未用 `LlmChunk` 与 `maxTotalTokens` 局部量、`classifier.ts` 未用 `DANGEROUS_COMMAND_RE` 与 `lower`、`index.ts` 未用 `handleTrusted`/`providerUsability`、`mcpHost.ts` 未用 `mcpToolName`、`pastedImage.ts` 未用 `IMAGE_MIME`、`secretStore.ts` 未用 `SECRETS_VERSION`、`domains/chat.ts` 未用 `sessionBeforeSend`。
- **UI 死代码**：`App.tsx` 的 `selectWorkspaceForChat`（26 行，已被 `bindWorkspaceToCurrentSession` 取代）、未被读取的 `sidebarWidthAnimating` 状态与 4 处 setter、`AgentSidebar` 的 `compactUi`/`liveWidth` 死 props 与 `sessionAnchorRef`/`workspaceName`、`PlusControl` 里未使用的 `browserControl` 透传、`chatStreamState` 的 `PlanStepLite`、5 处未用的 import/参数。
- **文档与仓库结构**：`README.md` 删除 sidecar 行、修正 services 描述；`.gitignore` 纳入 `.tmp/`。

---

## 4. 本轮已修复的缺陷（含回归用例）

| 级别 | 缺陷 | 证据 | 修复 |
|---|---|---|---|
| **P0** | **声称核验被 URL 正则旁路**：`looksLikeUrlFragment` 把 `report.md`/`README.md` 判成域名残片 → 「已保存到 report.md」这类最常见声称**永不核验**，诚实协议闭环失效 | `packages/core/src/claims.ts:70` | 只认「协议头 / www. 前缀 / 域名后跟路径分隔符」；新增 2 条回归用例（`tests/core/claims.spec.ts`） |
| **P0** | **沙箱硬规则对真实调用空转**：target 只从 `args.path` 取，而 `terminal_run` 用 `command`、`browser_*` 用 `url/target` → 越界判定与「危险命令」硬规则（八步决策链②③）**永不触发** | `packages/services/src/chat.ts:297` | 按类别取参：terminal→`command`，read/write→`path`，network/browser 不传（SSRF 在 net 层、浏览器走 requestGuard） |
| **P0** | **Anthropic 下 Token 闸失效**：usage 只累加 `output_tokens`，prompt token 从不计入 → 长上下文可无限突破四闸之一 | `packages/core/src/llm/anthropic.ts:230,276,345` | 解析 `message_start.message.usage.input_tokens`，与 OpenAI 的 `total_tokens` 口径统一 |
| P1 | **重新扫描把选中的 loop 静默切回 builtin**：`scan()` 先 `remove()`（会把 currentId 重置），注册完不还原 | `packages/shell/src/main/loopRuntime.ts:256` | 扫描前记录 activeId，注册后若仍存在则 `switchTo` 还原；新增回归用例 |
| P1 | **记忆归档 id 是近似值**：`archived: this.archived.slice(-(added.length+1))` 返回的 id 与本次真实归档无关 | `packages/core/src/memory/store.ts:178` | 由 `gateCapacity` 结果收集 `archivedIds` |
| P1 | **无进度停止原因在界面消失**：`emit("progress", { message })`，而 UI 只读 `note` | `packages/core/src/tool_loop.ts:714` | 改为 `{ note }` |
| P2 | **技能描述提取在正文末尾失效**：JS 无 `\Z`，被当字面量 `Z` | `packages/core/src/skill.ts:60` | `(?=\n##|(?![\s\S]))` |
| P2 | 死分支 / 重复导出 | `extension.ts:57` `enabled ?? true`、`platform/index.ts:6` 重复导出 | 删除 |

---

## 5. 未修问题台账（第三阶段输入）

### P0/P1：正确性、安全与接线

| # | 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| 1 | P1 | 扩展工具权限不取交集（声明 read 也能注册 write/terminal） | `extensionRuntime.ts:304` | 注册期强制 `toolPerms ⊆ manifestPerms`，越界 fail-closed 并记 conflicts |
| 2 | P1 | Loop 回退 = 重放而非续跑（脚本已执行的工具结果留在子进程，builtin 会重跑工具 → 重复副作用/重复计费） | `loopRegistry.ts:179`、`loopRuntime.ts:362` | 回退前把工具结果写回 `ctx.messages`，或回退只做收尾汇总 |
| 3 | P1 | 自定义 loop 无心跳 watchdog（只有一个总超时），L3 无 no-progress 检测 | `loopRegistry.ts:145`、`scriptLoopHost.ts:38` | 以「最后事件时间」做 watchdog，总超时降为兜底 |
| 4 | P1 | 静默超时只 `Promise.race`，不取消 runner → 超时后自定义 loop 与 builtin 并发跑同一 ctx | `loopRegistry.ts:145-157` | runner 接收 AbortSignal，超时 abort，并对 runner 挂 `.catch` |
| 5 | P1 | 扩展调用超时只返回错误，工具仍注册、状态仍 ready；崩溃无自动重启（MCP 有退避重连） | `extensionRuntime.ts:328,344` | 首次超时即 failRun（注销+kill）；补退避重启上限 |
| 6 | P1 | Anthropic thinking 块在后续轮被丢弃 → 开推理等级 + 工具轮会 400 | `anthropic.ts:67-95` | `LlmMessage` 增加 `reasoning` 并回灌 thinking 块 |
| 7 | P1 | Anthropic `max_tokens` 硬编码 4096（tool_loop 刻意不传），长回复靠最多 8 次续写兜底 | `anthropic.ts:139` | 从 `modelCapabilities.maxOutput` 推导 |
| 8 | P1 | 输出过滤无差别替换 `OpenAI` 等词，连 URL/配置键一起改（`https://api.openai.com` → `api.Loopsoar 平台.com`） | `filter.ts:14,26` | 只匹配自称句式，排除代码块与 URL |
| 9 | P1 | 记忆 0.68 合并闸跨 agent 生效（只看相似度，不比 agentId） | `memory/store.ts:146`、`fiveGate.ts:79` | `gateMerge` 内跳过不同 agent 的条目 |
| 10 | P1 | 合并闸在真实路径上永不触发：`extract` 产出的候选恒有 tags，而 `gateMerge` 对带 tags 的条目直接 `continue` | `memory/extract.ts:65`、`fiveGate.ts:78` | tags 不阻断合并（去重改为 tags 交集） |
| 11 | P1 | Node 平台按块 `chunk.toString("utf8")` → 跨块多字节字符变成 �（中文网页抓取损坏） | `platform/node.ts:372` | `TextDecoder({stream:true})` |
| 12 | P1 | 命令输出截断按「字节数 − 字符长度」记账 → 非 ASCII 截断量放大约 3 倍并出现乱码 | `platform/node.ts:107` | `Buffer.byteLength` 记账 + 完整字符边界 |
| 13 | P1 | `isSensitivePath` / `isProtectedSourceDir` / `targetFromArgs` 全仓 0 引用 → contracts 的「敏感文件 / 受保护源码目录」规则**从未执行** | `tools/classifier.ts:7,27`、`hard_rules.ts:38` | 接入 file_write 前置判定，或删函数并降级契约 |
| 14 | P1 | `canUseTool` 有实现但生产 0 引用，`chat.ts` 内联复制了同一白名单判定 | `core/agent.ts:95`、`services/chat.ts:275` | chat 改调 `canUseTool` |
| 15 | P1 | `assertStableUnchanged`（stable 段字节不变断言）0 引用 → 身份铁律无运行时校验 | `core/session.ts:69` | 在组装 stableContent 处与首轮快照比对 |

### P1：死通道 / 死事件 / 死契约

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 16 | 7 条死通道：`chat:send`、`file:read`、`file:write`、`app:version`、`browser:screenshot`、`memory:stats`、`settings:clearProvider` | `domains/chat.ts:215`、`workspace.ts:73,108`、`runtime.ts:9`、`browserAdapter.ts:210`、`memory.ts:33`、`settings.ts:561` | 分批删（需同步 schemas → gen → preload → 守卫）；`file:read/write` 是本范围内最大不可达块，且是渲染层唯一直接写文件面，优先删 |
| 17 | 4 条死事件：`boot:ready`（无 push 无订阅）、`chat:compacted`、`skills:updated`、`mcp:updated`（后三者有 push 零订阅） | `schemas.ts:1365`、`compact.ts:206`、`skills.ts:23`、`index.ts:1712` | `chat:compacted` 更像漏订阅，先补 App 订阅再判断其余 |
| 18 | 死校验：`ChatSteerResultSchema`、`SkillIdSchema`；生成物 `buildPreloadWhitelist`、`IpcRequest<T>` 无人消费 | `schemas.ts:39,199`、`gen/ipc.ts:156,174` | 删（生成器同步改 `scripts/gen.ts`） |
| 19 | `pushToRenderer` 向 `getAllWindows()` 广播 → 每个流式 chunk 都发给指针窗/Toast 窗/浮层窗/Agent 窗 | `index.ts:148-152` | 收敛到 mainWindow + 显式订阅窗口 |

### P1/P2：重复实现与单源破坏

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 20 | 品牌常量硬编码：`settings:about` 自写 `name/appId/protocol`，权威常量在 `shared/brand.ts`（注释明写「其他模块不得独立定义」） | `domains/settings.ts:820-829` | 改为 import |
| 21 | `searchUrlFor` 与 `buildSearchUrl` 同一 switch 两份（bing/google/baidu） | `core/preferences.ts:78` vs `contracts/omnibox.ts:20` | 保留 contracts 一份 |
| 22 | `ui/types.d.ts` 手写 `PermissionsState`、`LoopsoarEvent`（后者重复列了 `skills:updated`/`mcp:updated`），与契约重复 | `ui/types.d.ts:66,642` | 改用 `z.infer` / `EventName` |
| 23 | 两套 `McpServerSchema`（契约版无 superRefine，核心版才拦 http 无 url / stdio 无 command） | `schemas.ts:207` vs `core/mcp.ts:20` | superRefine 移入 contracts |
| 24 | 向量余弦两份：`vector.cosineSimilarity` 与 `retrieval.cosineSafe`；`hashEmbeddings`/`estimateVectorBytes` 0 引用 | `memory/vector.ts:89,94,325`、`retrieval.ts:187` | 保留一份 |
| 25 | `PermissionsState` 的 L0–L5 形式化分级（`SANDBOX_LEVELS/levelForTool`）只在本文件内自引用，未进 UI/审计 | `permissions.ts:104-211` | 接入设置页或删除 |

### P2：整洁度与体验

- `memory.accessCount` 全仓无自增、`totalAccess` 恒 0（UI 已在消费该字段）；`store.add()` 去重命中时返回无关条目；`archived` 数组无上限。
- `contextCompress` 压缩后的保留窗口可能以 `role:"tool"` 开头（上游会 400），当前调用方只喂 user/assistant 属潜在缺陷。
- `platform/web.ts` 已删除；若未来恢复 web 端，只需 `types.ts` 的 interface。
- E2E 钩子约 1,045 行挤在 `main/index.ts`（`scheduleE2E*` 8 个函数 + 40 个环境变量分支），应抽 `e2eHooks.ts`。
- i18n 约 120 个键疑似无引用（含动态拼接误报，需人工确认后再删）。
- `docs/decisions/ADR-0007/0008/0009` 三个独立文件与 `ADR.md` 内同号条目**主题不同**（0007=三体隔离 vs 记忆后端、0008=扩展运行时 vs MVP 范围、0009=UI 时间线 vs 安全验收），编号冲突需重排。
- 外层容器目录残留：`Parent%20file/`（路径转义 bug 产物）、`loopsoar download/`（空）、`.tmp/`（ADR 草稿）、约 30 个 `.loopsoar-data-*` E2E 数据目录；外层 `docs/` 是内层 `Parent file/docs/规划` 的**旧快照**（ADR-0002/0003 仍标「待验证」），两套 ADR 并存有误引风险。

---

## 6. 需要裁决的事项

1. **扩展权限交集（P0 级安全）**：修复会让「工具权限超出清单声明」的既有扩展注册失败，需要迁移策略（拒绝安装 / 降级只读 / 提示重新声明）。
2. **ADR-0011 定级**：是正式把「万物皆插件」降级为「扩展=唯一插件系统、仅 tools 贡献点」，还是排期补 PluginHost + 贡献点。
3. **`file:read`/`file:write` 去留**：删除收益是抹掉渲染层唯一直接写文件面；保留需补 UI 调用与守卫测试。
4. **Loop 回退语义**：接受「重放」还是要求「续跑」（后者要改 L2/L3 runner 契约）。
5. **core 子路径导出**：改 `./dist/*.js`（保留 tsc 产物）还是只发布 esbuild bundle。
6. **外层容器目录与外层 docs**：是否清理（涉及仓库外文件，未擅自删除）。

---

## 7. 验证基线（本轮结束）

```
pnpm -r typecheck                    # 5/5 exit 0
npx vitest run                       # 191 files / 1602 tests passed
pnpm build                           # 5/5 Done
pnpm gen && pnpm check               # 逐字节一致
git status --short                   # 仅本轮预期改动
```

---

## 8. 补充：浏览器子系统专项审计（同日补跑）

> 独立只读审计覆盖 browserHost / browserTools / browserAdapter / refs.ts / agentPointerWindow / chromePopover / toastWindow / browserRequestGuard / electronBrowser，逐条核对 16 个 `browser_*` 工具的门控、克隆、失败码。
> 结论：**「适配器一套、工具层一套」的担忧不成立**——生产只有 refs.ts 一套实现，适配器的 `click()/type()` 是零调用方死代码。

### 8.1 已修（本轮第二提交）

| 级别 | 缺陷 | 证据 | 修复 |
|---|---|---|---|
| **P0** | **敏感动作名单缺项**：只有 click/type/navigate/terminal_run——Enter 提交支付表单、下拉选「确认支付」、拖拽确认滑块都不触发确认；而 `browser` 档默认 allow，敏感闸是唯一拦截 | `core/src/sensitiveSteps.ts:48` | 名单补 `browser_press_key` / `browser_select` / `browser_drag`；新增 2 条回归用例（命中 + 不误报） |
| P1 | **等待就绪泄漏监听与定时器**：`waitDomReady` 每次导航 `wc.on("dom-ready")` 不移除、`setTimeout(done, 15s)` 不 clear | `browserAdapter/backends/webContentsView.ts:78-93` | settle 后 `removeListener`（对测试假件用可选调用）+ `clearTimeout` |
| P1 | **接管锁计数不随关页释放**：`lockAttempts` 只在手动解锁/删会话时清 | `main/browserHost.ts:216,907` | `closeTab` 内删 `session::tab` 键 |
| P1 | **前后退指针不回滚**：导航失败后 index 与真实页面脱钩，`canBack/canForward` 与地址栏永久错位（再点会跨两页） | `main/browserHost.ts:729-741` | 失败时回滚 index |
| P1 | **favicon 缓存只写不删**：每条最多 96KB，长时间浏览后主进程内存单调增长 | `main/electronBrowser.ts:146-182` | 上限 200 条，按插入顺序淘汰 |

### 8.2 待办（进第三阶段台账，需产品/安全口径）

| 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|
| **P0** | **敏感点击对 `#eN` 失明**：分类只看参数字符串，`browser_click` 的 schema 只有 `target`，文档主路径是 `#e5`；点「立即支付」传 `#e12` 时分类恒 false | `core/src/sensitiveSteps.ts:188`、`browserTools.ts:410` | 定位成功后用 `performTargetPoint` 已返回的 `label/role` 再判一次（需在工具层加确认通道，或把 label 回传给策略层复核） |
| **P0** | **浏览器侧 SSRF 比 web_fetch 松一档**：默认 `allowLoopback=true`（仅 `LOOPSOAR_STRICT_NET=1` 收紧）、无端口白名单；web_fetch 写死 `allowLoopback:false` → 可顶层导航到 `127.0.0.1:11434` 再读正文 | `browserRequestGuard.ts:115-155`、`browserTools.ts:1116` | 复用 `core/net/ssrf` 判据；回环改显式配置（默认关、E2E 才开）；回环导航加一次确认 |
| P1 | **后台会话抢前台视图**：`ensureAgentTab` 无条件 `showTask`，与「绝不切走用户所在会话」注释冲突，轮次结束也不恢复 | `browserHost.ts:1379,1408` | 仅 `sid === activeSession` 时切；后台只建标签 |
| P1 | **Agent 页面的新标签落错组**：`openInNewTab` 不传 sessionId/origin → 落到用户当前会话且 `agentBound=false` | `main/index.ts:1976`、`browserHost.ts:869` | window open handler 传回 `(sessionId, tabId)` 与 `origin:"agent"` |
| P1 | **新会话「首次快照→首次动作」必然 STALE_REF**：快照回落用户标签并回填 tabId，动作前取 `activeTabId(session)` 为 null，令牌迁移条件短路 | `browserHost.ts:1290-1296`、`browserTools.ts:1169-1182` | 迁移以 `lastSnapshotTab` 为来源键；或克隆后自动重快照一次 |
| P1 | **令牌跨标签错挂**：复用已有 agentBound 标签时仍把旧标签令牌改键挂到新标签 | `browserHost.ts:1356-1363` | 只在本函数新建标签时迁移；复用时删旧键让模型重快照 |
| P1 | **两张令牌表无界**：`snapshotTokens`/`lastSnapshotTab` 只在 `browser_tabs close` 清，UI 关页/删会话/fork 都不清 | `browserTools.ts:56-58` | 合并进 host 的 TabEntry，随标签生命周期释放 |
| P2 | 适配器 `click()`/`type()` 零生产调用，`scroll?/wait?` 无实现 | `browserAdapter/types.ts:81-94` | 删死接口，保留 `performClick/performType` 唯一入口 |
| P2 | `browser_dismiss_popup` 把任何异常映射成「没有可操作的网页标签」，找不到关闭控件时仍返回 `ok:true, escape` | `browserTools.ts:498`、`refs.ts:428` | 区分 NO_TAB/SCRIPT_ERROR/NOTHING_FOUND |
| P2 | `browser_navigate` 首次两次整页加载（先克隆加载源页、再加载目标页） | `browserTools.ts:1159` | 导航类工具用空白克隆，源=目标时跳过 |
| P2 | 缩放三源不一致；`setZoom` 忽略 tabId 且不持久 | `webContentsView.ts:130`、`browserHost.ts:1311` | 统一读 `wc.getZoomFactor()`；记入 TabEntry |
| P2 | `applyLayout` 重排所有会话所有标签；`browser_stateStore` 每次 set 全量同步读写 | `browserHost.ts:529`、`browserStateStore.ts:13-27` | 隐藏标签标 dirty；状态改内存 + 批量 flush |
| P2 | 失败码只在中文文案里，`ToolResult.error` 从不设置 → 无法按码聚合 | `browserTools.ts:440` 等 | 把 `perform*` 的 `code` 写进 `ToolResult.error`（契约变更） |
| P2 | 只读工具在会话无标签时回落用户全局标签，Agent 未开工即可读用户当前页 | `browserHost.ts:1290` | 结果显式标注来源，或加会话级开关 |

