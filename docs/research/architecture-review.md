# Loopsoar 架构复核：稳定性、灵活性与「自然生长」

复核时间：2026-11-17。范围：规则/记忆/工具/Loop 这一轮新增功能，以及它们与既有壳层、服务层、核心层的接缝。结论基于代码边界检查、持久化路径检查、IPC 契约守卫、全量测试与 E2E，不基于主观印象。

## 0. 结论先行

1. **稳定性：通过，但有明确的增长风险。** 新增功能全部走既有 domain + handleTrusted + contracts + dataDir 持久化模式；没有跨层 import（core 不依赖 shell/services，services 不依赖 shell，ui 不依赖 shell/services）。IPC 契约同步、通道 handler 守卫、sandbox/权限链、原子写都仍然成立。
2. **灵活性：通过。** 规则编译成守卫、清单、冲突检测都是纯函数，输入是 readRuleEntries 的条目；新增规则来源不需要改执行器。记忆 lesson 走 MemoryService.add；AI 回顾走可选 review 回调，不绑死模型。
3. **兼容性：通过。** 旧 memory.json 迁移、旧规则 workspace:AGENTS.md、旧 stats 缺 injected、旧候选缺 evidence/origin 都有迁移/容错；IPC 只增不改，gen/check 一致。
4. **自然性：大部分是自然生长，两处开始变「硬塞」。** 规则能力全部长在 Rules 域上，没有新建平行子系统；但 Settings.tsx 已经 2894 行、settings 域 966 行，规则页同时承载候选/守卫/冲突/清单/统计/历史六块，继续加功能会变成仪表盘。规则解析已在 2026-11-17 收拢到 core/rules/document.ts（guard/health/checklist/commandGuard 共用），剩余的主要技术债是 UI 门面。
5. **多 Agent 共享没有硬做。** 当前运行时是单活动 Agent；全局规则天然跨 workspace，记忆按 workspace 隔离且带 agentId/crossAgentLinks。强行加 per-agent 命名空间会是为了「清单上有」而造功能，不符合本次复核标准。

## 1. 复核方法与证据

- 依赖方向：grep core/services/ui 是否 import shell 或 services（结果 0 处）。
- IPC：manifest 每条通道必有 handler、registry 无死码（tests/guards/channels-have-handlers.spec.ts）；契约生成物逐字节校验（tests/guards/contracts-sync.spec.ts）。
- 持久化：检查 rules/candidates.json、rules/stats.json、rules/history.json、memory/vault 的写入路径与失败处理。
- 回归：全量 vitest 1778 用例；typecheck 5/5；build 5/5；gen/check 一致；E2E 规则页截图。
- 代码规模：index.ts 2864 行、Settings.tsx 2894 行、domains/settings.ts 966 行、services/chat.ts 792 行、core/tool_loop.ts 766 行。

## 2. 分层与数据流

    Contracts（request schema + gen manifest）
        │
    Shell main（Electron 生命周期、domain/IPC、dataDir 存储）
        │  domain 依赖注入（memory / rules / chat / browser / ...）
    Services（ChatService：流式编排、权限、工具执行、记忆/规则钩子）
        │
    Core（纯逻辑：llm / tools / sandbox / rules / memory / loop）
        │
    UI（React，经 preload 白名单调用 IPC；不直接碰主进程）

规则链路：

    readRuleEntries（全局 rules/*.md + 项目 AGENTS.md）
      ├─ currentRulesPrompt → system stable 段 + 自检清单
      ├─ compileRuleGuards → path deny → InternalToolExecutor
      ├─ compileCommandGuards → terminal deny → InternalToolExecutor
      ├─ analyzeRuleConflicts → 规则页体检
      ├─ buildRuleChecklist → 提交前自检
      └─ ruleStats（注入/命中） + ruleHistory（before/after）

记忆链路：

    captureFromTurn（五门） / ToolEvidence（连续失败 lesson） / AI 回顾候选
      → MemoryService.add / vault facts
      → recallPrompt（volatile） / 记忆面板

## 3. 稳定性审查

### 3.1 仍然成立的硬约束

- **IPC fail-closed**：未在 manifest 的通道拒绝注册；参数经 zod 校验；来源帧白名单；审计记录。新增 rules:* 通道全部走 handleTrusted。
- **权限链没有被绕过**：规则守卫位于 sandbox deny 之后、权限确认之前；规则 deny 不会降级成 confirm；敏感步骤确认仍然优先。
- **持久化 fail-open**：stats/history/candidates 写盘失败不影响工具调用或规则生效；索引/vault 仍以文件为真相。
- **原子写**：stats/history/candidates 使用 tmp + rename；规则文件直接写（沿用原有实现，未改变）。
- **规则路径安全**：回滚只允许 dataDir/rules 与已挂载工作区的 AGENTS.md/CLAUDE.md；历史被篡改整单拒绝。

### 3.2 新增风险

| 风险 | 位置 | 影响 | 建议 |
| --- | --- | --- | --- |
| 规则解析逻辑分散（已解决） | core/rules/document.ts | 原先五个文件各自切行；已统一为 parseRuleDocument，语义漂移风险显著下降 | 保持 document.ts 为唯一解析入口 |
| 门面文件过大 | shell/index.ts、Settings.tsx、domains/settings.ts | 合并冲突、测试定位、认知负担 | 规则子域拆出 rules 页面组件；settings 拆 prefs/providers/rules |
| 响应类型手工维护 | packages/ui/src/types.d.ts | 请求有 contracts，响应没有生成；字段新增靠人记得改 | 给关键响应加 zod schema 或共享类型 |
| 历史快照体积 | ruleHistory | 最多 100 条 × 多文件全文；规则上限 65KB，理论数 MB | 加总字节上限/压缩，或存 diff |
| stats 注入丢失窗口 | ruleStats | 1s 防抖内退出会丢注入计数 | app quit 时 flush |
| 命令守卫误报 | commandGuard | 命令字符串里出现 npm 即命中 | 已在文档标注；后续可只匹配命令首 token |
| AI 回顾成本 | ruleReview | 用户点一次可能 25s、消耗 token；无预算 | 加确认/费用提示或每会话一次限流 |

### 3.3 没有发现的问题

- 没有 core→shell/services 的反向依赖。
- 没有新增裸 ipcMain.handle；所有通道有契约与 handler。
- 没有把测试专用分支塞进生产路径；review 回调缺失时明确报错。
- 没有改旧数据格式的破坏性字段；旧 stats/候选/规则均可读。

## 4. 灵活性审查

### 4.1 扩展点

- **规则来源**：readRuleEntries 是唯一入口；新增全局/项目/未来 agent 级规则只需改这里，守卫/清单/体检自动受益。
- **执行边界**：ChatService.guardToolCall 是单一钩子；路径、命令守卫可继续增加类型，不需要改工具循环。
- **记忆写入**：MemoryService.add 是统一入口；工具 lesson、AI 候选、人工新增走同一治理。
- **LLM 能力**：reviewMemory / reviewSessionRules 都是可选回调；没有模型时功能降级，不阻塞主流程。
- **Loop**：runLoop 可插拔 + 安全模式回退未被破坏。

### 4.2 耦合点

- settingsDeps 同时承载 preferences/providers/rules/memory 路径，rules 的 stats/history/checklist/guards 都从这里注入；功能越多，settings 域越像「规则编排器」。
- UI 规则页把六个 box 塞进一个 case；数据获取在 Settings 初始化时一次性 Promise.allSettled，规则页变重。
- ChatService 同时负责规则注入、记忆注入、守卫回调、工具事件；services 层正在变成「上下文装配器」，与规划中的 T3 方向一致，但当前实现是硬编码钩子而非装配器。

## 5. 兼容性审查

- **旧 stats**：缺 injected 时迁移为 0，不丢命中（已测试）。
- **旧候选**：缺 evidence/origin 时按可选字段渲染；旧 status 不变。
- **旧规则**：未挂载工作区时保留 workspace:AGENTS.md 路径；旧 CLAUDE.md 仍可读。
- **旧记忆**：memory.json 首次加载迁移为 vault 的机制未动。
- **IPC**：只增通道；preload 由 gen 生成；contracts-sync 逐字节通过。
- **UI**：新字段均有空值容错（guards/commandGuards/conflicts/checklist/stats/history 缺失时最多空展示，不崩）。

## 6. 「自然生长」逐项审查

| 功能 | 接缝 | 判断 |
| --- | --- | --- |
| 候选抽取/存储 | core/rules/learn + shell store + chat afterUserTurn | 自然：与记忆抽取同构，未新开子系统 |
| 候选编辑/作用域 | rules:acceptCandidate + Settings 规则页 | 自然：确认动作的延伸 |
| 路径守卫 | core/rules/guard + 既有 executor 钩子 | 自然：规则变成权限边界，符合「规则不是强制」的结论 |
| 命令守卫 | core/rules/commandGuard + 同一钩子 | 自然，但覆盖范围刻意窄 |
| 冲突/重复 | core/rules/health + getRules 响应 | 自然：纯函数，不写文件 |
| 自检清单 | core/rules/checklist + currentRulesPrompt | 自然：规则投影，未改注入架构 |
| 注入/命中统计 | shell/ruleStats + settingsDeps | 基本自然；stats 进入 settingsDeps 略耦合 |
| 变更历史/回滚 | shell/ruleHistory + 保存/采纳点 | 自然：写路径的统一旁路；但保存点开始增多 |
| 工具失败 lesson | ToolEvidence + MemoryService.add | 自然：记忆的一种来源 |
| AI 会话回顾 | ruleReview + 可选 review 回调 | 自然：沿用 memoryReview 的「提议不写」边界 |
| 多 Agent 共享 | 未新增 | 正确：当前无 per-agent 会话维度，硬加会是假功能 |

**结论**：没有发现「为了清单而硬塞」的独立子系统。一处仍有「硬塞感」：规则页 UI 的六个 box。它们是增长导致的组织问题，不是架构方向错误。

## 7. 建议

### P0（下一步就该做）

1. ✅ **抽 RuleDocument 解析器（已完成）**：core/rules/document.ts 统一切行/去 bullet/跳过标题/清单/问句，提供 key/极性/body；guard/health/checklist/commandGuard 全部消费它。
2. **拆规则页面（未完成）**：Settings case 里拆出 RulesSection 组件（候选/守卫/体检/清单/历史各自子组件），Settings.tsx 只做导航与数据入口。
3. **响应类型契约化**：至少给 RulesSnapshot、MemoryListResult 加共享类型/zod，避免 UI 手工漂移。

### P1

4. 规则历史加总字节上限与 flush on quit；stats 同样 flush。
5. AI 回顾加「每次会话一次」限流或费用提示。
6. 命令守卫从「字符串包含」收紧到「命令首 token/包管理器调用」。

### P2

7. 把 ChatService 的规则/记忆/技能注入抽成 ContextAssembler（对应规划 T3），减少 services 层钩子数量。
8. 规则历史支持 unified diff 预览，而不只是 before/after 快照。

## 8. 最终判断

- **稳定性**：可以继续加规则能力；现有守卫/回滚/测试提供了安全网。主要风险是门面文件与解析重复，不是运行时正确性。
- **灵活性**：规则来源与执行边界都有单一入口；新增规则类型不需要改 Loop。
- **兼容性**：旧数据与旧 IPC 均未被破坏；新增字段全部可选/有迁移。
- **自然性**：整体是 Loopsoar 本体的延伸——规则走 Rules 域，记忆走 MemoryService，执行走既有权限链，Loop 只增加观察钩子。没有另起炉灶。下一步应先做「收拢」而不是继续加功能，否则规则页和解析器会先于架构失控。
