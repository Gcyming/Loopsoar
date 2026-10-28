# Loopsoar 初步项目规划（v0.3）

> 定稿：2026-10-27（v0.3 增补；v0.2 主体仍有效，冲突处以本增补与三份交付物为准）

## v0.3 增补：产品定位修正与三份交付物

### A. 定位修正（2026-10-27 用户裁决）：Loopsoar = **浏览器优先的 Agent（agentic browser）**

Loopsoar 是一个**完整的浏览器**（类似 Edge/Chrome 的浏览功能面），但**主体是 Agent**：以 **search 为中心**，AI 辅助全网 fetch 数据、理解、整合，从而辅助用户——形态参照 Tabbit（浏览器即界面、Agent 规划执行、可见执行日志、敏感步骤确认），但保持 Loopsoar 自己的三个差异化：**本地优先、Agent 连续性（可携带记忆）、可信自治**。

由此带来的规划修正（详细裁决见 [docs/decisions/ADR.md](docs/decisions/ADR.md)）：

1. **浏览器从「13 个工具组」升级为壳层主界面 + 一等公民**：主窗口即浏览器（多标签/地址与搜索一体框/书签/历史/下载/广告拦截/页面保存/独立任务标签组）。设计**借鉴 slime 的浏览器先例（webview、广告拦截、下载、browser 13 工具、searchIndexService）但绝不照搬代码**——实现走新的 `BrowserAdapter`（§5.3），D0 验证后冻结接口。
2. **search 升级为主干**：slime 的「5 引擎自建搜索 + searchIndexService 本地页面索引」从旁路工具升级为产品主链路能力；网页数据「fetch → 理解 → 整合 → 辅助用户」是核心闭环。
3. **§2.2 方向排序调整为**：①浏览器优先的 Agent（search 中心 + 全网 fetch 辅助）②Agent 连续性 ③可信自治 ④本地优先 + 混合模型路由 ⑤三层扩展生态 ⑥跨端同核（v1 收窄为 Windows 桌面；安卓为轻量形态，后置）。
4. **v1 范围按依赖收窄**：见 [docs/MVP-验收表.md](docs/MVP-验收表.md) 的最小可交付主链路——对话 → 模型调用 → 工具执行 → 权限判断 → 结果核验 → 记忆读写；其余按依赖进入。

### B. 五条收紧意见的落点（不再增加规划章节，收敛为三份交付物）

| 评审意见 | 落点 |
|---|---|
| ① v1 范围偏大，先定最小主链路 | [docs/MVP-验收表.md](docs/MVP-验收表.md) + ADR-0008 |
| ② 单栈与跨端同核需明确边界 | ADR-0004（platform 接口只抽象「有真实第二实现或明确必要性」的能力） |
| ③ 安全需攻击性测试而非规则清单 | [docs/P0-验证计划.md](docs/P0-验证计划.md) W4 + ADR-0009 |
| ④ 记忆/向量后端需真实负载测试 | [docs/P0-验证计划.md](docs/P0-验证计划.md) W5 + ADR-0007（阈值+硬件写入验收） |
| ⑤ Python 零进程是目标不是先验结论 | ADR-0005（逐项验证通过才删旧实现） |

### C. 三份交付物（本次产出，与规划同仓库）

- [docs/decisions/ADR.md](docs/decisions/ADR.md) —— 架构决策记录（9 条，逐条标注 已验证/待验证/可回退）
- [docs/P0-验证计划.md](docs/P0-验证计划.md) —— P0 验证计划（浏览器原型 / 契约管线 / 最小工具轮 / 安全拒绝路径 / 记忆负载测试）
- [docs/MVP-验收表.md](docs/MVP-验收表.md) —— 最小可交付版本验收表（主链路六步 / 必须 / 可后置 / 阶段门）

## v0.4 增补：最后设定（2026-10-27 用户裁决）—— Agent-Loop 可插拔 · 万物皆插件 · 好用低门槛

三件最终设定已落成独立文档 [docs/设定-Agent-Loop与插件体系.md](docs/设定-Agent-Loop与插件体系.md) + ADR-0010/0011/0012，摘要：

1. **Agent-Loop 可插拔**：内置唯一 minimal complete 初始 loop（不可删改，只能复制再改）；自定义三档（L1 参数化 / L2 声明式 / L3 脚本=插件 `loop` 贡献点）；**安全模式后备**——静态校验 + 运行期健康检查（心跳/预算闸/崩溃/死循环），改坏自动回退内置 loop，任务不中断、数据不丢；**护栏归属 harness**（权限四层、预算闸硬上限、声称核验、身份注入、心跳协议、Git 治理，loop 不可绕过）。
2. **万物皆插件（对齐 DSH）**：内核最小化四件（浏览器壳 + 引擎 + 安全护栏 + PluginHost）；内置功能以 builtin 插件形态存在、可禁用可覆盖（区别于 slime 31 组 `unloadable:false`）；贡献点 = slime 八类 + 新增 `loop` / `omnibox` / `agent-template`，UI 贡献点扩充；插件 `registerTools` 真实现；插件向导/热重载/校验器/沙箱预览/配置导出为插件。
3. **好用低门槛（不做毛坯房）**：三档使用深度渐进披露；反毛坯房清单 6 条进验收（向导 3 分钟可用/默认值+中文解释/错误可读给下一步/一键回退三件套/产品内文档/非开发者 10 分钟可演示）；保留 slime 原定风格（本地优先、Agent 人格、流式卡片、内嵌权限选择题、右侧栏、双主题），以可信自治为差异化。

对既有文档的影响：MVP 验收表新增「Agent-Loop 可插拔」必须项；P5 验收新增 loop 贡献点 + 安全模式回退演练；P6 验收新增渐进披露与清单 6 条；§6.2 处置表按 ADR-0011 调整。

> 定稿：2026-10-27（v0.2，响应 v0.1 评审意见修订）
> 性质：**初步规划**——回答「框架设定 / 功能安排 / 主要方向 / 双栈 vs 全栈 / 运行基座选型」五个问题；不替代详细设计文档。
>
> **v0.2 修订记录（对应评审 4+2 条意见）**：
> 1. 浏览器技术路线改为 **P0 决策门（D0 spike）**，先验证后冻结适配器接口；修正「Electron 官方不建议 `<webview>`」的外部事实
> 2. Electron **锁定架构、不锁主版本**：v1 使用开发与发布时处于官方支持期且通过回归验证的稳定版
> 3. 「引擎 6.3 万行复用」改为**有验收门的模块迁移**（五问清单），并补平台适配层（零 Electron 依赖 ≠ 可跑 Web Worker）
> 4. 安全验收具体化为**不可跳过的发布门**（5 条可测标准）+ IPC 敏感 handler 四要素校验
> 5. 里程碑口径统一：**P0–P9 为 v1 十个阶段，P10 为后续滚动阶段**
> 6. **心智模块精简方案**（§6.5）：保留精华、删除演化引擎与 PAD 情绪网络；「Agent 永存」改为「Agent 连续性」
> 7. 补充 AI 辅助定位与决策登记（ADR）机制

---

## 0. 结论速览（先读这一页）

| 问题 | 结论 | 一句话理由 |
|---|---|---|
| **是否延续 slime 代码** | ❌ 不照搬仓库，**新仓库重建**；✅ 引擎**按模块、过验收门迁移**（不是默认认可 6.3 万行旧代码） | 壳层与 Python 栈是技术债重灾区，引擎是待甄别的资产 |
| **双栈还是全栈** | **全栈 TypeScript（单栈）**；Python 收口为「零或最小侧车」，目标归零 | slime 全部 5 条双栈不对称缺陷都源自两套引擎平行漂移 |
| **运行基座** | **锁定 Electron 架构，不锁主版本**（随官方支持滚动，45→46→…）；**浏览器能力经适配器接口解耦，D0 spike 验证后冻结**；备选 Tauri 2.12 + Node sidecar（有 gate）；排除自编译/Wails/Sciter/Servo/Neutralino/Flutter | 浏览器自动化是核心功能但官方已不建议 `<webview>`——先验证 WebContentsView 路线再冻结接口；版本升级是例行工程 |
| **框架设定** | monorepo：`contracts / core / services / gateway / shell / ui / sidecar / mobile`；契约单源；IPC 由 schema 生成 + 敏感 handler 四要素校验；壳层按域拆分；**core 内平台适配层**（fs/进程/SQLite/网络抽象） | 反 God file、反双栈漂移、反「零 Electron 依赖=万能可移植」的错觉 |
| **主要方向** | ①Agent 连续性（可携带身份与记忆：陪伴感、越用越顺手、独立判断）②可信自治 ③本地优先+混合模型路由 ④三层扩展生态 ⑤跨端同核 | 不搞「永存/生命体」叙事；心智模块精简（§6.5） |
| **功能安排** | **P0–P9 十个 v1 里程碑**（P0 含 D0 浏览器决策门）+ **P10 滚动阶段**；发布前必须通过 §6.4 五条不可跳过的安全发布门 | 每个阶段带验收门，安全标准可测 |

---

## 1. 对 slime（D:\pilot project）的理解总结

### 1.1 它是什么

**本地优先的桌面 AI Agent 平台**：Electron 35 客户端 + TypeScript 调度核心 + Python 推理/工具侧车，内置 llama.cpp 本地推理（含 CUDA 后端 + MoE 适配）。核心命题：

> **模型是硬件，Agent 是软件。** 模型可换、设备可换，Agent 的身份、记忆、偏好与行为习惯必须能延续。

### 1.2 实测体量（非估算）

| 模块 | 文件 | 行数 | 语言 | 角色 |
|---|---:|---:|---|---|
| `core-ts/src` | 151 | 63,265 | TS | 调度核心（唯一引擎，**零 Electron import**） |
| `gui/src/main` | 40 | 25,497 | TS | Electron 主进程（其中 `index.ts` 单文件 10,105 行） |
| `gui/src/preload` | 1 | 1,499 | TS | contextBridge（51 个 API 域） |
| `gui/src/renderer` | 106 | 51,838 | TSX/TS | React 19（33 页 + 48 辅助模块） |
| `core/` | 51 | 24,598 | Py | Python 业务核心（CLI/Server 用） |
| `tools/` + `sidecar/` | 25 | 5,640 | Py | 工具实现 + 推理/嵌入/SILAM 侧车 |
| `gateway-ts/src` | 3 | 1,305 | TS | OpenAI 兼容 HTTP 网关 |
| `shared/gen` | 5 | 3,936 | TS+Py | 契约层 |
| `tests/` | 492 | ≈121,000 | TS+Py | 420 spec.ts + 72 test_*.py |

运行时事实：**65 个内置工具**；**305 条 IPC 通道**（274 handler + 31 推送；其中 **26 条裸 `ipcMain.handle` 不校验 sender**）；51 个 preload 域；31 组内置插件；18 个随包技能。QA：pytest **1529 passed / 5 skipped**，run_tests 1450 passed / 2 failed（两套 runner fixture 语义不一致所致）。

### 1.3 架构与主链路

```
renderer(React19) ── slimeAPI(51域) ──► preload ──IPC──► main 进程
                                                          │ 直接函数调用（不走 HTTP 回环）
                                                          ▼
                                    core-ts 引擎：ChatService → SlimeEngine
                                    （模型路由+工具轮）→ ToolLoop → SandboxManager
                                    → MemoryStore / mind / skills / plugins
                                                          │
                                    ├─ spawn llama-server（本地推理）
                                    ├─ spawn slime_server.py（Python 后端，:19000）
                                    └─ spawn SILAM sidecar（情感脑）
旁路：gateway-ts（Fastify 薄壳） / slime_cli.py（Rich CLI）/ mobile（Capacitor，复用同一 core-ts）
```

关键设计：主链路**不走 HTTP**；渲染层→IPC→主进程→core-ts 纯函数调用。Python 后端是并行形态，不是主链路必经节点。Android 端已在 Web Worker 里跑同一套 core-ts——证明引擎与壳的**接口**可解耦，但**不证明每个模块都天然可移植**（见 §6.1 迁移五问与平台适配层）。

### 1.4 已被实战验证、值得继承的能力（10 条）

1. **stable/volatile 前缀分离**——system 前缀字节稳定，易变段挂末段 user 消息，保住 KV 缓存（`engine.ts:954-1022`）
2. **四道预算闸 + 显式归因**——轮次 500 / 工具调用数（仅 Agent 显式配）/ token 12M / 墙钟 3h，命中即收束并写明是哪一闸（`tool_loop.ts:143-230`）
3. **心跳机制**——工具执行期每 15s 发 `heartbeat`，区分「静默」与「死亡」
4. **权限四层纵深 + fail-closed**——L0-L5 分级、八步决策链末位默认拒绝、「判不了 ≠ 不存在」（`sandbox.ts:462-527`）
5. **记忆写入五道闸**——去重 0.75 / 跨 agent 指针 / 合并 0.68 / 建链 0.70 / 2000 上限 + 软归档永不物理删除（`memory/store.ts:952-1061`；阈值已经真实语料校准，**不可下调**）
6. **召回门控**——廉价判据（过去时/指代/新实体/任务切换）先于检索，少而准 > 多而全
7. **幻觉护栏三层**——工具即事实源 / 声称核验（`claims.ts`）/ 强制工具轮
8. **插件作用域逆序 dispose**——可逆贡献是扩展系统的地基
9. **Git 治理运行时化**——commit 门禁 / diff 评审 / 无合并权 / 身份注入不可覆盖 / Lint Gate（`tools/git.ts`，948 行）
10. **契约单源 + 双端同源校验**——security-policy 一处产出两栈代码，「关键数字同源」守卫

> ⚠️ 这 10 条是**已验证的能力与语义**，是迁移蓝本——不代表承载它们的代码可以整体平移（§6.1）。

### 1.5 技术债与陷阱（做正式版必须绕开的）

- **双栈不对称（根因级）**：TS MCP 客户端零生产引用（真跑的是 Python）；TS OAuth 2.1 是 stub；TS `web_fetch` 无 SSRF/DNS 钉扎；Python `core/silam.py` 是导入即 NameError 的死代码；情绪主语两栈只修一半。**全部 5 条都源自「两套引擎平行漂移」。**
- **God file**：`gui/src/main/index.ts` 10,105 行、232 个 handler（全仓 85%），main 层几乎零单测，历史 3 处崩溃点都出自这里。
- **IPC 契约手写两份**：152 条常量声明里 5 条是真死码；26 条通道不校验 sender。
- **半接线三处**：声称核验只在生成类请求+零工具时跑；异常检测 5 条规则里 2 条是空实现；插件 `registerTools` 恒返回 `[]`（插件加不了工具）。
- **测试两套 runner**：run_tests.py 只注入 `tmp_path`，用了 `monkeypatch` 的用例就挂——**统一成一套是硬要求**。
- **浏览器路线隐忧**：13 个浏览器工具建立在 `<webview>` 上，而 **Electron 官方明确不建议使用 webview**（见 §5.1 官方原文）——slime 的技术支柱本身在官方警告范围内。
- **供应链/量级**：模型下载无 sha256 校验；`@lancedb/lancedb` 原生包 297MB；企业微信适配器实际走不通。

---

## 2. Loopsoar 定位与主要方向

### 2.1 核心命题（收敛表述，去宏大化）

「模型是硬件，Agent 是软件」。产品要实现的不是「数字生命」之类的宏大叙事，而是三个朴素目标（创立初心，表述收敛）：

1. **陪伴感 / 活人感**——Agent 记得住你、有连贯的性格与语气，用起来像一个持续的伙伴；
2. **越用越顺手**——偏好、习惯、教训随时间沉淀，配合度上升而不是每轮从零开始；
3. **独立判断、不迎合**——不完全讨好用户：用户要求与其偏好/事实冲突时礼貌指出，不确定就说不知道，不编造认同。

命名语义：**loop（无限循环）→ soar（打破循环、持续高飞）**。

### 2.2 五个主要方向（按优先级）

1. **Agent 连续性（原「永存」的收敛版）**：身份包（继承 `.slimeagent` v1.2 协议：manifest + SHA-256 + 冲突策略 + 向量索引不入包）+ 记忆/偏好可迁移。**卖点是「可携带、不丢失、跨设备连续」，不宣传「永生」。**
2. **可信自治**：权限四层 + 反幻觉三层 + Git 治理运行时化 + 审计日志。让「会自己干活的系统始终可信、可追溯、可兜底」——与大厂通用助手的最大分野。
3. **本地优先 + 混合模型路由**：llama.cpp 侧车（CUDA/CPU 双后端随包）+ **MoE 适配已实测跑通**（35B-A3B：字节口径显存估算、KV 只算注意力层、`--n-cpu-moe` 自动下放——三条实测决策原样继承）+ 外部就绪实例认领 + 云模型降级链。
4. **三层扩展生态（补齐 slime 的断点）**：插件（容器）→ 技能（指令层）→ MCP（工具来源），并且**插件 `registerTools` 真实现**。
5. **跨端同核**：桌面 + Android（Capacitor）共用 core-ts 与渲染层；壳层接口契约化，基座可替换。

### 2.3 v1 明确不做什么（边界）

- 不做网页版/纯云端版（本地优先是定位，gateway-ts 仅作为外部接入旁路保留）
- 不做企业微信等未跑通的社交适配器（挂起）
- SILAM 不作为主引擎融合（接口保留，作为后续插件化能力）
- 实体图谱不作为默认检索路径（调研结论：图结构在简单事实检索上可能倒退；保留为可开关）
- **心智模块不整体复刻 slime**：删演化引擎与情绪数值网络，按 §6.5 精简方案实现

---

## 3. 框架设定（架构总纲）

### 3.1 进程模型（统一图）

```
┌──────────────────────── Loopsoar 桌面应用 ────────────────────────┐
│  renderer（React 19，Vite 构建）                                    │
│     │ loopsoarAPI.<domain>.<method>()   ← 由契约 schema 生成       │
│     ▼                                                              │
│  preload（contextBridge，channel 由 schema 生成，白名单式）          │
│     ▼                                                              │
│  壳层 main（按域拆分：chat / perm / agents / workspace / extras /    │
│             runtime / updater / browserAdapter —— 反 God file）     │
│     │ 直接函数调用（不走 HTTP）                                     │
│     ▼                                                              │
│  core-ts 引擎（自 slime 按模块迁移，见 §6.1）                        │
│     ├─ ChatService / Engine / ToolLoop / Router 四件套              │
│     ├─ SandboxManager（权限四层）                                   │
│     ├─ MemoryStore / mind-lite / skills / plugins / mcp            │
│     ├─ ToolRegistry（按 profile 分组，默认最小面）                  │
│     └─ platform 适配层（fs / 进程 / SQLite / 网络 / 嵌入 抽象接口）   │
│            ├─ node 实现（桌面侧车）                                  │
│            └─ web 实现（Android Web Worker / 未来基座）              │
│     │                                                              │
│     ├─ spawn llama-server（本地推理+嵌入，生命周期归 core）           │
│     └─ spawn [可选最小 Python sidecar]（仅无 TS 等价物的场景，目标为零）│
└────────────────────────────────────────────────────────────────────┘
旁路：gateway-ts（OpenAI 兼容 HTTP）｜ mobile（Capacitor + Web Worker 跑 core-ts）
```

### 3.2 仓库结构（monorepo，pnpm workspace）

```
loopsoar/
  packages/
    contracts/   契约单源：openapi + security-policy + ipc-channels + 定价快照
                 → 生成 TS 类型/校验器/IPC 常量/preload 白名单（替代手写两份）
    core/        slime core-ts 的模块化迁移（engine/router/tool_loop/sandbox/
                 memory/mind-lite/tools/mcp/skills/plugin/model_server/websearch/…）
                 + platform/ 适配层（唯一允许接触 Node API 的边界）
    services/    域服务：chat/agents/workspace/extras/runtime/usage/export-import
    gateway/     OpenAI 兼容 HTTP 网关（Fastify 薄壳，复用 core 服务）
    shell/       壳层：main 按域拆分 + preload + 系统能力（adb/更新/托盘/窗口）
                 + browserAdapter/（浏览器适配器：§5.3，D0 验证后冻结接口）
    ui/          React 19 渲染层（对话/设置/右栏/权限交互/流式渲染）
    sidecar/     二进制侧车装配（llama-server 打包、CUDA 运行时分层）
    mobile/      Capacitor 安卓端（复用 ui + core，platform 走 web 实现）
  tools/         构建/QA/守卫/打包脚本（继承 slime 的 preflight/retry-build 思路）
  tests/         统一 vitest（+ 若保留 Python 侧车则 pytest 单轨）
  docs/          设计文档 + decisions/（ADR 决策登记）
```

### 3.3 四条架构铁律（从 slime 教训反推）

1. **契约单源**：IPC 通道、preload 域、安全策略、关键数字全部从 `contracts/` 单一 schema 生成；启动期断言「声明的通道必有 handler、handler 必在声明内」，死码在 CI 变红。
2. **壳层与引擎物理隔离 + 平台适配层**：core 包零 `electron` 依赖（编译期守卫钉死），且**所有 Node 专属能力（fs/子进程/SQLite/网络）只经 `platform/` 适配层调用**——「零 Electron 依赖」只保证引擎不直接依赖 Electron，**不保证可跑在浏览器/Web Worker**；适配层才提供这份保证。壳层可整体替换，这是基座选型自由的制度保障。
3. **单写者**：`data/` 与 `Knowledge/` 每类文件只有一个写入者；永存双根（`Knowledge/` 人读 + `data/agents/` 机读）不变。
4. **fail-closed 兜底 + 「判不了 ≠ 不存在」**：权限、插件信任、分支保护、工具表装配全部沿 slime 语义。

---

## 4. 双栈 → 全栈决策

### 4.1 结论

**全栈 TypeScript 单栈。** Python 不再承载任何业务编排（Agent/LLM 客户端/工具轮/MCP/沙箱/记忆全在 TS）；推理与嵌入由 **C++ 二进制侧车**（llama-server 系列）承担，不经 Python。

理由：
1. slime 的全部 5 条「双栈不对称」缺陷都来自两套引擎平行漂移，靠人工对齐是不可持续的；
2. Android 端已证明 core-ts 单栈可跑通全链路；
3. Python 剩余价值集中在少数几个场景，且每个都有 TS 等价路径（见下表）；
4. 单栈后测试体系统一、契约生成简化（只需 TS 一侧）、发布链路少一条 sidecar。

### 4.2 Python 现有内容的处置清单

| Python 内容 | 处置 | 替代 |
|---|---|---|
| `slime_server.py` / `slime_cli.py`（40 REST 端点 + 35 命令） | **删除** | gateway-ts + 壳层等价能力；CLI 形态如需保留，用 TS 薄 CLI |
| `core/llm.py` / `agent.py` / `executor.py` / `swarm.py` / `merger.py` | **删除** | core-ts 已有等价实现（引擎/子代理/批量编排/完成协议） |
| `core/mcp_client.py` + `mcp_oauth.py`（OAuth 2.1 完整实现） | **移植为 TS**（slime 里唯一 Python 更完整的能力，是移植蓝本） | TS `mcp.ts` 补齐 OAuth 2.1（PKCE/DCR/发现/refresh/401 重放） |
| `core/fetcher.py`（SSRF 13 段私网 + IP 钉扎 + Host/SNI） | **移植为 TS** | TS `web_fetch` 补齐对等安全边界 |
| `tools/agnes_media.py`（4 个媒体工具） | **TS 重写**（HTTP 调用 Agnes API，缓存/限额逻辑照搬） | 消除「强制工具轮无工具可调」的断点 |
| `sidecar/silam_brain_sidecar.py`（C 内核桥） | **TS 直桥**：TS 进程经 stdio/JSONL 直连 C 内核二进制 | 若 C 内核短期内不发布，此项整体挂起 |
| `core/emotion.py` / `behavior.py` / `evolve.py` / `knowledge.py` 等心智实现 | **删除**（TS 侧以 mind-lite 替代，见 §6.5；Python 侧不移植） | mind-lite |
| 嵌入/检索侧车（BGE-M3） | 保留二进制形态，**不经 Python** | llama-server `POST /v1/embeddings` 直接调用 |

**落地原则**：研究型/一次性 Python 脚本允许存在于 `tools/`（不发布、不进入产品链路），但**产品运行时内 Python 进程数目标 = 0**；若某场景确实无 TS 等价物，以「显式白名单 sidecar」存在并在文档标注理由（预期：agnes、SILAM 直桥，且都只是 HTTP/stdio 客户端，无编排逻辑）。

### 4.3 关键依赖选型

| 依赖 | 现状（slime） | Loopsoar 决策 |
|---|---|---|
| TS / Node | TS 5.6 / Node 22（Electron 35 内置） | TS 5.6+ / Node 随 Electron 稳定版（45=Node 24.22，46=Node 24.22） |
| 渲染 | React 19 + Vite 6 | 不变（渲染层按模块迁移，同样过验收门） |
| 向量库 | `@lancedb/lancedb` 原生包 **297MB** | **首选项换 `better-sqlite3 + sqlite-vec`**（检索 10 万条量级足够）；LanceDB 保留为可选后端着 spike 实测对比 |
| 本地 KV/SQLite | better-sqlite3（页存储/搜索索引） | 不变（走 platform 适配层） |
| 打包/更新 | electron-builder 26 + electron-updater | 不变（若走 Electron 主线） |
| 移动端 | Capacitor 8 | 不变 |

---

## 5. 运行基座选型（核心决策）

### 5.1 需求约束与一个必须修正的外部事实

| 约束 | slime 的依赖点 | 对基座的要求 |
|---|---|---|
| 内嵌浏览器自动化 | 13 个 browser 工具建立在 `<webview>` 上 | 基座必须能内嵌并注入/控制第三方网页 |
| 屏幕控制 | Windows UIA 经 **spawn powershell.exe + Add-Type UIAutomationClient**（`screen/backends/desktop.ts`）+ 截图/注入 | 只需能 spawn PowerShell——**任何基座都满足**，不构成 Electron 锁定 |
| Node 原生模块 | better-sqlite3 / lancedb（main 进程内，需匹配 Electron ABI） | 基座需带 Node（或可挂 Node sidecar） |
| 进程编排 | spawn llama-server / 外部服务 / adb | 通用能力 |
| 分发 | 安装器/便携版/自动更新/托盘/单实例/协议注册 | 基座需成熟分发体系 |
| 引擎可移植性 | core-ts **零 Electron import**（已实测） | 引擎随任何基座走，但 Node 专属能力必须经平台适配层（§3.3 铁律 2） |

**必须修正的外部事实（Electron 官方立场，2026-10 文档）**：

> *"We do not recommend you to use WebViews, as this tag undergoes dramatic architectural changes that may affect stability of your application. Consider switching to alternatives, like `iframe` and Electron's `WebContentsView`, or an architecture that avoids embedded content by design."*
> —— [Electron Web Embeds 教程](https://www.electronjs.org/docs/latest/tutorial/web-embeds)；[`<webview>` Tag API 警告](https://www.electronjs.org/docs/latest/api/webview-tag) 同义。

结论：**不能再把 `<webview>` 当成无条件成立的技术支柱。** 硬依赖是「内嵌浏览器自动化能力」，不是 webview 本身。Electron 仍是该能力最成熟的平台（`webContents` / `WebContentsView` / CDP 全家桶），但浏览器能力必须抽象成适配器接口，主实现优先验证 `WebContentsView`（主进程控制、webContents 语义完整），`<webview>` 降级为兼容层，WebView2+CDP 留作未来基座路径。

### 5.2 候选评估

| 候选 | 优势 | 劣势 | 对 Loopsoar 的真实成本 | 结论 |
|---|---|---|---|---|
| **Electron（锁定架构、版本滚动）** | 浏览器自动化能力全家桶（webContents/WebContentsView/CDP）；分发体系成熟；升级路径明确 | 内存/体积大；8 周一主版本、EOL 快（需例行跟进） | 壳层按新架构重构（25k 行 main 拆分 + 浏览器适配器重写），引擎按模块迁移 | ✅ **v1 主线** |
| **Tauri 2.12 + Node sidecar** | 系统 WebView2 共享（内存/安装体积显著下降）；Rust 壳 + 侧车架构干净 | 无 `<webview>` 等价物（浏览器工具需子窗口/多 webview + CDP 重做）；壳层 25k 行 TS 需重写为「薄 Rust 壳 + Node 侧车」两层 | 浏览器适配器接口若已冻结（D0 完成），迁移成本从「重做功能」降为「换实现」 | ✅ **备选（2.0 候选，有 gate）** |
| **自编译基座**（C++/Rust 自绘 WebView2 宿主） | 完全可控、无框架依赖 | 重复造 Tauri/wry 的轮子；更新器/签名/安装器全自维护 | 大，且无性能增益 | ❌ 排除 |
| **Wails v3**（Go 壳） | WebView2 + Go 侧车，v3 已发布 | Go 无法承接 TS 引擎；壳层逻辑必须 Go 重写 | 极大 | ❌ 排除 |
| **Sciter** | 体积小、单 DLL | 自有 JS 引擎，React 19 工具链无法运行；商业许可 | 渲染层全废 | ❌ 排除 |
| **Servo / Verso** | 独立渲染引擎愿景好 | 2026 仍处早期，嵌入 API 未成熟 | 实验级，不可作发布基座 | ❌ 排除（**持续跟踪**） |
| **Neutralino** | 极轻 | 无完整 Node、API 面窄 | — | ❌ 排除 |
| **Flutter / Qt** | 原生渲染 | 51k 行 React 渲染层全部重写 | 极大 | ❌ 排除 |

### 5.3 推荐结论（三句话）

1. **锁定 Electron 架构，不锁主版本**：v1 使用**开发与发布时仍处于官方支持期、且通过项目兼容性验证**的 Electron 稳定版本；主版本升级必须经过依赖、原生模块、浏览器自动化、安全、打包五类回归测试（§7）。当前锚点：45（稳定 2026-10-20，EOL 2027-04-27）；按 24-30 周工期推算，发布期应锚定 46（计划稳定 2027-01-05）并预留 47。
2. **浏览器能力走适配器**：`BrowserAdapter` 接口（navigate/snapshot/click/type/scroll/screenshot/wait/JS 注入/多标签/下载）在 **D0 spike 验证通过后冻结**；主实现用 `WebContentsView`（官方推荐），`<webview>` 仅作兼容后端，WebView2+CDP 作为未来基座预留。接口冻结后，换任何底层实现都不再牵动 Agent 内核与 13 个工具语义。
3. **Tauri 2.12 + Node sidecar 保持为 2.0 候选**：D0 的适配器解耦使未来迁移成本大幅下降；是否迁移由 v1 后的 spike 实测收益（内存/体积预设目标）决定，不再由「浏览器功能重做风险」决定。

### 5.4 D0：浏览器技术路线验证 spike（P0 内的关键决策门，时间盒 1-2 周）

> 目标：在冻结浏览器适配器接口与基座主线之前，用最小原型回答三个问题。

| 验证项 | 具体内容 | 通过标准 |
|---|---|---|
| ① 核心操作 | 第三方网页的导航、截图、元素定位与点击、JavaScript 注入 | WebContentsView 主实现全链路可用（含登录页等真实站点 3 个以上） |
| ② 会话与窗口 | 多标签/多窗口、Cookie 分区（`persist:`）、登录状态保持、弹窗（`window.open`/`target=_blank`）与权限弹窗处理 | 与 slime 现有 13 个工具的需求逐条对照，无不可替代项 |
| ③ 存量评估 | 13 个 browser 工具逐条评估：哪些可直接复用、哪些改实现不动语义、哪些必须重写 | 产出一份「复用/改造/重写」清单 + 工作量估计 |

**门禁规则**：①②任一未达标 → 冻结基座决策，先扩大原型范围或引入 CDP 兜底再定；③ 完成前不写 browser 工具的正式实现。spike 产物直接变成 `browserAdapter` 的接口契约文档（进 ADR）。

### 5.5 Tauri 备选的验证 spike（v1 发布后启动，时间盒 2 周）

| 风险点 | 验证方式 | 通过标准 |
|---|---|---|
| 浏览器自动化 | 以已冻结的 `BrowserAdapter` 接口实现 WebView2 子窗口 + CDP 后端（[playwright-cdp](https://github.com/Haprog/playwright-cdp) 已证 WebView2 CDP 可行） | 同 D0 三组用例全绿 |
| UIA 屏幕控制 | sidecar spawn PowerShell 原样移植 | `screen_ui_dump` + 点击全链路通过 |
| 原生模块 | better-sqlite3 / sqlite-vec 在 plain Node 侧车下加载（ABI 反而比 Electron 简单） | 检索/写入测试通过 |
| 分发 | Tauri updater + NSIS/便携 + 协议注册 + 托盘 | 安装→更新→卸载闭环 |
| 实测收益 | 同机型对比：常驻内存、安装体积、冷启动 | 达到**预设目标**（如内存 −40% 或体积 −60%）才迁移 |

### 5.6 基座决策路线图

```
现在 ──► P0：D0 浏览器 spike（WebContentsView 主实现验证）
  │
  ├─ D0 达标 ──► 冻结 BrowserAdapter 接口 → 锁定 Electron 架构主线（版本滚动：45→46→47…）
  │
  ▼ v1 发布后：Tauri spike（§5.5，以已冻结接口换实现）
  │
  ├─ spike 全绿 + 实测达标 ──► 启动 2.0 迁移（引擎与接口不动，壳层换实现）
  ├─ spike 部分受阻 ──► 维持 Electron；browserAdapter 继续双实现演进
  └─ spike 不达标 ──► 维持 Electron，每主版本例行升级
```

---

## 6. 功能安排

### 6.1 引擎迁移的验收门（对应评审意见 3，替代「整体复用 6.3 万行」）

**原则：复用的是经过验证的能力与语义，不是默认认可的所有旧代码。**

**每模块迁移前回答五问**：

| 问 | 产出 |
|---|---|
| ① 依赖关系 | 模块 import 图；确认无 Electron/隐式 Node 依赖越界（越界能力改走 platform 适配层） |
| ② 外部接口 | 模块对外 API 清单；契约层对齐（类型/校验器） |
| ③ 已有测试 | 该模块 slime 侧测试清单与通过情况；缺失测试的补测计划 |
| ④ 已知缺陷 | 对照 §1.5 与审计底稿逐条登记（如半接线、冲突项），明确「迁移即修复」还是「登记跟进」 |
| ⑤ 迁移后验收 | 本模块的独立验收条件（可执行、可断言） |

**迁移顺序**（先纯引擎与契约明确者，后含系统能力的模块）：

```
第一批  纯引擎：router / tool_loop 核心逻辑 / claims / filter / session 常量段
第二批  契约明确：tools/registry + 工具 schema 层、events、budget
第三批  系统能力（经 platform 适配层）：file/terminal/git/websearch/model_server/memory(sqlite)
第四批  安全与扩展：sandbox + hard_rules + policy、mcp、skills、plugin、mind-lite
```

**规则**：旧模块未过五问与验收，**不因「已有几十万行测试」默认放行**；每模块迁移提交独立、可回退；迁移途中不改语义（改语义走单独提案）。

### 6.2 功能处置四表

**A. 按验收门继承（15 项能力，代码按 §6.1 迁移）**

引擎四件套与四闸+归因、心跳、stable/volatile 分离、发前预检、会话恢复哨兵、steer 总线、权限四层+fail-closed、记忆五闸+四阶段检索+召回门控、幻觉护栏三层（含路径正则跳过代码块等细节）、插件作用域逆序 dispose、Git 治理运行时化（门禁/评审/无合并权/身份注入/Windows 斜杠 ref 兜底）、身份铁律+输出过滤+诚实协议、模型路由降级链（RPM 限流/重试退避/冷却熔断）、GGUF 解析+显存估算+**MoE 字节口径三层决策**、身份移民协议 v1.2、联网检索（5 引擎并行/融合打分/跳转解包）。

**B. 修复后继承（8 项，slime 的断点清单）**

1. MCP 单实现：TS 客户端补齐 OAuth 2.1（以 Python 实现为蓝本移植），删 Python 平行实现
2. `web_fetch` SSRF/DNS 钉扎对齐 Python 版（13 段私网 + IP 钉扎 + 重定向≤5）
3. 声称核验升级为**每轮**核验（TS 侧），强制工具轮保留
4. 插件 `registerTools` 真实现（插件贡献工具进同一注册表 + 作用域撤销）
5. 异常检测规则：`file_size_limit`/`resource_exhaustion` 要么实装要么删除声明，不留空分支
6. IPC 契约：schema 生成 + 启动期断言（消灭 5 条死码）；**26 条裸 handler 全部改走统一受信入口**（§7 四要素）
7. God file 拆分：main 按 chat/perm/agents/workspace/extras/runtime 六域拆文件，每域可独立测试
8. 测试统一：只留 vitest（+ 若保留侧车则 pytest 单轨），守卫保留「关键数字同源」风格

**C. 新增（7 项）**

1. **BrowserAdapter 适配层**（§5.3，D0 验证后冻结接口）
2. **platform 平台适配层**（fs/进程/SQLite/网络/嵌入抽象；node 与 web 双实现）
3. **评测台**（eval bench）：量化「改 prompt/引擎后 Agent 变聪明不变蠢」——继承 slime 四份调研报告结论做基线题集
4. **预算可视化**：token/墙钟/轮次四闸进度条（slime 已规划未落地）
5. **向量后端双实现**：sqlite-vec 默认 + LanceDB 可选（省 297MB 原生包）
6. **模型下载 sha256 校验** + 供应链签名
7. **审计日志查看器**（slime F6 规划项）

**D. 削减/挂起（6 项）**

企业微信适配器（未跑通）、SILAM 主线融合（挂起，接口保留）、实体图默认路径（改可选开关）、Python 服务端/CLI（删除）、PySide6 遗留（已死）、**slime 心智三件套（PAD 情绪网络 / 七阶段演化引擎 / trait 加权人格——见 §6.5 精简方案）**。

### 6.3 里程碑（P0–P9 = v1，P10 = 滚动）

| 阶段 | 内容 | 验收门 |
|---|---|---|
| **P0 地基 + D0 决策门**（2-3 周） | 仓库骨架 + 契约单源生成管线 + 品牌切换（`com.loopsoar.app`/`%APPDATA%\loopsoar`/`loopsoar://`，单一产地 `brand.ts` + 守卫）+ **D0 浏览器 spike（§5.4）** + 守卫测试框架 | contract-check 绿；「声明通道必有 handler」断言可红可绿；**D0 三组验证达标并冻结 BrowserAdapter 接口（ADR 落档）** |
| **P1 引擎**（3-4 周） | ChatService/Engine/ToolLoop/Router 四件 + 四闸 + 心跳 + stable/volatile（第一批迁移，过五问） | 引擎单测全绿；无壳环境跑通一次完整工具轮 |
| **P2 安全**（2-3 周） | 权限四层 + 沙箱 L0-L5 + 审计 + 每轮声称核验 + SSRF 对齐 + 受信 IPC 入口四要素 | §6.4 发布门 1、3、5 先行全绿；沙箱决策链全路径用例；异常规则无空分支 |
| **P3 工具**（3 周） | 注册表 + 工具面按 profile 分组（core/doc/screen/device/web/browser/git/skill，默认最小面）+ MCP 单栈（含 OAuth 2.1）+ 插件 registerTools | 65 工具归组表落地；MCP OAuth 授权流实测通 |
| **P4 记忆**（2-3 周） | 五闸写入 + 四阶段检索 + 召回门控 + sqlite-vec 默认后端（platform 适配层） | 10 万条检索延迟达标；归档区可查回 |
| **P5 扩展**（3 周） | 插件容器贡献点（八类 + `loop`/`omnibox`/`agent-template`）+ 技能引擎 + 逆序 dispose + **registerTools 真实现** | 第三方插件装载→贡献→停用→精确撤下闭环；§6.4 发布门 4 全绿；loop 贡献点装载 + **安全模式回退演练**（含破坏性用例） |
| **P6 壳层+UI**（4-6 周） | 壳层按域拆分 + preload 生成 + 流式渲染/折叠卡/权限交互/右侧栏 + BrowserAdapter 正式实现（WebContentsView 主实现）+ 屏幕控制 + **三档使用深度渐进披露** | 主链路端到端（含权限弹窗与浏览器自动化）；§6.4 发布门 2 全绿；**反毛坯房清单 6 条逐条勾选** |
| **P7 多 Agent**（2 周） | 子代理委派 + 批量编排 + 完成协议 + 风险裁决 + 群聊 | 批量任务完成协议不虚报；风险裁决有证据 |
| **P8 心智（mind-lite）**（2 周） | §6.5 精简方案：偏好/教训记忆 + 行为计数器 + 会话状态摘要 + 独立判断规则 | 闭环读回验证；注入不污染 stable 前缀；复杂度验收：无数值演化网络 |
| **P9 分发**（2 周） | 打包（NSIS/便携 + CUDA 分层）+ 自动更新 + 托盘/单实例 + 崩溃自愈 + 发布流水线 + **Electron 版本回归清单（§7）首次执行** | 三环境安装→更新→卸载实测；守卫全绿；§6.4 五条发布门全部通过 |
| **P10 滚动（v1 后续）** | 评测台基线、预算可视化、安卓对齐、Linux 发布评估、Tauri spike（§5.5）、Electron 例行版本升级 | 各自 gate；版本升级走 §7 回归清单 |

### 6.4 发布门（不可跳过，独立于模块验收）

> 以下五条是**发布前置条件**，任何里程碑完成都不能豁免；对应评审意见 4。

1. **权限 fail-closed 行为测试**：权限拒绝与「无法判断」两类路径全覆盖——八步决策链每一步的拒绝/兜底行为都有用例，且「判不了 ≠ 不存在」场景（工具表为空等）行为正确。
2. **浏览器桥隔离测试**：恶意或不可信网页（构造用劫持页面）无法借助浏览器桥接获得主应用权限——包括预加载脚本注入、IPC 冒用、`window.open` 逃逸、CDP 端口滥用四条攻击路径均有对抗用例。
3. **网络工具安全测试**：`web_fetch`/`web_search` 的 SSRF（13 段私网）、DNS 钉扎、重定向（≤5）全用例；私网地址与 IP 直连请求被拒。
4. **插件权限生命周期端到端**：插件工具注册→使用→停用→权限撤销全链测试；停用后工具立即不可调、作用域精确撤销、不影响其他插件。
5. **声称核验**：Agent 声称完成任务时必须有对应工具结果或其他可核验证据——每轮核验，覆盖 7 类完成动词 + 路径/大小证据、跳过代码块与 URL 残片、媒体裸文件名查产物目录。

### 6.5 心智模块精简方案（mind-lite）

> 原则：**保留精华，不全盘接收。** 原「心智」的复杂演化引擎维护成本高于收益；产品目标（§2.1）靠记忆与轻量状态即可达成。

| 层次 | slime 原设计 | Loopsoar 决策 |
|---|---|---|
| 记忆（保留核心） | 三层记忆 + 五闸写入 + 四阶段检索 + 召回门控 | ✅ **原样继承**——这是「越用越顺手」的引擎，质量关键全在写入门控 |
| 行为沉淀（轻量化） | BehaviorPattern：confidence 强化/衰减/归档数值网络 | ➖ **行为计数器**：`tool.<name>.success/fail` 计数 + 高频成功做法 top-5 注入；无置信度网络、无 30 天衰减演算 |
| 情绪（轻量化） | PAD 三维 + 8 原型 + 半衰期衰减 + DELTA 事件表 + mood 判定 | ➖ **会话状态摘要**：每次会话结束由 LLM 生成一句「当前状态」（含最近成败/褒贬），挂 volatile 段；三档语气调节；**无数值情绪网络、无半衰期演算** |
| 人格演化（删除） | 七阶段生命周期 birth→death + trait 加权演算 + 晋升阈值 | ❌ **删除**。性格由角色设定 + 记忆偏好 + 状态摘要自然呈现 |
| 知识自动晋升（删除/简化） | recurrence 3/5/8/10 → 自动生成规则/技能/改 trait | ❌ 自动生成技能**挂起**（手动技能足够）；保留「高频失败/成功 → 提示 Rule」这一条轻量反馈 |
| 独立判断（新增强调） | 诚实协议四条 | ➕ 诚实协议延伸：**不过度附和**——用户要求与其既有偏好/事实冲突时礼貌指出、不确定就说不知道、不编造认同（注入 system 稳定段，字节稳定） |
| 实体图 / SILAM | 图默认 BFS + SILAM 情感脑 | ❌ 挂起/可开关（见 §2.3） |

**实现要点**：行为计数器与状态摘要全部走既有 `volatileSegments` 注入通道（挂末段 user 消息），不新增注入面；所有状态可迁移（进身份包）；**验收标准含「无数值演化网络、无隐藏状态机」**——复杂度即风险，这条写进 P8 验收门。

---

## 7. 工程规范

- **测试**：单一 runner（vitest 主；Python 侧车若保留则 pytest 单轨，两者不得混跑同一逻辑）；CI = compile → 契约校验 → 全量测试 → 守卫（含「关键数字同源」）。
- **IPC 安全语义（契约生成 ≠ 安全）**：所有敏感 handler 必须经统一受信入口，**逐项校验四要素**——①调用方身份（sender 合法性，杜绝 26 条裸 handler）；②发送帧来源（`senderFrame.url` 必须匹配 `loopsoar://` 白名单）；③参数合法性（schema 校验器，非仅类型）；④权限上下文（agentId → 权限四层判定）。四要素缺一即拒绝，入口本身有可测语义（对应 §6.4 发布门 2）。
- **Git 治理**：`AGENTS.md` 契约整体继承（身份铁律 author、Conventional Commits、800 行/30 文件 Lint Gate、QA 门禁、无合并权、worktree 隔离、回滚双轨）。
- **Electron 版本政策**：v1 锁定架构、不锁主版本；主版本升级必须通过五类回归——依赖（原生模块 ABI）、浏览器自动化（D0 用例集）、安全（§6.4 五条）、打包（安装/更新/卸载）、性能冒烟。升级决策进 ADR。
- **发布**：Apache-2.0 延续；仓库全量公开（密钥/隐私/可再生产物除外）；安装包分层（主包 CPU 运行时 + CUDA 增补包，继承 A-1269 教训：增补包必须有代码去装）。
- **品牌**：loopsoar 域名/商标/包名占位（见 §9）；图标资产已定稿（破环·化片）直接复用。
- **AI 辅助定位与决策登记**：本项目对 AI 辅助的需求定义为**架构主设计、跨模块一致性审查、技术风险识别、长期决策跟踪**（不是代码补全）。落地机制：`docs/decisions/` 存 ADR——每个不可逆决策一条记录（背景/决策/理由/替代方案/验证状态/复核时间），跨模型、跨会话换手不丢决策上下文；评审角色与实现角色用不同模型档位（评审走高推理档，执行走中档，批量验证走轻量档——与 slime 已有的模型档位思路一致）。

---

## 8. 风险与开放问题（需你拍板的决策清单）

1. **D0 spike 范围确认**：先验证 WebContentsView 主实现（官方推荐）还是 webview 兼容后端并跑？（建议前者优先）
2. **Electron 版本锚点**：v1 基线按 46（计划 2027-01-05 稳定）还是 45 + 预留升级窗口？（建议 46，若工期早于稳定日则 45 起步、发布前升 46）
3. **平台范围**：Windows 优先已定；Linux（已有子项目脚本、无二进制）与 macOS 的优先级？安卓是否 v1 目标（APK 27.9MB 已真机验证）？
4. **Python 归零**：完全移除（目标 0 进程）还是保留「agnes / SILAM 直桥」两个白名单侧车？
5. **心智精简方案确认**：§6.5 的「行为计数器 + 会话状态摘要 + 无演化网络」是否认可？（若你希望保留某一块，请点名）
6. **向量后端**：默认切 sqlite-vec（省 297MB）还是双后端并测再定？
7. **开源与组织**：GitHub org / npm / PyPI 占位何时做；仓库公开策略延续 Apache-2.0？
8. **v1 范围取舍**：评测台/预算可视化/审计查看器是否进 v1，还是 v1.1？

---

## 9. 近期行动清单（本周起）

1. **注册 `loopsoar.com`**（命名文档 §4：地名抢注快，先占住）＋ 商标检索（USPTO/CNIPA/EUIPO 第 9/42 类）＋ GitHub org / npm / PyPI 占位
2. 确认 §8 八项决策（本规划评审会，重点：D0 范围、版本锚点、心智精简）
3. 建仓库骨架，落地 P0（契约单源管线 + 品牌切换守卫 + **D0 浏览器 spike**）
4. 启动 P1 引擎第一批迁移（每模块过 §6.1 五问）

---

## 附：关键外部依据链接

- [Electron 官方发布日历](https://releases.electronjs.org/schedule)（45 稳定 2026-10-20 / EOL 2027-04-27；46 计划稳定 2027-01-05）
- [Electron Web Embeds（官方：不建议 webview，建议 WebContentsView）](https://www.electronjs.org/docs/latest/tutorial/web-embeds)
- [Electron `<webview>` Tag API（官方警告原文）](https://www.electronjs.org/docs/latest/api/webview-tag)
- [Electron Local AI Handler 教程](https://www.electronjs.org/docs/latest/tutorial/local-ai-handler)（Electron 原生本地模型能力，值得跟踪）
- [Tauri 2.12 发布公告](https://v2.tauri.app/blog/tauri-2.12/) ｜ [Tauri webview API 参考](https://tauri.app/reference/javascript/api/namespacewebview/)
- [Wails v3.0.0 发布](https://v3.wails.io/blog/wails-v3-released/)
- [WebView2 CDP 自动化用例（playwright-cdp）](https://github.com/Haprog/playwright-cdp)
- [Servo 上 crates.io（LWN）](https://lwn.net/Articles/1067467/)；[Verso（Servo 内核浏览器）镜像](https://atomgit.com/GitHub_Trending/vers/verso)
- [Sciter 官网](https://sciter.com/) ｜ [sqlite-vec（npm）](https://www.npmjs.com/package/@photostructure/sqlite-vec)
