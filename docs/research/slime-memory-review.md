# slime 记忆系统复盘：哪些设计值得 Loopsoar 拿回来

> 对象：D:\pilot project（slime，上一个项目）。入口：core/memory.py（73KB）、core/memory_global.py（30KB）、core-ts/src/memory/*（TS 移植：store/global/fulltext/similarity/graph/embed_cache）、sidecar/retrieve_api.py、docs/slime-agent-loop-design.md、docs/Intelligence.md §十二。
> 方法：读实现 + 读它自己的裁决文档（它有 39 来源的记忆调研报告与一章「反直觉结论」），再用我们当前的实现逐条对照。
> 结论先行：**Loopsoar 的记忆是 slime 的「瘦身移植」——五闸阈值、召回门控、遗忘因子、四阶段检索都同源；但移植时砍掉了读取侧格式、访问语义、混合融合、跨 agent 指针、崩溃安全写入与可配置治理六块。这六块恰好是 slime 踩过坑之后长出来的，拿回来成本低、收益直接。**

---

## 1. slime 的记忆系统长什么样（一页看懂）

~~~
slime.toml [memory]  ← 治理参数（dedup/link/merge/max_entries/archive_limit/cross_agent_dedup/recall_gate/global_index_ttl）
        │
Knowledge/Agent Memory/<agentId>/memory.json   ← 真相源（facts/preferences/skills_unlocked/lessons + archived + shared_refs）
        │  atomic_write_text：tmp + fsync + replace + fsync(dir) + .bak；read_json_safe 读失败回落空库
        │
写入：_store_categorized_locked
   ① per-agent 去重 0.75（命中 repeated+1）
   ② 跨 agent 全局去重（命中⇒本地只留 shared_refs 指针，不新增内容）
   ③ 合并档（0.68，带 tags 的条目**不合并**，只建链）
   ④ 容量上限 2000：满了先合并，再按最低有效价值 _spill_to_archive 软归档，腾不出则丢弃本次写入
   ⑤ 建链：tags 相交或相似度 > 0.70（0.70 是真实语料校准后的值，原 0.30 误链 42%）
        │
检索：hybrid_recall = 向量通道 + 全文通道（BM25）→ RRF(k=60) 融合 → 可选 link_walk（BFS，最多 2 跳）
        │   link_walk **按查询意图触发**（link_traversal_requested：显式多跳/「所有相关」才开），不默认开
        │
注入：_retrieve_psyche_context（core/llm.py）→ 只在 should_retrieve_memory 命中时检索
       → summary(context, max_items) → _inject_psyche 塞进 **user message**（system 只留 L1+L2）
        │
跨 agent：GlobalMemoryIndex（.global/index.json，TTL 30s，倒排剪枝的 Jaccard）
          + shared_refs 指针 + 隔离开关（SLIME_MEMORY_ISOLATED / .memory-isolated）
~~~

### 1.1 数据模型（facts 条目字段）

~~~
id           = "mem_" + md5(content)[:8]   （内容哈希，幂等，便于双向链接）
content / category(fact|preference|skill|lesson) / tags / importance(1..10)
timestamp / last_accessed / repeated / confidence
links / backlinks / merge_trail[{content,score,at}] / merged_from
source / status / archived_at / archived_reason
success（lesson 专用：这条经验是成功还是失败）
~~~

### 1.2 它自己的三条「反直觉结论」（docs/slime-agent-loop-design.md §0）

| 结论 | 依据（它引用的原始数字） | 对我们的含义 |
| --- | --- | --- |
| **瓶颈在写入侧，不在检索侧** | LongMemEval：ChatGPT 会**覆盖**关键信息（在线 0.5773 vs 离线全文 0.9184）；Coze **根本没记下**间接信息；只有 Zep/Mem0 把写入治理做成一等公民，恰好也是公开数字最好的两家 | 我们 D1/D2（隔离/溯源/冲突）优先于检索调参，是对的 |
| **图结构不配做默认架构** | Mem0ᵍ 加图后单跳 67.13→**65.71**、多跳 51.15→**47.19**（都下降）；HippoRAG 2 自认图方法「基础事实记忆明显低于标准 RAG」；Zep 的 +18.5% 是相对「全上下文」基线的增益，**不是图 vs 向量** | 我上一份调研把 graph 列 P2 是对的，但**不能更早**；link_walk 必须默认关 |
| **遗忘机制只有理论优雅，无实证支持** | MemoryBank 作者自述艾宾浩斯曲线「探索性、高度简化」，全文**无增益 ablation**；MemoryAgentBench 把 Selective Forgetting 列为尚未掌握的四项能力之一；唯一有正向数字的是**矛盾软失效**（Zep 时序 45.1→62.4、Mem0ᵍ 55.51→58.13） | 衰减只做排序；D2 的 supersede/invalid_at 才是正主 |

它还补了第四条（§4.2）：**读取侧是独立瓶颈**——LongMemEval 原话「即使召回完美，准确利用检索条目也绝非易事」，**仅换阅读格式（Chain-of-Note + 结构化）就 +10 绝对点**；与 Chroma 的「~300 token focused 优于 ~113k full」互证。

---

## 2. Loopsoar 已经继承了什么（别重复造）

| 能力 | slime | Loopsoar | 结论 |
| --- | --- | --- | --- |
| 五闸阈值 | 0.75 / 0.70 / 0.68 / 2000 / archive_limit=0 | fiveGate.ts 同值 | **同源**，阈值是校准过的，别乱调 |
| 召回门控 | should_retrieve_memory 四信号（过去时/指代/新实体/任务切换） | recallGate.ts 同构 | 已继承，保留 |
| 遗忘因子 | exp(-days/5.0) × importance/10 | fiveGate.ts:158 / retrieval.ts:88 | 已继承 |
| 有效值 | weight × confidence × (1+repeated) | store.ts:248 同构 | 已继承 |
| 合并排除 tags | 带 tags 不参与合并 | fiveGate 同款 | 已继承 |
| 四阶段检索 | 向量种子 → BFS → 标签 → 权重排序（旧；已裁决要改） | 关键词 → 向量 → 融合 → top6 | **不同序**，见 §3.3 |
| 单 JSON 真相源 | memory.json + 可选 LanceDB 派生索引 | memory.json + 可选 sqlite-vec | 同构 |

**注意**：Loopsoar 的 hash embedding **不是** slime 那个「伪嵌入」。我用我们自己的实现跑了探针（5 条中文两两余弦）：

~~~
pairs = [0.4328, 0.3042, 0, 0.0548, 0.2394, 0.0537, 0, 0.0552, 0.0563, 0]
max = 0.4328（相关对：Python 脚本 vs Python 编程）  min = 0  avg = 0.1196
~~~

slime 的旧 `_hash_embed` 是字符码位截断，无关中文文本余弦 **0.9659–0.9920**（几乎全等），已被删除（§3.4，裁决「静默的垃圾比显式失败更糟」）。我们的是 **token 哈希**，无关文本接近 0——方向是对的，**不要照搬 slime 的这条裁决去删 hash 回退**。但探针也暴露一个真问题：中文**单字**让无关文本也能到 0.24–0.30（共享「使用」「用户」这类字），见 §4.5。

## 3. 九条值得拿回来的设计（按 D 切片归属）

### 3.1 读取侧格式是一等公民（D3）

**机制**。summary 的每一条不是散文，而是固定格式的一行：

~~~
- [fact] 时间: 2026-11-02T09:10:23+00:00 · 来源: user · 项目使用 pnpm + vitest
- [preference@语义] 时间: … · 来源: 未标注 · 用户偏好中文回复
~~~

并且按**类型分区**输出：已知事实 / 用户偏好 / 已解锁技能 / 经验教训（lessons 还带「结果: 成功/失败」）。

**证据**：core/memory.py:538-560（summary_item_line）、1295-1370（summary 分区）；docs/slime-agent-loop-design.md §4.2（LongMemEval「仅换阅读格式 +10 绝对点」）。
**我们**：memoryText 目前是拼接的纯文本行，无 category/时间/来源，也没分区。
**成本**：低（改 recallPrompt 的格式化函数 + 纯函数测试）。**收益**：模型更容易引用，用户能看见来源——正是 D1 provenance 的展示面。

### 3.2 访问语义：summary 不算访问，只有真正命中才算（D3）

**机制**。summary() 里明确写着**不刷新 last_accessed**。设计文档原文：

> 「summary() 每次调用都会把选中的 top-N 刷成当前时间，于是排名外的沉睡记忆永远不会被 touch，也就永远进不了 top-N——『沉睡但可唤醒』在实现上不成立。」（docs/slime-agent-loop-design.md §5.1）

只有 touch(content_prefix)（真实命中/用户查看）才更新访问时间。
**证据**：core/memory.py:1295-1310、1274-1288（touch）。
**我们**：审计已确认 accessCount 从不自增；下一步「写回使用信号」若按 summary 注入计数，会复现同一个 bug。**D3 验收必须包含**：连续 10 轮无命中注入，沉睡条目排名不变；一次 memory_search 命中后排名上浮。

### 3.3 检索融合用 RRF，而不是加权求和（D3）

**机制**。hybrid_recall = 向量通道 + 全文通道（真 BM25：k1/b、idf、长度归一）→ **RRF（k=60）** 融合，再可选图扩展。

~~~
score(d) = Σ_channel 1 / (60 + rank_in_channel(d) + 1)
~~~

**为什么比 0.5/0.5 加权好**：两条通道分数分布不可比（cosine ∈ [-1,1]、BM25 无上界），加权等于用两个未校准的量相加；RRF 只用名次，天然免疫分布差异，也不需要调权重。
**证据**：core/memory.py:167-175（_rrf_fuse）、129-166（BM25）。
**我们**：retrieval.ts 是「关键词候选 → 向量重排（权重 0.5）→ 融合」，融合用分数加权 + 0.08 阈值——换 embedding 源（hash vs BGE-M3）时阈值必然漂移。改 RRF 后这个阈值可以删掉。

### 3.4 图扩展按查询意图触发，不默认开（D3）

**机制**。link_walk 是 BFS（links + backlinks，最多 2 跳），但**默认不启用**；只有 link_traversal_requested(query) 命中「显式多跳」意图才开：

- 关系穷举：所有/全部/每一个/有哪些 … 相关/有关/关联
- 显式多跳：多跳/跨跳/关联链路/关系图/上下游/间接影响/multi-hop/transitive
- 英文穷举：all/every … related/associated/connected

**证据**：core/memory.py:117-128（规则表）、177-201（link_walk）、964-1005（want_graph 判定）；设计文档 §4.1 明确「BFS 降级为可插拔层」。
**我们**：完全没有 link_walk（links/backlinks 只存不遍历）。成本低（纯函数 + 意图正则表），默认关闭不拖慢普通召回。

### 3.5 跨 agent 去重：全局索引 + 指针，而不是丢弃（D1）

**机制**。写入时除 per-agent 去重，还查一次跨 agent 全局索引（.global/index.json，TTL 30s，倒排剪枝的 Jaccard）：

- 命中 → 本地**不新增内容**，只加一条 shared_refs **指针**（{agent, mem_id, content, score, category}）；
- 指针不进 facts、不进 summary、不建链，只让 get_shared_refs() / global_recall() 找得回来；
- 注释原文：「去重不等于丢知识——否则 A 已经知道的事实，B 永远查不到，等于把知识删除」；
- 隔离开关：SLIME_MEMORY_ISOLATED=1 或 .memory-isolated 文件 → check() 直接返回 None，调用方退回 per-agent 去重，**绝不读串生产数据**。

**证据**：core/memory.py:724-760（_cross_agent_scan）、824-853（_add_shared_ref）、891-950；core/memory_global.py:425-535；设计文档 §3.2。
**我们**：crossAgentLinks 字段存在但**没有实现**（审计已记）。更严重的是没有 workspace 维度——A 项目记忆会直接进入 B 项目召回。
**改造建议**：把「全局索引」从 agent 维度改成 **workspace 维度**——同工作区内跨 agent 共享（指针），跨工作区默认完全隔离（显式开关）。既保住「不丢知识」，又满足 D1 隔离。

### 3.6 崩溃安全写入（D1）

**机制**。_save() 走 atomic_write_text：tmp → fsync(tmp) → replace → fsync(父目录) → 留 .bak；读取走 read_json_safe，主文件与 .bak 都坏时回落空库并告警，而不是抛错炸启动。另有「旧路径存在、新路径不存在 → 自动迁移」。
**证据**：core/memory.py:1005-1055；A-989 注释「rename 是元数据操作，可能先于数据落盘，断电/强杀后会留下文件名在、内容空或半截的记忆文件」。
**我们**：memoryService.ts:198 直接 platform.fs.writeFileUtf8——没有 fsync、没有 .bak、没有读取兜底。记忆是少数「用户不可重建」的数据，这条应进 D1。

### 3.7 治理参数可配置 + 阈值有校准证据（D1）

**机制**。所有魔法数字从 slime.toml [memory] 读，读取失败一律回落默认（「配置坏了不能让记忆写入停摆」）；并明确写下去重 0.75 **不能下调**的理由：

- 真实语料校准：去重 0.75 召回 0.867 / 误判 3.2%；建链 0.30 → **0.70**（原值误链 42%）；
- 不同工具的模板条目相似度约 **0.74**，距 0.75 只有 0.01 余量。

**证据**：core/memory.py:271-390；设计文档 §3.3 对照表（旧空白分词 0.6204 vs 新 CJK 单+双字 0.8386）。
**我们**：除 memoryStorePath / memoryAutoCapture 外阈值全硬编码，五闸的 0.75/0.70/0.68 没有出处、没跑过校准。**D1 先把它们挪进偏好，D4 用真实语料校准一次。**

### 3.8 归档语义：0 = 永不回收，且记录归档原因（D2）

**机制**。archive_limit = 0 被钉死为「不设上限 / 永不回收」，**不是**「立即删光」；非法值一律往「不删」兜底。归档条目带 status=archived:<category>、archived_at、archived_reason（如「超出单 agent 上限 2000 条，按最低有效价值替换」），并调用 note_retired 把全局索引标记为已退役。
**证据**：core/memory.py:341-375、762-800；设计文档 §5.2「不要把遗忘做成到期物理删除——无任何实证来源支持遗忘带来增益；而物理删除不可逆，误删代价高于留存成本」。
**我们**：gateCapacity 有软归档与 archivedAt，但**没有原因字段**，也没通知索引；偏好里没有归档上限。

### 3.9 写入闸门：「工具成功不是经验」（D2，决定「写什么」）

**机制**。slime 写入前有一张裁决表：

| 事件 | 是否写 | 理由 |
| --- | --- | --- |
| 工具调用成功 | 不写 | 「file_read 成功」不构成可复用知识 |
| 工具反复失败后成功 | 写 | 「这条路走通了」是真经验 |
| 工具失败且原因非显然 | 写 | 负经验有价值 |
| 沙箱拒绝 / 权限错误 | 不写 | 环境噪声，非认知收获 |
| 用户显式纠正 | 写（高 importance） | 最高价值信号 |
| LLM 抽取的事实/偏好/教训 | 写 | 保留 |

并删掉了所有「机械 importance=4」的写入。
**证据**：docs/slime-agent-loop-design.md §3.2；设计文档标注闸门已在 core/llm.py 落地。
**我们**：captureFromTurn 是「每轮对用户消息与助手回复做规则抽取」，**不区分成功/失败/纠错**，也没有「沙箱拒绝不写」。这条决定记忆库信噪比，建议 D2 与冲突处理一起做（高价值信号往往也是更新信号）。

### 3.10 附带两条工程纪律（D3）

- **锁边界**：嵌入（同步 HTTP）与全局索引写入都在 per-agent 锁**外**；锁序恒为 per-agent → global（注释明确「绝不能在持有 per-agent 锁时去取全局索引锁」）。我们目前单进程单例，但 D3 加后台巩固后会立刻遇到同一个问题。
- **派生索引对账**：reindex() 从 JSON（唯一真相源）重建向量索引并返回对账结果。我们的 sqlite-vec 侧没有对账路径。

---

## 4. 它修正了我上一份调研的五个判断

> 上一份调研（docs/research/agent-memory-survey.md）是从公开资料出发的；slime 的调研报告带了**具体对照数字**，其中几条修正了我偏乐观的地方。

### 4.1 写入侧才是瓶颈，检索算法已进平台期

我原先把「检索多信号融合」放在很靠前的位置。slime 引用的 LongMemEval 观察更硬：

- ChatGPT 在线 0.5773 vs 离线全文 0.9184 —— 差距来自**覆盖了关键信息**，不是检索不到；
- Coze **根本没记下**间接信息；
- 公开数字最好的两家（Zep / Mem0）都把**写入治理**做成一等公民。

**修正**：D2（冲突/时效/写入闸门）的优先级高于任何检索优化；D3 的 RRF/图扩展是「锦上添花」，不要插到 D2 前面。

### 4.2 图不是默认架构——我原文对 Zep 的表述需要收窄

我写 Zep「LongMemEval 最高 +18.5%」，读起来像「图比向量好」。slime 的核对是：

- 那个 +18.5% 是相对**全上下文**基线，**不是图 vs 向量的对照**；
- Mem0ᵍ 加图后：单跳 67.13→**65.71**、多跳 51.15→**47.19**，**两项都降**；
- HippoRAG 2 自认图方法在「基础事实记忆」上明显低于标准 RAG。

**修正**：graph/PPR 继续留在 P2 或更后；D3 的 link_walk 默认关、按意图开（§3.4）是正确姿势。

### 4.3 遗忘没有实证增益，「软失效」才是唯一有数字的形态

我写「遗忘是特性不是缺陷」时引的是 MemoryBank 的艾宾浩斯曲线。slime 的核对更严格：MemoryBank 作者自述该曲线「探索性、高度简化」，全文**没有增益 ablation**；MemoryAgentBench 把 Selective Forgetting 列为尚未掌握的能力。

**修正**：衰减只做排序（我们已如此），**不要**在任何文档/UI 里把它宣传成「会忘记」；真正要做的是 D2 的 invalid_at 软失效（Zep 时序 45.1→62.4、Mem0ᵍ 55.51→58.13 是正向数字）。

### 4.4 读取侧是独立瓶颈（+10 绝对点）

「仅换阅读格式（Chain-of-Note + 结构化）就 +10 绝对点」——这条我在调研里只写到「结构化卡片」建议，没给权重。

**修正**：把「记忆注入格式」当作 D3 的一等验收项（不只是 D1 的展示需求）：格式本身影响准确率，值得单独做 A/B。

### 4.5 我们的 hash embedding：方向对，但中文单字在制造假相似

实测（用我们自己 packages/core 的 hashEmbedding，5 条中文两两余弦）：

~~~
相关对（Python 脚本 / Python 编程）：0.4328
无关对：0.3042、0.2394、0.0548、0.0552、0.0563、0（其余为 0）
~~~

无关文本能到 **0.30**，原因是 tokenize 对 CJK 输出**单字 unigram**，而「使用」「用户」「项目」这类高频字在所有技术句子里都出现。slime 的解法不是删掉哈希，而是：

- Jaccard 用 **unigram + bigram** 双集合（bigram 保精度）；
- 阈值用真实语料校准（去重 0.75 召回 0.867 / 误判 3.2%）。

**修正**：不要照搬 slime「删掉 hash 回退」的裁决（它删的是字符码位截断的伪嵌入，我们不是）。但**应该**在检索的向量通道里给 bigram 更高权重（或对 unigram 降权 0.5），否则 0.08 阈值 + 0.5 权重会放大假阳性。这条进 D3（或 D1 顺手改 tokenize，纯函数、有测试）。

---

## 5. 修订后的 D1–D4（把 slime 的东西塞进去）

| 阶段 | 原计划 | 加入 slime 的设计 |
| --- | --- | --- |
| **D1 隔离与溯源** | workspaceId、provenance、面板过滤 | 3.5 workspace 维度全局索引 + shared_refs 指针（跨工作区默认关）；3.6 崩溃安全写入 + .bak + 旧路径迁移；3.7 阈值进偏好；A-1269 的「说清这是谁的记忆」（注入头 + provenance.trust） |
| **D2 冲突与时效** | invalidatedAt/supersedes/conflictWith | 3.8 归档原因 + 0=永不回收；3.9 写入闸门（工具成功不写 / 反复失败后成功写 / 沙箱拒绝不写 / 用户纠正高 importance）；4.3 只做软失效不做遗忘 |
| **D3 巩固与使用信号** | accessCount 写回、后台 consolidation | 3.1 读取侧格式化 + 分区；3.2 summary 不刷访问、只有 touch 算；3.3 RRF 替代加权 + 0.08 阈值；3.4 link_walk 意图触发；3.10 锁边界与 reindex 对账；4.5 bigram 权重 |
| **D4 质量评测** | 60 题五类 + 三档对照 | 借 slime 的探针方法（probe_similarity_variants.py / probe_threshold_sweep.py）做**阈值校准**，并把「注入格式」作为单独 A/B 因子（4.4） |

---

## 6. 明确不要抄的四样

| 不抄 | 原因 |
| --- | --- |
| **情绪/人格（mind/emotion.ts、L1/L2/L3 psyche）** | 那是 slime「虚拟人格」产品线的核心，记忆只是它的输入；Loopsoar 是工作台，没有「情绪」这一层。可借鉴的只有 A-1269 的文案纪律：注入必须说清主语与归属。 |
| **全局索引默认跨 agent 开启** | slime 是「一个用户多个 agent」的形态；Loopsoar 是「多工作区」，默认必须隔离，跨工作区共享要显式开关。 |
| **Obsidian 式 Knowledge/ 全量目录当真相源** | 文件式记忆适合「人写的规则」（如 CLAUDE.md），不适合每轮自动捕获的事实；目录里混放会产生 diff 噪声与并发写冲突。 |
| **link_walk 默认启用** | slime 自己已裁决降级为可插拔（§4.1）；默认 BFS 会把弱关联拖进上下文，反而稀释注意力。 |

---

## 7. D1 可以立即动手的八件事（都有明确落点）

1. **MemoryFact 增 workspaceId**（旧数据迁移为 default，幂等）：packages/core/src/memory/fact.ts、store.ts、memoryService.ts 的 load/save。
2. **provenance 结构化**：{ sessionId, messageId?, workspaceId, url?, file?, trust, capturedBy }；captureFromTurn 与 memory_add 填充。
3. **崩溃安全写入**：memoryService 的 save 改成 tmp + fsync + rename + bak；load 读失败回落 .bak → 空库并告警（对齐 slime atomic_write_text / read_json_safe）。
4. **阈值进偏好**：memory 组增加 dedup/link/merge/capacity/archiveLimit，默认值沿用 0.75/0.70/0.68/2000/0，并注明「0.75 不可下调」的依据。
5. **注入头带归属**：memoryText 首行改为「[工作区 X 的长期记忆 · N 条]」，每条带 category/时间/来源（可先做 D3 的 3.1 的轻量版）。
6. **面板过滤**：memory 面板与 memory:list/stats 按当前工作区过滤，另加「显示全部工作区」显式开关。
7. **跨工作区默认不召回**：recall 入口只取当前 workspace；跨工作区检索走显式参数（对应 slime 的 isolation gate）。
8. **测试**：迁移幂等、A/B 工作区不串、.bak 恢复、注入格式快照——四个 spec 就能锁住 D1。

---

## 8. slime 关键位置索引（便于回查）

| 主题 | 位置 |
| --- | --- |
| 配置读取与阈值 | core/memory.py:271-390 |
| 召回门控四信号 | core/memory.py:392-424 |
| 相似度（CJK unigram+bigram） | core/memory.py:40-64 |
| BM25 | core/memory.py:129-166 |
| RRF 融合 | core/memory.py:167-175 |
| link_walk BFS | core/memory.py:177-201 |
| 图触发意图表 | core/memory.py:117-128 |
| 情绪调制 importance | core/memory.py:208-222 |
| 遗忘因子 / 有效值 | core/memory.py:512-537 |
| 摘要行格式 | core/memory.py:538-560 |
| 写入主流程（去重/跨agent/合并/容量） | core/memory.py:1112-1223 |
| 软归档 | core/memory.py:762-800 |
| shared_refs 指针 | core/memory.py:824-853 |
| hybrid_recall | core/memory.py:964-1005 |
| 读写与崩溃安全 | core/memory.py:1005-1055 |
| summary 分区输出 | core/memory.py:1295-1370 |
| 全局索引 check/upsert | core/memory_global.py:425-535 |
| 隔离机制 | core/memory_global.py:100-165 |
| TS 移植 | core-ts/src/memory/{store,global,fulltext,similarity,graph,embed_cache}.ts |
| 设计裁决 | docs/slime-agent-loop-design.md §0/§3.2/§3.3/§3.4/§4.2/§5 |
| L1/L2/L3 心智分层 | docs/Intelligence.md §十二 |
| 检索四阶段（旧，已移植） | sidecar/retrieve_api.py:54-140 |

---

> 下一步：把 §5 的修订合入 docs/规划/第三阶段-可自定义性与长期连续性.md 的 D 切片，然后按 §7 开工 D1。