# 规则文档如何运作：全网调研与机制拆解

调研时间：2026-11-16。范围：AGENTS.md / CLAUDE.md / Cursor Rules / GitHub Copilot / Windsurf / WorkBuddy(CodeBuddy) 的官方文档，以及规则自迭代相关的论文与工程实践。所有外部结论均附来源；未标注来源的部分是本文的分析。

## 0. 结论先行

1. 规则文档不是「配置」，而是**每轮注入上下文的自然语言指令**。模型把它当上下文，不把它当强制配置；真正能拦住动作的是工具网关、权限、hooks、沙箱。
2. 主流格式正在收敛到 **AGENTS.md**：根文件 + 嵌套文件，离被编辑文件最近的规则优先，显式聊天指令覆盖一切。官方站点称已有 6 万多个开源项目使用。
3. 加载方式分两派：**启动时全量拼接**（Claude 的 CLAUDE.md、Windsurf 的 always_on）与**按需加载**（路径 glob、模型判断、@mention）。前者稳定但占上下文，后者省 token 但可能漏。
4. 规则的遵从度随长度、抽象度、冲突数下降。Claude 官方直接建议 CLAUDE.md 目标 200 行以内；一篇 35+ 微服务的闭环实践把规则集控制在约 4,809 词（约 6,250 token，<5% 的 128K 上下文）。
5. **规则文档确实会「自己变化」，但通常是三条不同路径**：自动记忆（写 MEMORY.md，不改规则）、后台做梦（提出规则/技能修改，走 PR）、评审闭环（人工接受评审意见后追加规则）。把三者混为一谈，会误判「规则被 Agent 改了」。
6. 你观察到 WorkBuddy 随「只能/必须」变化，**更可能是 Memory 而不是 Rules**：官方把 Rules 定义为手动创建的配置文件，Memory 才是从会话自动抽取、每晚整理、注入系统提示的那一层。官方 FAQ 还建议记忆控制在 10–20 条。
7. 自迭代最大的风险不是「不学」，而是「学错」：CLR-Bench 发现自演化 Agent 往往把每次纠正记成例外，列表越来越长，却没学到背后的规则；固定给一条「命名分组」的提示反而提升 14.5–16.5 分。所以正确姿势是**候选 + 证据 + 人工确认 + 可回滚**，不是静默改写。

## 1. 规则文档是什么

AGENTS.md 的官方定位是「给 Agent 的 README」：构建/测试命令、代码风格、目录结构、安全注意事项，放在一个可预测的位置；README 给人看，AGENTS.md 给 Agent 看。它没有必填字段，就是标准 Markdown，按标题组织；官方明确说「把它当活文档（living documentation）」。

这带来两个直接后果：

- **格式极简**：没有 schema、没有编译器，模型靠自然语言理解。写得好不好，取决于具体、可执行、少歧义。
- **生态互通**：同一份 AGENTS.md 被 Codex、Cursor、Copilot、Windsurf、Gemini CLI、Aider、Amp、Jules 等读取；Claude Code 在仓库没有 CLAUDE.md 时也会读 AGENTS.md。规则因此从「某个产品的配置」变成「仓库的公共资产」。

参考：[agents.md](https://agents.md/)、[Claude Code memory](https://code.claude.com/docs/en/memory)。

## 2. 四种形态

| 形态 | 代表 | 优点 | 代价 |
| --- | --- | --- | --- |
| 单文件根规则 | AGENTS.md、CLAUDE.md、CODEBUDDY.md、GEMINI.md、CONVENTIONS.md | 简单、可 review、跨工具 | 项目大了会膨胀；所有规则每轮都进上下文 |
| 分层/嵌套规则 | 子目录 AGENTS.md、Claude 的 subdirectory CLAUDE.md | 就近生效，子项目自治 | 冲突时要有「最近优先」语义；发现成本高 |
| 模块化规则目录 | .claude/rules/*.md、.cursor/rules/*.mdc、.windsurf/rules/*.md、.github/instructions/*.instructions.md | 一文件一主题、可 scope、可启用/停用 | 需要元数据与加载器；规则多了会互相打架 |
| 记忆/技能等旁路 | CLAUDE.md 的 auto memory、Windsurf Memories、Cline Memory Bank、Skills | 不占常驻规则位、按需召回 | 不稳定、可能过时；和规则边界模糊 |

### 2.1 激活语义

Cursor 的规则用三个 frontmatter 字段决定何时进入上下文：alwaysApply、description、globs。四种类型分别是 Always Apply（每次会话）、Apply Intelligently（模型按 description 判断）、Apply to Specific Files（文件 glob 命中）、Apply Manually（@mention）。这是目前最清晰的「规则激活协议」之一。

Windsurf 同样有四种激活模式：Manual、Always On、Model Decision、Glob；工作区规则一文件一条，单文件上限 12,000 字符，全局规则上限 6,000 字符。它把 AGENTS.md 也纳入同一规则引擎：根目录 AGENTS.md 常驻，子目录 AGENTS.md 对所在目录 auto-glob。

Claude 的 .claude/rules/*.md 用 YAML 的 paths 做路径级加载；没有 paths 的规则在启动时加载，优先级与 .claude/CLAUDE.md 相同；路径规则在 Read/Write/Edit 命中文件时才加载。

GitHub Copilot 支持根 AGENTS.md、嵌套 AGENTS.md（最近的优先）以及 .github/instructions/*.instructions.md 的 applyTo glob；代码评审场景只自动读根 AGENTS.md，嵌套文件需要 instructions 路由。

参考：[Cursor Rules](https://cursor.com/docs/context/rules)、[Windsurf Memories & Rules](https://docs.windsurf.com/ja/windsurf/cascade/memories)、[Copilot repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions)。

## 3. 加载、优先级、作用域

### 3.1 AGENTS.md：最近优先

官方 FAQ 明确：规则冲突时，**离被编辑文件最近的 AGENTS.md 优先**；**显式聊天指令覆盖一切**。大型 monorepo 在每个子项目放一份，Agent 自动读目录树上最近的一份。OpenAI 主仓库在写作时已有 88 份 AGENTS.md。

这解释了一个常见困惑：根 AGENTS.md 写得再详细，子目录的一份也可能把它覆盖掉。规则不是「层层叠加的宪法」，更像「最近的路标」。

### 3.2 Claude：拼接 + 延迟加载 + 不作为 system

Claude 从当前工作目录向上逐级加载 CLAUDE.md 和 CLAUDE.local.md，全部拼接，不互相覆盖；从文件系统根到当前目录排序，越靠近当前目录越后读。子目录的 CLAUDE.md 不在启动时加载，而是在 Claude 读/写/编辑该目录文件时才加载。HTML 块注释在注入前被剥离，不占 token。

AGENTS.md 的支持有前提：仓库没有 CLAUDE.md 或 CLAUDE.local.md 时，才直接读 AGENTS.md；两者都有时只读 CLAUDE.md；也可以用 CLAUDE.md import AGENTS.md。这个细节很重要：跨工具共存时，不要让两个文件同时存在且内容分叉。

更关键的是：**CLAUDE.md 是作为用户消息（user message）在 system prompt 之后注入的**，不是 system prompt 的一部分。官方因此说它「是上下文，不是强制配置」；要阻止某个动作，应该用 PreToolUse hook。这打破了很多人的直觉：写在 CLAUDE.md 里的「禁止」并不会获得比用户输入更高的指令层级。

参考：[Claude Code memory](https://code.claude.com/docs/en/memory)。

### 3.3 Cursor / Copilot / Windsurf / WorkBuddy

- Cursor：Team Rules（团队/企业）、Project Rules（.cursor/rules）、User Rules（个人设置）三种作用域；主要靠 alwaysApply/description/globs 决定激活。
- Copilot：根 AGENTS.md、嵌套 AGENTS.md、.github/copilot-instructions.md、.instructions.md 的 applyTo；代码评审只读根 AGENTS.md 是一个实际限制。
- Windsurf：全局、工作区、系统（企业）三级；AGENTS.md 复用同一规则引擎；自动生成的 Memories 只存在本机、按工作区隔离，官方建议「要长期共享的知识，写成 rule 或 AGENTS.md，而不是依赖自动记忆」。
- WorkBuddy（腾讯 CodeBuddy 系）：Rules 是用户手动创建的行为规范文件（例如「代码必须加注释」），支持多层规则目录；**规则只在会话开始注入，新增/修改后需要新建会话才生效**。Memory 是另一套：从会话历史自动抽取事实/偏好/人物关系/跟进事项，每晚整理，注入系统提示作为背景，可在设置里增删改、关闭。

参考：[WorkBuddy 记忆](https://cloud.tencent.cn/document/product/1831/134444)、[WorkBuddy Rules FAQ](https://www.tencentcloud.com/document/product/1316/84402)、[CodeBuddy 规则说明](https://www.tencentcloud.com/document/product/1316/84402)。

## 4. 为什么写了规则却不生效

把原因分成六类，基本能覆盖实测中的绝大多数「规则失灵」：

1. **层级错觉**：规则在 system、user、tool 之间没有天然的强制力。OpenAI 的 Instruction Hierarchy 论文指出，模型经常把 system prompt 与用户/第三方文本等同对待，需要专门训练才会在冲突时忽略低优先级指令。Claude 的 CLAUDE.md 甚至明确是 user message。规则写得再硬，也只是「更可信的上下文」。
2. **注意力衰减（context rot）**：上下文越长，模型对其中信息的准确召回越差。Anthropic 把上下文称为有限资源，token 越多，注意力预算越少。规则文件从 50 行膨胀到 500 行，后面那些条目实际上在「陪跑」。
3. **位置效应**：启动时拼接的规则在长对话里会被后续工具输出、代码、日志淹没；按需加载的规则又可能在该生效的时候没有被触发（glob 不匹配、description 没命中、模型没判断出来）。
4. **抽象与冲突**：「代码要优雅」「注意安全」不可执行；「所有 IDisposable 必须 using」与「IHttpClientFactory 创建的 HttpClient 不要 dispose」会在具体文件上直接冲突。闭环规则论文里就记录了这个真实冲突，最后靠给第一条加 scope 限定解决。
5. **时序**：多数产品只在会话开始注入规则（WorkBuddy 明确要求新建会话）；Claude 的子目录规则在读到文件时才加载；Cursor 的 manual 规则不 @ 就不出现。改完规则立刻在当前轮追问「为什么没生效」，经常只是没重新加载。
6. **规则被当成事实**：规则里写「本项目用 pnpm」，但 lockfile 已经是 npm；模型会同时看到冲突证据。规则过期比没有规则更危险，因为它带来源自信。

## 5. 规则文档的自我迭代：五种现实机制

### 5.1 自动记忆旁路：Claude Auto Memory

Claude 在每个项目下维护 ~/.claude/projects/<project>/memory/，包含一个 MEMORY.md 索引和若干主题文件。它把记忆分成四类：user（角色/偏好）、feedback（纠正/确认）、project（进行中的工作/决策）、reference（外部信息在哪）。每次会话加载 MEMORY.md 的前 200 行或前 25KB（先到者为准），细节放主题文件；超过限制会提醒压缩/合并/删除。

关键设计：

- **它写的是 memory，不是 CLAUDE.md**；两者互补。CLAUDE.md 是人写的指令，auto memory 是模型自己写的学习与模式。
- **跳过能从中推导的内容**：架构、文件路径、调试修复不记；CLAUDE.md 已经说过的也不记。
- **不是每轮都写**：模型判断「未来会不会有用」才写。
- **机器本地**，同一 git 仓库的 worktree 共享，不跨机器同步。
- **容量治理**：索引超限会报错并要求重写；这实际上是一个「记忆也需要 compaction」的机制。

这直接回答了「规则会不会随使用变化」：在 Claude 里，变化的是 memory，规则文件仍然由人维护。

参考：[Claude Code memory](https://code.claude.com/docs/en/memory)。

### 5.2 后台做梦 + PR：GitHub Copilot Dreaming

Copilot 的 Dreaming 是目前最完整的「规则自迭代」产品化形态。官方 changelog 说它在后台反思过去的工作，改进未来的 agent 会话，当前有三类 dream：

- Personal memory curation：根据 agent 对话更新个人记忆，贴合个人偏好。
- Repository customization：管理仓库级记忆，并**提出对现有 skills 和 custom instruction files 的更新/改进**。
- Code review customization：把反复被接受的 code review 反馈变成 Copilot code review 的指导。

Dreaming 可以增加、更新、删除个人与仓库记忆；但对**已签入的 skills 和 instructions 的修改，会以 PR 形式提出，交给团队 review**。它是 opt-in 的，按 AI credits 计费。

这套设计把「自动学习」和「仓库变更治理」分开了：记忆可以自动增删，规则文件的变更必须走代码评审。这是 Loopsoar 最应该借鉴的边界。

参考：[GitHub Copilot Dreaming](https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/)、[Copilot Dreaming docs](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)。

### 5.3 评审闭环：Accumulated Behavioral Rules

论文《Self-Improving AI Coding Agents Through Accumulated Behavioral Rules: A Closed-Loop Framework》（arXiv:2607.13091，Microsoft）把「接受一条 review comment → 写成一条持久规则」做成闭环。部署在 35+ 微服务平台上，规则集从 5 条长到 18 条行为规则、15+ 语言规范、15 项自检清单；11 次记录会话中，被规则覆盖的错误类别的复发率为 0%。

它的规则不是一句自然语言，而是一个隐含 schema：

    Rule ID: R17
    Category: Architecture
    Trigger Origin: Human PR reviewer
    Scope: New internal HttpClient registrations
    Constraint: Add client to AllowIPV4Internal SSRF policy
    Rationale: Prevent runtime SSRF policy validation failures
    Checklist Map: Self-review item #9
    Added: 2026-02-28
    Traced To: PR review comment on missing SSRF allowlist entry

规则文件分五段：Behavioral Rules、Code Standards、Self-Review Checklist、Anti-Patterns、Workflow Rules。文件「append-friendly、单调增长」，但增长有治理：

- 判断标准是「这个错误是否会在别的上下文复现」，不是「这次错了没有」。
- 新反馈暴露旧规则太宽/太窄时，**原地细化**，保留 Rule ID。
- 重叠规则由更具体的那条 subsumes 更泛的那条。
- 冲突由团队在 PR 里裁决；例子就是 using 与 HttpClient 的生命周期冲突。
- 规则越具体越有效；早期规则宽泛，后期规则精确。
- 规则集约 4,809 词 / 6,250 token，占 128K 上下文 <5%。

这篇论文最重要的不是数字，而是**把规则、清单、评审、版本控制连成一个可审计的环**。规则不是写给模型看的散文，而是可追踪到一次评审事件的工程资产。

参考：[arXiv:2607.13091](https://arxiv.org/abs/2607.13091)。

### 5.4 社区的自改写实践

- create-agent-context：提供一个「自演化 AGENTS.md 结构」，让 Agent 读 AGENTS.md 里的自更新指令，完成任务后更新对应 context 文件并写 changelog。
- mcp-standards 的 SELF-LEARNING-GUIDE：用户纠正 Claude → 检测模式 → 统计频率 → 自动更新 CLAUDE.md。
- OpenClaw：Agent 内置 read/write/edit，系统提示里带 Self-Update 段，允许修改 AGENTS.md、把教训写进 MEMORY.md。

这些实践证明了可行性，但也暴露了共同问题：**没有证据分级、没有冲突检测、没有回滚**。一旦模型把一次口误写成规则，下一次它会一本正经地执行错误规则。

参考：[create-agent-context](https://www.npmjs.com/package/create-agent-context/v/1.1.0)、[mcp-standards self-learning guide](https://github.com/airmcp-com/mcp-standards/blob/v0.1.0-alpha.2/docs/guides/SELF-LEARNING-GUIDE.md)。

### 5.5 你看到的 WorkBuddy：更可能是 Memory

把官方文档放在一起看：

- WorkBuddy 的 Rules 是「你设定的行为规范」，需要手动创建配置文件；规则只在会话开始注入，修改后要新建会话。
- WorkBuddy 的 Memory 是「从会话历史中自动提取有价值的信息」，提取事实、偏好、人物关系、跟进事项，每晚整理当天会话，后续对话作为背景注入系统提示；用户可增删改、可关闭；官方建议记忆保持 10–20 条。

所以当你说「只能/必须」时，最可能发生的是：模型把这句偏好抽成了一条 Memory，下一轮以「背景信息」出现；Rules 文件本身没有被改写。你的观察「似乎会变化，也可能是 Agent 的设定」是准确的：变化的是自动记忆层，不是规则层。

这对产品设计的启示是：**UI 必须把「规则」和「记忆」分开呈现**，并且让用户能看到「这条是我写的规则，还是模型抽的记忆」。否则用户永远不知道哪一层在起作用。

参考：[WorkBuddy 记忆](https://cloud.tencent.cn/document/product/1831/134444)、[WorkBuddy Rules FAQ](https://www.tencentcloud.com/document/product/1316/84402)。

### 5.6 失败模式：不是学得越多越好

CLR-Bench（arXiv:2610.40758）设计了一条「隐藏规则课程」：每一层加一条没人告诉 Agent 的规则，规则作用在一个不透明的标签上（例如某个联盟的创始成员），练习只给一个成员和一个非成员，测试看没见过的成员与相似非成员。结果：

- 六种自演化方法在认证模型上「几乎没有学会」，最好只比冻结 Agent 高 5 分；排除掉的未见成员只有 6–12%，还不如直接保留原始练习历史（20%）。
- 这些方法的状态里，75–98% 存了「见过的成员」，但几乎从不存「类名」；练习暴露一个漏掉的成员，它们就把这个成员加进列表——典型的**例外清单**，不是规则。
- 给一条固定的「命名分组」提示，同样的方法提升 14.5–16.5 分。
- 换成更强的 GPT-6-Sol 后，ACE 和 Dynamic Cheatsheet 才能从反馈中学会，达到 78% 准确率。

结论：**自演化的瓶颈常常是「抽象能力」，不是「记忆容量」**。把每次纠正都追加成一条规则，会让列表变长、上下文变贵、泛化变差。规则学习必须回答三个问题：这是不是一个类？类的边界在哪？这条规则会不会和已有规则冲突？

参考：[arXiv:2610.40758](https://arxiv.org/abs/2610.40758)。

## 6. 规则、记忆、工具、Loop 的四层模型

| 层 | 本质 | 信任来源 | 变化速度 | 典型载体 | 失败模式 |
| --- | --- | --- | --- | --- | --- |
| Rule | 规范：应该怎样 | 人/评审/版本控制 | 慢 | AGENTS.md、rules/*.md | 过时、冲突、太泛、太长 |
| Memory | 描述：发生过什么/偏好 | 证据/重复/时间 | 快 | MEMORY.md、vault、memory.json | 幻觉、过时、隐私、膨胀 |
| Tool | 能力：能做什么/世界反馈 | 执行结果/权限 | 中 | registry、MCP、shell | 权限过大、结果噪声、失败不可见 |
| Loop | 控制：下一步做什么 | 预算/状态/事件 | 每轮 | ChatService、agent loop | 死循环、上下文爆、无反思 |

四者不是并列的四个模块，而是一个**证据 → 规范 → 行动 → 证据**的环：

    Loop 观察用户消息/工具结果
      → Tool 执行并产生可验证的结果（成功/失败/差异）
      → Memory 记录事实、偏好、情节与证据
      → 反思/评审把重复出现的模式抽象成 Rule 候选
      → 人确认后写入规则文件
      → 下一轮 Loop 把 Rule 注入 system/上下文
      → Tool 受规则约束（权限/守卫/清单）
      → 结果再次验证或推翻规则

### 6.1 五条反馈通道

1. 用户纠正：最高信号，但噪声也最大（口误、一次性要求）。
2. 工具结果：最客观，成功/失败/测试红绿/编译错误。
3. 代码评审：高质量、带理由，适合抽象成类级规则。
4. 重复错误：同类错误第二次出现，说明上次的修复没有沉淀。
5. 冲突/过期：新证据与旧规则矛盾，触发细化或废弃。

### 6.2 升降级机制

- 候选（candidate）：单次出现，只存证据，不进 prompt。
- 激活（active）：人确认/多次复现/评审接受，写入规则文件。
- 强化（reinforced）：再次出现，增加证据计数与置信度。
- 弱化（deprecated）：长期未命中、被新规则 subsumes、或证据显示过时。
- 冲突（conflicted）：与另一条规则在同一 scope 冲突，冻结并请人裁决。

### 6.3 注入预算

论文的规则集 6,250 token（<5%）；Claude 的 MEMORY.md 限制 200 行/25KB；Windsurf 单文件 12,000 字符。这些不是巧合，而是「规则是常驻成本」的工程约束。

一个可操作的预算：

- 常驻规则：不超过上下文窗口的 5%，或 200 行。
- 路径/主题规则：按需加载，不计入常驻。
- 记忆：只注入 top-k 相关条目，不整库注入。
- 工具 schema：只暴露当前任务需要的工具，避免工具描述挤占规则位。

参考：[Anthropic context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)。

## 7. 十二条设计原则

1. 规则是上下文，不是强制；强制交给工具/权限/hook。
2. 自动学习默认只写候选，不写规则文件；写文件必须有人或 PR 门。
3. 每条规则带来源（session/message/review）、作用域、理由、时间。
4. 一条规则只表达一个可判定的约束；禁止「优雅」「健壮」这类形容词。
5. 先判断「是不是一类」，再决定是否成规则；一次性 typo 不进规则。
6. 规则文件 append-friendly，但要定期去重、细化、废弃；不是只增不减。
7. 冲突要显式检测；同一 scope 内互相矛盾的规则必须冻结裁决。
8. 规则要能映射到自检清单/工具守卫，否则只是口号。
9. 控制常驻规则体量；超过预算就拆到路径规则/技能。
10. 规则变更可 diff、可回滚、可审计；不要静默改写。
11. 记忆与规则分层：记忆是证据，规则是结论；不要让记忆直接冒充规则。
12. 用「同类错误复发率」而不是「规则条数」衡量成功。

## 8. 对 Loopsoar 的映射

### 8.1 已有

- Memory：Markdown vault 为唯一真相，facts/archive/index，usage 事件，回顾/合并，hash 召回，索引与 fs.watch，评测脚本。
- Rules：全局 rules/*.md + 项目 AGENTS.md，按工作区隔离，session workspace 解析，system 稳定段注入。
- Tools：registry、权限分类、sandbox、审计、permission bus。
- Loop：ChatService 流式循环、工具调用、steering、上下文压缩、记忆自动汇总。

### 8.2 缺口

- 规则是静态的：没有从对话/工具结果/评审中学习。
- 记忆与规则不连通：记忆里的「用户偏好」不会变成候选规则，规则也不会引用记忆证据。
- 工具结果没有回流到规则：同类工具失败重复发生，系统不会提示「该沉淀一条规则」。
- 没有规则效能数据：不知道哪条规则被违反、哪条从未命中。
- 没有冲突检测/废弃机制：规则只增不减。
- 没有「规则 → 工具守卫」的编译：硬约束仍然只靠模型自觉。

### 8.3 已落地的第一刀：规则候选（本会话实现）

- core：extractRuleCandidates 从用户消息抽「必须/只能/不要/never/must」等硬约束，输出 key/text/quote/strength/scopeHint/confidence。
- shell：RuleCandidateStore 持久化候选，按工作区+key 去重、累加证据、限制 pending 数量。
- loop：ChatService 回合结束后调用 observe，只产生候选，不改规则文件。
- UI：规则页显示「学到 N 条候选规则」，可采纳/忽略；采纳后追加到项目 AGENTS.md 或全局 learned-rules.md，下一轮 system prompt 立即包含。
- 测试：抽取 6 条、候选生命周期 6 条；E2E 截图 e2e-evidence/rules-learned.png。

这一刀刻意不做「自动写规则」，就是为了避开 5.6 的例外清单陷阱：先让用户看见、确认，再让规则进入下一轮。

## 9. 路线图

P0（已完成）：候选抽取、去重/证据、人工采纳、项目/全局写入、UI 审核。

P1：
- 规则效能：注入次数、违反次数、最后违反时间；连续违反触发「规则太泛/未被遵守」提示。
- 冲突检测：同 scope 的否定/肯定规则、路径重叠、工具约束冲突。
- 自检清单：每条规则映射一个 checklist item，回合结束前自检（论文做法）。
- 记忆→规则：把高频 feedback 类记忆作为候选证据，而不是直接当规则。

P2：
- 工具守卫编译：把「不要改 dist/」「只能用 pnpm」编译成 deny/confirm 规则，接权限系统。
- PR 式规则变更：规则 diff、评审、回滚；多 Agent 共享同一套规则。
- 评测：同类错误复发率、规则命中率、上下文成本、候选接受率。

## 10. 指标

- 规则遵从率：抽样回合中，规则被违反的比例。
- 同类错误复发率：同一错误类在规则生效后再次出现的比例（论文的 0% 是目标，不是保证）。
- 候选质量：采纳率、误报率、平均证据数。
- 上下文成本：常驻规则 token 占比、规则文件行数。
- 规则健康度：冲突数、过期数、从未命中数。
- 记忆健康度：召回命中率、过期/矛盾条目比例。

## 11. 参考

官方文档与产品：
- [AGENTS.md](https://agents.md/)
- [Claude Code memory](https://code.claude.com/docs/en/memory)
- [Cursor Rules](https://cursor.com/docs/context/rules)
- [GitHub Copilot repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions)
- [GitHub Copilot Dreaming changelog](https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/)
- [GitHub Copilot Dreaming docs](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)
- [Windsurf Memories & Rules](https://docs.windsurf.com/ja/windsurf/cascade/memories)
- [Cline Memory Bank](https://docs.cline.bot/best-practices/memory-bank)
- [WorkBuddy 记忆](https://cloud.tencent.cn/document/product/1831/134444)
- [WorkBuddy Rules FAQ](https://www.tencentcloud.com/document/product/1316/84402)
- [Gemini CLI GEMINI.md](https://geminicli.com/docs/cli/gemini-md/)
- [Aider conventions](https://aider.chat/docs/usage/conventions.html)

论文：
- [Agentic Context Engineering (ACE)](https://arxiv.org/abs/2510.04618)
- [Dynamic Cheatsheet](https://arxiv.org/abs/2504.07952)
- [ExpeL](https://arxiv.org/abs/2308.10144)
- [Agent Workflow Memory](https://arxiv.org/abs/2409.07429)
- [Reflexion](https://arxiv.org/abs/2303.11366)
- [The Instruction Hierarchy](https://arxiv.org/abs/2404.13208)
- [Accumulated Behavioral Rules](https://arxiv.org/abs/2607.13091)
- [CLR-Bench: More Rules, Longer Lists?](https://arxiv.org/abs/2610.40758)
- [Anthropic: Effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)

工程实践：
- [create-agent-context](https://www.npmjs.com/package/create-agent-context/v/1.1.0)
- [mcp-standards self-learning guide](https://github.com/airmcp-com/mcp-standards/blob/v0.1.0-alpha.2/docs/guides/SELF-LEARNING-GUIDE.md)
