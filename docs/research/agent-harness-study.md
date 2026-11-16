# Agent Harness 调研：Pi 与同类项目，对 Loopsoar 的启示

> 调研时间：2026-11-16。对象：[earendil-works/pi](https://github.com/earendil-works/pi)（主要），以及 OpenHands、Goose、SWE-agent、browser-use、Cline、smolagents 的公开资料。
> 目的：为 Loopsoar harness 的下一阶段找可验证的设计模式，不是做功能清单。

## 0. 结论先行

1. Pi 的核心不是「功能多」，而是**把会话做成可分支的事件树、把扩展做成进程内模块、把接口做成 RPC/SDK**——三者都可以独立于模型供应商。
2. 会话持久化用 **JSONL 树（id/parentId）**，分支不复制文件、compaction 作为一条 entry 插入，原始历史永不丢。这是 Loopsoar 目前最大的结构性缺口。
3. 工具层值得抄的是「**输出治理**」：统一截断 + 溢出落盘 + 文件修改串行队列，而不是再加更多工具。
4. 代码模式（codemode）把多步工具调用压成一段沙箱脚本，只把结果给模型——是 token 效率的方向，但需要沙箱边界。
5. 安全上 Pi 明确说「审批不是边界」：真正的边界是 OS 用户/容器。Loopsoar 的确认弹窗是**防误触**，不是防提示注入，威胁模型要写清楚。

## 1. Pi 拆解

### 1.1 定位

- 自我描述：*minimal, extensible agent harness that you can make your own*；默认不做 sub-agents、不做 plan mode，鼓励用扩展/包补。
- 仓库结构：`packages/agent`（纯 loop）、`packages/ai`（统一 LLM API）、`packages/coding-agent`（CLI/TUI/SDK/RPC）、`packages/codemode`、`packages/evals`、`packages/mcp`、`packages/durable`、`packages/tui` 等。
- 门槛：Node 22.19+；安装器固定依赖；npm 包 `@earendil-works/pi-coding-agent`。

### 1.2 Agent loop（packages/agent/src/agent-loop.ts）

- 以 `AgentMessage` 为内部消息模型，**只在调用 LLM 的边界**转换成 provider message。
- `agentLoop(prompts, context, config, signal, streamFn)` 返回 `EventStream<AgentEvent, AgentMessage[]>`；事件含 `agent_start / turn_start / message_start / message_end / tool_call / tool_result / agent_end`。
- 循环外层处理**排队的 follow-up**；`steering messages` 在「当前 assistant turn 之后」插入，abort 会停当前 run 并把排队消息退回编辑器。
- `agentLoopContinue` 专用于重试：上下文已含 user/toolResult，不再新增消息。
- 工具变更（tool state changes）在下一轮请求前显式声明给模型，避免模型看到过期工具列表。

### 1.3 会话：JSONL 树 + compaction

- 每条 session entry：`{type, id, parentId, timestamp}`；分支 = 从任意 entry 继续，**同一文件内**形成树，不复制文件。
- 文件位置：`~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`；路径里的 `/ \ :` 替换为 `-`，便于按工作区分组。
- 版本迁移：v1 线性 → v2 树 → v3 角色统一；加载时自动迁移。
- Compaction 不是删历史：插入一条 summary entry，后续请求用它替换更早消息；原始 entries 保留在树里，可回溯。
- `SessionManager` 是「模型上下文」的权威：active leaf 决定分支；外部恢复历史必须通过 manager，直接改 messages 不生效。

### 1.4 上下文装配

- system prompt = 基础指令 + 发现的 context files + 工具定义 + **skills 的 name/description**（完整指令按需读取）+ 扩展可注入的片段。
- skills 遵循 [Agent Skills 规范](https://agentskills.io/specification)：目录 + `SKILL.md` frontmatter（name/description）+ 可选 scripts/references/assets；启动只扫元数据。
- prompt templates 在输入变成 user message 之前展开；选中的文件/图片/粘贴文本/shell 输出可成为消息内容。

### 1.5 工具层

- 内置：read / bash / edit / write / ls / grep / find / powershell；文件修改走 `file-mutation-queue.ts`（串行化，避免并发写冲突）。
- `output-accumulator.ts` + `truncate.ts`：统一输出预算，超限保留首尾并落盘，把路径交给模型。
- `edit-diff.ts`：编辑前生成 diff/校验，减少「改错文件」。
- `tool-definition-wrapper.ts`：工具定义与执行统一包装；`prepareLoadout` 可把工具声明隐藏（只能经由另一个工具到达）。

### 1.6 扩展模型

- **Extensions**：TypeScript 模块加载进主进程，工厂函数可注册 tools、slash commands、快捷键、providers、事件处理器、渲染器。
- **Skills**：按需加载的指令包（见上）。
- **Pi packages**：把 extensions/skills/prompts/themes 打包，经 npm 或 git 分发。
- **Codemode**：模型写 JS，跑在 QuickJS 沙箱里，通过 `tools`/`models` 调其它工具与非 LLM 模型；顶层 await/return；无 Node/FS/网络/定时器；默认输出 10k tokens、总输出 16MB 上限，超限落盘。适合并行调用、过滤大结果后再给模型。
- **MCP**：作为外部工具边界接入。

### 1.7 接口

- TUI（交互）、print（一次性）、JSONL（事件流）、RPC（stdin/stdout JSONL 命令）、TypeScript SDK（`createAgentSession` + `SessionManager`）。
- 所有接口复用同一套 agent/session 机制——这是「harness 可嵌入」的关键：UI 不是架构。

### 1.8 安全与信任

- `project trust` 决定是否加载项目设置与资源；加载后，工具用**进程的 OS 权限**执行。
- 文档明确：*审批/看日志/看 diff 不构成安全边界*；边界是 OS 用户、容器/VM、最小暴露的凭据与网络。
- 提示注入来源：文件、注释、命令输出、模型回复；trust 只控制启动资源，不使内容安全。

### 1.9 工程习惯（AGENTS.md）

- 先读完文件再大改；改前看同类实现；不滥用 `any`；只在信任边界做运行时校验；顶层 import；erasable TS；一个概念一个文件。
- 有 `packages/evals`（vitest 双配置：单测 + 场景评测）、telemetry、crash-log、迁移。

## 2. 同类项目速览

| 项目 | 一句话定位 | 可借鉴点 |
|---|---|---|
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | 自托管 coding agent 控制台，支持多后端/多 agent | 事件流驱动的 run 状态；sandbox runtime 与 UI 解耦 |
| [Goose](https://github.com/block/goose) | 桌面/CLI/API 的通用 agent | MCP-native 扩展；跨端同一 agent 能力 |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) / mini-swe-agent | issue→patch 的研究型 agent | ACI（agent-computer interface）极简主义：少工具、强约束、可复现 |
| [browser-use](https://github.com/browser-use/browser-use) | 浏览器 agent 库 | DOM/可访问性树 + 截图观察；动作空间小；云端 stealth/回放 |
| [Cline](https://github.com/cline/cline) | IDE/CLI/桌面 coding agent | 计划/执行分离；checkpoint 与人工确认 |
| [Stagehand](https://github.com/browserbase/stagehand) | 浏览器自动化原语库 | act/extract/observe 三原语，把「操作」与「取数」分开 |
| [smolagents](https://github.com/huggingface/smolagents) | 「think in code」的极简库 | code-as-action；沙箱执行 |
| [Aider](https://github.com/Aider-AI/aider) | 终端 pair programming | repo map（结构化上下文选择）、edit format 约束 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 有状态 agent 编排 | 显式图/检查点/恢复；durable execution |

## 3. 横向模式总结

1. **事件流是骨架**：Pi 的 AgentEvent、OpenHands 的 event stream、LangGraph 的 checkpoint——UI、持久化、回放都从事件派生。
2. **上下文是产品**：Pi 的 system prompt 装配、Aider 的 repo map、Cline 的 checkpoint——决定「模型看到什么」比工具数量更影响成功率。
3. **工具有预算**：输出截断/落盘、文件修改串行、编辑 diff 校验——防止上下文被一次命令撑爆。
4. **扩展边界统一**：Pi 的 extensions/packages、Goose 的 MCP、Cline 的 rules/workflows——都在回答「第三方能力怎么进来」。
5. **接口与核心解耦**：Pi 的 TUI/print/RPC/SDK 共用 agent；Loopsoar 目前是 Electron IPC 单一入口。
6. **安全是环境问题**：Pi 明确不做「逐调用审批=安全」；容器/OS 用户才是边界。审批是 UX，不是安全。

## 4. Loopsoar 对照

### 已有

- 工具注册/白名单、权限策略、敏感确认；浏览器工具与敏感点击二次确认；
- 会话存储、IPC 契约（manifest + gen）、扩展/MCP/技能、规则文件；
- 记忆模块（Markdown vault + 索引 + 回顾）；E2E 脚本与 ADR 记录习惯。

### 缺口（按影响排序）

1. **会话模型是线性的**：没有 branch/fork/retry-from-entry；compaction 与原始历史的关系不显式。
2. **没有统一的 run 事件日志**：UI 状态、工具调用、错误恢复各自维护，难以回放/审计/评测。
3. **工具输出治理不统一**：缺「统一截断 + 溢出落盘 + 文件修改串行队列」这层。
4. **只有 Electron IPC 入口**：没有 headless/RPC/SDK，CI 与第三方集成成本高。
5. **缺少 agent 级场景评测**：E2E 覆盖 UI，但「给一个任务，模型+工具能否完成」没有可重复评测。
6. **上下文装配分散**：system prompt 由多处拼接，缺一个显式的 assembler（base/rules/skills/memory/tool guidelines）。

## 5. 建议路线（按投入产出）

### P0：结构性地基（先做，后续都受益）

| 项 | 做什么 | 成本 | 收益 |
|---|---|---|---|
| 会话树 | sessions 改 JSONL 树（id/parentId/activeLeaf），保留线性兼容；支持 fork/retry | M | 分支实验、失败重试、审计 |
| 事件日志 | 每次 run 记录 agent/turn/tool/message 事件（JSONL），UI 从事件派生 | M | 回放、评测、恢复 |
| 上下文装配器 | 单一 `assembleContext()`：base + rules + skill 索引 + memory + tool snippets；技能只注入 name/description | S | 可解释、可测试、省 token |
| 输出治理 | 工具输出统一截断（首尾）+ 溢出落盘路径；文件写串行队列 | S | 防上下文爆炸、防并发写冲突 |

### P1：可验证与可嵌入

| 项 | 做什么 | 成本 | 收益 |
|---|---|---|---|
| 场景评测 | `packages/evals` 式：Mock LLM + 真实工具 + 断言最终状态 | M | 改 prompt/工具可回归 |
| Headless/RPC | 抽出无 Electron 的 run 入口，stdin/stdout JSONL 或 HTTP | M | CI、脚本、第三方客户端 |
| 技能按需加载 | 启动只扫 frontmatter，命中再读 SKILL.md | S | 大技能库不占上下文 |

### P2：进阶

| 项 | 做什么 | 成本 | 收益 |
|---|---|---|---|
| Codemode | QuickJS/WASM 沙箱内脚本编排工具，输出预算 | L | token 效率、并行调用 |
| 容器化执行 | 工具在容器/受限用户下跑，审批仅作 UX | L | 真正的安全边界 |
| 扩展分发 | extensions 打包/版本/签名（对齐 MCP 或 npm） | M | 生态 |

## 6. 不建议照搬

- **不要为了「像 Pi」而删功能**：Pi 刻意不做 sub-agents/plan mode，是因为它把选择权交给用户；Loopsoar 的定位是桌面浏览器 agent，计划/审批本身是产品价值。
- **不要用审批当安全边界**：与 Pi 的结论一致，容器/OS 权限才是边界；审批只防误触。
- **不要一开始就上 codemode**：没有沙箱与输出治理时，代码执行会把风险放大；先把 P0 的工具预算做好。

## 7. 参考

- Pi: <https://github.com/earendil-works/pi>（how-pi-works / session-format / compaction / skills / security 文档）
- Agent Skills 规范: <https://agentskills.io/specification>
- OpenHands: <https://github.com/All-Hands-AI/OpenHands>
- Goose: <https://github.com/block/goose>
- SWE-agent: <https://github.com/SWE-agent/SWE-agent>
- browser-use: <https://github.com/browser-use/browser-use>
- Cline: <https://github.com/cline/cline>
- smolagents: <https://github.com/huggingface/smolagents>
- Aider: <https://github.com/Aider-AI/aider>
- LangGraph: <https://github.com/langchain-ai/langgraph>
- Stagehand: <https://github.com/browserbase/stagehand>