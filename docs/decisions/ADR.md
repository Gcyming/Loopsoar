# 架构决策记录（ADR）— Loopsoar

> 维护规则：每条记录包含 背景 / 决策 / 理由 / 替代方案 / 验证方式 / **状态（已验证·待验证·可回退）** / 回退条件 / 复核时间。
> 决策不可逆或影响全局时，必须在开工前写入本文件；变更决策 = 新增一条 ADR 并标注「取代 ADR-00XX」，不修改历史条目。
> 对应定位：本项目对 AI 辅助的需求 = 架构主设计、跨模块一致性审查、技术风险识别、长期决策跟踪（换模型/换会话/换人都不丢决策上下文）。

---

## ADR-0001 产品定位：浏览器优先的 Agent（agentic browser）

- **背景**：2026-10-27 用户裁决——Loopsoar 要完全区别于 slime：以 search 功能为主、AI 辅助全网 fetch 数据以辅助用户；是一个类似 Edge/Chrome/360 的**完整浏览器**，但更偏向 Agent（参照 Tabbit 形态）。
- **决策**：
  1. 主窗口即浏览器；search 与网页 fetch 是一等公民（非旁路工具）；
  2. Agent 是主体：规划、执行、记忆、权限、核验全部由 Agent 引擎驱动浏览行为；
  3. 三个差异化：本地优先、Agent 连续性（可携带身份与记忆）、可信自治；
  4. 浏览器功能面：多标签、地址与搜索一体框、书签、历史、下载、广告拦截、页面保存、独立任务标签组、可见执行日志、敏感步骤确认。**借鉴 slime 先例（webview/广告拦截/下载/browser 13 工具/searchIndexService），不照搬代码。**
- **理由**：浏览器是 Agent 的天然居所（工具即眼前的 Web）；slime 已验证整套浏览器自动化与自建搜索能力，资产可借鉴；「AI 浏览器」红海里的差异点必须是本地优先 + 可信自治 + Agent 连续性。
- **替代方案**：维持 slime 的「聊天为主、浏览器为工具」形态——被否（与用户意图不符）。
- **验证方式**：MVP 验收表的主链路 + 浏览器功能面必须项全部跑通。
- **状态**：✅ 已验证（用户裁决，不可逆）
- **回退条件**：无（产品定位级）
- **复核时间**：v1 发布后复盘

---

## ADR-0002 运行基座：锁定 Electron 架构、主版本滚动

- **背景**：候选为 Electron / Tauri 2.12 + Node sidecar / 自编译基座 / Wails v3 / Sciter / Servo(Verso) / Neutralino / Flutter·Qt。
- **决策**：
  1. **锁定 Electron 架构，不锁主版本**：v1 使用开发与发布时处于官方支持期、且通过项目回归验证的 Electron 稳定版（当前 45，EOL 2027-04-27；发布期预计锚定 46，计划稳定 2027-01-05）；
  2. 主版本升级必须过五类回归：依赖（原生模块 ABI）/ 浏览器自动化（D0 用例集）/ 安全（§6.4 五条）/ 打包（安装·更新·卸载）/ 性能冒烟；
  3. Tauri 2.12 + Node sidecar 保持 2.0 候选，v1 发布后按 §5.5 spike 实测收益裁决；
  4. 排除：自编译基座（重复造 wry 的轮子）、Wails（Go 壳重写）、Sciter（React 不可跑）、Servo/Verso（未成熟）、Neutralino（能力不足）、Flutter/Qt（渲染层全废）。
- **理由**：浏览器自动化（webContents/WebContentsView/CDP 全家桶）与分发体系最成熟；内存/体积差被本地 LLM 摊薄；升级是例行工程而迁移是架构冒险。
- **替代方案**：直接上 Tauri——被否（无 `<webview>` 等价物，浏览器工具需重做，风险前置收益后置）。
- **验证方式**：P0 验证计划 W1（D0 浏览器 spike）；Electron 版本回归清单（规划 §7）。
- **状态**：✅ 已验证（D0 通过，见 `packages/shell/dev/d0-probe/D0-RESULT.md`；环境约束：本机受限会话下 v45 需 `--no-sandbox`，40.10.2 全项通过；正式打包不启用该参数）
- **回退条件**：D0 ①② 任一未达标 → 冻结基座决策，扩大原型或引入 CDP 兜底，重开基座评审（新 ADR）。
- **复核时间**：D0 完成后

---

## ADR-0003 浏览器实现路线：BrowserAdapter 接口 + WebContentsView 主实现

- **背景**：Electron 官方明确「不建议使用 webview tag」（[web-embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds) / [webview-tag](https://www.electronjs.org/docs/latest/api/webview-tag)：webview 正在经历重大架构变动，稳定性不保证）；slime 的 13 个浏览器工具建立在 `<webview>` 上。
- **决策**：
  1. 定义 `BrowserAdapter` 接口（navigate / snapshot / click / type / scroll / screenshot / wait / JS 注入 / 多标签 / 下载 / 弹窗策略），**D0 spike 验证通过后冻结**；
  2. 主实现用 **WebContentsView**（主进程创建/定位/控制，webContents 语义完整）；
  3. `<webview>` 仅作兼容后端（不新增功能依赖）；
  4. WebView2 子窗口 + CDP 作为未来基座（Tauri）路径预留实现；
  5. 13 个 browser 工具按「复用 / 改实现不动语义 / 重写」三档逐条评估（D0 ③ 产出清单）。
- **理由**：接口冻结后换底层实现不再牵动 Agent 内核与工具语义；官方路线的架构变动风险被隔离在适配层内。
- **替代方案**：继续以 `<webview>` 为主——被否（官方警告 + 未来可用性无保证）。
- **验证方式**：D0 三组验证（核心操作 / 会话与窗口 / 存量评估）。
- **状态**：✅ 已验证（D0 实测：导航/元素编号/点击/输入/滚动/截图/JS 注入全通过；BrowserAdapter 主实现已落地并冻结接口；13 工具三档评估见 TOOL-TRIAGE.md）
- **回退条件**：WebContentsView 关键能力（元素级自动化、分区 Cookie、弹窗控制）验证失败 → CDP 兜底方案升级为主实现（新 ADR）。
- **复核时间**：D0 完成后

---

## ADR-0004 单栈边界：纯逻辑核心 + platform 适配层，不做提前抽象

- **背景**：评审指出「全栈 TS + 跨端同核」不等于自动解决 Node API / SQLite 原生模块 / 进程管理 / Web Worker 运行环境差异。
- **决策**：
  1. `core` 拆两层：**纯逻辑核心**（引擎/工具轮/权限决策/记忆策略等，零 Node 依赖）与 **platform 适配层**（fs / 子进程 / SQLite / 网络 / 嵌入，node 与 web 双实现）；
  2. **接口只抽象「有真实的第二种实现或明确必要性」的能力**：桌面 Node 实现为真实现；web 实现仅覆盖 Android 轻量端真实需要的子集（不提前把每个桌面能力都抽象成通用接口）；
  3. 「跨端同核」的口径 = **引擎与策略同核**，壳层与系统能力各端各自实现；
  4. v1 只交付 Windows 桌面；Android 为轻量形态（对话 + 网页查看），后置，不进 MVP。
- **理由**：每个空接口都是维护成本与虚假安全感的来源；Android Web Worker 已证明「引擎可跑」，但系统能力必须老老实实分实现。
- **替代方案**：全量抽象所有系统能力——被否（无第二实现的抽象是死代码，slime 半接线问题的翻版）。
- **验证方式**：P0 W3 最小工具轮在无壳 harness 跑通（platform=node）；后续 Android 轻量端用 platform=web 实跑。
- **状态**：✅ 已验证（边界规则已定；web 实现子集待 Android 阶段验证）
- **回退条件**：不适用（边界规则）；若某能力在两端语义无法统一，降级为「壳层能力」（不进 core）。
- **复核时间**：Android 轻量端开工时

---

## ADR-0005 Python 退场政策：零进程是目标，不是先验结论

- **背景**：规划定「全栈 TS、Python 进程目标为零」；评审要求逐项验证 TS/二进制等价路径，避免为凑指标牺牲已验证功能。
- **决策**：
  1. 业务编排全 TS（已定）；推理/嵌入走 llama-server 二进制（已定）；
  2. 三项专用能力**逐项验证后才移除旧实现**：
     - Agnes 媒体生成：验证 TS 直调 Agnes HTTP API + 缓存/限额/进度等价 → 通过后删 `tools/agnes_media.py`；
     - SILAM 直桥：验证 TS 进程经 stdio/JSONL 直连 C 内核 → 通过后删 Python 桥；若 C 内核不发布则整体挂起；
     - 嵌入（BGE-M3）：验证 llama-server `/v1/embeddings` 全链等价 → 通过后删除 Python 检索侧车；
  3. 「零 Python」作为**发布目标**而非**迁移门禁**：验证未通过的项，保留旧实现并登记理由（白名单 sidecar），不允许为了指标删功能；
  4. 每项验证的记录进本 ADR 的「验证日志」附注。
- **理由**：双栈漂移的解法是「单引擎」，不是「物理消灭 Python 进程」；后者是结果而非手段。
- **替代方案**：一刀切删掉全部 Python——被否（Agnes/SILAM 是已验证功能，风险前置无收益）。
- **验证方式**：三项各自的等价性测试（功能/失败模式/性能冒烟）。
- **状态**：✅ 已验证（政策本身）；🟡 三项待验证（逐项）
- **回退条件**：某项验证失败 → 该项保留白名单 sidecar，ADR 附注理由与复核期限。
- **复核时间**：P3（Agnes）／SILAM 决策时／P4（嵌入）

---

## ADR-0006 引擎迁移策略：五问验收门 + 四批顺序，不默认放行

- **背景**：slime core-ts 63,265 行 / 420 spec；评审要求「复用的是经过验证的能力与语义，不是默认认可的所有旧代码」。
- **决策**：
  1. 每模块迁移前回答**五问**：依赖关系 / 外部接口 / 已有测试 / 已知缺陷 / 迁移后验收；
  2. 四批顺序：①纯引擎（router / tool_loop 核心 / claims / filter / session 常量）②契约明确（registry + schema / events / budget）③系统能力经 platform（file / terminal / git / websearch / model_server / memory）④安全与扩展（sandbox / hard_rules / policy / mcp / skills / plugin / mind-lite）；
  3. 旧模块未过五问与验收，**不因测试行数默认放行**；每模块迁移提交独立、可回退；迁移途中不改语义（改语义走单独提案）；
  4. slime 测试随模块迁移，且**必须在本仓 CI 实际变绿**才计入。
- **理由**：「为了复用而复用」会把 slime 的断点（半接线/冲突项）复制进正式版。
- **替代方案**：整体拷贝 core-ts——被否。
- **验证方式**：P0 W3 最小工具轮 + 各阶段验收门（规划 §6.3）。
- **状态**：✅ 已验证（策略已定；逐模块执行中验证）
- **回退条件**：某模块五问发现不可迁移依赖 → 该模块重写并登记（新 ADR）。
- **复核时间**：每批迁移完成时

---

## ADR-0007 记忆后端：sqlite-vec vs LanceDB，真实负载测试裁决

- **背景**：slime 用 `@lancedb/lancedb`（原生包 297MB）；候选 sqlite-vec（better-sqlite3 已装，零额外体积）。评审要求：不能只凭「10 万条」认定性能，须测检索质量/延迟/体积/增量写入/备份恢复/归档查回，阈值与硬件写入验收。
- **决策**：
  1. 默认候选 sqlite-vec，LanceDB 保留为可选后端，**P0 W5 真实负载测试裁决后才定默认**；
  2. 测试维度：检索质量（与 BGE-M3 向量 + BM25 混合对照）、P50/P95 延迟、磁盘体积、增量写入、备份恢复、归档查回；
  3. **阈值与测试硬件写入验收标准**：参考机 i9-13900HX / RTX 4070 Laptop 8GB（用户实机）；10 万条语料下检索 P95 ≤ 50ms（初定，实测校准）；质量不劣于 LanceDB 基线；
  4. 测试语料用真实或脱敏的记忆语料（不用合成模板），含中文（Jaccard 阈值校准沿用 slime 0.75/0.70/0.68 不可下调）。
- **理由**：向量库是记忆系统的地基，换库影响身份包的向量重建逻辑，必须实测而非推断。
- **替代方案**：直接换 sqlite-vec——被否（无实测）；维持 LanceDB——被否（297MB 体积是硬伤）。
- **验证方式**：P0 W5 负载测试报告（报告即本 ADR 的裁决附件）；F8 三路原生索引后端对照（报告 §8）+ Electron ABI 运行时验证。
- **状态**：🟢 **最终裁决（2026-11-02，F8 收口）**：默认后端 = 纯 TS flat hybrid（FlatVectorIndex + hash embedding + 四阶段），10 万条 hybrid P95 **12.18ms**（满足 ≤50ms）、零原生依赖。F8 三路实测（flat / sqlite-vec / LanceDB，10 万条）显示 flat 综合最优：查询 P95 26.2ms vs 64.1/67.7ms，建索引 166.7ms vs 808.6/1751.6ms，增量写入 83k/s vs 80k/18k/s；**sqlite-vec 已作为显式可选后端接入**（`MemoryService.vectorBackend:"sqlite-vec"`，原生模块缺失/ABI 不匹配自动降级 flat）；**LanceDB 不纳入运行时**（RSS +513MB、构建/写入最慢，默认无 ANN）。Electron ABI：better-sqlite3 13 为 N-API prebuild，**无需 electron-rebuild**，Electron 45 主进程加载 better-sqlite3 + sqlite-vec 实测通过。本地语义模型按用户决定**不引入**（保留 `platform.embed`/llama-server 适配 + hash 回退），语义质量留待 llama-server 可用时复测。报告：`docs/research/memory-bench-ADR-0007.md` §4/§8
- **回退条件**：未来容量显著增长或需磁盘持久化索引 → 复评 sqlite-vec/ANN；原生后端在目标平台不可用 → 自动降级 flat（已实现，fail-open）；本地模型引入后若质量不达标 → 维持 hash + 关键词混合。
- **复核时间**：打包阶段（llama-server 语义质量复测；若开放 10 万级容量则复评倒排关键词 + ANN）

---

## ADR-0008 MVP 范围：最小可交付主链路，其余按依赖进入

- **背景**：评审指出 v1 十阶段（引擎/安全/记忆/插件/浏览器自动化/屏幕控制/多 Agent/心智/安卓/分发）偏大，24-30 周不可当承诺。
- **决策**：
  1. MVP = **一条完整主链路**：对话 → 模型调用 → 工具执行 → 权限判断 → 结果核验 → 记忆读写（六步全通才算可交付）；
  2. 浏览器功能面 MVP 必须项（见 MVP 验收表）：多标签导航/输入/点击/截图/下载/书签/历史/广告拦截；
  3. 其余能力按依赖关系逐步进入（插件全集、MCP OAuth、子代理批量、群聊、屏幕控制、安卓、行为计数器、评测台、预算可视化、审计查看器 → 可后置清单）；
  4. 24-30 周仅为初步估算，不对外承诺；每阶段出口以验收门为准，不以日历为准。
- **理由**：先有一台「能用的浏览器 + 能在浏览器里干活的 Agent」，再谈生态与心智。
- **替代方案**：十阶段并行推进——被否（所有模块半成品 ≠ 一个可用产品）。
- **验证方式**：MVP 验收表逐项勾选 + §6.4 五条安全发布门。
- **状态**：✅ 已验证
- **回退条件**：若 MVP 主链路某步发现不可行，收敛该步范围并更新 MVP 表（新 ADR）。
- **复核时间**：每阶段出口时

---

## ADR-0009 安全验收标准：攻击性测试，反例/攻击输入/预期拒绝

- **背景**：评审指出安全发布门需攻击性测试，而非正常路径单测；尤其网页内容不得经预加载桥获取主进程能力；DNS 解析/重定向/实际连接目标之间不得有缺口。
- **决策**：
  1. 每条安全门 = **反例集 + 攻击输入 + 预期拒绝结果 + 自动化测试**四件套（缺一不验收）；
  2. 浏览器桥隔离至少覆盖四攻击路径：预加载脚本注入、IPC 冒用（伪造 sender）、`window.open` 逃逸、CDP 端口滥用；
  3. SSRF 验证覆盖「DNS 解析结果、重定向链、实际连接目标」三者一致性（防 DNS rebinding 类缺口），13 段私网 + IP 直连 + 重定向 >5 全反例；
  4. 攻击用例进入 CI 常跑（不是一次性演练）；
  5. 敏感 handler 四要素（调用方身份/帧来源/参数合法性/权限上下文）缺一即拒，入口语义可测。
- **理由**：安全清单会漂移，攻击用例不会——它们是可执行的安全契约。
- **替代方案**：仅正常路径 + 文档清单——被否。
- **验证方式**：P0 W4 安全拒绝路径先行；§6.4 五条发布门在 P9 前全绿。
- **状态**：✅ 已验证（标准已定；用例随 P0/P2/P6 补齐）
- **回退条件**：不适用（标准）；新增攻击路径时追加用例到对应门。
- **复核时间**：每个安全相关阶段出口时

---

## ADR-0010 Agent-Loop：内置最小完备 + 彻底开放自定义 + 安全模式后备

- **背景**：2026-10-27 用户最终设定——只内置最基本、足够 Agent 正常完备运行的 Agent-Loop；彻底开放自定义（可不用初始 loop、可修改、可自建）；初始 loop 必须做后备，防止用户改坏后 Agent 无法运行。
- **决策**：
  1. 内置**唯一一个** minimal complete 初始 loop（装配上下文 → 推理 → 工具轮 → 轮末后处理），标记 `builtin`，**不可删除/不可原位修改**，只能「复制为新 loop 再改」；
  2. 自定义 loop 三档：L1 参数化（设置面板）/ L2 声明式（复制修改 + 校验器）/ L3 脚本式（插件 `loop` 贡献点）；
  3. **安全模式后备**：启动前静态校验（失败拒绝启动）+ 运行期健康检查（心跳超时/预算四闸/异常崩溃/空工具面死循环）→ 任一触发自动切回内置 loop 跑完当前任务，界面显著提示 + 诊断 + 一键修复；**回退不丢数据**；
  4. **护栏归属 harness，不属于 loop**：权限四层、四道预算闸（loop 可收紧不可放松超硬上限）、每轮声称核验、身份注入、心跳协议（自定义 loop 必须实现）、Git 治理——全部不可被自定义 loop 绕过。
- **理由**：开放与安全在同一枚硬币两面；把「可自定义的」与「不可动的」边界定在「护栏」，而不是「功能」，才能既给自由度又不让 Agent 变砖。
- **替代方案**：loop 完全硬编码——被否（用户要求彻底开放）；loop 可改护栏——被否（安全失效）。
- **验证方式**：MVP「Agent-Loop 可插拔」必须项 + P5「loop 贡献点装载 + 安全模式回退演练」；破坏性用例：故意写坏 loop（语法错/死循环/无心跳）→ 断言回退且数据不丢。
- **状态**：✅ 已验证（用户裁决）；**2026-11-02 已接线**：LoopRegistry 接入 ChatService（runLoop 注入）、builtin core-loop 注册、崩溃/静默超时回退 + `loop:fallback` 可见、`loop:list`/`loop:setActive` + 设置页选择 + `preferences.loopId` 持久化；L1 参数化已随请求上限设置覆盖；**2026-11-02 最终收口**：L2 声明式（`<dataDir>/loops/<id>.json`：systemPromptAppend / limits 只可收紧 / 工具白名单「过滤清单 + 执行器二次拦截」）+ L3 脚本 loop（`<dataDir>/loops/<id>/loop.json` + loop.mjs：子进程 JSON-RPC 代理 `ctx.llm`/`ctx.executeTool`/`ctx.emit`，预算护栏，崩溃/超时/非法 outcome 自动回退 builtin）+ `loop:reload` 重扫全部接线并测试；「一键修复」后置
- **回退条件**：不适用（核心设定）
- **复核时间**：P5 出口

---

## ADR-0011 扩展系统：万物皆插件（对齐 DSH）

- **背景**：2026-10-27 用户最终设定——等效 DSH 的插件体系，给用户最大自由度：功能、UI 界面、额外能力等方方面面皆可插件化；slime 的程序已钉死没机会大改，Loopsoar 要最好的待遇。
- **决策**：
  1. **内核最小化四件**：浏览器壳 + 引擎 + 安全护栏 + PluginHost（不可卸载）；其余全部插件化；
  2. 内置功能以 **builtin 插件**形态存在：默认开启、可禁用、可被用户插件覆盖（冲突按声明优先级裁决，裁决可见）——区别于 slime 的 31 组 `unloadable:false`；
  3. 贡献点 = slime 八类 + 新增 **`loop`**（Agent-Loop）/ **`omnibox`**（地址栏命令）/ **`agent-template`**（Agent 预设）；UI 贡献点扩充（面板/侧栏/工具栏/右键菜单/状态区）；
  4. **插件 `registerTools` 真实现**（slime 断点）；插件工具权限 = 插件声明权限 ∩ 会话授权；
  5. 信任/撤销沿用 slime 已验证机制（trust.json fail-closed / 逆序 dispose / 脚本默认不信任 / 沙箱 iframe + CSS 禁令表）；
  6. 低门槛开发体验：插件向导模板、热重载、校验器、沙箱预览、「当前配置导出为插件」。
- **理由**：slime 的教训是「程序钉死」→ 大改无门；DSH 的教训是「毛坯房」→ 门槛高。插件化内核 + 内置功能可禁用 = 自由；向导 + 校验 + 预览 = 低门槛。
- **替代方案**：只开放工具/Skills 两层——被否（用户要求 UI 与功能全开放）。
- **验证方式**：P5 扩展阶段验收（第三方插件装载→贡献→停用→精确撤下）+ 发布门 4；builtin 插件禁用后内核仍可用。
- **状态**：✅ 已验证（用户裁决）；**2026-11-02 用户裁决：扩展与插件是同一概念的两套实现，合并为单一「扩展」系统**——插件子系统（PluginStore/PluginRuntime/pluginWorker/plugin 域/设置·插件面板/core plugin kernel + 3 个测试）已全部删除；插件独有的安全能力（子进程 env 白名单、工具冲突 fail-closed 且状态可见、入口越界/缺失双层守卫、调用超时）已并入 ExtensionHost/ExtensionRuntime；工具命名统一 `ext__<id>__<tool>`；扩展沿用既有 `loopsoar.extension.json` 清单（`plugin.json` 从未发布，无迁移成本）。**未做（后置）**：UI 贡献点（面板/侧栏/菜单）、CSS 沙箱与 trust.json 完整信任链、扩展市场。另：OpenAI 兼容 Gateway 子系统按用户决定整条删除（slime 遗留测试项，Loopsoar 无实质作用）
- **回退条件**：不适用（核心设定）
- **复核时间**：P5 出口

---

## ADR-0012 易用性策略：好用 + 低门槛（不做「毛坯房」）

- **背景**：2026-10-27 用户最终设定——对齐 DSH 的 harness 理念，但 DSH 被诟病「毛坯房、门槛高」；Loopsoar 要即好用、门槛也不高，同时不失 slime 原定风格。
- **决策**：
  1. **三档使用深度渐进披露**：①直接用（默认 loop/插件/向导，开箱即用）②改配置（设置面板，L1 参数化）③造东西（L2 编辑器 + L3 脚本 + UI 定制，全自由度）；默认 UI 只显示 ①；
  2. **反毛坯房清单 6 条进验收**：首次向导 3 分钟可用 / 可配置项有默认值+中文解释+恢复默认 / 错误可读且给下一步 / 一键回退三件套（loop 回退·插件禁用·配置快照）/ 产品内文档就地解释 / 非开发者 10 分钟完成「搜索→抓取→出结论」可演示；
  3. **保留 slime 原定风格**：本地优先、Agent 人格与陪伴感、流式卡片、输入框内嵌权限选择题、右侧栏、双主题；以「可信自治（可见执行日志 + 敏感步骤确认 + 审计）」为差异化。
- **理由**：自由度与门槛的矛盾用「分层」化解——自由度不削减，只是递进释放；slime 的风格资产是差异化来源，丢弃等于重新发明产品。
- **替代方案**：DSH 式裸壳——被否（门槛高）；完全封死定制——被否（与 ADR-0011 冲突）。
- **验证方式**：P6 壳层验收（渐进披露 + 清单 6 条逐条勾选）。
- **状态**：✅ 已验证（用户裁决）
- **回退条件**：不适用
- **复核时间**：P6 出口

---

## ADR-0016 P0 安全门加固 + 持久多环境终端 + 工具参数单一转换

- **背景**：2026-11-02 代码级扫描发现三个发布门级缺陷：① 危险命令硬规则「双落空」（`terminal_run` 参数名 `command`，而沙箱只校验 `args.path`，`hardRuleCheck` 永不触发）；② `web_fetch`/`browser_navigate`/模型探测使用裸 `fetch`，无 SSRF/DNS 钉扎；③ `file:read/write` IPC 无工作根约束、`sessionId` 未净化即拼路径；另有沙箱全局根竞态、退出不清理 MCP/扩展子进程、审计不落盘。同时产品缺少「真正的终端」与工具参数 Schema（模型收到空 `parameters`）。
- **决策**：
  1. **安全门优先于新功能**：先把 fail-closed 链路修到可验证，再补能力；
  2. 危险命令在**工具执行与终端输入两条路径**都前置拦截（不依赖沙箱的 target 推断）；
  3. 网络统一走「SSRF 判据（纯逻辑）+ 平台层 DNS 钉扎 + 浏览器请求守卫」三层，工具不得直接 `fetch`；
  4. 文件 IPC 与所有会话落盘路径一律「会话工作根约束 + 会话 ID 净化」；
  5. 沙箱判定显式传入会话工作根，**禁止运行时改写全局根**；
  6. 终端采用**持久会话 + 应用内面板**，配置档覆盖 cmd/PowerShell/Git Bash/Python/Node/C++（零新增原生依赖，不用 PTY/xterm）；
  7. 工具参数由 zod 单一转换到 JSON Schema（零依赖），未知类型降级 + warning 而不抛错。
- **理由**：这些是「敢不敢给人用」的发布门级缺陷，且全部有可自动化验证的判据；终端真实可用是 Agent 浏览器形态的日常操作入口；工具参数为空会让工具调用靠猜，是 Agent 质量的第一道漏点。
- **替代方案**：① 只修工具不修 IPC——被否（潜伏的面更大）；② 引入 node-pty/xterm 做完整 TTY——被否（本轮零新增原生依赖，Unix/Windows PTY 差异大，且沙箱受限会话无法验证）；③ 用第三方 zod-to-json-schema 包——被否（离线环境无法安装且子集足够）。
- **验证方式**：`tests/core/ssrf.spec.ts`、`tests/core/netFetch.spec.ts`、`tests/shell/browserRequestGuard.spec.ts`、`tests/shell/terminalCommandPolicy.spec.ts`、`tests/shell/terminalDomain.spec.ts`、`tests/shell/sessionId.spec.ts`、`tests/shell/fileIpc.spec.ts`、`tests/core/sandboxSessionRoot.spec.ts`、`tests/shell/auditFile.spec.ts`、`tests/shell/shutdown.spec.ts`、`tests/core/jsonSchema.spec.ts`；基线 typecheck 6/6 + gen/check 逐字节 + build 6/6 + vitest 686/686。
- **状态**：✅ 已验证（自动化测试）；🟡 E2E 真机冒烟（终端面板、C++ 编译、浏览器守卫）待跑
- **回退条件**：浏览器请求守卫误杀正常页面 → 拆成「仅拦私网/IP + 子资源 scheme 白名单」两档配置；终端管道语义不满足验收 → 引入 PTY 作为独立 ADR
- **复核时间**：P0 发布门复验时（E2E 后）

---

## ADR-0017 浏览器功能面：书签 / 广告拦截 / 页面保存 / 快照面板

- **背景**：MVP 浏览器功能面要求多标签、地址搜索一体框、页面操作、下载、书签、历史、广告拦截、页面保存、可见执行日志、敏感确认。2026-11-02 扫描确认「书签/广告拦截/页面保存」三项零实现，快照仅 toast、刷新按钮语义错误（重新导航而非 reload）。
- **决策**：
  1. 书签用独立 JSON 存储（与 session/workspace 同风格：原子写、损坏隔离、上限淘汰），不进记忆库；
  2. 广告拦截做在 **webRequest 请求层**（域名后缀 + URL 片段，单一产地放 contracts/security-policy），设置里整体开关；不做元素级/脚本级拦截（避免与页面脚本对抗）；
  3. 页面保存为**单文件 outerHTML**（补 UTF-8 meta），不做资源打包；保存动作显式、路径可读；
  4. 截图/等待补齐为 Agent 工具（截图落会话工作根 `.loopsoar/screenshots/`，返回尺寸；等待支持 selector/text 轮询）；
  5. 快照从 toast 升级为面板（正文/元素/复制），并让原生视图在面板期间隐藏；
  6. 刷新按钮统一走 `browser:reload`（保持历史栈语义）。
- **理由**：三项都是 MVP 必须项且实现成本可控；请求层广告拦截可验证、可关闭、不侵入页面；单文件保存对「页面消失后内容仍在」的 MVP 目标已足够；快照面板化让「可见执行日志」真正可用。
- **替代方案**：书签进记忆库——被否（用户显式收藏与自动记忆语义不同）；元素级广告隐藏——被否（对抗成本高、易失效）；完整资源打包保存（mhtml）——被否（复杂度与跨域限制，留待后续）。
- **验证方式**：`tests/shell/bookmarksStore.spec.ts`（16）、`tests/shell/adBlockPolicy.spec.ts`（15）、`tests/shell/pageSave.spec.ts`（12）、`tests/shell/browserExtraTools.spec.ts`（12）、`tests/shell/browserRequestGuard.spec.ts`（41）；全量 109 文件 / 867 tests 绿。
- **状态**：✅ 已验证（自动化测试）；🟡 真机 E2E（广告拦截实际拦截、截图尺寸、保存效果）待跑
- **回退条件**：广告误杀率高 → 降级为仅域名后缀（去掉 URL 片段规则）或默认关闭；页面保存需求升级为完整离线归档 → 新增 mhtml 方案 ADR
- **复核时间**：P6 出口

---

## ADR-0018 浏览器工具栏浮层 / 管理整页 / 窗口自适应（用户反馈整理轮）

- **背景**：用户实机反馈四个问题：① 点「更多」时网页界面消失（此前方案是浮层打开即隐藏原生 WebContentsView——治标且体验不可接受）；② 靠上/下/左/右的展开菜单靠近窗口边缘必被截断；③ 历史记录面板为空；④ 所有网页不随窗口缩放自适应、只能手动拖拽。
- **根因**（代码级定位）：
  1. 主窗口 DOM 永远渲染在原生 WebContentsView 之下，凡是渲染在主窗口里的浮层都必然被网页遮挡；「隐藏网页」只是绕过遮挡，用户看到的就是网页消失；
  2. 历史为空：记录逻辑本身正常（新导航会写 `<dataDir>/browser-history.json`），但启动时**恢复的旧标签走 restoreInto（navigating=true 抑制记录）**，升级用户在新导航前打开面板必然为空；
  3. 不随窗口缩放：只有 `resize` 单事件直连 syncBounds；Windows maximize/unmaximize 有过渡动画（末次 resize 取到中间尺寸）且 enter/leave-full-screen 常不伴随 resize → 原生视图停在旧 bounds（非几何公式错误）；
  4. 边缘截断：各菜单各自算 absolute 位置，无翻转/夹取。
- **决策**：
  1. **工具栏浮层改为独立子 BrowserWindow**（parent=主窗口、frame:false、transparent、resizable/movable:false、skipTaskbar、sandbox/contextIsolation、与主窗口同 preload 白名单注入）。浮层窗口天然浮在原生网页之上：**不再隐藏 WebContentsView，网页始终可见**；从根上消除「点开菜单网页消失」类问题；
  2. 定位纯函数 `computePopoverBounds(anchorScreenRect, size, workArea, gap=6)`：默认下方右对齐 → 底部越界翻转上方 → 最终四边 clamp 到工作区、超工作区收缩尺寸；**任何边缘都不截断**；
  3. 交互：按钮 hover 250ms 打开预览浮层（限条数：书签/历史 8 条、下载 5 条）+ 底部「查看更多」；主进程 120ms 光标轮询，光标离开「浮层外扩 8px + 锚点外扩 24px」且浮层未聚焦才关闭（支持按钮→浮层移动路径）；Esc/blur/主窗口 resize/move/close 关闭；
  4. 「查看更多」跳转**整页管理界面**（ChromePage：历史/下载/收藏夹/设置，覆盖内容区、顶部返回栏；设置复用 Settings fullPage 模式），不再用小弹窗塞长列表；
  5. 应用内其它锚定菜单统一改用 `placePopover`（下方优先/翻转/夹取/maxHeight），窗口 resize/scroll/内容尺寸变化自动重定位；
  6. 历史全局化 + 恢复标签 backfill（启动恢复后补记 URL+标题；已存在条目**不增 visitCount、不刷时间**，只按需补空标题）；
  7. 窗口自适应：`resize` 50ms 防抖 + `maximize/unmaximize/restore/enter-full-screen/leave-full-screen` 六事件统一 `syncBounds()`；新增 `debugBounds(actual)/debugEval` 与 E2E 探针（baseline→setContentSize→maximize→unmaximize→fullscreen→exit）验证 `actual == bounds == page.innerWidth`。
- **理由**：独立浮层窗口是 Electron 下「自定义菜单浮在原生视图之上」的正解（VS Code/浏览器类应用同思路），一次性解决遮挡与网页消失，且不牺牲原生网页性能与安全边界；整页管理符合用户「像其他浏览器一样」的诉求；六事件+防抖修的是「最终几何未生效」而非公式。
- **替代方案**：继续用「打开浮层就隐藏网页」——被否（用户明确否决）；把网页换成 `<webview>`/iframe 让 DOM 可覆盖——被否（架构/安全/性能代价大，且 D0 已冻结 WebContentsView 方案）；全部菜单改用系统原生 Menu——被否（无品牌样式、无法做列表预览/查看更多）。
- **验证方式**：`tests/shell/chromePopover.spec.ts`（37）、`tests/ui/popoverPosition.spec.ts`（18）、`tests/shell/browserHistoryBackfill.spec.ts`（13）、全量 129 文件 / 1130 tests；真机 E2E：`E2E_POPOVER_WINDOWS 1`（浮层为独立窗口）+ 浮层窗口截图与网页视图截图同时正常（证明未隐藏网页）、hover 打开浮层、浮层内「查看更多」打开整页、历史补记日志 `{"added":0,"merged":1}`、resize 六步探针 `actual==bounds==innerWidth`（995→734→1682→734→1682→734）。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：透明子窗口在目标机器出现点击穿透/闪烁 → 改为 backgroundColor 不透明 + hasShadow，或回退到「原生 Menu + 隐藏视图」组合（不推荐）。
- **复核时间**：打包阶段（多显示器/多 DPI/全屏组合回归）

## ADR-0019 柔和无框双主题 + 会话栏三态（收起/小窗）+ 全宽底部终端

- **背景**：用户对界面提出三点：① 终端塞在右侧栏里的小抽屉不美观，希望像 VS Code 一样「从整个程序下面拉起」；② 右侧会话栏要加「收起」和「小窗化」，衔接动画参考 `D:\pilot project`（只读参考其 collapse/float 交互与动效参数）；③ 整体界面太「板正」（全是 1px 条框），要柔和无框的舒服观感，旧观感保留为可选主题。
- **根因/约束**：
  1. 终端此前渲染在侧栏内部 → 宽度受会话栏限制，永远只能是窄抽屉；
  2. 会话栏只有常驻宽度一种形态，没有收起/浮窗状态；
  3. 组件观感由内联样式 + BRAND 常量硬编码 → 想换风格必须先把颜色/边框/圆角/动效收敛成可切换的 token，否则「换主题」只能改一遍所有组件。
- **决策**：
  1. **终端改为应用级全宽底部 dock**：从窗口最底部拉起，横跨浏览器区与会话栏；高度可拖拽（契约 140–560），开关 240ms 高度过渡；原生 WebContentsView 必须同步让出底部高度（新增 `browser:setBottomInset` → `computeBrowserViewBounds({bottomInset})`），否则面板会被原生视图盖住；拖拽期间用 `setOverlay({open:true})` 临时隐藏视图，防止 mousemove 被网页吞掉；
  2. **会话栏三态**：`docked`（常驻）/ `collapsed`（48px 图标条）/ `float`（8px 外边距 + 16px 圆角 + 浮阴影的卡片）；模式持久化到 `preferences.sidebarMode`，`effectiveSidebarWidth` 变化时实时同步原生视图宽度；收起态内容**常驻 DOM 只做宽度+透明度过渡**（条件卸载会导致动画生硬），320ms decelerate；
  3. **双主题 token 体系**：BRAND 全部改为 `var(--ls-…, fallback)` 引用 → 所有内联样式自动跟随主题；`:root` 定义 soft 默认 30 个 token，`html[data-theme="classic"]` 覆盖 23 个旧值（逐像素复刻旧观感）；58 条 soft 专属无框化规则（去硬边/大圆角/明度分层/hover 只变色/统一缓动）；310 处颜色字面量收敛到 token；设置·外观提供 soft/classic 分段选择，切换 200ms 颜色过渡，`prefers-reduced-motion` 降级；
  4. **动效参数对齐参考项目经验**：布局/面板过渡 240–450ms `cubic-bezier(0.2,0,0.2,1)`；折叠内容常驻 DOM + 可插值属性（grid/宽度/高度），收起结束后延迟 120ms 再 `visibility:hidden`；禁止在包含原生网页视图的祖先上使用 `backdrop-filter`（Electron 命中测试失效雷区）；
  5. **二次调优（用户反馈「没变化」）**：首版 soft 无框力度不足（像素采样确认主题已生效，只是边框仍可感知）→ soft token 再收紧（`--ls-border` 归零、明度层级拉开、圆角 10/14/20、阴影加深），会话栏 docked 态也改为「8px 留白浮动卡片」，内部 header/工作区/会话条分隔线全部移除，输入区去框、focus 才出现品牌描边，应用底加极轻品牌光晕；
  6. **实机 bug 三连修**：① 收起态网页不铺满 —— 根因是宽度 IPC 契约/宿主把侧栏最小宽度锁死在 240，48 被拒或被夹回，改为 0..720 下限；② 小窗化无效 —— 原实现只是同列换皮，改为 `position:fixed` 的 340×min(68vh,620) 右下角浮窗；③ 关标签后音视频继续响 —— 根因是只 detach 视图、WebContents 未销毁，close 时先静音再 `webContents.close()`。
- **理由**：终端全宽是编辑器类应用的成熟模式；三态侧栏兼顾「专注网页」与「随手对话」；token 化是主题可切换的前提，且顺带消除了大量散落色值；借鉴参考项目的动效参数而非代码，规避隔离红线。
- **替代方案**：终端继续留在侧栏（否，用户明确否决）；小窗做成覆盖网页的 DOM 浮窗（否，原生视图层级更高必被盖）；仅换配色不取消边框（否，用户核心诉求是「没有条条框框」）。
- **验证方式**：`tests/ui/theme.spec.ts`（8：双主题 token/对比度/格式）、`tests/core/layout.spec.ts`（14：bottomInset/sidebarWidth 几何）、`tests/shell/browserHost.spec.ts`（+5 inset）；全量 130 文件 / 1150 tests；真机 E2E：soft/classic 两主题截图、侧栏 collapsed/float 截图、终端全宽截图、`config/preferences.json` 持久化验证（theme/sidebarMode）、终端打开后 `E2E_RESIZE_STEP` 显示 `bottomInset:260` 且 `actual.height == bounds.height == page.innerHeight`。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：soft 主题在个别显示器对比度过低 → 设置切 classic；浮动卡片在窄窗口遮挡网页 → 切 docked/collapsed；终端底部让位异常 → 关闭面板即可恢复。
- **复核时间**：打包阶段（多显示器/多 DPI/窗口极窄组合）

---

## ADR-0020 会话栏「小窗化」= 独立 Agent 窗口（真·窗口化）

- **背景**：用户明确「小窗化还是坏的，无法真正窗口化，参考 slime 都做差不多了」，要求会话小窗像真正的独立窗口，而不是主窗口内的浮层。
- **根因/约束**：渲染层 DOM 永远位于原生 `WebContentsView` 之下，页内任何浮窗都会被网页盖住、也无法移出主窗口或独立缩放；此前的 `float` 只是同列换皮，改成 `position:fixed` 悬浮卡片后仍受主窗口边界与原生命中层限制。
- **决策**：
  1. 新增主进程 `agentWindow.ts` 创建**独立顶层 BrowserWindow**（非 always-on-top、非子窗口）：可移动/缩放/最大化/最小化，任务栏独立条目；内容加载同一套渲染层，URL 带 `?mini=1`；
  2. `mini=1` 的 App 隐藏所有浏览器 chrome 与标题栏，只渲染铺满整窗的会话栏；
  3. 主窗口打开小窗时把 `sidebarWidth` 置 0 让原生网页铺满，关闭小窗恢复；原生视图宽度只允许 `App.tsx` 的 `effectiveSidebarWidth` 一个来源；
  4. 窗口生命周期由主进程统一管理：单实例、主窗口关闭时联动关闭、shutdown 时 dispose；用户关闭与程序性关闭都收敛为 `chrome:agentWindowClosed`，避免主窗口侧栏卡在隐藏态。
- **理由**：原生 WebContentsView 的层级是硬约束，只有独立 BrowserWindow 才能「真窗口化」；复用同一渲染层与 IPC 契约，Agent 逻辑、权限与主窗口完全一致，不引入第二套 UI。
- **替代方案**：继续页内浮动卡片（否，无法盖住网页且不能移出主窗口）；无边框浮层窗口（否，会话需要正常标题栏/缩放/任务栏行为）；把会话渲染成独立页面但仍在主窗口内（否，用户要的是真窗口）。
- **验证方式**：`tests/shell/agentWindow.spec.ts`（24：窗口创建/单实例/关闭事件语义/加载失败/域守卫/参数归一化）；`tests/guards/layering.spec.ts` 允许惰性 require；真机 E2E 打开/关闭两段探针与截图（见 `docs/E2E-SMOKE.md` 第 13 节）；全量 131 文件 / 1176 tests 全绿。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：独立窗口在个别桌面环境无法获得焦点或任务栏异常 → 暂时改回主窗口内 docked 会话栏（`sidebarMode: docked`），窗口模块可独立摘除。
- **复核时间**：打包阶段（多显示器 / 多 DPI / 窗口置顶与焦点 / 开机恢复）

---

## ADR-0021 定制窗口 chrome + 交互反馈 + 动效规范收敛

- **背景**：用户第 9 轮五点诉求：① 独立 Agent 小窗不要系统默认标题栏，最小化/关闭换成定制图标；② 使用其本地收录的图标库、不得再用 emoji 当图标，发送按钮图标也要改；③ 发送后发送按钮变中断按钮，点击立即中断生成，但用户再次输入时变回发送按钮；④ 主界面最小化/最大化/关闭按钮悬停无反馈；⑤ 「loopsoar 也出现了跟 slime 一样的动画逻辑错误，出现位置、收起位置全部反逻辑」，要求以 `D:\pilot project` 的 slime 为基准根除此类问题。
- **根因**：
  1. Agent 小窗仍是 `frame:true`，系统标题栏与自绘 UI 叠加，且窗口位置交给 OS 默认放置（录屏逐帧：打开时先出现在偏右位置、右侧被屏幕截断，再瞬间补全，没有从主窗口右缘滑入的轨迹；关闭是 1–2 帧硬切）。
  2. `TitleBar` 的 `styles.windowButton` 内联 `background:"transparent"`，内联样式优先级压过 `index.html` 的 `.win-btn:hover`，主窗口按钮 hover 永远不生效（小窗是系统按钮所以有反馈）。
  3. 发送/中断是两个并排控件，且运行中输入会弹「编辑/直接引导/取消」询问，不符合「单按钮随状态切换」的预期。
  4. 动效三处不同源：DOM 侧栏过渡 `cubic-bezier(0.2,0,0.2,1)` 与主进程原生视图插值 `cubic-bezier(0,0,0.2,1)` 不同曲线（同 320ms 下 160ms 处进度 0.815 vs 0.838，371px 位移差 8–9px → 原生网页盖住侧栏边缘）；侧栏外层 `display:none` 瞬切；窗口最小化/关闭事件在动画前推送，导致侧栏提前展开；收起/窗口化时仍扣 6px splitter 留缝；启动水合时误播动画。
- **决策**：
  1. **独立 Agent 窗口改无边框自绘**：`frame:false` + `titleBarStyle:"hidden"` + `roundedCorners:true`；复用 `TitleBar variant="agent"`（品牌标 + 「Agent 对话」+ 仅最小化/关闭，拖拽区 `-webkit-app-region: drag`，双击不最大化）；新增 `ui:minimizeAgentWindow` 通道（仅 Agent 窗口可调），最小化后主窗口恢复侧栏避免无入口。
  2. **窗口几何由主进程显式管理**：`computeAgentWindowBounds` 以主窗口 `contentBounds` 贴右缘（`right-420-8`、`top+118`），按显示器 `workArea` 四边夹取；打开时隐藏创建、首帧在 `target.x+24`，200ms 同曲线滑入淡入；关闭 160ms 滑出后销毁；`chrome:agentWindowClosed` 改为**窗口真正销毁后**推送；主窗口 7 类几何事件 16ms 防抖 `reposition()` 跟随。
  3. **发送↔中断单按钮状态机**：`busy && 输入为空` → 停止图标（点击立即中断、不置灰）；`busy && 有输入` → 发送图标（走 steer）；`idle` → 发送；删除独立停止块与运行中询问弹窗。
  4. **hover 根因修复**：删除 `windowButton` 内联背景/颜色，统一由 `.win-btn`/`:hover` 提供；补标签页/chip/模型项 hover，chip 用 `!important` 覆盖内联背景；关闭键 hover 变红。
  5. **本地图标库替代 emoji**：从用户 `Loopsoar/icon/icon_fpbc119q3rk` 迁入 42 个 1024 viewBox SVG 到 `packages/ui/public/icons`（ASCII 命名 + `SOURCE.md` 映射），发送=`guide-arrow`、中断=`终止`、最小化=`minus`，自绘 maximize/restore/checkbox 等；`Icon` 走 CSS mask + currentColor；替换全部 emoji/几何符号并新增图标存在性测试。
  6. **动效规范收敛（`docs/design/sidebar-motion.md`，10 条不变式）**：右缘钉住（`margin-left:auto`/`justify-content:flex-end`）；禁用 auto 宽过渡、过渡期 px 目标宽 + `!important`；wrapper 与内容同 duration/curve；退场独立类；内容常驻 DOM；预捕获 + 时间驱动；CSS token 单一产地（JS 读回）；动画与拖拽互斥。据此统一 DOM 侧栏与原生视图为 320ms `cubic-bezier(0.2,0,0.2,1)`；splitter 仅 docked 扣 6px；删除侧栏 `display:none` 瞬切与死 CSS；启动水合不播动画。
- **理由**：原生 `WebContentsView` 的层级与 OS 窗口行为是硬约束，只有独立 BrowserWindow + 自绘 chrome 才能实现用户要的「全自定制窗口」；单按钮状态机符合成熟聊天产品的交互直觉；动效必须「曲线/时长/几何三者同源」才能避免出现/收起位置反逻辑（参考项目已用注释与逐帧追踪验证过同类故障）。
- **替代方案**：保留系统标题栏只换图标（否，用户明确「不要系统默认顶部控制页」）；用第三方 UI 库图标（否，用户已提供本地图标库）；把中断做成独立按钮并保留（否，用户要单按钮切换）；仅调时长不改曲线（否，根因是两条曲线不同源）。
- **验证方式**：`tests/shell/agentWindow.spec.ts`（42：无边框创建/贴边+夹取/滑入/滑出/关闭事件时序/最小化/reposition/域守卫）、`tests/shell/browserHost.spec.ts`（23：同曲线插值/收起态宽度/splitter 语义）、`tests/ui/icons.spec.ts`（5）、`tests/core/layout.spec.ts`（splitter 仅 docked）、`tests/guards/channels-have-handlers.spec.ts`；全量 **132 文件 / 1205 tests 全绿**，typecheck 5/5、gen/check 逐字节一致、build 5/5；真机 E2E 见 `docs/E2E-SMOKE.md` 第 14 节（无边框小窗、滑入轨迹 x 686→662、原生视图 507→0 插值、hover 变红、Composer stop→输入后 send）。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：无边框窗口在个别桌面环境无法拖动/缩放 → 恢复 `frame:true` 系统标题栏；单按钮状态机与用户预期冲突 → 可回退为独立停止按钮（Composer 局部改动）；动效异常 → 设置中关闭动效（`data-animations` / reduced-motion）即可降级。
- **复核时间**：打包阶段（多显示器 / 多 DPI / 窗口贴边吸附 / 输入法与快捷键）

---
## ADR-0022 顶部标签行 + chrome 闭环外壳（网页面板内缩/圆角）

- **背景**：用户第 10 轮 UI 精修：① 标签页移到最顶行、与最小化/最大化/关闭同列，活动标签填充高亮、去掉白描边胶囊；② 网页/会话/顶部之间仍是硬直角，要求把会话与整体底部配色调一致、把网页区专门划分出来；③ 网址栏只覆盖网页列、不要延伸进会话栏，会话栏顶部按钮区与工具条同底色并纵向拉长；④ 输入框要与周围底色区分；⑤ 最后要求把工具条与会话栏之间的小缝隙连接起来，用弧度形成彻底的闭环框住网页栏。
- **根因**：
  1. 标签栏是独立的第三行（`TAB_BAR_HEIGHT=34`），与标题栏/窗口按钮分离，活动标签用 `borderColor: BRAND.borderStrong` 描边，视觉上像一排白框胶囊。
  2. 标题栏以下用 `body` 平铺：`BrowserChrome` 顶栏横跨整个窗口（包括会话栏上方），会话栏从工具条下方才开始；外壳底色透明，splitter 6px 与侧栏左侧 8px 内边距露出应用底色，形成暗缝与硬直角。
  3. 网页面板（StartPage DOM 占位 + 原生 `WebContentsView`）与窗口/工具条之间没有统一的内缩与圆角，原生视图默认直角、贴到内容区边缘。
- **决策**：
  1. **标签并入标题行**：`TitleBar` 增加 `tabs` 插槽（main 变体：左标签 + `+`、中拖动区、右窗口按钮；agent 变体保持品牌 + 最小化/关闭）；新增 `BrowserTabs.tsx`，`BrowserChrome` 只保留第二行导航工具条；`TITLE_BAR_HEIGHT` 36→**40**，删除 `TAB_BAR_HEIGHT`，原生视图顶部偏移同步为 `TITLE_BAR_HEIGHT + TOP_BAR_HEIGHT + BROWSER_VIEW_INSET`。
  2. **标签视觉（Chrome 式）**：非活动标签透明、无边框、次级文字，仅 hover 变色；活动标签填充 `--ls-surface-raised`（与工具条同色连成一片）并提亮文字；关闭键仅 hover 显示；规则统一放 `index.html`，soft/classic 共用 token。
  3. **闭环外壳**：`App` 改 `workRow`（背景 `BRAND.inkRaised`）= 左 `pageColumn`（工具条 + 页面）+ splitter + 右满高会话栏；`StatusBar` 同色并删除上分隔线，外框延伸到底；工具条背景 raised、只覆盖网页列（omnibox `maxWidth:720` + 动作区 `marginLeft:auto`），去 borderBottom；会话栏 raised、无左边框、header 高度 48 对齐第二行工具条；`Composer` 外层透明、输入卡片 raised + radius 14。
  4. **网页面板闭环**：契约新增 `BROWSER_VIEW_INSET=8`、`BROWSER_VIEW_RADIUS=14`，`computeBrowserViewBounds` 四边内缩为 `x=inset, y=title+top+inset, w=size-sidebar-splitter-2*inset, h=size-title-top-status-bottomInset-2*inset`；DOM `StartPage.browserPane` 与原生视图共用同一组值，主进程 `view.setBorderRadius(14)` 切角露外壳底色，形成「深色门户嵌在抬高外壳里」。
- **理由**：标签与窗口控制同列是主流浏览器的稳定心智模型；外壳单块抬高 + 网页面板内缩圆角，用同一底色自然消掉 splitter/侧栏内边距的暗缝与硬直角，不需要再加分隔线；契约单一产地保证 DOM 与原生视图几何不漂移。
- **替代方案**：保留第三行标签只改配色（否，用户明确要「挪到最上面」）；用 CSS `border-radius` 只修 DOM 不修原生视图（否，网页仍是直角、闭环破口）；给外壳加描边/阴影伪造连接（否，缝隙仍是缝，且抬高底色已能自然连成一体）。
- **验证方式**：`tests/contracts/layout-nav.spec.ts`（新常量与 1280×800/小窗口边界）、`tests/core/layout.spec.ts`（inset/圆角几何全量重写）、`tests/shell/browserHost.spec.ts`、`tests/shell/agentWindow.spec.ts`、`tests/shell/browserHistoryBackfill.spec.ts`；全量 **132 文件 / 1205 tests 全绿**，typecheck 5/5、gen/check 逐字节一致、build 5/5；真机 E2E 见 `docs/E2E-SMOKE.md` 第 15 节（顶行标签高亮、闭环外壳像素采样、几何探针 `{x:8,y:96,width:978,height:724}`、截图 `e2e-round10-closed-frame.png`）。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：标签行与窗口按钮在极窄窗口（<640px）挤压拖动区 → 隐藏部分标签文字/允许横向滚动，不改回第三行；`setBorderRadius` 在个别显卡/合成器异常 → 降级为 DOM 圆角 + 原生视图不切角（契约常量可回退 0）。
- **复核时间**：打包阶段（多显示器 / 多 DPI / 极窄窗口 / 高对比度主题）

---

---
## ADR-0023 会话栏星标折叠开关 / 地址栏随列伸缩 / 聊天滚动条单一化

- **背景**：用户第 11 轮三点反馈：① 「收起与展开的图标位置很反直觉，一个在右上角的左边，一个在右上角的下面」，要求用收起态那个 Loopsoar 星标方块作为唯一开关——未展开时只显示方块，点击展开后方块由正方形变长方形、星标平滑左移、右侧空出的部分渐入收起图标；② 「收起后，上方网址填入栏也要随右侧边栏的收起向右延伸为正常长度，现在一直维持的比较短的长度」；③ 「会话的右边上下滚动的拖拽处又出现了我原本叫你替代了的按钮？仅保留现有波纹状按钮条就行」。
- **根因**：
  1. 收起/展开入口分散：展开态 header 的 `>` 收起按钮位于右上角左侧，收起态 rail 的 `‹` 展开按钮位于星标方块下方；两个不同位置、不同方向的按钮执行相反动作，且 rail 还混着会话切换/新建，视觉与操作都反直觉。
  2. 地址栏 `maxWidth:720` 是第 10 轮为「地址栏不要伸进会话栏」加的静态上限；第 10 轮已把工具条裁进 `pageColumn`，该 cap 变成多余限制——侧栏收起、网页列变宽后地址栏不跟着延伸。
  3. soft 主题块给 `.chat-scroll` 设了 `scrollbar-width:thin` + `scrollbar-color`，覆盖基础规则 `scrollbar-width:none` 与 `::-webkit-scrollbar{width:0}`，原生 WebKit 滚动条（含上下箭头）重新出现，与 TopicRail 波纹卷轴重叠。
- **决策**：
  1. **单一星标开关**：`AgentSidebar` 用绝对定位 `.sidebar-toggle` 取代两个入口——`top/right:8`、宽 `isCollapsed ? 32 : 62`、高 32；收起=仅星标方块，展开=长方形（星标绝对 `left:8` 随容器左扩左移，右侧渐入 `forward` 箭头，opacity 延迟 90ms）；宽度 320ms `cubic-bezier(0.2,0,0.2,1)`，右缘固定所以只有「左伸右收」一个方向。点击收起→`lastExpandedModeRef`（docked/float），展开→collapsed；`fill`（mini/独立 Agent 窗口）隐藏，靠该窗口标题栏关闭；header `paddingRight:78` 防重叠；hover 放 `index.html` `.sidebar-toggle:hover`（避免内联背景压过 hover）。删除 rail 全部按钮与 header 收起按钮。
  2. **地址栏弹性**：删除 `omniboxWrap.maxWidth:720`，omnibox `flex:1` 填满 `pageColumn`；侧栏收起时网页列变宽、地址栏自动延伸。新增 `.browser-toolbar` / `.browser-omnibox` 类作为探针与样式锚点。
  3. **滚动条单一化**：删除 soft 主题对 `.chat-scroll` 的 `scrollbar-width:thin` 覆盖，保留基础 `scrollbar-width:none` + `::-webkit-scrollbar{width:0;height:0}`，聊天区只保留波浪卷轴。
- **理由**：同一元素做两态切换时，右缘固定 + 宽度变化会把「方向」自然编码进动作（展开=向左长出来），不再需要记忆两个反向按钮；地址栏长度应由列宽决定，静态上限在列宽可变后必然过时；滚动条只能有一个视觉来源，否则两个滚动指示器叠加既乱又会抢拖拽。
- **替代方案**：保留两个按钮只调整位置（否，用户明确只留一个星标方块）；展开按钮放回 header 右侧（否，仍是两个入口）；地址栏用 JS 监听宽度写像素（否，flex 即可，避免状态同步与抖动）；仅隐藏 WebKit 箭头而保留滚动条（否，仍与卷轴重叠）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **132 文件 / 1205 tests 全绿**；真机 E2E（`docs/E2E-SMOKE.md` 第 16 节）DOM 探针：展开 `omni.w=667`/toggle 62，收起 `omni.w=1132`/toggle 32/`mode=collapsed`/`chat-scroll` 滚动条厚度 0，展开动画采样 32→47→62；截图 `e2e-round11-expanded.png`、`e2e-round11-collapsed.png`、`e2e-round11-toggle-mid.png`。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：32px 方块在触屏/高 DPI 下点击过小 → 增大命中区域（padding/伪元素）而不是改回两个按钮；地址栏过长导致图标被挤 → 给 omnibox 加 `minWidth:0` 与动作区 `flexShrink:0`（已具备），必要时按列宽百分比限制。
- **复核时间**：打包阶段（触屏 / 高 DPI / 极窄窗口 / 经典主题）

---

## ADR-0024 输入区独立色块 / 卷轴悬停卡片 / 数据目录绝对化

- **背景**：第 11 轮追加反馈：①「会话栏的输入框，我希望那个区域做成其他色块区分一下」——上一轮只把输入卡片改成 raised，但它与会话栏同色，视觉上仍分不出来；②「如图，这个地方（聊天区右缘波纹卷轴），鼠标放上去后的表现形式仍旧不是我要的样子，你给我仔细研究 slime 项目」——Loopsoar 的卷轴悬停是一条窄 tooltip，slime 是带圆点、序号与标签的浮动卡片；③ 调试中用 `LOOPSOAR_DATA_DIR=.loopsoar-data` 启动，Electron 抛 `Error: Path must be absolute`，主进程直接退出并弹错误框。
- **根因**：
  1. `Composer` 外层背景 `transparent`、卡片 `BRAND.inkRaised`，而会话面本身也是 raised —— 输入区与聊天区同色，只剩 1px 边框，达不到「独立色块」。
  2. `TopicRail` 的 tip 只输出一行百分比文本，缺少 slime 的卡片容器、序号与主题化排版；显隐用 opacity，且无序号/标签分层。
  3. `app.setPath("userData", value)` 要求绝对路径；`LOOPSOAR_DATA_DIR` 直接透传，相对值在 Electron 加载阶段抛错（这是开发/CI 脚本的常见写法，不是用户配置错误）。
- **决策**：
  1. **三段色阶**：输入区外层改用 `BRAND.ink`（`--ls-bg`，深一档的整条色带），输入卡片保持 `BRAND.inkRaised`（`--ls-surface-raised`）+ 圆角 14 + 1px 边框；soft 主题下为 `#0a0c10` 色带上的 `#171b22` 卡片，与会话面 `#171b22` 形成清晰分层，不再依赖分隔线。
  2. **slime 式悬停卡片**：`TopicRail` tip 改为 `<i class="dot"/> + <span class="ord"/> + <span class="txt"/>`：6px 强调色圆点、`n / total` 等宽序号、话题标签（无标签时显示上下文百分比）；`right:22px` 悬浮在卷轴左侧、`translate3d` 跟随鼠标（合成器属性，不触发布局）、`display:none→flex` 显隐；样式全部走主题变量（`--ls-surface-raised` / `--ls-border` / `--ls-accent`），最大宽 300、12.5px、圆角 8、阴影 `0 6px 22px rgba(0,0,0,.5)`。
  3. **数据目录归一化**：新增无 Electron 依赖的 `packages/shell/src/main/dataDir.ts`：`resolveDataDir(override, appDataPath)` = `trim()` 后非空则 `path.resolve(...)`，否则 `path.join(appDataPath, "loopsoar")`；`index.ts` 的 `app.setPath("userData", …)` 与 `pastedImage.ts` 共用该归一化，相对路径也能启动。
- **理由**：色块区分比描边更稳（不依赖主题的边界色，也不受窗口缩放/显示缩放影响）；悬停卡片把「这是第几条话题」这一信息显式化，与 slime 的操作心智一致，同时沿用其「只动 transform」的性能约束；数据目录属于基础设施输入，必须在进入 Electron API 前归一，否则错误发生在能捕获之前（主进程加载阶段）。
- **替代方案**：输入区加深色边框/阴影（否，用户要的是色块）；保留单行 tooltip 只改配色（否，缺少序号与卡片结构，仍不是 slime 的样式）；在 `app.whenReady` 后再修正相对路径（否，`app.setPath` 在模块顶层执行，来不及）；只在 `dev-gui.mjs` 里改成绝对路径（否，治标不治本，其他脚本/CI 同样会踩）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**（新增 `tests/shell/dataDir.spec.ts` 4 用例：未设置/空白回落、相对路径绝对化、绝对路径去空白保持）；真机 E2E `docs/screenshots/e2e-round11-composer.png` 显示色带 + 卡片 + 卷轴悬停卡片「● 1 / 1 你：…」，日志 `[E2E] RAIL_HOVER hovered`；相对路径启动日志 `dataDir=D:\…\.loopsoar-data-mock` 正常。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：深色带在经典主题下对比过强 → 经典主题单独覆盖 `--ls-bg`/`--ls-surface-raised` 的色带关系，不改结构；悬停卡片遮挡消息 → 调 `right` 偏移或 `max-width`，不改信息结构；`LOOPSOAR_DATA_DIR` 指向不存在目录 → 已由后续 `mkdirSync` 处理，保持归一化职责单一。
- **复核时间**：打包阶段（经典主题、极窄窗口、多显示器 DPI、CI 相对路径启动）

---

## ADR-0025 输入框本体色块 / slime 式双股编织卷轴

- **背景**：ADR-0024 的「三段色阶」把输入区外层整条涂深，用户反馈「我希望变色的是输入框而非输入框周围」；同时卷轴仍是一条细金线，用户给出 slime 截图要求「双股编织发光」的视觉效果，而非只改悬停卡片。
- **根因**：
  1. 变色层级选错：上一轮改的是 `Composer` 外层容器（整条色带），输入卡片本身仍是 raised，与消息面同色。
  2. 卷轴渲染模型不同：旧实现是「两条细 sin 线 + 视口段高亮」，slime 是「两股反相/反向/不同波长的粗线 + 每股 glow pass + 纵向亮度渐变」，两者视觉量级差一个数量级。
- **决策**：
  1. 输入区恢复 `transparent` 外层（会话面底色），只把 `composerBox` 下沉到 `BRAND.ink` + 圆角 14 + 1px 边框；变色对象 = 输入框本体。
  2. `TopicRail` 按 slime `strokeWave` 重写：两股线 `key=±1`、**同一波长**（`min(lam0, lam1)`）、`sep = amp*taper*(1-0.55*focusAt)` 编织；主线 + glow 双 pass；`lineStyle` 纵向渐变；`scrollPhase`；悬停「捏拢 + 推开」；删除圆点与旧高亮段。配色沿用 Loopsoar 品牌（linen + ochre），不照搬 slime 蓝白。
  3. `amp` 收敛为 `min(width/2-3, (width/2-3)*amp%*1.2)`（默认约 2.9px），主线 1.5～1.8px、光晕 3～3.8px、光晕 alpha 0.10～0.15；x 夹取留 2px 安全边，避免被画布裁切。首版用不同波长 + 5px 振幅 + 宽光晕，两股漂移分离被用户评价为「越来越乱」，故改为同波长规整交叉。
- **理由**：用户要的是「输入框本体与会话面不同色」和「slime 那种编织发光」，两者都是视觉层级问题，用色阶 + 线宽/光晕量级解决最直接；`scrollPhase` 让卷轴在滚动时保持「内容在动」的感知，悬停收拢则保留 slime 的「捏住」手感。
- **替代方案**：继续加深周围色带（否，与用户诉求相反）；只把单线加粗（否，没有编织交叉结构与双股光晕，仍不像 slime）；直接复制 slime 蓝白配色（否，违反品牌约定，且 Loopsoar 是暖色墨底）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**；真机 E2E `docs/screenshots/e2e-round11-rail-braid.png`（静止态：规整双股麻花 + 输入框本体色块）与 `e2e-round11-rail-braid-hover.png`（悬停收拢 + 卡片），日志 `[E2E] RAIL_HOVER hovered`。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：编织线在窄窗口/低分屏显拥挤 → 调 `railParams` 的 width/amp 或降低 lineWidth 系数，不改结构；用户要求严格 slime 配色 → 只改两个 RGB 常量，不动几何；输入框对比过强 → 调 `--ls-bg` 与 raised 的关系，不改结构。
- **复核时间**：打包阶段（经典主题、极窄窗口、多显示器 DPI、系统减少动画）

---

## ADR-0026 卷轴外观回退 + slime 式悬停突起

- **背景**：ADR-0025 的双股编织被用户判定「不如原来那版、越来越乱」；同时用户指出悬停反馈方向错误——要的是 slime 那种「鼠标放上去后的突起」（向外鼓包），而不是把两股收拢。
- **根因**：
  1. 编织版虽做到同波长规整，但粗线/光晕与 Loopsoar 原始极细卷轴的观感冲突，用户明确更认可原版。
  2. 原实现的 hover 只有约 4px 的 `pointerPush` 与局部提亮，方向还跟随 `flip`，视觉上几乎无感，更不是 slime 的鼓包。
- **决策**：
  1. 外观回退到 `1a4f641` 的「极细双股波浪线 + 视口提亮 + 话题圆点」。
  2. 仅在交互层新增突起：画布左侧扩 `BUMP_PAD=30px`（热区宽度保持 16px 不变），`bumpRef` 0→1 每帧缓动，指针高度处用高斯窗把整条线向左推 `max(8, w*0.75)`，形成平滑鼓包；指针离开后从最后位置回缩。
  3. 突起使用 `pointerYRef` 的最后一个值做回缩动画，`onPointerLeave` 不再清空 y。
- **理由**：用户明确要「外观改回去、反馈做出来」，因此不动视觉基础，只把交互做强；突起需要额外画布空间，扩画布而不扩热区，避免遮挡聊天区文本的指针事件。
- **替代方案**：保留编织只改 hover（否，外观已被否决）；用 CSS transform 整体位移（否，只有整条线平移、没有局部隆起）；用圆形光斑/高亮（否，用户要的是波形鼓起）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**；真机 E2E `docs/screenshots/e2e-round11-rail-final.png`（静止细线）与 `e2e-round11-rail-bump.png`（悬停鼓包），日志 `[E2E] RAIL_HOVER hovered`。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：突起在窄窗口被裁切 → 调 `BUMP_PAD` / `reach`；鼓包过大 → 调 `reach` 系数；仍想要编织 → 从 git 历史取 ADR-0025 版本，但需同时满足「外观可切换」再上线。
- **复核时间**：打包阶段（窄窗口、多显示器 DPI、系统减少动画）

---

## ADR-0027 卷轴突起平滑化 + 悬停卡片对比度（ADR-0026 的交互细化）

- **背景**：ADR-0026 的「向外鼓包」上线后，用户仍反馈实机「不对」；像素测量用户截图确认突起幅度已生效（-8.5 ~ -14px），问题在观感：突起区两股线交叉成 S 形/打结，且悬停卡片与会话面同色、几乎不可见。
- **根因**：
  1. 基础荡漾（两股线 λ0/λ1 相位不同）与突起的平移叠加，在平移中心附近两条线交叉自交。
  2. `bumpSigma = max(26, height*0.045)` 偏窄，窄窗口突起边缘陡、像折角。
  3. 卡片背景 `--ls-surface-raised` 与会话面相同，soft 主题 `--ls-border` 为透明 → 卡片没有可感知的边界。
  4. 突起缓动只靠 rAF；窗口失焦/降频时可能停在 0，表现为「悬停没反应」。
- **决策**：
  1. 突起区内用 `waveDamp` 把正弦项压到接近 0（`1 - 0.85*bumpAmt*gauss`），指针处两股重合为单条平滑外鼓曲线，离开后恢复波纹。
  2. `bumpSigma = max(34, height*0.06)`；`reach = max(10, width*0.9)`。
  3. `onPointerMove` / `onPointerEnter` 立即重绘；`reducedRef` 时直接把突起强度置 0/1，不依赖 rAF。
  4. 卡片背景改 `var(--ls-bg)`，描边 `rgba(255,255,255,0.12)`，保留 `0 6px 22px` 阴影与 8px 圆角。
- **理由**：用户要的是 slime 那种「平滑突起 + 一眼可见的卡片」；编织外观已被否，不能靠加粗/加光晕解决，只能把突起从「波形叠加」改成分离的平滑包络，并解决卡片与背景同色的问题。
- **替代方案**：继续调大 `reach`（否，会遮挡聊天区且形状仍打结）；把基础荡漾关掉（否，静止外观会失去卷轴特征）；卡片用 backdrop-filter（否，含原生视图的祖先层禁用，见 ADR-0019）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**；真机 E2E `docs/screenshots/e2e-round11-rail-smooth.png`（静止外观不变）与 `e2e-round11-rail-smooth-bump.png`（平滑单包络 + 深色卡片），日志 `[E2E] RAIL_HOVER moved` / `RAIL_TIP`。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：突起过大遮挡消息 → 调小 `reach` 或提高 `waveDamp` 系数；classic 主题卡片对比不足 → 为 `--ls-bg` 之外的卡片色单独加 token；窄窗口突起被裁切 → 调大 `BUMP_PAD`。
- **复核时间**：打包阶段（窄窗口、系统减少动画、多显示器 DPI）

---

## ADR-0028 卷轴外观重做为 slime wave 编织（沿用 Loopsoar 品牌配色）

- **背景**：ADR-0025~0027 一直在旧「极细双线」上叠动画（突起、压平荡漾、卡片对比度），用户多次指出与参考作品 `D:\pilot project`（slime）的卷轴外观不一致。复查确认参考作品的关键是**编织几何本身**：两股波长接近（46/53）、相位差 π、反向摆动，主股亮、辅股暗，视口位置之上更亮、之下转暗，两股各带一档宽光晕。
- **决策**：
  1. `packages/ui/src/TopicRail.tsx` 按 slime 的 wave 模式逐项移植 `band / shapeAt / lineStyle / strokeWave / frame`（含悬停收拢 `wOsc`、bulge 2.8、dip 1.1、strength 0.18/帧、uc 0.22/帧）。
  2. 颜色改为 Loopsoar 品牌色：主股亚麻白 `244,239,230`、辅股赭石 `216,141,86`；不复刻 slime 的蓝白配色（用户明确「颜色要贴合 loopsoar 主题」）。
  3. 参数默认值采用 slime 出厂值（`w12 / amp55 / lam46 / lam53 / spd1 / tap90`）；存储键升级为 `loopsoar_rail_params_chat_v2` 并清理旧键，避免旧 localStorage 参数把新外观覆盖回细线。
  4. 细节保留：`contain:paint` 只放 canvas（host 上会裁掉左伸的悬浮卡片）；拖拽热区左侧多留 10px；`prefers-reduced-motion` / 动效关闭时冻结荡漾并把悬停强度直接置 0/1。
- **理由**：用户要的是参考作品那张图的视觉结果，而不是在旧图形上加动画；编织几何 + 品牌色是唯一能同时满足「像 slime」和「贴合 Loopsoar 主题」的组合。
- **替代方案**：继续微调旧双线（否，几何不同，永远不像）；直接复制 slime 蓝白配色（否，违背品牌约束，用户明确要求主题色）；只做悬停突起不改静态外观（否，静态外观才是用户比较的主体）。
- **后果**：外观与参考作品一致；用户此前自定义的卷轴参数会因存储键升级回到默认值（已在代码注释标明）；slime 的「刻度模式」不移植（Loopsoar 聊天区只需要 wave 模式）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**；真机 E2E `docs/screenshots/e2e-round11-rail-wave.png`（静止编织）与 `e2e-round11-rail-wave-hover.png`（悬停鼓包 + 卡片），日志 `[E2E] RAIL_HOVER moved` / `RAIL_TIP`。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：品牌色在浅色主题对比不足 → 按主题 token 切换两股颜色；窄窗口光晕过亮 → 按 `height` 缩放 alpha；用户仍不认可 → 恢复 ADR-0026 外观（`git checkout fc3c97c -- packages/ui/src/TopicRail.tsx`）。
- **复核时间**：打包阶段（浅色主题、多显示器 DPI、系统减少动画）

---

## ADR-0029 卷轴外观回退原版配色，只借鉴悬停突起（含突起坐标即时定位）

- **背景**：ADR-0028 全盘移植参考作品的编织外观后，用户反馈：「我还是更喜欢原版配色……主要是我叫你调整鼠标放置位置的反馈显示，也没叫你全盘搬过来啊，原设计也有不少优秀的地方，不用全盘搬 slime 的。」同时反馈一个交互 bug：鼠标离开后似乎留下了多余的坐标记录，下一次悬停时突起总是从上一次位置滑到当前鼠标位置，而不是直接出现在鼠标处。
- **根因**：
  1. 过度移植：用户只要求调整「悬停反馈」，静态外观仍应保持 Loopsoar 原设计（暖金细双线 + 视口提亮段 + 话题圆点 + 悬停局部高光）。
  2. 坐标滑移：slime 移植版用 `pointerSmoothRef` 对指针高度做二次缓动，`pointerleave` 后仍保留上一次的平滑位置；下一次进入时从旧值缓动到新值，表现为「突起滑过来」。原版突起的位移直接使用 `pointerYRef`，本身没有这个问题，但 `onPointerEnter` 没有刷新 `pointerYRef`，首次进入可能沿用旧高度。
- **决策**：
  1. `packages/ui/src/TopicRail.tsx` 回退到 ADR-0027 外观（`git checkout 51a414a -- packages/ui/src/TopicRail.tsx`）：暗线/亮线颜色、视口渐变提亮、话题圆点、悬停高光全部恢复；仅保留突起（`waveDamp` 压平突起区荡漾、`bumpSigma = max(34, height*0.06)`、`reach = max(10, width*0.9)`）。
  2. `onPointerEnter` 立即把 `pointerYRef` 设为当前指针高度；突起位移直接使用 `pointerYRef`（不再有二次平滑），保证下一次悬停第一帧突起就落在鼠标位置。
  3. `railParams.ts` 默认值恢复原版（w16 / amp48 / lam0 86 / lam1 112 / spd0.8 / tap130），存储键升级 `loopsoar_rail_params_chat_v3` 并清理 v1/v2（v2 是编织版参数，会覆盖回错误外观）。
  4. `i18nSettings.ts` 标签恢复「亮线波长 / 暗线波长」与对应预览说明。
- **理由**：用户的诉求是「保留原设计的优点，只借鉴参考作品的悬停反馈」；坐标必须即时定位，任何「平滑跟随」都会引入延迟/滑移观感。
- **替代方案**：保留编织只换颜色（否，用户明确要原版外观）；去掉平滑但仍在 `pointerleave` 保留位置（否，进入首帧仍可能用旧坐标）；回退到 fc3c97c（否，会丢 ADR-0027 的平滑包络与卡片对比度修复）。
- **后果**：外观与 ADR-0027 完全一致；用户自定义的卷轴参数因存储键升级回到默认值；slime 编织实现只保留在 git 历史中（ADR-0028）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**；真机 E2E `docs/screenshots/e2e-round11-rail-restored.png`（静止原版外观）、`e2e-round11-rail-restored-hover.png`（悬停突起 + 高光 + 卡片）、`e2e-round11-rail-reenter.png`（`LOOPSOAR_E2E_HOVER_RAIL=2`：45% 悬停 → 离开 → 75% 重新进入；像素测量突起中心 y≈675 与重新进入点一致，日志 `[E2E] RAIL_HOVER reenter`）。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：原版高光在浅色主题过亮 → 按主题 token 调 alpha；突起仍遮挡正文 → 调小 `reach`；`LOOPSOAR_E2E_HOVER_RAIL=2` 的合成移动在 CI 上不稳定 → 以像素测量为准、重跑。
- **复核时间**：打包阶段（浅色/classic 主题、多显示器 DPI、系统减少动画）

---

## ADR-0030 卷轴突起宽度固定（修复大窗口下整条线被拉成大弯）

- **背景**：ADR-0029 上线后用户反馈「鼠标放上去后的反馈又崩了」。截图显示突起不再是局部鼓包，而是整条线被缓慢拉成 S 形大弯。
- **根因**：突起的高斯宽度写成了 `bumpSigma = Math.max(34, height * 0.06)`，**按轨道高度百分比缩放**。轨道越高（窗口最大化/高 DPI），高斯覆盖范围越大，指针处整个可见段落都被平移，视觉上就是「线被拉弯」。ADR-0027 为了让窄窗口不出现折角而引入下限，但没有解决「高轨道」的情况。
- **决策**：
  1. `packages/ui/src/TopicRail.tsx` 中 `bumpSigma` 固定为 **20px**，与轨道高度解耦；任何窗口尺寸下突起只覆盖指针上下约 ±50px。
  2. `bumpReach = Math.max(12, Math.min(18, width))`，幅度限制在 12~18px。
  3. 突起形状采用 slime 的 **bulge + dip**：中心高斯向外鼓、两翼轻微回缩（`BULGE=2.8 / DIP=1.1 / DIP_T=2.7`），把纯高斯的「肘部」过渡为圆润的包。
  4. `waveDamp` 使用同一 `bumpSigma`；悬停高光段与突起范围对齐（`±2.4×bumpSigma`）。
- **理由**：突起是「指针位置的局部提示」，其物理尺寸不应随窗口变大；固定像素宽度 = 视觉一致，且避免高轨道下的整条线位移。
- **替代方案**：继续按高度百分比并加 cap（否，cap 值难调且仍是高度相关）；把突起改回 ADR-0026 的纯高斯（否，窄线上会出折角）；取消突起只留高光（否，用户明确要突起反馈）。
- **后果**：所有窗口尺寸下突起尺寸一致；ADR-0027/0029 中 `bumpSigma` 的高度相关公式被本 ADR 取代（其余外观/交互不变）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**；真机 E2E `docs/screenshots/e2e-round11-rail-bump-fixed.png`（`HOVER_RAIL=2` 重新进入）与 `e2e-round11-rail-bump-fixed-crop.png`（4× 局部放大）；像素测量突起中心 y≈675 与指针物理位置 674.75 相差 <1px，位移峰值约 -18px（逻辑 14.4px），阈值法突兀范围约 46 物理像素。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：窄轨道上 18px 幅度显大 → 按 `width` 再缩放；高 DPI 下突起偏小 → 按 DPR 缩放 `bumpSigma`（需真机对比后定）；用户想要更长包络 → 只调 `bumpSigma`，不要恢复高度百分比。
- **复核时间**：打包阶段（4K/高 DPI、窄窗口、系统减少动画）

---

## 附：ADR 索引与状态总览

| 编号 | 主题 | 状态 |
|---|---|---|
| ADR-0001 | 产品定位：浏览器优先的 Agent | ✅ 已验证（不可逆） |
| ADR-0002 | 运行基座：Electron 架构 + 版本滚动 | ✅ 已验证（D0 通过） |
| ADR-0003 | 浏览器实现路线：BrowserAdapter + WebContentsView | ✅ 已验证（D0 实测） |
| ADR-0004 | 单栈边界：纯逻辑 + platform 适配层 | ✅ 已验证 |
| ADR-0005 | Python 退场：目标而非先验，逐项验证 | ✅ 政策已定 / 🟡 三项待验证 |
| ADR-0006 | 引擎迁移：五问验收门 | ✅ 已验证 |
| ADR-0007 | 记忆后端：负载测试裁决 | 🟢 最终裁决（默认 flat hybrid；sqlite-vec 可选；LanceDB 不纳入；Electron ABI 已消解） |
| ADR-0008 | MVP 范围：最小主链路 | ✅ 已验证 |
| ADR-0009 | 安全验收：攻击性测试 | ✅ 已验证 |
| ADR-0010 | Agent-Loop：最小完备 + 开放自定义 + 安全模式后备 | ✅ 已验证 / 已接线（L1/L2/L3 全部落地） |
| ADR-0011 | 扩展系统：万物皆插件（内核最小化） | ✅ 已验证 / **扩展=唯一插件系统（Plugin 已合并删除）**；UI 贡献点/市场后置 |
| ADR-0012 | 易用性策略：三档深度 + 反毛坯房清单 | ✅ 已验证 |
| ADR-0013 | 会话流按会话隔离 + 会话 UI 纯模块化 | ✅ 已验证 |
| ADR-0014 | 会话 = 浏览器文件夹（标签按会话隔离 + 本地恢复） | ✅ 已验证（云端待批准） |
| ADR-0015 | 工作区（挂载项目文件夹）+ 会话级 Git Worktree | ✅ 本地已实现（云端后置） |
| ADR-0016 | P0 安全门加固 + 持久多环境终端 + 工具参数单一转换 | ✅ 已验证（真机 E2E：6 终端档/C++ vcvars/广告拦截/书签/页面保存/快照/ask_user/顶部整理/全局历史） |
| ADR-0017 | 浏览器功能面：书签/广告拦截/页面保存/快照面板 | ✅ 已验证（真机 E2E 已跑） |
| ADR-0018 | 工具栏浮层独立窗口 / 管理整页 / 窗口自适应 / 全局历史 | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0019 | 柔和无框双主题 / 会话栏三态 / 全宽底部终端 | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0020 | 会话栏「小窗化」= 独立 Agent 窗口（真·窗口化） | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0021 | 定制窗口 chrome / 本地图标库 / 发送↔中断 / hover / 动效规范收敛 | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0022 | 顶部标签行 + chrome 闭环外壳（网页面板内缩/圆角） | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0023 | 会话栏星标折叠开关 / 地址栏随列伸缩 / 聊天滚动条单一化 | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0024 | 输入区独立色块 / 卷轴悬停卡片 / 数据目录绝对化 | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0025 | 输入框本体色块 / slime 式双股编织卷轴 | 🟡 输入框色块保留；编织外观已被 ADR-0026 回退 |
| ADR-0026 | 卷轴外观回退 + slime 式悬停突起 | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0027 | 卷轴突起平滑化 / 悬停卡片对比度 | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0028 | 卷轴外观重做为 slime wave 编织（Loopsoar 品牌配色） | 🟡 编织外观已按用户要求回退（ADR-0029） |
| ADR-0029 | 卷轴外观回退原版配色，只借鉴悬停突起（坐标即时定位） | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0030 | 卷轴突起宽度固定（修复大窗口下整条线被拉成大弯） | ✅ 已验证（自动化 + 真机 E2E） |
