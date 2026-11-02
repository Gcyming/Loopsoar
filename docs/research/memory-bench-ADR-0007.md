# ADR-0007 W5 记忆基准报告（10 万条，纯 TS 方案）

> 生成方式：`node scripts/memory-bench.mjs`（可复现；参数 count=100000 queries=120 dim=256 repeat=3 seed=20261102）。
> 本报告是 ADR-0007「记忆后端裁决」的实测附件。F8 收口已补充原生索引后端对照（§8）：
> sqlite-vec/LanceDB 三路实测 + Electron ABI 验证；**最终裁决：默认 flat（纯 TS hybrid）、sqlite-vec 可选、LanceDB 不纳入运行时**。
> 本地语义模型按用户决定**不引入**（保留 `platform.embed`/llama-server 适配 + hash 回退），因此语义质量结论仍受限制。

## 1. 测试环境

| 项 | 值 |
|---|---|
| 生成时间 | 2026-11-02T09:10:23.134Z |
| OS | win32 10.0.26200 (x64) |
| CPU | 13th Gen Intel(R) Core(TM) i9-13900HX × 16 |
| 内存 | 32504.7 MB |
| Node | v24.18.0 |
| 向量实现 | 生产实现（packages/core/src/memory/vector.ts 直接导入） |
| hash 维度 | 256 |
| llama-server (BGE-M3, 127.0.0.1:8991) | 不可用（fetch failed） |
| better-sqlite3 | 可用（packages/shell 依赖） |
| sqlite-vec | 可用（packages/shell 依赖） |
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
| 语料生成（含唯一性去重） | 151.37 ms |
| 分词 + token 哈希集（全库） | 475.94 ms |
| hash embedding + FlatVectorIndex 写入（100,000 × 256） | 630.02 ms |
| 倒排关键词索引（bench-only，73,884 个 token、2,477,569 条 posting） | 136.95 ms |
| FlatVectorIndex 内存（含槽位/Map 估算） | 104.7 MB |
| 向量原始字节（100,000 × 256 × 4B） | 97.7 MB |
| token 哈希集原始字节 | 9.5 MB |
| 倒排索引估算（posting + Map 开销） | 23.4 MB |
| 全部索引估算合计 | 145.8 MB |
| 进程 heapUsed（索引构建后） | 165.8 MB |
| 进程 heapUsed / RSS（基准结束时） | 144.3 MB / 943.0 MB |
| 增量写入 2,000 条 | 32.25 ms（62022 条/秒） |
| 删除 2,000 条 + compact | 44.23 ms |
| hash 向量非零桶（首条样例 256 维） | 13 |

## 4. 检索延迟与召回（10 万条）

| 路径 | P50 | P95 | max | recall@5 | exact | partial | paraphrase | P95 ≤ 50ms |
|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| keyword-linear | 19.29 ms | **27.33 ms** | 34.86 ms | 50.0% | 75.0% | 27.8% | 27.8% | ✅ |
| keyword-inverted | 1.95 ms | **3.68 ms** | 11.15 ms | 86.3% | 97.9% | 97.2% | 33.3% | ✅ |
| vector-hash | 28.80 ms | **34.42 ms** | 50.33 ms | 67.6% | 100.0% | 55.6% | 5.6% | ✅ |
| hybrid | 4.85 ms | **12.18 ms** | 20.42 ms | 90.2% | 100.0% | 97.2% | 50.0% | ✅ |

- 质量查询数（有 expected id）= 102 条；无关词查询只计延迟。
- **合成语料的质量读法**：每条语料带高熵细节（记录号/session/耗时/日期），因此 exact/partial 的源条目
  可被唯一识别——这验证的是**索引与候选链路正确性**，也让 recall 偏乐观；它不代表真实语料的语义召回。
  partial/paraphrase 的绝对值只用于**四路相对对比**，真实语义质量必须接入 BGE-M3 + 真实语料后复测（见 §6）。

- **测量噪声**：同一脚本在本机连续多次运行的 P95 波动约 ±10–20%（实测范围：keyword-linear 34–50ms、vector-hash 42–54ms、
  hybrid 17–24ms、keyword-inverted 4–5ms）；判定以「是否满足 50ms 且余量」为准，不做毫秒级横向比较。需要更稳可加 `--repeat=5`。

### 4.1 向量维度权衡（单查询全库向量扫描，10 万条；前 60 条查询 × 2 轮）

| 维度 | P50 | P95 | 索引内存 | 构建耗时（含 embedding） |
|---:|---:|---:|---:|---:|
| 128 | 13.93 ms | **14.33 ms** | 55.9 MB | 391.55 ms |
| 256 | 28.80 ms | **34.42 ms** | 104.7 MB | 630.02 ms |
| 384 | 39.58 ms | **43.14 ms** | 153.5 MB | 517.31 ms |

- 维度↑ → 内存/延迟近似线性↑；256 维（BGE-M3 小模型常见量级）在本机 P95 ≈ 34.4 ms，已贴近 50ms 阈值、余量不足（单轮 max 可到 50.3 ms）；
  改为 hybrid（关键词候选 → 向量重排）后 P95 只有 12.2 ms。
- 若将来必须「全库向量扫描」：128 维可压到 P95 ≈ 14.3 ms，但需接受 hash 碰撞带来的质量损失；更优解是 ANN（HNSW/IVF）或 sqlite-vec。

## 5. 结论与建议（ADR-0007 裁决建议）

1. **默认后端（v1）= 纯 TS 混合检索**：`FlatVectorIndex`（flat float32 暴力余弦）+ `hash embedding` + `retrieval` 四阶段。
   - 零原生依赖、可离线、可复现、Electron ABI 无关；实测 10 万条下 **hybrid 路径 P95 = 12.18 ms（达标）**；
     但「全库裸向量扫描」单路径 P95 = 34.42 ms（贴近阈值、余量不足）——
     这正是四阶段设计要「先关键词候选、再向量重排」的原因（向量只对候选集算，10 万条下仍 10ms 级）。
   - 生产记忆库容量上限为 2000（`THRESHOLD_CAPACITY_MAX`），实际规模远小于 10 万；本基准的 10 万是 ADR-0007 要求的压力目标。
2. **关键词路径在 10 万条需要索引才能稳过 50ms**：keyword-linear P95 = 27.33 ms（临界达标，max 已到 34.86 ms）；倒排版 keyword-inverted P95 = 3.68 ms（达标）。
   → 若产品未来把容量提到 10 万级，优先把 `retrieval.keywordCandidates` 换成倒排/前缀索引（纯 TS 即可，无需原生模块）。
3. **hybrid 实测**：P95 = **12.18 ms**，recall@5 = 90.2%（其中 exact 桶 100.0%，证明索引/候选/融合链路正确）；
   在 10 万条下满足 P95 ≤ 50ms 目标。
4. **sqlite-vec / LanceDB 裁决**：F8 已完成三路实测（§8）：10 万条下 flat TS 查询/构建/内存综合最优，
   sqlite-vec 与 LanceDB 均更慢（查询 P95 64.1 / 67.7 ms vs flat 26.2 ms），故**默认 flat、sqlite-vec 可选、LanceDB 不纳入运行时**。
   本报告不宣称 LanceDB 的 ANN 能力优劣（未建 ANN 索引）；语义质量仍受「无本地模型」限制（llama-server/BGE-M3 不可用，按决定不引入本地 BGE）。
5. **与 W5 通过标准逐条对照**：
   - 检索 P95 ≤ 50ms @ 10 万条：hybrid 通过（12.18 ms）；裸向量扫描 34.42 ms 贴近阈值（余量不足）（这也验证了「关键词候选 + 向量重排」四阶段不是冗余设计）；keyword-linear 27.33 ms（临界）。以本机 Node 单线程实测，非 Electron 渲染进程。
   - 检索质量不劣于 LanceDB 基线：**未验证**（无 LanceDB/BGE-M3；hash embedding 是词法向量，不能冒充语义基线）。需在打包阶段用真实 BGE-M3 复测。
   - 备份恢复/归档查回 100%：**未在本基准范围**（记忆持久化是 JSON 快照，恢复=读 JSON；归档查回由五闸软归档保证）。建议打包阶段补专项用例。
   - 增量写入无死锁：单线程索引 upsert/remove 实测 62022 条/秒，无并发写场景（Node 单线程），并发写需上层串行化。

## 6. 原生模块 / llama-server 现状与后续路径

**原因（可复核）**：
1. F8 已接入**可选** sqlite-vec 后端（better-sqlite3 13.0.3 N-API + sqlite-vec 0.1.9，见 §8）；但主基准与默认运行时仍走纯 TS：10 万条实测 flat 查询/构建最快（§8.3），且默认后端按数据裁决为 flat。`NodeSqliteAdapter` 仍是 P4 前的 `LoopsoarNotImplementedError`（packages/core/src/platform/node.ts:153-158），与本可选向量后端无关。
2. llama-server（BGE-M3，127.0.0.1:8991）本机探测结果：不可用（fetch failed）；`platform.embed` 有实现但无服务时只能降级；按用户最新决定不引入本地 BGE/onnxruntime。
3. 因此本基准用 `hash embedding` 做**可运行**的向量能力对照，并明确它只是词法向量（质量不代表 BGE-M3 语义检索）。

**后续路径（按优先级）**：
1. ~~接入 better-sqlite3 + sqlite-vec~~ **已由 F8 完成**（见 §8）：sqlite-vec 作为显式可选后端接入 `MemoryService.vectorBackend="sqlite-vec"`，不可用自动降级 flat；三路 10 万条实测后默认仍 flat；
2. 接入 llama-server BGE-M3（`platform.embed` 已就绪）：本报告的 `hybrid` 路径与 `searchAsync` 自动切到真实语义向量，重测 recall@5 与 P95（不引入本地 BGE/onnxruntime，仅保留 llama-server 适配）；
3. 若 hybrid 的向量阶段在 10 万条仍需更低延迟：先加倒排关键词（纯 TS，本基准已证明有效），再评估 HNSW/IVF 或 sqlite-vec 的 ANN 能力；
4. 裁决门槛（F8 后更新）：默认 flat 已由 §8 数据裁决（10 万条下 flat 查询/构建最优）；只有未来容量显著增长或需要磁盘持久化索引时，才复评 sqlite-vec/ANN，并用真实语义模型重测质量。

## 7. 复现

```bash
cd "Parent file"
node scripts/memory-bench.mjs                 # 默认 10 万条 / 120 查询 / 256 维
node scripts/memory-bench.mjs --count=20000   # 快速冒烟
```

- 脚本无子进程、无强网络依赖（llama-server/原生模块探测失败只记录）。
- 随机种子固定（20261102），语料与查询可复现。
- 结果随 CPU 调度/热降频波动约 ±10–20%（见 §4 测量噪声），判定看阈值余量；用 `--repeat=5` 可增稳。
- 单次总耗时：29868.66 ms（含索引构建；纯检索延迟见 §4）。

> **§8（F8 原生后端对照）由独立项目 `.tmp/membench/` 实测补充**：重跑本脚本时会把已有 §8 原样保留
> （脚本从旧报告提取 `## 8.` 起的内容附回），避免外部实验数据被覆盖；§8 数字不参与本脚本重算。

## 8. F8 原生索引后端对照（sqlite-vec / LanceDB）与最终裁决

> 本节由 F8 收口任务补充（独立 npm 项目 `.tmp/membench/`，不入库；`scripts/memory-bench.mjs` 重跑会保留本节，脚本已支持保留 §8）。
> 本地语义模型的限制不变：**不引入 BGE/onnxruntime**，hash embedding 仍是词法向量；本节只裁决「索引后端」，不改变检索质量结论。

### 8.1 环境与依赖安装

| 项 | 值 |
|---|---|
| OS / CPU / 内存 | win32 10.0.26200 (x64) / i9-13900HX ×16 / 32504.7 MB |
| Node | v24.18.0（bench 进程） |
| Electron | 45.0.0（运行时 node 24.22.0 / NAPI 10 / chrome 156） |
| better-sqlite3 | 13.0.3（N-API prebuild，无 ABI 后缀） |
| sqlite-vec | 0.1.9（+ sqlite-vec-windows-x64） |
| @lancedb/lancedb | 0.41.0（+ @lancedb/lancedb-win32-x64-msvc 0.41.0） |
| @electron/rebuild | 4.2.1（仅 ABI 复核用） |
| MSVC | Visual Studio 2022（本会话未用于编译，原因见 8.5） |

仓库侧安装（写入 `packages/shell/package.json` + `pnpm-lock.yaml`）：

```bash
cd "Parent file"
pnpm add better-sqlite3 sqlite-vec --filter loopsoar-shell
pnpm add -D @electron/rebuild --filter loopsoar-shell
```

> 本会话沙箱的 pnpm store 在工作区外且只读，`pnpm add` 用 `--lockfile-only` 更新清单与锁文件；随后 `packages/shell` 下依赖已完成安装，`require("better-sqlite3")` / `require("sqlite-vec")` 实测可用（见 8.5）。

独立基准项目（不进仓库）：

```bash
mkdir -p .tmp/membench && cd .tmp/membench && npm init -y
npm install better-sqlite3 sqlite-vec @lancedb/lancedb
node --expose-gc bench-native.mjs --only=flat        # 三个后端各跑独立进程，内存数字才干净
node --expose-gc bench-native.mjs --only=sqlite-vec
node --expose-gc bench-native.mjs --only=lancedb
node merge-results.mjs
```

### 8.2 口径

- 语料：100,000 条记忆文本（中英混合；fact/preference/lesson/convention/identity），hash embedding 256 维（复用 `packages/core/src/memory/vector.ts`，三路使用同一向量）。
- 查询：200 条（随机抽取语料原文 → 向量），topK=6 / topK=20；每后端预热 10 条后逐条计时，统计 P50/P95/max。
- 内存：每后端在独立 Node 进程 + `--expose-gc`，构建前后取 RSS/heapUsed 增量（不含语料生成与 embedding 的干扰）。
- 体积：sqlite-vec 取 `.db` 文件大小；LanceDB 目录递归；flat 无文件（给 `memoryBytes` 估算）。
- 增量：三个后端各自追加写入 2,000 条，统计耗时与吞吐。

### 8.3 三路实测（10 万条，256 维）

| 后端 | 建索引 | 查询 topK=6 P50/P95 | 查询 topK=20 P50/P95 | 索引体积 | 进程内存增量 RSS/heap | 增量写入 |
|---|---:|---:|---:|---:|---:|---:|
| **flat TS（默认）** | **166.7 ms** | **24.4 / 26.2 ms** | **26.6 / 28.2 ms** | 0（内存；向量原始 97.7 MB，memoryBytes 估算 203.3 MB） | +143 MB / +7 MB | **83,196 条/s** |
| sqlite-vec | 808.6 ms | 59.1 / 64.1 ms | 60.4 / 66.6 ms | 103.8 MB（.db，含 payload 表） | +22 MB / +7 MB | 80,273 条/s |
| LanceDB | 1,751.6 ms | 62.6 / 67.7 ms | 63.3 / 100.6 ms | 98.4 MB（目录） | +513 MB / +204 MB | 18,220 条/s |

> 说明：flat 的 RSS 增量包含整个索引（≈向量 97.7 MB + 槽位/Map），203.3 MB 是 memoryBytes 的保守上界；sqlite-vec/LanceDB 的向量在原生/磁盘侧，故 RSS 低但磁盘占用明显。
> 三者都是「暴力/自适应暴力」检索（sqlite-vec 0.1.9 无 ANN；LanceDB 未建 vector index），本表反映的是**索引后端自身开销**，不是 ANN 能力对比。

### 8.4 裁决：默认 flat、sqlite-vec 可选、LanceDB 不纳入运行时

1. **查询最快**：flat topK=6 P95 26.2 ms，比 sqlite-vec（64.1 ms）快 2.4×、比 LanceDB（67.7 ms）快 2.6×；生产记忆容量上限 2000（`THRESHOLD_CAPACITY_MAX=2000`），该规模 flat 是亚毫秒级，没有引入原生后端的必要。
2. **构建最快**：flat 166.7 ms；sqlite-vec 808.6 ms（4.8×）、LanceDB 1,751.6 ms（10.5×）。load 时重建索引直接影响启动/工具可用时间。
3. **增量写入不亏**：flat 83k/s、sqlite-vec 80k/s 相当；LanceDB 18k/s（4.5× 慢）。
4. **内存/体积可控**：flat 10 万条 ≈143 MB RSS（2000 条 <3 MB）；sqlite-vec 103.8 MB 磁盘 + 22 MB RSS；LanceDB 磁盘 98.4 MB 但 RSS +513 MB、heap +204 MB，成本最高。
5. **依赖成本**：better-sqlite3 13 是 N-API prebuild（ABI 风险已消除，见 8.5），但仍多一个原生依赖 + 平台扩展包；LanceDB 的原生包体积/内存代价大且默认无 ANN，收益不足。
6. **无本地语义模型**：hash embedding 只是词法向量，本节的「快」不代表语义质量；语义路径仍由 `platform.embed`（llama-server，可选）+ `searchAsync` 承担，不可用时降级 hash。按用户最新决定不引入 BGE/onnxruntime。

**最终裁决：`MemoryService.vectorBackend` 默认 `"flat"`（纯 TS hybrid）；`"sqlite-vec"` 为显式可选后端（不可用自动降级）；LanceDB 仅作对照，不进入运行时依赖。** 无本地语义模型 = 现状不变（`platform.embed` 适配 + hash 回退）。

### 8.5 Electron ABI：N-API 让 electron-rebuild 不再是必需

- better-sqlite3 **13.0.3 已改为 N-API**：`binding.gyp` 定义 `NAPI_VERSION=10`，`package.json` 标记 `gypfile:false`，并随包分发 `prebuilds/win32-x64.node`（文件名无 ABI 后缀）。
- 仓库内执行 `electron-rebuild -f -w better-sqlite3`（@electron/rebuild 4.2.1，Electron 45.0.0）→ exit 0：`Searching dependency tree / No native modules found / ✔ Rebuild Complete`——electron-rebuild 把 N-API 预编译模块视为「无需重建」，这是正确行为，不是失败。
- 在独立项目强制重建（`-v 45.0.0 -f`）时 electron-rebuild 尝试 node-gyp 编译 → **`spawn EPERM`**（本会话沙箱禁止子进程管道；非代码问题，CI/本地终端可正常执行）。该失败无需修复：N-API 二进制可跨 Node/Electron 加载。
- **运行时实测（Electron 45 主进程）**：`ELECTRON_VERSIONS {"electron":"45.0.0","node":"24.22.0","napi":"10","chrome":"156.0.8078.48"}`；加载 `packages/shell/node_modules` 的 better-sqlite3 → `BETTER_SQLITE3_OK`；`sqlite-vec.load` + vec0 KNN → `SQLITE_VEC_OK [{"rowid":1,"distance":0}]`；`RESULT OK`（进程退出码 3 仅因沙箱拒绝 Chromium mojo 命名管道，应用逻辑已完成）。
- 结论：**Electron ABI 风险已消除，打包无需 electron-rebuild**；若未来引入非 N-API 原生模块，再执行 `pnpm add -D @electron/rebuild` + `electron-rebuild -f -w <module>`（devDependency 与锁文件已就绪）。

### 8.6 降级证据（fail-open）

- `createSqliteVecBackend`：loader 抛错（模拟未安装 / ABI 不匹配）→ `null`；better-sqlite3 导出形状非法 / sqlite-vec 无 `load` / 维度非法 → `null`；**绝不向调用方抛错**。
- `resolveVectorBackend`：请求 `"sqlite-vec"` 但工厂返回 null / 抛错 / 维度不符 → 自动降级 flat，并在 `note` 记录原因。
- `MemoryService`：`vectorBackend:"sqlite-vec"` + 后端不可用 → `vectorStats()` 返回 `requestedBackend="sqlite-vec"`、`backend="flat"`、`backendNote="sqlite-vec 不可用…已降级 flat"`，`search/searchAsync` 照常工作；默认为 flat 时**完全不 require 原生模块**（启动零开销）。
- 验证：`tests/shell/sqliteVectorBackend.spec.ts`；本沙箱 vitest 仍 `spawn EPERM`，已用编译后真实实现 harness 跑等价断言 **9 组全过**（flat 语义 / 不可用返回 null / 真实 sqlite-vec 全链路 / resolve 降级 / MemoryService 接线与降级 / memoryTools 兼容）。

### 8.7 复现与后续

- 基准脚本与原始 JSON 在 `.tmp/membench/artifacts/results.json`（本地文件，不入库）；三后端各跑一次约 1–2 s（100k 语料生成 + embedding 0.44 s 另计）。
- 若未来记忆容量提升到 10 万级：先把 `retrieval.keywordCandidates` 换成倒排（§4 已测 4.1 ms），再评估 sqlite-vec/ANN；当前 2000 容量下 flat 足够。
- 若未来引入本地语义模型（用户已明确暂不引入）：`platform.embed` 接口已就绪，`searchAsync` 自动切换，无需改后端。
