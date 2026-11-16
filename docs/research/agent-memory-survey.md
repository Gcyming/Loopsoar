# Agent 记忆机制全网调研（2026-11-16）

> 目的：为 Loopsoar 第三阶段「记忆板块」做前置研究——**先看清别人怎么做的、代价是什么、哪些能直接抄、哪些是坑**，再动手改代码。
> 方法：一手论文（arXiv）+ 官方文档（Letta / Mem0 / Graphiti / LangMem / Cognee / Claude Code / Cursor）+ 产品公告（Claude 记忆）+ 工程报告（Chroma Context Rot）+ 我们自己的实现（packages/core/src/memory 与 shell 装配）。
> 结论先行：**记忆系统的难点不在「存」和「搜」，而在「写什么、何时写、怎么改（冲突/时效）、怎么忘、怎么注进上下文」这五件事**。
> 修订（同日）：读 slime 项目后有三处需要收窄（Zep 的 +18.5% 是对全上下文基线的增益、图在 Mem0ᵍ 上是负收益、遗忘无实证增益），见 [slime-memory-review.md](slime-memory-review.md) §4。业界已收敛出三条主线（OS 分页派、抽取-巩固派、时序图谱派），它们各自解决不同的问题，且都承认同一件事：**记忆是上下文工程的一部分，不是独立数据库**。

---

## 1. 十二结论（可直接用于决策）

1. **别把记忆当数据库做**。所有成熟方案都把记忆当作「下一轮 prompt 的输入物料」，写入与检索都由上下文预算驱动（MemGPT、Mem0、Letta、LangMem 一致）。
2. **写入必须有治理，不能无脑追加**。Mem0 的核心不是向量库，而是「抽取 → 与已有记忆比对 → 新增/合并/替换/忽略」这条管线；无治理的追加式记忆在几周内就会变成互相矛盾的噪声（这也是 Mem0 后来加 Dream 的动机）。
3. **冲突要显式建模，用「时效」而不是「覆盖」**。Graphiti 的 bi-temporal（事实生效时间 vs 记录时间）与 Mem0 Dream 的 supersede（标记旧的过期而不是删除）是同一思想：**保留历史，读取当前**。LongMemEval 把「knowledge updates」列为五大能力之一，说明这是刚需而非加分项。
4. **记忆需要三种类型，不是一种**：semantic（事实/偏好）、episodic（经历过什么）、procedural（怎么做/规则）。LangMem 三者齐备；Letta 用 memory blocks + MemFS 文件 + skills 近似；我们目前只有 semantic 一类（layer 字段区分 working/episodic/semantic，但写入路径没有真正区分）。
5. **检索要多信号融合**。纯向量在「同词不同义」「时间限定」「多跳」上都会翻车；Graphiti 用「向量 + BM25 + 图遍历」融合，HippoRAG 用 Personalized PageRank 做多跳，LongMemEval 的消融显示「会话结构化 + 时间感知查询扩展」提升显著。
6. **分层摘要与图索引解决「大局观」问题**。RAPTOR 的树（递归聚类+摘要）与 HippoRAG 的图（实体+PPR）都在回答同一个问题：**细节之外还有结构**。只有扁平 chunk 的系统，遇到「这个项目的整体技术选型是什么」这类问题会失明。
7. **遗忘是特性不是缺陷**。MemoryBank 用艾宾浩斯遗忘曲线（时间 + 重要性）；Mem0 的 decay 是 0.3×–1.5× 的**排序缩放**，明确「永不筛掉候选」；Letta/Mem0 的「dream」把巩固放到后台。**衰减只影响排序、归档只软删除**，是业界共识的两条安全线。
8. **巩固（consolidation）必须是后台任务**。Mem0 Dream 的三件事（合成模式 / 取代过时 / 合并重复）与 sleep-time compute（离线预计算，测试时算力降约 5×）指向同一个工程结论：**别在用户对话的关键路径上做昂贵的记忆维护**。
9. **注入位置决定缓存成本**。稳定前缀（身份/规则）进 system，易变内容（召回/时间/技能）挂末段 user——这是我们已经在做的（chat.ts:480-528），也是 Anthropic 上下文工程与各家 caching 实践的共同要求。Chroma 的 Context Rot 报告（18 个模型）进一步说明：**上下文越长，模型对其中任何一段的利用都越不可靠**，所以「少而准」优于「多而全」。
10. **记忆要有归属维度**。产品侧已收敛为 user / project / org 三级（Claude 的项目级记忆、Cursor 的 Project/User/Team rules、LangMem 的多级 namespace）。我们目前是**全局单库 + agentId**，缺 workspace 维度——这正是第三阶段要补的。
11. **可解释与可编辑是产品底线**。Claude 记忆明确提供「查看/编辑/项目隔离/无痕会话」；Letta 的记忆是 agent 自己可读写的文件。用户必须能看见「你记住了我什么」，否则记忆会变成不可控的偏见来源。
12. **评测要分层**。LoCoMo（超长对话，300 轮 / 9K token / 35 会话）、LongMemEval（5 项能力 / 500 题）、MemBench、MSC、DMR——单看一个基准会被带偏；至少要覆盖「单跳 / 多跳 / 时序 / 更新 / 拒答」五类，并同时记录 token 成本与 P95 延迟。

---

## 2. 记忆的分类学

### 2.1 按内容（认知科学借来的三分法）

| 类型 | 内容 | 例子 | 典型载体 |
| --- | --- | --- | --- |
| semantic | 事实、偏好、约定 | 「用户偏好 pnpm」「项目用 Postgres」 | 向量库 + 元数据 |
| episodic | 经历过的事件、时间线 | 「上周三排查过这个 OOM」 | 事件日志 + 摘要 |
| procedural | 怎么做、规则、技能 | 「发版前先跑 gen/check」 | 规则文件 / 技能库 / 提示词 |

LangMem 的概念指南把这三分法讲得最清楚，并额外区分「意识形成（对话中即时写）」与「潜意识形成（后台整理）」（https://langchain-ai.github.io/langmem/concepts/conceptual_guide/）。Voyager 的「技能库」（可执行代码）与 Reflexion 的「反思文本」则分别把 procedural 与 episodic 推到了极端形态：**技能必须是可执行/可复用的，反思必须是可回灌的自然语言**。

### 2.2 按载体

- **上下文窗口内**：core memory blocks（Letta）、system 段（我们）、FIFO 队列（MemGPT 的主上下文）。
- **外部存储**：archival memory（向量库）、recall storage（消息库）、图数据库（Graphiti/Cognee）、关系库（Cognee 的三库合一）。
- **文件系统**：Letta 的 MemFS（git 版本化的记忆仓库）、Claude Code 的 CLAUDE.md 与 auto memory、Cursor 的 .cursor/rules。**这条路线对我们最有参考价值**——本地优先、可 diff、可导出、用户可手改。
- **权重**：持续学习/微调。业界共识是「记忆 ≠ 改权重」：成本高、不可解释、不可撤销（Letta 与 Mem0 都明确走「外部持久化 + 上下文注入」）。

### 2.3 按归属（决定隔离边界）

| 维度 | 说明 | 谁在用 |
| --- | --- | --- |
| user | 跨项目、跨会话的个人偏好 | Mem0 的 user_id、LangMem 的 namespace |
| agent | 某个 Agent 自己的经验/人格 | Letta（agent 自己的 memory repo）、我们的 agentId |
| project / workspace | 某个项目/工作区的知识 | Claude 的项目记忆、Cursor 的 Project Rules、Claude Code 的仓库级 auto memory |
| session | 当前会话的临时上下文 | 所有系统的 short-term / working memory |
| org / team | 团队共享 | Cursor Team Rules、Letta 共享记忆仓库 |

> **对我们的直接含义**：第三阶段要补的是 **workspace（工作区）维度**。我们已有「工作区 > 会话 > 网页」的层级（ADR-0015/0094），记忆应当挂在工作区上，而不是全局文件里。

### 2.4 按生命周期（七个动作）

~~~
触发（何时写） → 抽取（写什么） → 治理（去重/合并/替换/冲突） → 存储（结构化+向量+图）
   → 检索（何时读、读什么） → 注入（放哪、放多少） → 衰减/巩固/归档（怎么忘）
~~~

后面第 4–8 节就按这条链展开；这是我认为最有用的一张「地图」。

---

## 3. 七大流派（机制、优点、代价、可借鉴点）

### 3.1 OS 分页派：MemGPT / Letta

**机制**。MemGPT 把 LLM 的上下文当成「内存」，把外部存储当成「磁盘」，用函数调用在两者之间搬数据（virtual context management）：主上下文（system instructions + working context + FIFO 队列）与外部上下文（recall storage = 历史消息、archival storage = 长期文档/事实）分离；上下文快满时把 FIFO 头部「驱逐」并写入归档，需要时再由模型主动检索（`archival_memory_search` / `conversation_search`）。论文在文档分析与多会话聊天两个域验证（https://arxiv.org/abs/2310.08560）。

**Letta 的工程化演进**（值得单独看）：
- **memory blocks**：人格/用户/项目上下文以「带 label 的 Markdown 文件」存在 agent 自己的 git 仓库里（MemFS）；`system/` 下的文件每轮都进系统提示，其余文件只在上下文里暴露**文件树**，由 agent 按需读取——即「记忆是文件，读是工具调用」（https://docs.letta.com/agent-sdk/memory/index.md）。
- **dreaming / sleep-time subagents**：后台整理记忆（合并、重写、总结），与 Mem0 Dream 撞名同理。
- **共享记忆仓库**：多个 agent 可以挂同一个仓库，等价于「团队级记忆」。

**优点**：显式的读/写工具让模型对记忆有自主权；分页解决上下文上限；文件形态可 diff、可导出、可手改。
**代价**：模型要会「管理记忆」（多一轮工具调用 = 多一轮 token 与延迟）；文件树需要好的命名规范，否则会退化成一堆无序笔记。
**可借鉴**：① 记忆「可读文件」而不是黑盒向量库，对本地优先产品是巨大优势；② 主上下文里只放「索引/摘要」，细节靠工具取；③ 后台 dreaming 是我们最该补的一块。

### 3.2 抽取-巩固-检索派：Mem0

**机制**。Mem0 的核心是一条写入管线：新消息 → LLM 抽取「值得记住的事实」→ 与已有记忆做**上下文查找** → 判定 ADD/UPDATE/DELETE/NOOP（2025 版文档已改为「以 ADD 为主 + 后台 Dream 做 supersede/merge/synthesis」）→ 去重、向量化、实体链接 → 分别写入 SQL（事实+元数据）、向量库（语义）、实体库（关系）。检索时 `search` 返回候选，由应用决定塞哪些进 prompt（https://docs.mem0.ai/core-concepts/how-it-works.md、https://docs.mem0.ai/core-concepts/memory-operations/add.md）。

**工程细节（最值得抄的部分）**：
- **Dream**（后台整理）：Supersede（新事实与旧事实矛盾 → 把旧的标记为过时，**默认开启**）、Merge（重复折叠成一条规范记忆，默认开启）、Synthesis（把多条记忆合成为更高阶的「模式记忆」，按项目开关）。文档明确：pattern memories 是**追加**，不替换原记忆（https://docs.mem0.ai/platform/features/dream.md）。
- **Memory Decay**（排序缩放）：每条记忆维护「上次检索时间 + 次数」，检索时乘一个 0.3×–1.5× 的系数；**永不筛掉候选**，只是重排；默认关闭、按项目开启（https://docs.mem0.ai/platform/features/memory-decay.md）。
- **Graph Memory**：从记忆文本里抽实体（人/地/组织/概念）做节点，共享实体的记忆连边，用来回答「关于 Alice 我们知道什么」这类跨会话问题（https://docs.mem0.ai/open-source/features/graph-memory.md）。
- **Advanced Retrieval**：可选 rerank，官方标注额外 150–200ms（https://docs.mem0.ai/platform/features/advanced-retrieval.md）。

**效果（论文口径）**：在 LOCOMO 上，Mem0 相对 OpenAI 记忆的 LLM-as-judge 提升 26%（相对值），带图记忆再高约 2%；相对 full-context 方法，p95 延迟降低 91%、token 成本节省 >90%（https://arxiv.org/abs/2504.19413）。**注意这是相对 full-context 的成本对比，不是绝对成本**。

**优点**：写入治理最完整；成本/延迟有明确的量化叙事；产品化程度高。
**代价**：写入依赖 LLM 抽取（每次写入一次模型调用）；抽取质量决定一切，抽错会污染整个记忆库。
**可借鉴**：① Dream 的三件事（supersede/merge/synthesis）直接对应我们要补的「冲突/合并/巩固」；② decay 的「排序缩放而非过滤」是最安全的遗忘实现；③ 实体图可以后置，但**实体链接字段**应尽早留位。

### 3.3 时序知识图谱派：Zep / Graphiti

**机制**。Graphiti 把记忆建成「上下文图（Context Graph）」：事实是三元组（实体-关系-实体），边带**时序元数据**（生效时间、失效时间、记录时间），数据以**episode**（离散事件）增量摄入，保留来源；检索用「向量 + BM25 + 图遍历」融合，官方强调**不做 LLM 参与的 rerank**（https://help.getzep.com/graphiti/getting-started/overview.md）。

**关键概念**：
- **bi-temporal**：一条事实有两个时间轴——「何时为真」与「何时被系统知道」，因此可以回答「上周三时我们认为的负责人是谁」。
- **fact invalidation**：新事实与旧事实冲突时，旧边被标记失效而不是删除。
- **episodic processing**：每条输入是一个 episode，边可追溯到 episode，形成 provenance。
- **custom entity types**：允许领域自定义实体类型（提高精度）。

**效果（论文口径）**：DMR 基准 94.8% vs MemGPT 93.4%；LongMemEval 上准确率最高提升 18.5%，同时延迟降低约 90%（https://arxiv.org/abs/2501.13956）。

**优点**：时序与冲突处理最严谨；多跳与实体中心查询最强；provenance 天然。
**代价**：需要图数据库（Neo4j/FalkorDB/Neptune）与抽取管线；维护成本高；对「纯偏好类」记忆是杀鸡用牛刀。
**可借鉴**：① **bi-temporal 的两个时间戳**我们必须加（现在只有 `timestamp` 与 `lastAccessed`）；② 「失效而非删除」；③ episode 化写入是 provenance 的最小实现。

### 3.4 记忆流派生式代理派：Generative Agents

**机制**。每个 agent 维护一条 **memory stream**（自然语言事件流）；检索时用三个分数加权——**recency（指数衰减）、importance（LLM 打分 1–10）、relevance（与查询的相似度）**；定期触发 **reflection**：把低层观察总结成更高层的洞察（「他喜欢早起」），再写回流中（https://arxiv.org/abs/2304.03442）。

**优点**：极简、可解释、无需图库；reflection 让「洞察」与「原始事件」共存。
**代价**：检索是每次全量打分（规模上不去）；importance 依赖 LLM 打分（成本）；没有冲突处理。
**可借鉴**：① **recency/importance/relevance 三因子加权**是我们 `effectiveValue × (0.3 + similarity) + tagBonus` 的直系亲属，可以把 importance 从「写入时静态值」升级为「可被反思修正」；② reflection（把多条记忆合成为洞察）与 Mem0 Synthesis 是同一件事，适合放在后台。

### 3.5 Zettelkasten 自组织派：A-MEM

**机制**。借鉴卡片盒笔记法：每条新记忆生成一张「结构化笔记」（上下文描述、关键词、标签），系统再分析历史记忆寻找可连接项，建立链接；新记忆的加入还会**反向更新旧记忆的上下文与属性**（memory evolution）——记忆网络自我精炼（https://arxiv.org/abs/2502.12110）。

**优点**：链接与演化让记忆越用越「结构化」；不需要预先定义 schema。
**代价**：每次写入都可能触发对历史条目的更新（成本与一致性风险）；链接过多会噪声化。
**可借鉴**：我们已有 `links/backlinks` 与「第 4 闸建链」，但**没有「反向更新旧条目」**这半步；A-MEM 的「note 属性（关键词/标签/上下文）」提示我们应该把「是什么/为什么记/关联谁」显式化。

### 3.6 图索引与分层摘要派：HippoRAG / RAPTOR

- **RAPTOR**：递归地对文本块聚类、摘要、再聚类，形成一棵「不同抽象层级」的树；检索时在不同层级取（https://arxiv.org/abs/2401.18059）。解决「全局性问题」（总结、主题）与「细节问题」并存。
- **HippoRAG**：用知识图谱 + Personalized PageRank 模拟海马体索引，一次检索完成多跳；论文报告多跳 QA 提升最高 20%，且比 IRCoT 这类迭代检索便宜 10–30 倍、快 6–13 倍（https://arxiv.org/abs/2405.14831）。

**可借鉴**：① 我们已有「记忆分层（layer）」字段但没有真正的**摘要层**——工作区记忆里应该有「项目摘要」这一层，由后台任务从细节记忆合成；② 多跳可以先用「链接 + 1 跳扩展」实现，不必上图数据库。

### 3.7 OS 分层 + 热度迁移派：MemoryOS

**机制**。三级存储：short-term（STM）、mid-term（MTM）、long-term personal（LTM）。STM→MTM 按「对话链 FIFO」更新；MTM→LTM 用**分段页（segmented page）**组织；四个模块：存储、更新、检索、生成（https://arxiv.org/abs/2506.06326）。

**优点**：把「热度」与「结构」结合；迁移有明确策略；对长对话场景友好。
**代价**：分级阈值需要调；页组织对代码/项目类语料未必最优。
**可借鉴**：**分层迁移**思路可以映射为我们的「working → episodic → semantic」与「软归档」，但要避免「只按时间迁移」——应当按「被检索热度 + 重要度 + 时效」组合。

### 3.8 工程化 SDK 派：LangMem / Cognee

- **LangMem**：把记忆抽象成三种类型 + 两种形成方式（意识/潜意识）+ 命名空间（org/user/context 多级），并提供「记忆工具」与「提示词优化」两类 API（https://langchain-ai.github.io/langmem/concepts/conceptual_guide/）。它的三条设计问题是很好的自检清单：**学什么内容？谁在什么时候形成？存在哪里决定了怎么召回？**
- **Cognee**：三库合一（关系库存文档/chunk/provenance、向量库存语义、图库存实体/关系），以「任务 + DataPoint」的管道组织摄入与检索，并提供会话记忆与永久记忆两条管道（https://docs.cognee.ai/core-concepts/architecture.md）。

**可借鉴**：① LangMem 的「namespace 多级 + 动态模板」正是我们缺的 workspace 维度的标准解法；② Cognee 的「provenance 落在关系库」提醒我们：**记忆条目必须能追回原始消息/会话/URL**，否则无法审计、无法纠错。

### 3.9 文件/项目记忆派：Claude Code / Cursor

- **Claude Code**：两套互补机制——`CLAUDE.md`（人写的指令/规范，项目/用户/组织级）与 **auto memory**（Claude 自己记的学习与偏好，按仓库隔离、跨 worktree 共享）；两者每次会话都加载，auto memory 只加载**前 200 行或 25KB**（https://code.claude.com/docs/en/memory.md）。
- **Cursor**：四类规则——Project（`.cursor/rules`，版本化）、User、Team、`AGENTS.md`；明确说「大模型不会在会话之间保留记忆」，规则是 system 级指令（https://cursor.com/docs/context/rules）。

**优点**：零基础设施、可读可改可 diff、天然版本化；对「项目级知识」极其有效。
**代价**：没有检索（全靠全量加载或人维护）；规模一大就爆 token。
**可借鉴**：**这是 Loopsoar 最该走的路**——本地优先产品应该让「记忆 = 可读文件 + 可检索索引」：工作区下有 `memory/` 目录，既能被模型按需 read（走 browser/file 工具），也能被索引进语义检索；同时保留「人写的规则文件」与「Agent 自写的记忆」两类，互不覆盖。

### 3.10 产品侧：Claude 记忆 / ChatGPT 记忆

- **Claude**（2025-09 上线，10 月扩到 Pro/Max）：项目级记忆（每个 project 独立）、可查看/编辑、无痕会话；官方强调上线前做了敏感话题的安全测试（https://claude.com/blog/memory）。
- **ChatGPT**：同样提供「已保存的记忆」列表与可删除/关闭，并在新会话中作为个性化上下文注入（产品文档/帮助中心）。

**共同点**：**记忆必须可见、可编辑、可关闭、按项目隔离**。这四点是产品底线，不是可选项。

## 4. 写入侧：从「什么都记」到「记什么、怎么记」

### 4.1 触发时机（四种，必须区分）

| 时机 | 谁在用 | 优点 | 代价 |
| --- | --- | --- | --- |
| 每轮对话后 | Mem0 的 add、我们的 captureFromTurn | 不遗漏 | 每轮一次抽取成本；噪声多 |
| 会话结束/分支结束时 | 多数产品 | 噪声少、可汇总 | 中途崩溃会丢 |
| 模型显式调用工具 | Letta（memory blocks 编辑）、我们的 memory_add | 精准、可控 | 依赖模型自觉 |
| 后台/定时任务 | Mem0 Dream、Letta dreaming、sleep-time compute | 不占关键路径 | 需要调度与幂等 |

**建议**：三段都留但职责分开——**每轮只做「候选捕获」（廉价规则，落 pending 队列）**；**会话结束做「整理」（去重/合并/替换，规则 + 小模型）**；**空闲后台做「巩固」（合成/取代/摘要，可选开关）**。这是 Mem0 从「ADD-only + Dream」演进出来的结论。

### 4.2 抽取：事实化 vs 原样保留

- **事实化抽取**（Mem0 / LangMem）：把「Let's use Postgres for this project」变成「项目决策：使用 Postgres」。检索干净、去重容易；代价是**丢上下文**（谁说的、何时、为什么）。
- **原样保留**（infer=False、文件派）：保真但不适合检索。
- **折中（推荐）**：存结构化事实 + **保留原始 episode 指针**。事实是检索单元，episode 是证据单元，用 sourceEpisodeId 关联。Graphiti 的 episode、Cognee 的关系库 provenance 都是这个思路。

**粒度**：LongMemEval 的实验结论是「session decomposition（按会话拆成更小的值粒度）+ fact-augmented key expansion（索引时扩充事实关键词）」显著提升召回（https://arxiv.org/abs/2410.10813）。一条记忆不要塞整段对话，应拆成「一句可独立理解的事实」。

### 4.3 去重、合并、冲突（最容易做错的一层）

| 操作 | 判据 | 动作 | 反面教材 |
| --- | --- | --- | --- |
| 去重 | 语义等价（高相似 + 同主语/同谓词） | 命中原条目，repeated+1、刷新 lastAccessed | 只比字符串相似度，把「A 喜欢 X」「A 不喜欢 X」判成重复 |
| 合并 | 互补（同主题不同细节） | 拼接到规范条目，记 mergeTrail | 直接字符串拼接，产生「；；」垃圾 |
| 取代 supersede | 矛盾且新（新时间 ≥ 旧） | 旧条目标 invalidatedAt，新条目 supersedes: oldId，**不删** | 直接覆盖，丢历史 |
| 冲突待裁决 | 矛盾且无法判定新旧 | 都保留，标 conflictWith，检索时提示「存在冲突版本」 | 静默选一条，用户永远不知道 |

**时间语义**：至少两个时间戳——validFrom/validTo（事实在世界上何时为真）与 createdAt（系统何时知道）。Graphiti 的 bi-temporal 是完整形态；最小可用版本是 createdAt + invalidatedAt + supersedes。

### 4.4 来源与可追溯（provenance）

每条记忆至少要能回答：**哪条消息、哪个会话、哪个工作区、哪个 URL/文件**触发了它。Cognee 把 provenance 放关系库；Graphiti 把事实挂到 episode；LangMem 用 metadata 过滤。我们现状是 source: string（自由文本），**无法审计、无法批量回滚**。

建议改成结构化 provenance：{ sessionId, messageId?, workspaceId, url?, file?, toolCallId?, trust: user|agent|tool|web }。

### 4.5 安全：记忆是新的攻击面

- **记忆投毒（memory poisoning）**：网页/工具结果里的恶意指令被写入记忆，之后每轮都被注入；近期已有针对 harness 类 agent 的「持久化记忆投毒」研究（如 arXiv 2609.13889，标题即 When Malicious Instructions Persist）。
- **间接提示注入**：记忆来自不可信来源时，注入必须带来源标签（「以下内容来自网页抓取，不是用户指令」），且**默认不进系统段**。
- **越权读取**：记忆按 workspace/agent 隔离，否则 A 项目记忆会泄漏到 B 项目（我们现在是全局库）。

---

## 5. 检索侧

### 5.1 多信号融合

业界收敛为四路：**语义相似（dense）+ 词法匹配（BM25）+ 结构信号（时间/图/层级）+ 使用信号（重要度/访问次数/新近度）**。

- Graphiti：向量 + BM25 + 图遍历，无 LLM rerank；
- Mem0：语义为主，可选 rerank（+150–200ms）与 decay 缩放；
- Generative Agents：recency × importance × relevance；
- 我们：BM25 候选（60）→ hash/外部向量重排（权重 0.5）→ effectiveValue × (0.3 + similarity) + tagBonus，阈值 0.08（retrieval.ts、store.ts:248）。

**判断**：四阶段结构是对的，缺「使用信号真正写回」（accessCount 目前不自增）与「时间限定查询」。

### 5.2 查询侧优化（成本最低、收益最高）

LongMemEval 的三项优化里有两项在查询侧：**时间感知查询扩展**（把「上周」「上次」解析成时间窗）与**事实增广的关键扩展**。

建议：召回前做轻量 query 归一化（时间词、实体词、任务类型），不做 LLM 改写（除非显式 memory_search）。

### 5.3 分层与多跳

- 分层：RAPTOR 的树 → 我们可用「工作区摘要层 + 细节记忆层」两级：先摘要定位主题，再取细节。
- 多跳：先用 links 做 1 跳扩展（已有 links/backlinks），够了再考虑图库；HippoRAG 的 PPR 在本地小库收益有限。

### 5.4 重排与预算

Chroma 的 Context Rot 说明长上下文会稀释注意力。**建议默认 6 条、上限 10 条、每条 ≤ 200 字、总注入 ≤ 1.5K token**；超预算时优先「高重要度 + 新近 + 直接命中」。

---

## 6. 注入侧（最容易踩坑的一层）

### 6.1 缓存友好的分层注入

Anthropic 把上下文定义为「采样时进入模型的所有 token」，强调像管理预算一样管理（https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents）。工程硬约束：**前缀字节级稳定**才能命中 KV/prompt 缓存，所以：

- **stable 段进 system**：身份铁律、规则、技能清单（顺序固定、不随轮次变）；
- **volatile 段挂末段 user**：记忆召回、当前时间、工作目录、任务状态；
- 我们已这么做（chat.ts:480-528），**这条不能动**；新增记忆能力必须继续落在 volatile。

### 6.2 注入形态

推荐「结构化卡片 + 来源标注 + id」：

~~~
[记忆 · 工作区 loopsoar · 3 条]
- (id:m_8f2a, fact, 2026-11-02) 项目使用 pnpm + vitest，构建走 esbuild bundle。
- (id:m_1c07, preference, 2026-10-28) 用户偏好中文回复，代码注释用中文。
- (id:m_44b1, lesson, 2026-10-30) 改 shell 主进程后必须重跑 bundle，否则 E2E 用旧包。
（来自本工作区的长期记忆；与当前任务无关可忽略）
~~~

好处：模型能引用 id（便于 memory_update）、用户能看见「记住了什么」、注入量可控。

### 6.3 何时不注入

- 没有召回信号时不注入（recallGate 已在做，四类信号；业界少有这么省的，值得保留）；
- 记忆数超预算时只注入「摘要 + top-k」，其余留给显式 memory_search；
- 与当前会话明显无关的工作区记忆不注入（workspace 隔离的直接收益）。

---

## 7. 遗忘、巩固与生命周期

### 7.1 衰减

- **MemoryBank**：艾宾浩斯遗忘曲线，按「距上次访问的时间 + 重要度」决定保留强度（https://arxiv.org/abs/2305.10250）。
- **Mem0 Decay**：0.3×–1.5× 的排序缩放，**只重排不过滤**，默认关闭（https://docs.mem0.ai/platform/features/memory-decay.md）。
- **我们**：effectiveValue 含时间衰减，但「访问强化」没有写回（accessCount 从不自增）。

**结论**：衰减只影响排序与归档优先级，绝不做硬过滤；检索命中时必须写回使用信号，否则模型是静态的。

### 7.2 归档

软归档（标 archivedAt，可恢复）是共识，我们已有（gateCapacity，上限 2000）；按「有效值升序」而非纯时间（已如此）；归档后必须能查回（includeArchived + UI 可见）。

### 7.3 巩固（consolidation）

三件事按优先级：① **合并重复**（低成本、收益直接）；② **取代过时**（中等成本）；③ **合成模式**（高成本可选，把细节合成「用户偏好模式 / 项目技术选型」）。
Mem0 Dream / Letta dreaming / Generative Agents reflection / A-MEM evolution 都是同一件事的不同命名。**建议：后台任务 + 每 N 次写入触发一次 + 可手动触发**。

### 7.4 成本

- 抽取/巩固优先用便宜的小模型或本地模型，不要用主推理模型；
- sleep-time compute 论文：把思考放到空闲时间，测试时算力可降约 5×（https://arxiv.org/abs/2504.13171）；
- 我们的默认路径（规则抽取 + hash 向量）成本几乎为零，**不要为了像 Mem0 而改成 LLM 抽取**；做成可选增强。

---

## 8. 隔离、隐私与治理

- **隔离维度**：workspace（必须补）> session（已有）> agent（已有 agentId）。
- **可见性**：用户必须能查看、编辑、删除单条记忆；Claude 提供「查看/编辑/项目隔离/无痕」四项（https://claude.com/blog/memory），Cursor 提供 Project/User/Team 三级（https://cursor.com/docs/context/rules）。
- **导出/迁移**：记忆是用户资产，必须可导出（JSON/Markdown 目录）；我们已有 memory:list 与文件路径配置，缺「导出为可读目录」。
- **删除语义**：软删除 + 物理清空两档；被删记忆不得再进召回。
- **审计**：谁在何时写了什么（source + captureKind + sessionId），至少能在 UI 展示。

---

## 9. 评测基准与指标

| 基准 | 规模/形态 | 覆盖能力 | 备注 |
| --- | --- | --- | --- |
| LoCoMo | 平均 300 轮、约 9K token、最多 35 会话 | 单跳/时序/多跳/开放域；事件摘要；多模态 | 超长对话记忆代表（https://arxiv.org/abs/2402.17753） |
| LongMemEval | 500 题，可扩规模聊天历史 | 信息抽取、多会话推理、时序推理、知识更新、**拒答** | 五能力划分最实用（https://arxiv.org/abs/2410.10813） |
| MemBench | 多类型任务 | 有效性 + 效率 | （https://arxiv.org/abs/2506.21605） |
| MSC | 多会话聊天 | 会话间一致性 | Xu et al. 2021 提出 |
| DMR | Deep Memory Retrieval | 深度检索 | MemGPT 团队提出；Zep 用 94.8% vs 93.4% 对比 |

**指标建议**：accuracy（分五类）、token 成本、P50/P95 延迟、拒答率、冲突处理正确率、更新后旧值不再命中率。我们的 memory-bench 目前只测**性能**（10 万条延迟），**缺质量评测**——这是第三阶段要补的。

---

## 10. 横向对照表

| 维度 | MemGPT/Letta | Mem0 | Zep/Graphiti | Generative Agents | A-MEM | LangMem | Cognee | Claude Code | Loopsoar 现状 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 写入触发 | 模型工具调用 | 每轮 add + 后台 Dream | episode 摄入 | 观察即写 | 新增即链接 | 意识/潜意识 | 管道任务 | 人写 + 自动笔记 | 每轮 capture + 工具 |
| 抽取 | 模型自管 | LLM 抽取 | LLM 三元组 | 原始事件 | 结构化 note | LLM 抽取 | 管道抽取 | 人/模型 | 规则抽取 |
| 冲突/时效 | 覆盖写 | supersede | **bi-temporal 失效** | 无 | 反向更新 | 用户自定义 | 图更新 | 无 | **无** |
| 检索 | 工具检索 | 语义 + rerank + decay | 向量+BM25+图 | 三因子加权 | 链接扩展 | 语义+元数据 | 三库融合 | 全量加载 | BM25+向量+有效值 |
| 分层摘要 | 有（blocks） | 有（synthesis） | 有（community summary） | reflection | evolution | 有 | 有 | 无 | **无** |
| 遗忘 | 驱逐 + 归档 | decay + 归档 | 失效 | 无 | 无 | 自定义 | 可配 | 无 | 有效值衰减 + 软归档 |
| 归属 | agent | user/agent/run | group | agent | agent | 多级 namespace | dataset/tenant | project/user/org | agent（**缺 workspace**） |
| 可解释 | 文件可读 | 列表可查 | 图可查 | 流可查 | 卡片 | 可查 | 可查 | 文件可读 | 列表可查 |
| 基础设施 | 自带 DB | 向量库 | **图数据库** | 无 | 向量库 | LangGraph store | 三库 | 文件 | **JSON 文件** |

## 11. 对 Loopsoar 的设计建议

### 11.1 现状盘点（代码级）

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 记录模型 | MemoryFact：id/content/category/tags/importance/timestamp/lastAccessed/links/backlinks/repeated/layer/accessCount/confidence/source/status/archivedAt/mergeTrail/agentId/crossAgentLinks | packages/core/src/memory/fact.ts |
| 五闸 | 去重 0.75 / 跨 agent 0.70 / 合并 0.68（带 tags 不参与）/ 容量 2000 软归档 / 建链 | packages/core/src/memory/fiveGate.ts |
| 检索 | 四阶段：关键词候选（≤60）→ 向量重排（权重 0.5）→ 融合 → top 6（阈值 0.08） | packages/core/src/memory/retrieval.ts |
| 召回打分 | effectiveValue × (0.3 + similarity) + tagBonus | packages/core/src/memory/store.ts:248 |
| 召回门控 | 四类廉价信号（过去时/指代/新实体/任务类型），未命中不检索 | packages/core/src/memory/recallGate.ts |
| 注入 | stable→system，volatile（记忆/技能/墙钟）挂末段 user | packages/services/src/chat.ts:480-528 |
| 捕获 | 每轮 captureFromTurn（规则抽取） | packages/services/src/chat.ts:169 |
| 向量 | 默认 hash 256 维；sqlite-vec 可选；platform.embed（BGE-M3）可用时异步重排并自动降级 | packages/shell/src/main/memoryService.ts |
| 工具 | memory_search / memory_add / memory_update / memory_delete | packages/shell/src/main/memoryTools.ts |
| 持久化 | 单个 JSON 文件（默认 data/memory/memory.json，可配 memoryStorePath） | packages/shell/src/main/memoryService.ts |
| 偏好 | memoryStorePath / memoryAutoCapture | packages/contracts/src/schemas.ts:379-382 |

### 11.2 差距（对照第 3–9 节）

| 能力 | 业界做法 | 我们的差距 | 优先级 |
| --- | --- | --- | --- |
| workspace 隔离 | Claude 项目记忆 / Cursor Project Rules / LangMem namespace | **全局单库 + agentId**，工作区之间会串味 | P0 |
| provenance | Graphiti episode / Cognee 关系库 | source 是自由字符串，无法审计/回滚 | P0 |
| 冲突与时效 | supersede / bi-temporal | 只有「合并」，会把矛盾事实拼成一句 | P0 |
| 使用信号 | Mem0 decay / Generative Agents recency | accessCount 不自增，衰减模型是静态的 | P1 |
| 巩固 | Dream / dreaming / reflection | 无后台整理，重复与过时只能靠人清 | P1 |
| 分层摘要 | RAPTOR / Mem0 synthesis | layer 字段存在但无「摘要层」与合成任务 | P2 |
| 实体/关系 | Graphiti / Mem0 graph | 只有记忆间 links，无实体维度（多跳弱） | P2 |
| 质量评测 | LoCoMo / LongMemEval / MemBench | 只有性能基准（10 万条延迟），无质量集 | P1 |
| 记忆安全 | 信任分级 + 来源标注 | 无 trust 维度，网页抓取内容可能与用户指令同权 | P0 |

### 11.3 目标架构（三层 + 三类记录）

~~~
┌─ 工作区记忆（workspace） ──────────────── 长期，跨会话 ─┐
│  semantic facts（事实/偏好/约定）  episodic episodes（事件）  │
│  summary facts（由细节合成的项目摘要，P2）                  │
└───────────────▲────────────────────────────────────────┘
                │ 检索/注入（volatile 段，≤1.5K token）
┌─ 会话工作记忆（session） ─────────────── 中期 ─────────────┐
│  当前任务状态、最近结论、待办（已有 session 机制）          │
└───────────────▲────────────────────────────────────────┘
                │ 每轮候选捕获（规则，零成本）
┌─ 原始事件（episode log） ─────────────── 证据层 ───────────┐
│  消息摘要 + 工具调用 + 来源（会话/消息/URL/文件/信任级别）   │
└────────────────────────────────────────────────────────┘
~~~

- **事实是检索单元，episode 是证据单元**：事实带 provenance 指回 episode；删记忆不影响 episode，反过来可「从 episode 重建记忆」。
- **三类记录**：fact（语义）、episode（情景）、rule（程序性/规则，可来自用户手写或 Agent 反思）。
- **巩固任务**从 episode 与 fact 生成 summary fact；不删除原始事实。

### 11.4 数据结构草案

~~~ts
interface MemoryFact {
  id: string;
  workspaceId: string;           // P0：新增，默认 "default" 兼容旧数据
  content: string;
  category: "fact" | "preference" | "convention" | "lesson" | "identity" | "summary";
  layer: "working" | "episodic" | "semantic";
  importance: number;            // 1..10
  confidence: number;            // 0..1
  tags: string[];
  // 时效（P0）
  createdAt: number;
  validFrom?: number;            // 事实在世界上何时为真
  invalidatedAt?: number;        // 被取代/失效的时刻（不删除）
  supersedes?: string;           // 取代了哪条
  conflictWith?: string[];       // 待裁决的冲突条目
  // 使用信号（P1）
  lastAccessed: number;
  accessCount: number;
  repeated: number;
  // 结构
  links: string[];
  backlinks: string[];
  mergeTrail: { mergedAt: number; reason: string; fromIds: string[] }[];
  // 溯源（P0）
  provenance: {
    sessionId?: string; messageId?: string; toolCallId?: string;
    url?: string; file?: string;
    trust: "user" | "agent" | "tool" | "web";
    capturedBy: "auto" | "tool" | "user" | "consolidation";
  };
  status: "active" | "archived" | "deleted";
  archivedAt?: number;
  agentId?: string;
}

interface MemoryEpisode {
  id: string;
  workspaceId: string;
  sessionId: string;
  messageIds: string[];
  summary: string;               // 一段可独立理解的摘要，≤400 字
  facts: string[];               // 由它产生/更新的 fact id
  createdAt: number;
}
~~~

### 11.5 分阶段落地（对齐第三阶段切片 D）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **D1 隔离与溯源** | 加 workspaceId（旧数据迁移为 default）；provenance 结构化；召回/写入/面板全部按工作区过滤；注入头标注「来源工作区」 | A/B 两工作区同 query 不串；删除工作区后其记忆不再注入；每条记忆可在 UI 看到来源会话 |
| **D2 冲突与时效** | invalidatedAt / supersedes / conflictWith；新事实与旧事实矛盾时取代而非拼接；检索默认排除已失效（可开关查看）；UI 展示「已被取代」 | 「项目改用 npm」后旧「用 pnpm」不再召回；冲突对可被看见；回归用例覆盖 supersede 与 conflict |
| **D3 巩固与使用信号** | 检索命中写回 accessCount/lastAccessed；后台 consolidation（合并重复 / 取代过时 / 生成 summary fact）；上限与幂等 | 连续 100 轮对话后重复条目不增长；summary 可被检索且不替代原事实；任务可手动触发、可中断 |
| **D4 质量评测** | 自建评测集（≥60 题，覆盖单跳/多跳/时序/更新/拒答 5 类）+ 指标（准确率/token/P95/冲突处理）；对照「无记忆/仅向量/完整」三档 | 每档数字可复现；D4 结束后能回答「这次改动让记忆变好还是变坏」 |

**顺序理由**：D1 是其余三项的地基（没有 workspace 维度，巩固会把 A 项目的摘要写进 B 项目）；D2 决定「记忆是否可信」，比 D3 的「记忆是否整洁」更影响可用性；D4 应尽早有雏形，否则后面每一片都在盲改。

### 11.6 反模式（明确不要做）

1. **不要为了像 Mem0 就把默认写入改成 LLM 抽取**：我们现在的规则抽取零成本、可离线；LLM 抽取应作为「高质量模式」的可选项。
2. **不要先上图数据库**：实体图对多跳有收益，但维护成本高；先用 links + 1 跳扩展，等评测证明不够再上。
3. **不要把记忆塞进 system 段**：会破坏 KV 缓存（缓存命中要求前缀稳定），也会让「不可信来源」获得系统级权威。
4. **不要用相似度阈值同时承担去重与冲突**：相似 ≠ 等价，「喜欢 X」与「不喜欢 X」相似度极高但语义相反；冲突必须走独立判据（否定词/数值/时间更新）。
5. **不要在关键路径做巩固**：每轮都跑 LLM 摘要会让 p95 直接翻倍，必须后台化。
6. **不要只做「写入」不做「可见」**：用户看不见的记忆，迟早会被当成偏见来源。

### 11.7 与现有 ADR 的衔接

- ADR-0007（记忆后端裁决）：默认 flat + sqlite-vec 可选 + 不引入 LanceDB——本调研不推翻该裁决，D1–D3 都在现有后端上做。
- ADR-0094（工作区 > 会话 > 网页）：记忆挂工作区正是它的延伸；建议在 D1 里补一条 ADR 记录「记忆的归属维度」。
- ADR-0009（安全验收）：D2 的冲突处理与 D4 的评测需要反例用例（错误取代/错误合并/越权召回），纳入同一套验收习惯。

---

## 12. 参考来源

### 12.1 论文（一手来源）

- MemGPT: Towards LLMs as Operating Systems — https://arxiv.org/abs/2310.08560
- Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory — https://arxiv.org/abs/2504.19413
- Zep: A Temporal Knowledge Graph Architecture for Agent Memory — https://arxiv.org/abs/2501.13956
- Generative Agents: Interactive Simulacra of Human Behavior — https://arxiv.org/abs/2304.03442
- A-MEM: Agentic Memory for LLM Agents — https://arxiv.org/abs/2502.12110
- HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs — https://arxiv.org/abs/2405.14831
- RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval — https://arxiv.org/abs/2401.18059
- MemoryOS（Memory OS of AI Agent） — https://arxiv.org/abs/2506.06326
- LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory — https://arxiv.org/abs/2410.10813
- Evaluating Very Long-Term Conversational Memory of LLM Agents（LoCoMo） — https://arxiv.org/abs/2402.17753
- MemBench: Towards More Comprehensive Evaluation on the Memory of LLM-based Agents — https://arxiv.org/abs/2506.21605
- MemoryBank: Enhancing LLMs with Long-Term Memory（艾宾浩斯遗忘曲线） — https://arxiv.org/abs/2305.10250
- Voyager: An Open-Ended Embodied Agent with LLMs（技能库） — https://arxiv.org/abs/2305.16291
- Reflexion: Language Agents with Verbal Reinforcement Learning — https://arxiv.org/abs/2303.11366
- ExpeL: LLM Agents Are Experiential Learners — https://arxiv.org/abs/2308.10144
- Sleep-time Compute: Beyond Inference Scaling at Test-time — https://arxiv.org/abs/2504.13171

### 12.2 框架与产品文档

- Letta 记忆模型（memory blocks / MemFS / 共享仓库 / dreaming） — https://docs.letta.com/agent-sdk/memory/index.md
- Letta 文档索引（上下文层级 / sleep-time subagents） — https://docs.letta.com/llms.txt
- Mem0 工作原理 — https://docs.mem0.ai/core-concepts/how-it-works.md
- Mem0 写入操作（add / 抽取 / 实体链接） — https://docs.mem0.ai/core-concepts/memory-operations/add.md
- Mem0 Dream（supersede / merge / synthesis） — https://docs.mem0.ai/platform/features/dream.md
- Mem0 Memory Decay（0.3×–1.5× 排序缩放） — https://docs.mem0.ai/platform/features/memory-decay.md
- Mem0 Graph Memory（实体图） — https://docs.mem0.ai/open-source/features/graph-memory.md
- Mem0 Advanced Retrieval（rerank 成本） — https://docs.mem0.ai/platform/features/advanced-retrieval.md
- Graphiti 概览（bi-temporal / episode / 混合检索） — https://help.getzep.com/graphiti/getting-started/overview.md
- LangMem 概念指南（semantic/episodic/procedural、意识/潜意识、namespace） — https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- Cognee 架构（关系库 + 向量库 + 图库、provenance、管道） — https://docs.cognee.ai/core-concepts/architecture.md
- Claude Code 记忆（CLAUDE.md / auto memory / 200 行或 25KB / 仓库级） — https://code.claude.com/docs/en/memory.md
- Cursor Rules（Project/User/Team/AGENTS.md） — https://cursor.com/docs/context/rules
- Claude 记忆产品公告（项目级 / 可查看编辑 / 无痕） — https://claude.com/blog/memory

### 12.3 工程与安全

- Chroma《Context Rot: How Increasing Input Tokens Impacts LLM Performance》（18 个模型） — https://www.trychroma.com/research/context-rot
- Anthropic《Effective context engineering for AI agents》 — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- 持久化记忆投毒（harness 类 agent，arXiv 2609.13889） — https://arxiv.org/abs/2609.13889

---

## 13. 下一步（进入 D 切片前的三个动作）

1. **先定维度**：确认记忆归属是 workspace（推荐）还是 workspace + agent 双维度；这决定 D1 的迁移与索引设计。
2. **先定兼容**：旧 memory.json 需要一次迁移（补 workspaceId=default、provenance.trust=user、createdAt=timestamp），迁移必须幂等且可回滚。
3. **先有评测雏形**：D4 不必等 D3——可以先搭 60 题自建集与三档对照脚本，后面每一片都用它回归（否则「记忆变好了」只能靠感觉）。

> 本文件是调研与设计输入，不是最终 ADR；D1 动手前会把「归属维度」「迁移策略」「冲突判据」三条写成 ADR。