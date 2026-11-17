# 规则 × 记忆 × 工具 × Loop：协同设计

状态：第一版（2026-11-16）。配套调研见 docs/research/rule-documents.md；已落地的第一刀见 ADR-0132。

## 1. 目标与非目标

目标：让四层形成一个可审计的闭环，而不是四个各自增长的仓库。

- 规则：从「人写的静态文件」变成「有来源、有证据、可审核、可废弃的规范」。
- 记忆：从「聊天摘要」变成「规则的证据来源」和「工具经验的载体」。
- 工具：从「执行通道」变成「规则的执行边界」和「结果的 ground truth」。
- Loop：从「调模型」变成「观察 → 执行 → 反思 → 提议 → 再注入」的调度器。

非目标（本阶段）：

- 不让模型静默改写 AGENTS.md。
- 不做全自动规则挖掘（没有人工门）。
- 不把记忆整库注入上下文。
- 不为了「自进化」而牺牲可解释性和可回滚性。

## 2. 现状与缺口

现有数据流：

    user message
      → ChatService（system stable + memory volatile + skills）
      → LLM tool loop
      → tool result
      → assistant final
      → session append
      → memory.captureFromTurn
      → settings:getRules（下一轮）

缺口：

1. 规则只在人手动保存时变化；对话里的硬约束不会变成候选。
2. 记忆抽取和规则抽取是两条平行线，记忆不能给规则提供证据。
3. 工具结果只被展示/记录，不参与「这条规则是否有效」的判断。
4. 规则没有效能数据，无法知道哪条在起作用、哪条该废弃。
5. 规则与工具权限没有编译关系，硬约束仍靠模型自觉。

## 3. 目标架构

    ┌──────────────────────────────────────────────────────────┐
    │ Loop（ChatService）                                      │
    │  观察：用户消息 / 工具调用 / 工具结果 / 最终回复          │
    │  注入：system = 规则；volatile = 记忆 top-k；on-demand = 技能 │
    └───────────────┬───────────────────────────────┬──────────┘
                    │                               │
                    ▼                               ▼
    ┌───────────────────────────┐       ┌───────────────────────────┐
    │ Rule Engine               │       │ Memory                    │
    │ candidate → active        │◄──────│ facts / episodes / usage  │
    │ → reinforced → deprecated │ evidence│ recall / review / merge   │
    └───────────────┬───────────┘       └───────────────┬───────────┘
                    │                                   │
                    ▼                                   │
    ┌───────────────────────────┐                       │
    │ Tool Gateway              │                       │
    │ registry / permission     │                       │
    │ guard / audit             │                       │
    └───────────────┬───────────┘                       │
                    │ result                            │
                    └──────────────► evidence ───────────┘

## 4. 规则对象模型

### 4.1 候选（已实现）

候选是「可能的规则」，不是规则。字段：

    id           rc-xxxxxxxx
    key          去重键（去掉情态词/标点）
    text         可写入规则文件的规范句
    quote        用户原句（证据）
    strength     hard / should / prefer
    scopeHint    workspace / global
    confidence   0..1
    tags         ["硬约束","中文"]
    status       pending / accepted / dismissed
    workspaceId  归属项目（全局候选没有）
    sessionId    来源会话
    seenCount    出现次数（证据强度）
    createdAt / lastSeenAt / acceptedAt / promotedTo

约束：

- key 在同一工作区唯一；重复出现只累加 seenCount，不新建条目。
- pending 上限 80，settled 上限 40；防止候选本身膨胀成噪声。
- 采纳时才写文件；写入后 promotedTo 记录落点，便于回滚。

### 4.2 正式规则（下一阶段）

正式规则建议在 Markdown 之外维护一份 sidecar 元数据（或 frontmatter），不改 Markdown 的可读性：

    id            R-0007
    scope         workspace:<id> / global
    constraint    「不要修改 dist/ 下的文件」
    rationale     生成物不应手改
    evidence      [session:..., memory:..., review:...]
    checklist     「提交前确认没有改 dist/」
    enforcement   advisory / confirm / deny
    stats         injected, violations, lastViolatedAt
    status        active / deprecated / conflicted

Markdown 仍是唯一可读真相；sidecar 只存机器需要的数据（统计、证据、guard 表达式）。两者用稳定 id 关联。

### 4.3 生命周期

    observed → pending → accepted → active
                    │          │
                    │          ├─ reinforced（重复出现/再次违反）
                    │          ├─ deprecated（过期/被取代）
                    │          └─ conflicted（与其他规则冲突）
                    └─ dismissed（用户忽略）

转移规则：

- observed → pending：抽取器命中硬约束，写入候选。
- pending → accepted：用户点击采纳，写入 AGENTS.md / learned-rules.md。
- pending → dismissed：用户忽略；同 key 后续再出现时重新建候选（因为用户可能改主意）。
- active → reinforced：规则文本再次被用户重复，或工具守卫命中后仍被违反。
- active → conflicted：同 scope 出现语义相反/路径重叠的规则。
- active → deprecated：90 天未命中且被新规则 subsumes，或代码事实已改变。

## 5. Loop 的四个钩子

### 5.1 afterUserTurn（已实现）

在助手回复落库、记忆汇总之后调用：

    ruleLearning.observe({ sessionId, workspaceId, message })

只做三件事：抽取、去重、累加证据。任何异常都吞掉，不阻断对话。

### 5.2 afterToolCall / afterToolResult（第一版已实现失败证据）

工具结果是规则最好的证据：

- 同一工具、同一错误类连续失败 N 次 → 生成「经验」记忆，并提示候选规则。
- 权限拒绝/守卫命中 → 记录规则违反；如果用户随后重复同一约束，提升候选置信度。
- 工具成功且用户确认 → 记录「这条规则有效」的正证据。

事件建议：

    tool:result { sessionId, tool, ok, errorClass, durationMs }
    rule:violation { ruleId, tool, sessionId, evidence }

### 5.2.1 失败 + 纠正（第一版已实现）

工具失败证据现在会关联到规则候选：用户说「不对，应该用 pnpm」时，即使没有「必须/只能」，也会生成一条 how 候选，并在规则页显示最近的失败工具与错误。仍然只进候选，不自动写规则。

### 5.3 afterSession（第一版：手动会话回顾）

会话结束/切换时做一次轻量反思：

- 本轮是否出现「用户纠正 → 助手改对」？把纠正抽成候选。
- 本轮是否反复调用同一工具？考虑写成 workflow/skill，而不是规则。
- 本轮是否有未解决的冲突？写入待办，不自动改规则。

### 5.4 afterReview（P2）

接入代码评审/人工反馈：

- 接受的 review comment → 候选规则（论文的闭环）。
- 拒绝的 comment → 负证据，避免把一次争论写成规则。
- 规则变更走 PR/diff，保留 Rule ID 与来源。

## 6. 工具与规则的耦合

规则只有两种命运：被模型遵守，或被工具执行。后者更可靠。

### 6.1 守卫编译

把可判定的规则编译成工具网关策略：

| 规则 | 编译结果 |
| --- | --- |
| 不要修改 dist/ 下的文件 | write/edit 的 path glob 命中 dist/** → deny |
| 只能用 pnpm | shell 命令含 npm/yarn → confirm 或 deny |
| 提交前必须跑测试 | 调用 git commit 前要求 test 工具成功 → confirm |
| 不要读 .env | read/grep 命中 .env → deny |
| 所有项目必须加中文注释 | 无法编译成守卫 → advisory + checklist |

第一版已实现路径写入/读取守卫与包管理器命令守卫（只能使用 pnpm / 不要用 npm）：规则页会显示「已把 N 条路径禁令编译成工具守卫」，命中时工具不执行。命令类规则（只能用 pnpm）仍留给 prompt，等命令解析与白名单成熟后再编译，避免误杀。

不可编译的规则（风格、注释、设计原则）留在 prompt + checklist，不要假装能强制。

### 6.2 自检清单（第一版已实现）

论文的做法值得抄：每条规则映射一个 checklist item，回合结束前让 Agent 自检。

    ## 提交前自检
    - [ ] 没有修改 dist/（R-0007）
    - [ ] 使用 pnpm（R-0003）
    - [ ] 新增导出有中文注释（R-0011）

清单不是再写一遍规则，而是把规则变成「可勾选的最后一步」。它同时是评测数据的来源：哪一项经常被跳过，哪条规则就需要改写或加守卫。

### 6.3 工具结果的证据化

每次工具调用记录：

    { tool, argsHash, ok, errorClass, ruleIds, sessionId, at }

用途：

- 规则效能：某条规则生效后，相关错误类是否下降。
- 规则冲突：两个规则对同一工具给出相反要求。
- 候选证据：同类失败重复出现时，提示「这值得一条规则」。

## 7. 记忆与规则的耦合

### 7.1 分工

- 记忆回答「发生过什么、用户偏好什么」；规则回答「应该怎么做」。
- 记忆是证据，规则是结论；不要让记忆直接变成规则。
- 规则可以引用记忆 id 作为来源；记忆可以引用规则 id 作为「已沉淀」。

### 7.2 召回与注入

- 规则：稳定段，按 workspace 解析，每轮重新读取（保存后即时生效）。
- 记忆：易变段，按当前消息召回 top-k，不整库注入。
- 技能：按需加载，不常驻。

这样既保护 KV 前缀缓存（稳定段不因记忆变化而重写），又保证规则的新鲜度。

### 7.3 去重

同一条约束可能同时出现在：

- 用户消息（候选）
- 记忆（feedback 类）
- AGENTS.md（正式规则）

处理顺序：先查正式规则（key 相同 → 只累加证据），再查候选（key 相同 → 证据+1），最后才考虑写记忆。避免「规则、候选、记忆」三份重复。

## 8. UI 面

已实现：

- 规则页「学到 N 条候选规则」：文本可改写、作用域可选（项目/全局）、出现次数、关联工具失败、采纳/忽略。
- 采纳后合并预览立即更新，下一轮 system prompt 包含新规则。
- 候选为空时不占版面。

下一阶段：

- 规则健康面板：守卫命中次数、注入次数、冲突/重复标记（第一版已实现；prompt-only 规则的违反仍无法自动判定）。
- 规则历史/回滚：保存/采纳记录 before/after，规则页最近 5 条可回滚（ADR-0141）。
- AI 会话回顾：rules:reviewSession 提炼候选，仍走人工确认（ADR-0143）。
- 变更 diff：采纳前预览「将追加到 AGENTS.md 的哪一行」。
- 来源跳转：从候选跳到原会话消息；从规则跳到证据记忆。
- 一键停用/回滚：从 AGENTS.md 移除对应行，保留审计记录。

## 9. 失败处理

- 抽取失败：静默，不阻断对话；候选文件损坏时从空开始，不让 UI 崩。
- 写入失败：候选保持 pending，提示错误；不标记 accepted。
- 重复采纳：拒绝（已处理），避免重复写文件。
- 未知工作区：拒绝写入，提示先挂载项目。
- 规则冲突：不自动裁决，标记 conflicted，交给用户。
- 规则过期：不自动删除，标 deprecated，保留可恢复。

## 10. 评测

离线：

- 抽取集：中文/英文硬约束、问句、假设、一次性要求、代码块；precision/recall。
- 候选生命周期：去重、证据、采纳、忽略、未知 id。
- 规则注入：采纳后 system prompt 包含、停用后不包含。

在线（P1）：

- 同类错误复发率：规则生效前后对比。
- 候选接受率：采纳/展示。
- 规则违反率：守卫命中/注入次数。
- 上下文成本：规则 token 占比、候选/记忆注入量。

## 11. 分阶段落地

P0（本会话已完成）：
- 抽取器 + 候选存储 + afterUserTurn 钩子 + IPC + UI + 测试 + E2E。

P1：
- 规则 sidecar 元数据与效能统计。
- 冲突检测（同 scope 否定/路径重叠）。
- 自检清单生成。
- afterToolResult 证据回流。

P2：
- 守卫编译器（规则 → 权限策略）。
- PR 式规则 diff/回滚。
- 评审闭环（接受 review comment → 候选）。
- 多 Agent 共享规则与记忆。

## 12. 验收标准

- 任何规则文件变更都能追溯到来源（人/会话/评审）。
- 任何自动学习都先进入候选，不直接改规则。
- 采纳后下一轮 system prompt 必须包含；停用后必须不包含。
- 候选/规则/记忆三处不出现同一约束的重复注入。
- 规则集常驻 token 不超过上下文预算的 5%（或 200 行）。
- 每个硬规则要么有守卫，要么有 checklist；不允许「写了但没人执行」。
