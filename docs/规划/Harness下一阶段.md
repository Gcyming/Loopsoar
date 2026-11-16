# Harness 下一阶段任务（由 Pi/同类调研转化）

> 依据：[docs/research/agent-harness-study.md](../research/agent-harness-study.md)。
> 原则：先补结构性地基（P0），再做可验证/可嵌入（P1），最后才是进阶能力（P2）。每项都写验收标准，避免「做了但没法判断」。

## P0：结构性地基

### T1 会话树（JSONL + parentId）
- **目标**：会话从线性列表改为树；同一文件内 branch/fork，`activeLeaf` 决定上下文；保留旧会话迁移。
- **验收**：
  - 新会话写入 JSONL，每行 `{type,id,parentId,timestamp}`；
  - 可以从任意历史 entry 继续，生成分支，原分支不丢；
  - fork/clone 生成新文件或新分支，二者行为有测试；
  - 旧线性会话自动迁移，UI 能正常打开。
- **涉及**：`packages/shell/src/main/sessionStore.ts`、`packages/core/src/session.ts`、会话列表 UI。
- **依赖**：无。

### T2 Run 事件日志
- **目标**：一次 run 的 `agent/turn/message/tool_call/tool_result/error` 进事件流；UI 状态与持久化从事件派生。
- **验收**：
  - 事件落盘（JSONL）可按 session 回放；
  - 中断/恢复后 UI 能重建到中断前状态；
  - 工具调用与结果一一对应，含耗时与错误。
- **涉及**：ChatService、sessionStore、渲染层事件处理。
- **依赖**：T1（事件挂到 entry 树上更自然）。

### T3 上下文装配器
- **目标**：单一 `assembleContext()` 负责 base + rules + skills 索引 + memory + tool guidelines，禁止各处拼 prompt。
- **验收**：
  - 输入（session/工作区/模式）→ 输出可测试的 prompt 结构；
  - 技能只在命中时注入完整 SKILL.md，默认只注入 name/description；
  - 记忆注入有 token 预算与截断策略。
- **涉及**：`chat.ts`、`skills.ts`、`memoryService.ts`。
- **依赖**：无。

### T4 工具输出治理
- **目标**：统一截断（首尾保留）+ 溢出落盘路径 + 文件写串行队列。
- **验收**：
  - 任意工具输出超过预算时返回摘要 + spill 路径；
  - 同一文件的并发写被串行化；
  - 编辑前校验（diff/目标行）失败时不写盘。
- **涉及**：工具注册层、文件工具、shell 执行器。
- **依赖**：无。

## P1：可验证与可嵌入

### T5 场景评测
- **目标**：Mock LLM + 真实工具 + 断言最终状态；覆盖 agent loop、工具调用、记忆注入。
- **验收**：
  - `pnpm test:evals` 可独立运行；
  - 至少 5 个场景（读写文件、失败重试、敏感确认、记忆召回、长任务中断）；
  - CI 可跑，失败输出可定位到轮次/工具。
- **依赖**：T2。

### T6 Headless / RPC 入口
- **目标**：不启 Electron 也能跑一次 agent run；stdin/stdout JSONL 或本地 HTTP。
- **验收**：
  - 同一套工具/权限在 headless 下可用；
  - 事件流输出与 UI 一致；
  - 有最小客户端示例。
- **依赖**：T2；工具层不能依赖 Electron。

### T7 技能按需加载
- **目标**：启动只扫 frontmatter，命中再读全文。
- **验收**：技能库 50 个时 system prompt 不膨胀；命中记录可观测。
- **依赖**：T3。

## P2：进阶

### T8 Codemode（沙箱脚本编排）
- 目标：模型写脚本批量调工具，只回结果；QuickJS/WASM 沙箱 + 输出预算。
- 前置：T4 完成，且有沙箱边界。

### T9 容器化执行
- 目标：工具在容器/受限用户下运行；审批只作 UX。
- 前置：T6（headless 入口）。

### T10 扩展分发
- 目标：extensions 打包/版本/签名，对齐 MCP 或 npm。

## 建议顺序

T1 → T2 → T3 → T4 → T5 →（并行 T7）→ T6 → T8/T9/T10。

## 与当前记忆阶段的关系

记忆模块已收口；上述任务不再改记忆的数据格式，只在 T3（上下文装配）里接入现有 `recallPrompt` 与 token 预算。