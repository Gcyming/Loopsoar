# ADR-0007 W5 记忆基准报告（10 万条，纯 TS 方案）

> 生成方式：`node scripts/memory-bench.mjs`（可复现；参数 count=100000 queries=120 dim=256 repeat=3 seed=20261102）。
> 本报告是 ADR-0007「记忆后端裁决」的实测附件，但**不能替代** W5 要求的 sqlite-vec vs LanceDB 对照：
> 本环境无法安装原生模块（better-sqlite3/sqlite-vec）且 llama-server（BGE-M3）不可用，原因与后续路径见 §6。
> 结论：**默认后端 = 纯 TS 混合检索（FlatVectorIndex + deterministic hash embedding），零原生依赖**；
> sqlite-vec 保留为打包阶段可选后端，需在具备 BGE-M3 与原生 ABI 的环境复测后再裁决是否替换。

## 1. 测试环境

| 项 | 值 |
|---|---|
| 生成时间 | 2026-11-02T07:46:45.335Z |
| OS | win32 10.0.26200 (x64) |
| CPU | 13th Gen Intel(R) Core(TM) i9-13900HX × 16 |
| 内存 | 32504.7 MB |
| Node | v24.18.0 |
| 向量实现 | 生产实现（packages/core/src/memory/vector.ts 直接导入） |
| hash 维度 | 256 |
| llama-server (BGE-M3, 127.0.0.1:8991) | 不可用（fetch failed） |
| better-sqlite3 | 未安装 |
| sqlite-vec | 未安装 |
| @lancedb/lancedb | 未安装 |

## 2. 语料与方法

- **规模**：100,000 条记忆；总正文 4,623,677 字符（平均 46.2 字符/条）。
- **类别**：fact/preference/lesson/convention/identity（权重 40/20/25/10/5）；分类统计：fact=40268、lesson=24838、preference=20071、convention=9952、identity=4871。
- **语言**：含中文条目 95,582 条（95.6%）；混合英文模板与中英混排。
- **非纯模板重复**：模板 × 随机实体（22 类词表）× 随机细节后缀；基句去重后 96,561 条（96.6%），同基句重复出现时加「 #n」后缀保证正文 100% 唯一。
- **合成语料局限（诚实声明）**：无法取得真实脱敏用户语料，本基准用「模板组合 + 随机实体」生成真实感语料；它适合比较不同索引的**工程性能**，但不能替代真实语料的**语义质量**评估。
- **查询集**：120 条 = 整条原文 48 条 + 取后半段（含高熵细节）36 条 + 改写式 18 条 + 无关词 18 条。
  - exact 用于检验索引正确性（源条目必须命中）；partial/paraphrase 模拟真实「想起半句」；unrelated 只测延迟（不计召回）。
- **路径定义**：
  1. `keyword-linear`：与生产 `retrieval.keywordCandidates` 同语义，但把「线性扫描全库」的 token Jaccard 计算用哈希集优化（生产 ≤2000 条时是字符串集）；
  2. `keyword-inverted`：bench-only 倒排索引 BM25（验证「加倒排」能否把关键词检索压到 50ms 内）；
  3. `vector-hash`：生产 `FlatVectorIndex`（10 万 × 256 维 float32 连续存储）暴力余弦 top10；
  4. `hybrid`：关键词倒排候选 top200 → hash 向量余弦重排 → 0.5/0.5 融合 top10（与 core/retrieval 四阶段同构）。
- **延迟口径**：每路径预热 10 条后，按 3 轮 × 120 条合并统计（`performance.now()`，单线程 Node），取 P50/P95/max，降低单轮 JIT/调度噪声。
- **质量口径**：recall@5（源条目是否进入 top5），按 exact/partial/paraphrase 分桶报告（只取第一轮结果，确定性）。

## 3. 索引构建与内存

| 阶段 | 耗时/占用 |
|---|---|
| 语料生成（含唯一性去重） | 126.44 ms |
| 分词 + token 哈希集（全库） | 411.20 ms |
| hash embedding + FlatVectorIndex 写入（100,000 × 256） | 457.51 ms |
| 倒排关键词索引（bench-only，73,884 个 token、2,477,569 条 posting） | 92.50 ms |
| FlatVectorIndex 内存（含槽位/Map 估算） | 104.7 MB |
| 向量原始字节（100,000 × 256 × 4B） | 97.7 MB |
| token 哈希集原始字节 | 9.5 MB |
| 倒排索引估算（posting + Map 开销） | 23.4 MB |
| 全部索引估算合计 | 145.8 MB |
| 进程 heapUsed（索引构建后） | 165.5 MB |
| 进程 heapUsed / RSS（基准结束时） | 143.2 MB / 950.8 MB |
| 增量写入 2,000 条 | 51.68 ms（38698 条/秒） |
| 删除 2,000 条 + compact | 58.80 ms |
| hash 向量非零桶（首条样例 256 维） | 13 |

## 4. 检索延迟与召回（10 万条）

| 路径 | P50 | P95 | max | recall@5 | exact | partial | paraphrase | P95 ≤ 50ms |
|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| keyword-linear | 22.52 ms | **43.19 ms** | 64.35 ms | 50.0% | 75.0% | 27.8% | 27.8% | ✅ |
| keyword-inverted | 1.98 ms | **4.12 ms** | 17.10 ms | 86.3% | 97.9% | 97.2% | 33.3% | ✅ |
| vector-hash | 24.16 ms | **42.95 ms** | 79.95 ms | 67.6% | 100.0% | 55.6% | 5.6% | ✅ |
| hybrid | 7.81 ms | **17.23 ms** | 30.28 ms | 90.2% | 100.0% | 97.2% | 50.0% | ✅ |

- 质量查询数（有 expected id）= 102 条；无关词查询只计延迟。
- **合成语料的质量读法**：每条语料带高熵细节（记录号/session/耗时/日期），因此 exact/partial 的源条目
  可被唯一识别——这验证的是**索引与候选链路正确性**，也让 recall 偏乐观；它不代表真实语料的语义召回。
  partial/paraphrase 的绝对值只用于**四路相对对比**，真实语义质量必须接入 BGE-M3 + 真实语料后复测（见 §6）。

- **测量噪声**：同一脚本在本机连续多次运行的 P95 波动约 ±10–20%（实测范围：keyword-linear 34–50ms、vector-hash 42–54ms、
  hybrid 17–24ms、keyword-inverted 4–5ms）；判定以「是否满足 50ms 且余量」为准，不做毫秒级横向比较。需要更稳可加 `--repeat=5`。

### 4.1 向量维度权衡（单查询全库向量扫描，10 万条；前 60 条查询 × 2 轮）

| 维度 | P50 | P95 | 索引内存 | 构建耗时（含 embedding） |
|---:|---:|---:|---:|---:|
| 128 | 23.60 ms | **28.23 ms** | 55.9 MB | 653.71 ms |
| 256 | 24.16 ms | **42.95 ms** | 104.7 MB | 457.51 ms |
| 384 | 64.85 ms | **78.88 ms** | 153.5 MB | 781.73 ms |

- 维度↑ → 内存/延迟近似线性↑；256 维（BGE-M3 小模型常见量级）在本机 P95 ≈ 42.9 ms，已贴近 50ms 阈值、余量不足（单轮 max 可到 79.9 ms）；
  改为 hybrid（关键词候选 → 向量重排）后 P95 只有 17.2 ms。
- 若将来必须「全库向量扫描」：128 维可压到 P95 ≈ 28.2 ms，但需接受 hash 碰撞带来的质量损失；更优解是 ANN（HNSW/IVF）或 sqlite-vec。

## 5. 结论与建议（ADR-0007 裁决建议）

1. **默认后端（v1）= 纯 TS 混合检索**：`FlatVectorIndex`（flat float32 暴力余弦）+ `hash embedding` + `retrieval` 四阶段。
   - 零原生依赖、可离线、可复现、Electron ABI 无关；实测 10 万条下 **hybrid 路径 P95 = 17.23 ms（达标）**；
     但「全库裸向量扫描」单路径 P95 = 42.95 ms（贴近阈值、余量不足）——
     这正是四阶段设计要「先关键词候选、再向量重排」的原因（向量只对候选集算，10 万条下仍 10ms 级）。
   - 生产记忆库容量上限为 2000（`THRESHOLD_CAPACITY_MAX`），实际规模远小于 10 万；本基准的 10 万是 ADR-0007 要求的压力目标。
2. **关键词路径在 10 万条需要索引才能稳过 50ms**：keyword-linear P95 = 43.19 ms（临界达标，max 已到 64.35 ms）；倒排版 keyword-inverted P95 = 4.12 ms（达标）。
   → 若产品未来把容量提到 10 万级，优先把 `retrieval.keywordCandidates` 换成倒排/前缀索引（纯 TS 即可，无需原生模块）。
3. **hybrid 实测**：P95 = **17.23 ms**，recall@5 = 90.2%（其中 exact 桶 100.0%，证明索引/候选/融合链路正确）；
   在 10 万条下满足 P95 ≤ 50ms 目标。
4. **sqlite-vec / LanceDB 裁决**：本环境**无法实测**（原生模块未安装且不能在本会话安装；llama-server/BGE-M3 不可用）。
   因此本报告不宣称「sqlite-vec 优于/劣于 LanceDB」，只裁决**当前可落地默认**：纯 TS 方案先上线，
   sqlite-vec 留作打包阶段可选后端（接口已就绪，见 §6 后续路径）。
5. **与 W5 通过标准逐条对照**：
   - 检索 P95 ≤ 50ms @ 10 万条：hybrid 通过（17.23 ms）；裸向量扫描 42.95 ms 贴近阈值（余量不足）（这也验证了「关键词候选 + 向量重排」四阶段不是冗余设计）；keyword-linear 43.19 ms（临界）。以本机 Node 单线程实测，非 Electron 渲染进程。
   - 检索质量不劣于 LanceDB 基线：**未验证**（无 LanceDB/BGE-M3；hash embedding 是词法向量，不能冒充语义基线）。需在打包阶段用真实 BGE-M3 复测。
   - 备份恢复/归档查回 100%：**未在本基准范围**（记忆持久化是 JSON 快照，恢复=读 JSON；归档查回由五闸软归档保证）。建议打包阶段补专项用例。
   - 增量写入无死锁：单线程索引 upsert/remove 实测 38698 条/秒，无并发写场景（Node 单线程），并发写需上层串行化。

## 6. 未接原生模块 / llama-server 的原因与后续路径

**原因（可复核）**：
1. 本会话禁止安装新原生依赖：better-sqlite3 / sqlite-vec 需要联网下载 + 预编译二进制或本地编译，并且必须与 Electron 45 的 Node ABI 匹配（打包阶段统一处理）；当前 `NodeSqliteAdapter` 仍是 P4 前的 `LoopsoarNotImplementedError`（packages/core/src/platform/node.ts:153-158）。
2. llama-server（BGE-M3，127.0.0.1:8991）本机探测结果：不可用（fetch failed）；`platform.embed` 有实现但无服务时只能降级。
3. 因此本基准用 `hash embedding` 做**可运行**的向量能力对照，并明确它只是词法向量（质量不代表 BGE-M3 语义检索）。

**后续路径（打包阶段，按优先级）**：
1. 接入 better-sqlite3 + sqlite-vec：在 `MemoryService` 注入 `FlatVectorIndex` 的替换实现（`vector.ts` 接口不变：upsert/remove/search/memoryBytes），跑本脚本同一套 10 万条基准做 A/B；
2. 接入 llama-server BGE-M3（`platform.embed` 已就绪）：本报告的 `hybrid` 路径与 `searchAsync` 自动切到真实语义向量，重测 recall@5 与 P95；
3. 若 hybrid 的向量阶段在 10 万条仍需更低延迟：先加倒排关键词（纯 TS，本基准已证明有效），再评估 HNSW/IVF 或 sqlite-vec 的 ANN 能力。
4. 裁决门槛：真实 BGE-M3 + 真实语料下 P95 ≤ 50ms 且 recall@5 不劣于 LanceDB 基线，才把默认后端切到 sqlite-vec；否则维持纯 TS（可在设置面板提供「启用本地嵌入模型」开关）。

## 7. 复现

```bash
cd "Parent file"
node scripts/memory-bench.mjs                 # 默认 10 万条 / 120 查询 / 256 维
node scripts/memory-bench.mjs --count=20000   # 快速冒烟
```

- 脚本无子进程、无强网络依赖（llama-server/原生模块探测失败只记录）。
- 随机种子固定（20261102），语料与查询可复现。
- 结果随 CPU 调度/热降频波动约 ±10–20%（见 §4 测量噪声），判定看阈值余量；用 `--repeat=5` 可增稳。
- 单次总耗时：36139.07 ms（含索引构建；纯检索延迟见 §4）。
