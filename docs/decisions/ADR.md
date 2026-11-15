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

## ADR-0031 卷轴突起幅度调小（视觉轻重）

- **背景**：ADR-0030 将突起宽度固定后，用户仍反馈「现在太大了」——16px 轨道的峰值 16px 约等于一个轨道宽，鼓包会明显压到正文区域。
- **决策**：`packages/ui/src/TopicRail.tsx` 中 `bumpSigma` 20→**16**、`bumpReach` 改为 `Math.max(8, Math.min(12, width * 0.7))`（16px 轨道峰值 **11.2px**）；bulge+dip 形状与即时定位逻辑不变；高光段随 `±2.4×bumpSigma` 自动收短。
- **理由**：突起是「指针位置提示」而非装饰主角，峰值应小于一个轨道宽，只做轻微外鼓；形状不变以保证过渡仍圆润。
- **替代方案**：只降幅度不降宽度（否，包仍偏长且肩部更平）；改成悬停只亮不鼓（否，用户要的是突起）；按 DPR 缩放（否，逻辑像素下已合适）。
- **后果**：突起在 16px 轨道上峰值约 11px、可见范围约 ±40px，不再遮挡正文；与 ADR-0030 相比仅尺寸变化。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**；真机 E2E `docs/screenshots/e2e-round11-rail-bump-small.png`；像素测量峰值约 -14 物理像素（逻辑 11.2px），突起中心 y≈487 与指针一致；4× 放大目视确认「轻微鼓包、无折角」。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：觉得仍大 → 把 `bumpReach` 下限降到 6；觉得太小 → 上限提到 14；高 DPI 观感偏小 → 打包阶段按 DPR 复核。
- **复核时间**：打包阶段（4K/高 DPI、浅色主题）

---

## ADR-0032 卷轴凹陷防裁切 + 突起参数可调 + 删除拖拽提示

- **背景**：ADR-0031 收小幅度后，用户反馈三点：① 突起两翼的「凹陷」仍有一点点被窗口右缘裁切，看起来像伸出屏幕；② 突起与上下凹陷整体想更紧凑、更显眼（「调几个像素就够了」），并建议把整套参数开放到设置里；③ 右侧 `.topic-rail` 的 `title` 原生 tooltip（「拖动卷轴滚动 · 悬停查看位置」）没必要，要删掉。
- **根因**：线基线原本距窗口右缘约 11px（`right:3` + 16px 轨道中心），dip 向右回弹约 4px，再叠加悬停高光 `shadowBlur:12` 的光晕，而 canvas 右缘只留 8px → 凹陷末端/光晕在窗口边缘被裁切。
- **决策**：
  1. **防裁切**：`packages/ui/src/TopicRail.tsx` 线基线左移 4px（`cx = BUMP_PAD + width/2 - 4`）；轨道 `right` 3→4；悬停高光 `shadowBlur` 12→8、线宽 2.4→2.2。dip + 光晕整体留在窗口内，静态外观不变。
  2. **更紧凑/更显眼**：默认 `bumpSigma` 16→**13**、`bumpReach` 11.2→**13**；dip 收近（`DIP` 1.1→**0.75**、`DIP_T` 2.7→**2.2**），凹陷更贴突起。
  3. **参数可调**：`RailParams` 新增 `bumpReach`（4–24px）与 `bumpSigma`（8–32px），`Settings.tsx` 外观页新增两个滑杆，`i18nSettings.ts` 补中英文案；旧 v3 localStorage 数据由 `normalizeRailParams` 补默认值，不重置已有参数。
  4. **删除拖拽提示**：移除 `.topic-rail` 的 `title` 属性，原生 tooltip 不再出现。
- **理由**：防裁切必须同时调整基线位置与光晕范围，单独缩 dip 会在不同 DPR 下复发；突起参数交给用户可以在不重新发包的情况下微调；原生 title 与自定义悬停卡片语义重复。
- **替代方案**：只缩 dip（否，光晕仍裁切）；把轨道整体再往左挪 8px（否，视觉上离窗口右缘太远）；不开放参数只调默认值（否，用户明确建议开放，且不同 DPI/主题观感不同）。
- **后果**：卷轴基线比 ADR-0031 左移 4px；突起默认幅度 13px、宽度 13px（比上一版紧凑且略大）；设置页多两个滑杆；用户已有 v3 参数无需迁移。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1209 tests 全绿**；真机 E2E `docs/screenshots/e2e-round11-rail-compact.png`（紧凑突起、凹陷完整、卡片正常）、`...-compact-crop.png`（4× 放大）、`e2e-round11-rail-settings.png`（外观页新增两个突起滑杆）；像素测量基线 x≈1683（窗口宽 1702，右侧留 19px），dip/光晕均在窗口内。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：觉得突起仍大/小 → 设置页直接调「悬停突起幅度」；觉得凹陷仍多 → 调小「悬停突起宽度」；浅色主题光晕刺眼 → 按主题 token 调 alpha。
- **复核时间**：打包阶段（4K/高 DPI、light/classic 主题、系统减少动画）

---

## ADR-0033 卷轴悬停流动开关：默认不暂停、由用户选择

- **背景**：用户反馈「鼠标悬置在卷轴上，卷轴是否停止“流动”的开关设置，现在都是直接停止的，我希望交由用户自行选择。」`railParams.pause` 与设置页复选框其实早已存在，但默认 `true`，开箱即停，用户以为写死。
- **决策**：
  1. `packages/ui/src/railParams.ts` 的 `DEFAULT_CHAT_RAIL.pause` 由 `true` 改为 **`false`**：悬停时波浪继续流动；想让它停下来再自己勾选。
  2. `i18nSettings.ts` 标签改为「悬停时暂停流动」，新增 `pauseHint` 说明（默认关闭、突起/卡片不受影响）；`Settings.tsx` 复选框下方展示说明。
  3. 把冻结判断抽成纯函数 `shouldPauseWave(params, { reduced, hovering, dragging })`（位于 `railParams.ts`）：reduced / 拖拽中 / `spd<=0` 始终暂停；悬停是否暂停只看用户 `pause`；`TopicRail.tsx` 的 `frame()` 改用它。
  4. 新增单测 `tests/ui/railParams.spec.ts`：默认不暂停、开启后悬停才暂停、reduced/拖拽/速度 0 始终暂停。
- **理由**：默认行为应符合「不要直接停」的直觉；开关存在但默认强制停止等于没给选择；纯函数便于测试，也避免以后再把策略散落在渲染循环里。
- **替代方案**：保持默认 true 只改文案（否，用户仍会觉得「直接停止」）；把开关放到卷轴右键菜单（否，设置页已有统一入口，减少新的交互面）；悬停时降低流动速度而非停止（否，用户要的是明确开关）。
- **后果**：默认悬停不再冻结波浪（`pause=false`）；用户已有 v3 数据若明确勾选过则保持 true；设置页文案更清楚。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1212 tests 全绿**；新增 3 个 `shouldPauseWave` 用例；真机 E2E `docs/screenshots/e2e-round11-rail-pause-switch.png`（设置→外观：默认未勾选的「悬停时暂停流动」+ 说明）。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：默认流动导致性能/分心 → 把 `DEFAULT_CHAT_RAIL.pause` 改回 true；用户仍希望更省事的开关位置 → 打包阶段评估放到工具栏右键菜单。
- **复核时间**：打包阶段（低性能设备帧率、系统减少动画）

---

## ADR-0034 收紧网页/会话分区间隙 + 删除会话顶部滚动阴影

- **背景**：用户反馈「会话与网页两侧栏目看似只有一线之隔，实际上中间有相当大一段间距……改成符合直观逻辑直觉的，将会话栏宽度变大点。然后除去上方会话未滚动在最顶层时的阴影。」
- **根因**：
  1. 间隙由三层叠加：页框 `BROWSER_VIEW_INSET=8`（设计需要的圆角面板留白）+ splitter `6px` + 侧栏 wrapper `padding-left:8px`；同时 `AgentSidebar width={sidebarWidth-16}` 又按旧「左右各 8px」预留并右对齐，导致内容被压窄、空白被放大。
  2. 顶部阴影是 `MessageList` 的 `.scroll-fade-mask.is-top`（44px、`rgba(17,19,24,0.92)` 渐变），在会话未滚到最顶时一直压着一条暗色带。
- **决策**：
  1. `packages/contracts/src/layout.ts` 的 `SPLITTER_WIDTH` 6→**2**（契约是原生 `WebContentsView` 宽度的单一产地，DOM 同步）；`App.tsx` splitter 宽度改用 `LAYOUT.SPLITTER_WIDTH`；docked 侧栏 wrapper padding 归零（独立 Agent 窗口的 8px 保留），`AgentSidebar width` 改为 `Math.max(240, sidebarWidth)`，内容铺满整列。
  2. 删除顶部滚动阴影：移除 `MessageList.tsx` 的 `scroll-fade-mask is-top` 元素及 `atTop` state / `setAtTop` 调用；删除 `index.html` 的 `.scroll-fade-mask.is-top` 规则；底部渐隐保留。
  3. 同步 5 个布局测试文件的 splitter 期望（非收起态宽度 +4px）。
- **理由**：页框 8px 内缩本身已经提供了「网页卡片」的视觉边界，再叠 6px splitter 和 8px padding 就变成空白带；splitter 只需要一个可拖拽的 2px 热区。顶部渐变属于旧版「滚动提示」，与当前柔和外壳风格冲突，用户明确不喜欢。
- **替代方案**：把 BROWSER_VIEW_INSET 也调小（否，会破坏圆角门户的闭合外框设计）；保留 6px splitter 只删 padding（否，仍有 14px 空白，用户仍会觉得「不是一线之隔」）；保留顶部阴影只调低透明度（否，用户要删除）。
- **后果**：网页卡片右缘到会话内容 ≈10px（8 inset + 2 splitter），会话内容宽度增加 16–24px；顶部不再出现暗色渐变；拖拽热区变窄但仍有 2px + cursor 反馈。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1212 tests 全绿**；真机 E2E `docs/screenshots/e2e-round12-gap.png`，DOM 探针 `.browser-toolbar` 右缘 852.6 / `.agent-sidebar` 左缘 854.6 → gap=2px，`.scroll-fade-mask.is-top` 不存在。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：2px 热区在触控板上过难拖拽 → 加宽透明命中区（不动视觉宽度）；用户希望更宽的侧栏 → 调大 `sidebarWidth` 默认/记忆值，而不是加 padding。
- **复核时间**：打包阶段（高 DPI、窄窗口、触控板拖拽手感）

---

## ADR-0035 网页面板右侧留白再收紧 + 会话内容右侧收窄

- **背景**：ADR-0034 把间隙从 22px 收到 10px 后，用户仍觉得「还可以再压缩一点点」，并指出对话气泡与右侧卷轴挤在一起，要求把会话内容整体收窄几个像素，但明确「不包括卷轴那里以及对话以外的内容」。
- **决策**：
  1. 新增契约常量 `BROWSER_VIEW_INSET_RIGHT: 4`：右侧留白比其它三边（8px）窄，`computeBrowserViewBounds` 宽度扣 `inset + insetRight`，`StartPage` margin 同步 `8px 4px 8px 8px`。页框右缘到会话内容 = **4px + 2px splitter = 6px**。
  2. `MessageList` 的 messageList 右侧 padding 14→20px（仅对话列表内容收窄 6px）；卷轴绝对定位、头部与输入框不受影响。
- **理由**：右侧紧邻的是会话栏而不是窗口边缘，不需要与其它三边等宽的「门户留白」；对话内容与卷轴之间需要一点呼吸感，但卷轴位置本身不能动。
- **替代方案**：继续缩小 `BROWSER_VIEW_INSET` 全边（否，会破坏圆角门户的上下留白）；把卷轴左移（否，卷轴贴右缘是设计且用户未要求）；缩小会话栏整体宽度（否，用户说「几个像素就够」，收内容即可）。
- **后果**：视觉缝 10→6px；对话气泡右缘距卷轴 20px；原生视图宽度 +4px（与 DOM 页框一致）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm check` 逐字节一致、`pnpm build` 5/5、`vitest` **133 文件 / 1212 tests 全绿**；真机 E2E `docs/screenshots/e2e-round12-gap2.png`，探针 `paneGap=6px`、`padding-right:20px`、无顶部 mask。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：用户希望网页更宽 → 调小 `BROWSER_VIEW_INSET_RIGHT`；对话与卷轴仍挤 → 调大 messageList 右 padding；2px 热区难拖拽 → 加透明命中区。
- **复核时间**：打包阶段（高 DPI、窄窗口）

---

## ADR-0036 拖拽命中区对齐视觉交界 + 会话内容再收窄

- **背景**：用户反馈拖拽分隔条时，「能拖拽的位置在灰黑交界处右侧一点点」，与视觉直觉不符；同时对话内容仍与右侧卷轴略挤。
- **根因**：splitter 只有 2px，且位于页框右侧 4px 留白之外；视觉交界是网页深色面板的右缘（= 页框右缘 - 4px），命中区却从页框右缘才开始，二者差 4px。
- **决策**：
  1. splitter 视觉净占位仍为 2px，但盒子向外扩：`width: LAYOUT.SPLITTER_WIDTH + 4` + `marginLeft: -4`，命中区左缘正好落在页框右缘（视觉交界）、右缘到会话栏左缘，整段 6px 都能拖拽；负 margin 抵消额外宽度，flex 占用与原生视图几何不变。
  2. `MessageList` 右侧 padding 20→24px，对话内容再收窄 4px；卷轴（绝对定位）、头部、输入框保持原样。
- **理由**：拖拽热区应对齐用户看到的边界，而不是 DOM 盒子的边界；负 margin 扩展命中区不改变布局数值，也不需要额外的绝对定位层。
- **替代方案**：splitter 宽 6px 并让原生视图多让 6px（否，会话栏与网页间距回到 10px，刚被要求收紧）；绝对定位覆盖层（否，需额外 pointer 事件与层级管理）。
- **后果**：交接处 6px 内均可拖拽；布局数值、原生视图 bounds、测试期望均不变。
- **验证方式**：`pnpm typecheck` 5/5、`vitest` **133 文件 / 1212 tests 全绿**；真机 E2E `docs/screenshots/e2e-round12-seam.png`，探针 `hitOffset=0`、`hitWidth=6`、`elementFromPoint(页框右缘+1)` = `sidebar-splitter`、`padding-right:24px`。
- **状态**：✅ 已验证（自动化 + 真机 E2E）
- **回退条件**：负 margin 在某些缩放/方向下导致命中区错位 → 改为绝对定位覆盖层；热区盖住网页边缘点击 → 把负 margin 收窄到 -2。
- **复核时间**：打包阶段（高 DPI、窄窗口、触控板）

---

## ADR-0037 会话栏最小宽度 = 窗口宽度比例（当前比例即下限，单一夹紧产地）

- **背景**：用户（m00005）要求「把当前左右栏比例固定为右侧会话栏的最小窄度」——当前窗口 2048 CSS px、会话栏 720px（≈35.2%），用户认可这一比例，不希望被拖得比现在更窄（浏览器列被挤压）。
- **决策**：
  1. 契约 `packages/contracts/src/layout.ts` 新增常量：`SIDEBAR_MIN_WIDTH_RATIO: 0.35`、`SIDEBAR_MIN_WIDTH_FLOOR: 240`、`SIDEBAR_MAX_WIDTH: 720`、`BROWSER_COLUMN_MIN_WIDTH: 320`，并导出 `computeSidebarMinWidth(viewportWidth)` / `computeSidebarMaxWidth(viewportWidth)`：下限 = `min(720, max(240, round(w × 0.35)))`，上限 = `max(下限, min(720, w - 320))`。
  2. UI 三处夹紧共用同一对函数：拖拽分隔条（`startResize`）、窗口 resize、偏好水合/启动（clamp effect，依赖 `preferences?.sidebarWidth`）。
  3. 偏好 schema 的 240/720 数据合法性约束保持不动（它是「存量数据是否可信」而非「当前窗口比例」的语义），不写迁移。
- **理由**：按**比例**而非绝对像素设下限，窗口缩放时用户认可的比例关系保持不变（1280 宽时下限自动降到 448，而不是硬卡 720 把浏览器列挤没）；上下限兜底保证极窄窗口不出现负区间；单一产地避免拖拽/resize/水合三处各算各的导致「拖得动但重启后更窄」的不一致。
- **替代方案**：写死 720（否，小窗口下浏览器列不可用）；只改拖拽手感（否，resize/重启仍可绕过）；把比例逻辑塞进 preferences schema（否，schema 不感知窗口宽度，且会破坏存量数据兼容）。
- **后果**：2048 窗口下可调区间 **[717, 720]**（720/2048≈35.16%，取整差 3px，等效锁死当前宽度）；1280 → [448, 720]；1024 → [358, 704]；800 → [280, 480]；任何窗口 max ≥ min。既有 `preferences.sidebarWidth: 720` 合法，无需迁移。
- **验证方式**：新增 `tests/core/sidebar-width.spec.ts` 7 tests、`tests/core/layout.spec.ts` 14 tests、`tests/guards/ui-contract.spec.ts` 7 tests 全绿；`pnpm --filter loopsoar-contracts typecheck` 通过；真机 E2E（拖到最窄应停在 ≈717）待跑。
- **状态**：✅ 自动化 + 真机 E2E 已验证（1600 窗口拖拽 723→566、下限 560；2048 最大化侧栏 717）
- **回退条件**：用户想恢复「能拖得更窄」→ 调低 `SIDEBAR_MIN_WIDTH_RATIO`（或改为偏好项）；高 DPI/窗口缩放导致夹紧抖动 → clamp 内加取整阈值。
- **复核时间**：打包阶段（多窗口尺寸、高 DPI）

---

## ADR-0038 引导/插入（steer + 待发队列）移植：入队不打断 + 注入回执折进思考历程

- **背景**：用户（m00005）指出 Loopsoar 的「引导 / 插入」功能异常，要求对照 `D:\pilot project`（slime）移植，并明确指出 slime 里也有同类错误、部分错误代码只是被注释掉但依旧存在，只搬运**正确、有用、经检验精简后**的实现。Loopsoar 旧实现：运行中发送 = 乐观把用户气泡塞进对话 + 独立 `steerBus` 字符串队列，在轮次边界拼成 `【转向提示】` 用户消息；UI 用 `is-steer` 气泡 + 「转向」徽标；无待发卡、无回执、无自动续发、无撤销/修改，失败时消息已经写进记录且无法回收。
- **决策**：
  1. **core**：`SteerBus` 结构化（`SteerItem {id,text,kind?,fromName?,createdAt?}`、`STEER_MAX_PENDING=8`、`STEER_TEXT_MAX=2000`、同 id 覆盖保留位置、`take/list/drain/size`、`push` 返回 `ok|full|empty`）；`tool_loop` 在轮次边界 drain 后 emit 新循环事件 `steer {items}`，注入文案「用户在你运行期间插入了下面的请求（把它们当作本轮新增的指令一并考虑）」，注入消息标记为「运行中插入的指令」，删除旧的 progress note「已注入 N 条转向提示」。
  2. **契约**：`ChatSteerSchema` 增加可选 `steerId`；新增 `ChatSteerResultSchema {accepted,steerId,reason?}` 与 `ChatSteerCancelSchema`；新通道 `chat:steerCancel`；新事件 `chat:steer:applied`；全部经 `pnpm gen` 生成、`pnpm check` 逐字节校验。
  3. **services/shell**：`chatService.steer(sessionId,text,steerId?)` 返回结构化 `{accepted,steerId,reason:"no-running"|"full"|"empty"|"duplicate"}`，新增 `steerCancel`；shell 把 `steer` 循环事件转成 `chat:steer:applied {sessionId,items}` 推给渲染层（不走 `chat:stream:*`）。
  4. **UI**：运行中 Enter = 入「待发队列」并立即投递（绝不打断当前输出），待发卡分两态：待发 = 虚线左条 + 「待发」徽标 + 三图标（`edit` 修改取回 / `guide-arrow` 引导注入，A-1151 用户指定图标、替换被评"太简陋"的 arrow-narrow-right / `close` 撤销删除）；已注入 = 实线强调左条 + 「已注入」徽标 + 「已作为引导注入当前这轮 · 模型响应中」状态行（不再出现箭头）。收到 `chat:steer:applied` 才撤卡并把文案折进当轮 assistant 的「引导」时间线卡（`applySteerToLatest`，不乐观提前塞）；本轮结束仍未注入 → 改回 queued 并自动续发为下一轮（`handleStreamSettled`）；队列按会话隔离、上限 8；删除旧的 `is-steer` 用户气泡/「转向」徽标及对应 i18n。
  5. **core 引导续轮（slime A-1061⑥）**：模型只出正文、没有工具轮的收尾点**再 drain 一次**——若有引导：emit `steer` 事件、把本轮 assistant 正文与引导 user 消息回灌 conversation，并 `continue` **同一轮**继续跑。引导永远在模型当前这轮的思考历程里被消费，不会落到"本轮结束后按排队续发"而表现成一条新用户消息（"插队"观感正来自缺少这一步）。
  6. **收尾竞态修复**：`ChatService` 的循环 `done` 不再映射为渲染层 done（只认 finally 的权威 done），且 finally 先 flush 再发 done —— 否则渲染层先收到 done、后收到迟到 chunk 会新建一条"幽灵助手消息"；UI 的 `saveTimeline` 在会话 `append` 之前到达，shell 侧改为按会话暂存、append 完成后挂到新助手消息上（否则时间线会覆盖上一条消息、重启后引导卡丢失）。
- **理由**：乐观写正文会在投递失败时留下无法撤销的假记录（旧实现的核心病）；slime 的经验是「注入成功回执驱动 UI」——失败可重试/撤销/修改，成功才落痕。`steer` 以独立循环事件暴露（而不是复用 progress 文案），让主进程到渲染层有结构化时间线数据；待发卡沿用 slime 的三图标操作，按钮与图标一一对照（`gui/icon/icon_fpbc119q3rk`，其中 `arrow-narrow-right.svg` 已复制进 `packages/ui/public/icons`）。
- **替代方案**：直接在 UI 侧提前把引导塞进 timeline（否，失败无法撤回，与旧 bug 同类）；轮次边界用 progress note 传文本（否，无 id、无法回执/撤销）；全局单一队列（否，多会话并行会串消息）；复用 slime ChatPanel 整块代码（否，7954 行且含被注释的旧实现，按用户要求只取正确语义重写）。
- **后果**：运行中发送不再产生独立用户气泡（旧 `chat.steerBadge`/`chat.userSteer` 删除）；`chat:steer` 返回结构由 boolean 变对象（`chat.steer` 的 UI 调用方已同步）；轮次边界多一次 `chat:steer:applied` 事件；待发队列上限 8 条、单条 2000 字；跨会话切走再切回队列仍在；引导注入后**只出现在思考历程**（TimelineView 的「引导」卡），正文与用户记录都不落；重启后仍可见（时间线随会话持久化）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm gen`+`pnpm check` 逐字节一致、`pnpm test` **139 文件 / 1246 tests 全绿**（含新增 `tests/core/steerBus.spec.ts` 6、`tests/core/tool_loop_steer.spec.ts` 2（续轮：正文轮收尾注入 → 同轮第二次 LLM 调用收到引导、done 只发一次）、`tests/ui/steerQueue.spec.ts` 8、`tests/ui/steerAppliedTimeline.spec.ts` 5、`tests/shell/browserRestoreAttach.spec.ts` 4）；**真机 E2E（2026-11-08）**：运行中发引导 → 待发卡「已注入」→ 思考历程出现「引导」卡（无用户气泡、无 ABORT、未打断输出），流自然收尾；**重启 App 后引导卡仍在思考历程**（证据 `e2e-evidence/steer-final.png` / `steer-restored.png`；DOM 断言 steerCards:1、userBubbleHasSteerText:false、aborted:false）。
- **状态**：✅ 已验证（自动化 + 真机 E2E；用户确认保留「运行中回车即作为引导注入当前轮」语义，不改为 slime 的"仅排队"变体）

- **补充（2026-11-08，正文被截断/劈成两条气泡）**：用户反馈"思考结束后正文只有寥寥几字，退出重进才恢复"。根因两条叠加：①`ChatService` 的 finally 里 `emit("done")` 排在 `batcher.flushNow()` **之前**，收尾批次里的尾部 chunk 在 done 之后才到渲染层；②工具循环自己也 emit 过一次 `done`（渲染层收到两次 done）。于是 done 已把 `meta.activeId` 清空，随后的迟到 chunk 被旧 `upsertAssistant` 当成新流 → `nextId("a")` 新建一条助手气泡：前半正文缺尾、后半只有寥寥几字；重启后从会话库重读完整 `finalText` 才"恢复"。已修：done 只认 finally 一次、先 flush 再 done（上一轮 f8ad404）；并在 UI 增加硬防线 `applyLateChunk`（`chatStreamState.ts`）——activeId 为空时迟到增量一律并回**最后一条助手消息**、绝不新建气泡，streaming 消息按原 id 追加。回归：`tests/ui/chatStreamStateLateChunk.spec.ts` 5 tests；`pnpm test` **139 文件 / 1246 tests 全绿**；真机 E2E（`e2e-evidence/body-fixed.png`）：长回复收尾后仍是一条助手消息、正文完整（1522 字，末尾完整、无第二条小气泡）。

- **补充（2026-11-08，用户 m01591 纠正交互语义）**：用户明确要 slime 的三选项，不接受「回车即自动投递」：
  1. **什么都不做** → 本轮 Agent 输出结束后，自动把这条作为下一轮用户需求发出（`handleStreamSettled` 的排队续发）；
  2. **引导插入** → 点待发卡上的「引导」按钮，才把内容作为 steer 投递给主进程，在轮次边界并入当前这一轮的思考历程（绝不打断）；
  3. **修改 / 撤销删除** → 取回输入框重写，或直接丢弃（同时 `chat:steerCancel` 清主进程缓冲）。
  已改：`queueSteer` 只入队不投递；待发卡三按钮 + 「排队中 · 本轮结束后自动发出」状态行；`insertPendingSteer` 才调 `deliverSteer`。E2E：排队后不点按钮 → 本轮结束自动出现新用户消息且待发卡清空；点「引导」→ 思考历程出现「引导」卡、不生成用户气泡。
- **回退条件**：注入回执丢失导致卡片不撤 → `handleStreamSettled` 的 requeue 已兜底，仍异常则改为「发起新轮前清空 delivered」；待发卡遮挡小窗输入区 → 卡片折叠为单行 pill；自动续发抢跑（用户还没看结果）→ 关闭 `handleStreamSettled` 的自动续发，改为仅在用户点「直接插入」时续发。
- **复核时间**：打包阶段（多会话并发、压缩窗口内投递、子代理回流）

---

## ADR-0039 界面隔离与换界面收起：浮层随界面收起、会话草稿按会话隔离、去掉重复的「生成中…」脚注

- **背景**：用户（m01591）反馈：①切到设置等其它界面后，聊天界面的展开列表（模型选择浮层 / 会话列表）仍压在界面上（截图证据：设置页上残留「选择模型 · 跨供应商」浮层）；②切换会话时 UI 临时态应隔离，不能串台；③输入框下方的「生成中…」脚注重复且累赘，要求去掉。
- **决策**：
  1. **换界面收起**：进入任一非聊天界面（设置、浏览器管理整页、工作区面板、页面快照）时，自动收起聊天浮层（`modelMenuOpen`、`sessionOpen`）；切换浏览器标签时同样收起。浮层是聊天界面的临时态，不跟随到其它界面。
  2. **会话隔离**：新增输入草稿按会话存储（`draftRef`，切会话时保存本会话草稿、恢复目标会话草稿；新建会话清空输入并把旧草稿留档）；待发指令队列此前已按会话隔离；切会话/新建会话同时收起浮层。
  3. **去掉累赘脚注**：Composer 底部脚注在运行中不再显示「生成中…」（运行/中断状态已由上方 LiveStatus 与主按钮三态表达）；静止时仍显示 Build/Plan 说明，notice 优先。
- **理由**：浮层跨界面残留会遮挡并误导（用户实测截图）；聊天临时态（草稿/队列/浮层）属于"每个会话/每个界面"的局部状态，按界限隔离才符合直觉；同一条信息在状态条与脚注重复出现会让界面显得嘈杂。
- **替代方案**：全局模态遮罩把一切压住（否，过重且打断多任务）；把浮层状态持久化（否，恢复时弹旧菜单毫无意义）；只隐藏不收起（否，状态残留，回到聊天会自动弹开）；草稿全局共享（否，正是用户抱怨的串台来源）。
- **后果**：回到聊天界面时浮层不会自动重开；草稿随会话走、不再跨会话串；运行中仍可正常输入（主按钮提示"先排队，本轮结束后自动发出"）。
- **验证方式**：真机 E2E（2026-11-08）：①聊天里打开模型选择浮层 → 斜杠命令进入设置 → 浮层已消失（`modelMenuStillThere:false`）；②运行中排队不点按钮 → 本轮结束后自动出现新用户消息、待发卡清空；③点「引导」按钮 → 思考历程出现「引导」卡、无用户气泡；④运行中脚注不含「生成中…」。`pnpm typecheck` 5/5、`pnpm test` 全绿。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-08）
- **回退条件**：希望浮层跨界面保留 → 移除 isolation effect；不需要草稿隔离 → 去掉 `draftRef`（恢复全局 input）；希望脚注恢复 → Composer 脚注三态还原。
- **复核时间**：打包阶段（多会话并发、独立 Agent 窗口）


---

## ADR-0040 模型可见墙钟时间：每条消息带时间戳 + 当前时间放 volatile 段

- **背景**：用户（m01685）反馈 Agent 缺乏时间感知、会把旧消息当新消息处理，要求「为每条消息追加模型可见的墙钟时间（消息时间戳）」并建议参考业界做法。调研（[Claude Code 注入 Current date 的做法](https://github.com/router-for-me/CLIProxyAPI/commit/6d57ac9087623268e35086728d893487657127e8)、[multica add-time-awareness](https://github.com/multica-ai/multica/commit/5c26f92caa7acac968349faa1978a4d8b7f79826)、[时间感知缺失问题](https://github.com/NousResearch/hermes-agent/issues/60765)）结论一致：只给「当前日期」不够，模型需要每条消息的时间才能判断新旧与间隔；时间戳必须确定性生成，否则破坏 KV 前缀缓存。
- **决策**：
  1. 新增 core 纯函数模块 `packages/core/src/messageTime.ts`：`formatWallClock(ts)` → 本地 `YYYY-MM-DD HH:mm`；`withWallClockPrefix(content, ts)`（幂等、空值/非法时间原样返回）；`MESSAGE_TIME_INSTRUCTION`（**静态**格式说明）；`currentWallClockLine(now)`。
  2. 历史消息：shell `getHistory` 透传持久化的 `ts`，services 组请求时用 `withWallClockPrefix` 统一加前缀（同一历史每轮生成一致 → 前缀缓存稳定）。
  3. 当前用户消息同样带当前时间前缀；**当前时间**行放 volatile 段（每轮刷新、不进 stable），因此不污染 KV 缓存。
  4. system 稳定段追加 `MESSAGE_TIME_INSTRUCTION`：解释 `[YYYY-MM-DD HH:mm]` 语义，要求按时间判断新旧、旧消息的请求不得当新请求重复执行；该段字节级稳定（`assertStableUnchanged` 仍通过）。
  5. 时间格式统一为本地时区 24 小时制、分钟精度（不需要秒：秒级差异对 Agent 判断无意义且增加噪声）。
- **理由**：per-message 时间戳让模型能区分「几分钟前」与「昨天」；确定性前缀保证 KV 缓存命中；当前时间放 volatile 避免 stable 段每轮变化；格式说明与时间数据分离，稳定段保持字节不变。
- **替代方案**：只在 system prompt 写当前日期（否，无法判断单条消息新旧）；时间戳放 system 段（否，每轮变化破坏缓存）；把时间戳持久化进会话正文（否，污染用户可见文本与回滚/导出）；秒级/时区缩写（否，噪声大且易误读）。
- **后果**：模型每次请求多出每条历史消息 ~18 字符前缀（长历史下有少量 token 成本，但远小于时间判断错误的成本）；会话导出/界面显示不受影响（时间戳只在发往模型的副本上加）；旧会话没有 `ts` 的历史保持原样（不补造时间）。
- **验证方式**：`tests/core/messageTime.spec.ts` 7 tests（格式化补零/非法值/null、前缀幂等、静态说明不含具体时间、当前时间行）；`tests/services/chat-timeaware.spec.ts`（历史消息与当前消息都带前缀、system 含说明且不含具体时间、volatile 含当前时间）；`tests/core/session.spec.ts` 稳定段断言通过；`pnpm typecheck` 5/5。
- **状态**：✅ 自动化已验证（2026-11-08）
- **回退条件**：模型被时间戳干扰（例如把它当用户输入的一部分复述）→ 改为只在 system 段给「会话起始时间 + 最近消息时间」两条；token 成本敏感 → 缩短为 `MM-DD HH:mm`。
- **复核时间**：打包阶段（长会话、跨天会话、压缩后时间连续性）


---

## ADR-0041 中断立即生效 + 上游额度/鉴权错误快速失败

- **背景**：用户（m01685）反馈「中断按钮点击后不是立即中断，中断后 Agent 会话仍显示思考中」，并质疑 opencode-zen「思考非常慢，是上游连接问题还是没适配」。排查结论（同一根因的两个面）：
  1. `core/llm/openai.ts` / `anthropic.ts` 内部的 AbortController 只用于超时，**忽略调用方 `req.signal`** → `ChatService.stop()` 的 abort 到不了在途 fetch；工具执行（终端/MCP/ask_user 最长 600s）也没与 abort 竞速 → 点停止后循环根本不退，UI 一直「思考中」，最坏等首字节 120s / 总 300s。
  2. 直连诊断 opencode-zen：free 模型额度用尽时上游返回 HTTP 429 `FreeUsageLimitError`，响应头 `retry-after: 62231`（≈17 小时后重置）；旧客户端把 429 一律当可重试、把等待上限截到 60s 再重试 3 次 → **静默等待约 3 分钟**才报错。这就是用户感知的「zen 思考非常慢」：不是上游慢，是额度错误被当成临时限流反复重试。同账号另见 402 `Insufficient account funds`、403 `An OpenCode Go subscription is required`。
- **决策**：
  1. **信号透传**：openai/anthropic 客户端把 `req.signal` 接到在途 fetch（含退避等待可中止）；用户 abort → 抛 AbortError，不重试、不 yield error chunk。
  2. **abort 竞速**：core `tool_loop` 新增可等待 abortPromise，LLM 迭代用「手动 next() 与 abort 竞速」，工具 `invoke()` 也参与竞速；abort 立即返回 `status:"aborted"`（不再发 fatal error）；工具执行中被放弃（后台可能跑完但结果不再回灌/展示）。
  3. **语义归一**：services 在 aborted 时原因归一「用户已停止本轮生成」、空正文兜底「（已停止）」、跳过 claims 审计；UI `applyDone` 落 `done + interrupted` 并把 running 工具节点落定「已停止」，done(aborted) 即使来自其它入口也按「已停止」收尾。
  4. **上游错误分类**（新增 `core/llm/upstreamError.ts`）：解析错误体，`FreeUsageLimitError` / insufficient funds / subscription required / permission_error / invalid_api_key 等 → **不可重试**、立即给中文可行动提示；普通 429 仅当 `retry-after ≤ 15s` 才重试（≤2 次），`retry-after` 很大/缺失 → 立即报错并给「上游限流，约 X 后重试」（62231s → 约 17 小时）；5xx/529 保留退避重试。
- **理由**：abort 必须能打断在途 I/O 才有「立即」；把额度耗尽当限流重试是最贵的错误处理——用户白等 3 分钟还看不到真正原因；工具无法可靠取消（MCP/终端），但放弃等待并立刻收敛 UI 符合「立即中断」预期；错误分类让用户可以马上换供应商/订阅，而不是反复重试。
- **替代方案**：只改 UI 文案（否，治标不治本）；等工具返回再退出（否，600s 级延迟）；把 429 全部禁用重试（否，真正的短时限流应允许快速重试）；继续用 `win?.abort()` 之类隐式取消（否，无法穿透工具执行）。
- **后果**：中断后 UI 在 ~50ms 级收敛（实测 52-53ms）；工具被放弃时后台可能仍跑完（无副作用回灌）；额度错误改为立即失败，不再出现 3 分钟静默；旧构建仍会慢，需重新部署。
- **验证方式**：新增 `tests/core/toolLoopAbort.spec.ts`（3）、`tests/core/llmAbortSignal.spec.ts`（3）、`tests/core/upstreamErrors.spec.ts`（8，含 429 FreeUsageLimitError+retry-after 62231 → <500ms 报「额度」、402/403 立即失败、普通 429 retry-after 0.2 重试成功）、`tests/services/chat-stop.spec.ts`（2）、`tests/ui/abort-settle.spec.ts`（3）；全仓 `pnpm test` **146 文件 / 1278 tests 全绿**、`pnpm typecheck` 5/5。真机 E2E：点停止后 **52-53ms** 收尾、`.stream-gate` 0 个、无「正在思考」残留、横幅「本轮已中断：用户已停止」、主按钮恢复「发送（Enter）」。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-08）
- **回退条件**：放弃工具导致资源泄漏 → 改为「等待工具返回但 UI 立即收敛」；误杀正常长任务 → 把竞速范围收窄到 LLM 流；上游分类误判 → 只对明确 type 生效，其余回落原重试策略。
- **复核时间**：打包阶段（自定义 loop 是否响应 signal、MCP 工具取消语义）

---

## ADR-0042 启动速度优化：非关键启动任务后移 + 启动计时锚点 + UI 面板懒加载

- **背景**：用户（m01685）要求「优化整体架构，整理并精简整体代码，优化启动速度」。定位到首屏路径上的三类浪费：记忆库 `await memory.load()`（重建向量索引时会探测本地 embedding，最坏 3000ms）阻塞出窗；MCP 自动连接（spawn 子进程 + stdio 握手）、浏览器历史补记（同步 JSON 落盘）、扩展子进程启动都排在窗口创建之前；UI 单 JS 包 614KB（Settings/i18nSettings 等面板全部静态 import）。
- **决策**：
  1. **不阻塞出窗**：`memory.load()` 改为后台加载（读取路径未加载时按空库返回，装配不依赖 loaded），完成打点 `memory-load-done`。
  2. **首帧后 deferred 任务**：MCP 自动连接、browser-history 补记、扩展子进程启动移到 `ready-to-show` 之后，另有 3s 兜底（窗口加载失败时仍会执行）；`mcp.connect` 补 `.catch`。
  3. **启动计时锚点**：`boot.ts` 新增 `createBootTrace()`，默认关闭、`LOOPSOAR_BOOT_TRACE=1` 时打印 13 个阶段「Δ距上一阶段 / @距进程启动」（module-eval → window-created → ready-to-show/did-finish-load/deferred-boot），不引入新依赖、关闭时零开销。
  4. **UI 懒加载**：Settings / ChromePage / TerminalPanel / SnapshotPanel 改 `React.lazy` + `<Suspense fallback={null}>`，首帧只加载聊天主链路；`Onboarding` 因 `isOnboardingDone` 被入口引用暂不拆。
- **理由**：首屏只需要「窗口 + 聊天壳」；embedding 探测、子进程 spawn、同步落盘都是"几百毫秒~几秒"的可用性负债，后移不影响功能（MCP/扩展/历史面板稍后可用）；计时锚点让"哪一段慢"可观测，避免下次凭感觉优化；面板懒加载把首包拆成按需块，减少首帧解析/执行。
- **替代方案**：把窗口创建提到全部装配之前（否，IPC/域未装配完会造成首帧请求失败）；整包拆成多入口（否，自定义协议与打包链改动大）；不做懒加载只优化主进程（否，UI 614KB 解析同样占首帧）。
- **后果**：离线等价 harness（真 esbuild bundle + fake electron + 真实数据，warm n=6）：`protocol.handle → 窗口创建` **47.6ms → 28.3ms（-41%）**；进程入口 → 窗口创建 **89.4ms → 71.7ms（-20%，-17.7ms）**；记忆加载从「窗口前阻塞」变为「窗口后 +18~20ms 后台完成」。真机 dev trace（本机）：window-created @669.9ms、did-finish-load @899.1ms、ready-to-show @915.9ms、deferred-boot 随后启动。UI 主包 614KB → **527.13KB**（-14%），按需块：Settings 59.44KB / TerminalPanel 15.50KB / ChromePage 11.28KB / SnapshotPanel 3.19KB（gzip 后分别为 14.44/5.19/3.04/1.16KB）。
- **验证方式**：`pnpm typecheck` 5/5、`pnpm test` 146 文件/1278 tests 全绿、`pnpm vitest run tests/shell tests/guards` 630 tests 全绿；真机 E2E：懒加载后设置页可正常打开（隔离断言仍通过）、终端面板展开/贴底正常、`LOOPSOAR_BOOT_TRACE=1` 输出全链路。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-08）
- **回退条件**：懒加载导致首开面板白屏/慢 → 把对应面板改回静态 import；deferred 任务影响 MCP/扩展可用性 → 缩短 3s 兜底或改回首帧前；memory 未加载导致首轮记忆召回缺失不可接受 → 恢复 await（接受最坏 3s 延迟）并改为限制 embedding 探测超时。
- **复核时间**：打包阶段（冷启动、低配机、MCP 多 server 场景）


---

## ADR-0043 不做跨供应商静默降级：选哪个供应商就用哪个，用不了直接报上游错误

- **背景**：用户（m02010，截图证据）发现「设置/状态栏显示的是 opencode-zen · deepseek-v4.1-flash-free，但回复却自称 Agnes-3.0-flash」。根因：shell 装配层有一套「多供应商降级链」（`routerLlm.ts`）：活动供应商排最高优先级，其余按配置顺序作为后备；主供应商出现 429/超时/5xx 等可重试错误时，自动 `markCooldown` 并**无提示切换**到下一个供应商继续回答。opencode-zen 免费额度用尽（429 `FreeUsageLimitError`）时，请求被静默切到 agnes 并成功回答——UI 与模型 chip 仍显示活动供应商，于是「模型对应不上」。用户明确要求：「别这样。用不了正常返回上游报错就行了。」
- **决策**：
  1. shell 层删除聊天用「多供应商静默降级链」装配：`buildLlmFromActive` 只按当前活动供应商构建客户端，不再构造 `createFallbackLlmClient`；活动供应商不可用（无密钥/未配置）时返回 undefined，由 ChatService 输出可读错误。
  2. 供应商增删改/切换后仍即时生效（重建 `llmRef`），但不会再自动换到其它供应商。
  3. 上游错误照旧由 `core/llm/upstreamError.ts` 分类：额度/余额/订阅/鉴权错误立即失败并给中文可行动提示；网络/5xx 按各自策略快速报错。要换供应商由用户显式切换（设置/模型菜单）。
  4. 保留 `routerLlm.ts` 模块与其单测（其它角色/未来可选能力可复用），但**不再接入聊天主链路**。
- **理由**：静默换模型是「看起来能用、实际答非所问」的隐性错误，比直接报错更难排查；用户对模型身份/供应商有明确预期（截图里的 Agnes 自称就是证据）；显式失败 + 可行动提示让用户自己决定换供应商还是订阅/等待额度。
- **替代方案**：保留降级但 UI 显示「已自动切换至 X」并允许关闭（否，用户明确不要自动切换；且中途换模型会破坏上下文/工具兼容性）；只在非额度错误时降级（否，仍属静默改变模型身份）；把降级做成设置项（暂不做，等用户明确需要再引入）。
- **后果**：活动供应商故障时该轮直接失败，需用户手动切换；多供应商配置不再提供自动容灾；模型 chip 与实际调用永远一致；额度/鉴权错误会立即显示可行动中文提示（不再出现 3 分钟静默等待，ADR-0041）。
- **验证方式**：真机 E2E（确定性构造）：把活动供应商 baseUrl 指到关闭端口（`http://127.0.0.1:9/v1`，模拟上游不可达，旧实现会静默降级到 agnes 回答）→ 断言显示上游错误、**没有出现 Agnes 回答**、没有「收到」产出、按钮回到发送态；mock/单测：`pnpm vitest run tests/shell` 全绿。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-08）
- **回退条件**：若之后确需容灾，改为「显式配置的备用供应商 + UI 横幅提示 + 用户确认」，绝不静默切换。
- **复核时间**：打包阶段（多供应商真实故障场景、模型路由需求）


---

## ADR-0044 回复元信息下移 + 复制图标统一 + 模式提示归状态栏 + 思考时间线图标化

- **背景**：用户（m02010）指出四处界面问题：①助手消息头部的悬停元信息行（Build·模型·复制·「思考」按钮·重生成）挤在正文上方且窄栏下换行，要求移到**这条回复最下面**，并删掉多余的「思考」按钮（点「思考过程」标题已可展开）；②全应用「复制」按钮图标不一致（有的用通用 file 图标），要求统一为 `D:\tool\AI\real-project\Loopsoar\icon\icon_fpbc119q3rk\复制.svg`；③输入框下面还挂着一行「Build 模式：可在权限范围内执行工具」，要求移除并移到**窗口最底部**；④思考过程时间线太单薄——只有正文开头几个字当标题，要求像 dsh 一样「图标 + 动作类型 + 详情」（思考/工具调用/读取/规划/推进/引导各有区分）。
- **决策**：
  1. **元信息下移**：`ChatMessageView` 的助手 `.msg-hover` 移到回复内容最底部（正文/产物/错误/中断/状态之后），新增 `.msg-hover-bottom`；内容保留 Build 标签、模型名（nowrap+ellipsis）、`· HH:MM`、右侧复制/重新生成；**删除 `.msg-think-toggle`**（「思考过程」卡标题即展开入口）。用户消息的回滚/复制行保持原位。
  2. **复制图标统一**：复制 `复制.svg` → `public/icons/copy.svg`；ChatMessageView 用户/助手复制、AgentSidebar「复制整段会话」、Markdown 代码块复制全部改用 `<Icon name="copy">`；附件/文件类图标保持原样。`SOURCE.md` 映射同步。
  3. **模式提示归状态栏**：删除 Composer 的 `composerFoot` 与 notice 重复渲染（notice 继续走 Toast）；`StatusBar` 新增 `mode` 必传参数，最左渲染 `footer .status-mode[data-mode]`（图标 + `composer.buildFoot`/`planFoot` 文案）。
  4. **时间线图标化**：`timeline.ts` 新增纯函数 `toolVisual(name) → {icon,label}`（唯一映射产地）：terminal/bash→`terminal` 执行命令、file_read/write/edit→`file` 读写文件、browser/navigate/snapshot→`globe` 浏览网页、search→`search` 搜索、memory→`layers-linked` 记忆、mcp__/ext__→`puzzle` 外部工具、todo_write/plan→`list-details` 任务规划、默认→`bolt` 工具调用。TimelineView 每个节点统一「图标 + 类型标签 + 预览/详情 + 状态」：think（bulb+「思考」）、tool（动态图标+类型+工具名+详情+运行呼吸点）、plan（list-details+「任务规划」）、todo（play/check+「推进播报」）、steer（guide-arrow+「引导」）；节点加 `data-kind` 便于测试/样式；原有折叠分组逻辑保留。
- **理由**：元信息属于"回复的元数据"应放在回复之后（浏览器/聊天客户端惯例），也不再和正文抢首行；悬停区只保留对当前回复有意义的动作（复制/重生成），「思考」开关与卡标题重复；复制是高频动作，图标必须语义明确；模式提示属于全局状态，放窗口底部状态栏才不挤输入区；时间线要给用户"模型此刻在干什么"的结构化感知，纯文本预览无法区分工具/思考/规划。
- **替代方案**：保留头部元信息只做换行处理（否，用户明确要求下移）；复制图标继续用 file（否，语义混淆）；模式提示留在输入框下方但缩小字号（否，用户要求挪到最下面）；时间线只加颜色不分类（否，无法区分动作类型）。
- **后果**：回复底部多一行元信息（窄栏下单行省略）；「思考」按钮删除后展开入口只剩卡标题（点击区域更大）；状态栏多一个模式段；时间线每行多图标+类型标签（信息密度提升，长历史下高度略增，可折叠分组控制）。
- **验证方式**：`tests/ui/uiLayoutGuards.spec.ts`（4 例：hover 下移/思考按钮删除、copy 图标三处、composerFoot 移除+status-mode、时间线 data-kind/类名覆盖）、`tests/ui/timeline.spec.ts`（toolVisual 2 例）、`tests/ui/icons.spec.ts`（copy/layers-linked/list-details/guide-arrow 守卫）；`pnpm typecheck` 5/5、`pnpm test` **147 文件 / 1284 tests 全绿**；真机 E2E：`.msg-hover-bottom` 存在、`.msg-think-toggle` 0 个、hover 内含 copy.svg 图标、`.composerFoot` 不存在、`footer .status-mode` 文案「Build 模式：可在权限范围内执行工具」、时间线 `data-kind` 覆盖 think/body/tool/plan/todo/steer、tool 节点显示「外部工具/执行命令」类型标签（截图 e2e-evidence/ui-redesign.png、timeline-rich.png）。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-08）
- **回退条件**：底部元信息干扰阅读 → 恢复为仅 hover 显隐/或移动到消息右侧；时间线图标化影响性能（长历史）→ 折叠分组默认收起或虚拟列表；复制图标在某些系统 mask 不显示 → 保留 file 作为兜底。
- **复核时间**：打包阶段（长历史、窄侧栏、深浅主题）


## ADR-0045 长度截断自动续写：finish_reason=length 透传 + 同一轮续写

- **背景**：用户（m02115 ④）截图长回复结尾断在半句（「（老陈的铁盒」），要求修。排查发现 UI 渲染无重复/劈开（E2E 断言 bodyLen 1692 且以句号结尾、`scrollGap=0`、无 stream-gate），根因指向 OpenAI 兼容上游默认 `max_tokens` 截断：上游以 `finish_reason="length"` 结束，但适配器丢弃该字段、tool_loop 不知情直接收束，用户看到的就是「消息被截断」。旧行为既不可观测也无法自愈。
- **决策**：
  1. `LlmChunk` 的 `done` 增加 `finishReason?: string`；`openai.ts` 在流式（`choices[0].finish_reason`，含 `[DONE]` flush 与无 `[DONE]` 正常结束）与非流式兜底都携带；`anthropic.ts` 把 `stop_reason:"max_tokens"` 映射为 `"length"`，其余原样透传（单一映射函数 `anthropicFinishReason`）。
  2. `tool_loop.ts` 在正文轮收尾（`sawDone`、无工具调用、无待注入引导）时：若 `finishReason` 为 `length`/`max_tokens` 且续写次数 < `maxLengthContinuations`（默认 4）→ `emit("progress",{note:"输出达到上游长度上限，自动续写…"})`，回灌 `{role:"assistant",content:roundText}` + `{role:"user",content:"请紧接上文继续输出未完成的内容：不要重复已写内容，不要重新开头，不要总结。"}` 后 `continue`，**同一助手消息内**续写（不新开用户轮、不打断）。
  3. `ToolLoopOpts.maxLengthContinuations`（默认 4，0=关闭续写）；每轮结束重置 `roundFinishReason`；达到上限以现有正文正常收束（不报错、不静默丢内容）。
- **理由**：用户感知的是「话没说完」，模型自然结束与长度截断必须区分；同轮续写让长文写作无需手动「继续」，且不改变消息气泡数量；透传 finishReason 让该故障从不可见变为可观测（progress 文案 + 日志）。
- **替代方案**：按模型 spec 调大 `max_tokens`（否：大量上游无 maxOutput 声明、仍可能截断，且只是延后问题）；前端提示「可能被截断」（否，治标）；用户手动点「继续」（否，长文写作体验差）。
- **后果**：长回复可能触发额外上游调用（多耗 token，受 `maxLengthContinuations` 与预算四闸双重约束）；续写时 UI 出现一条 progress 提示；对不返回 finish_reason 的旧客户端零影响（`undefined` 不续写，行为与旧版一致）。
- **验证方式**：`tests/core/lengthContinuation.spec.ts` 4 例（length → 自动续写并拼接 finalText、done 只发一次；stop 不续写；无 finishReason 向后兼容；`maxLengthContinuations` 封顶不无限续写）；现有 openai/anthropic 适配器测试全绿；`pnpm typecheck` 5/5；真机 E2E：用本地假上游（`e2e-evidence/mock-llm-server.mjs`）确定性返回首轮 `finish_reason=length`、次轮 `stop`，界面同一助手消息拼接为「第一段被上游长度上限截断在这里自动续写完，正文完整结束。」（`hasPart1/hasPart2/contiguous` 全 true、`continuationSeen` true、无中断标签；日志 `[LOOP] length continuation` + `outcome rounds:2`）。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-08）
- **回退条件**：续写造成重复内容或 token 成本异常 → `maxLengthContinuations` 设 0（等价关闭，行为回到 ADR 前）；上游不兼容 → 保持旧行为。
- **复核时间**：打包阶段（长文写作、上游默认 max_tokens 差异）

## ADR-0046 图标几何居中 + 浮层阴影收敛 + 全局点外/切界面收起 + 全屏层不挡窗口按钮

- **背景**：用户（m02115）四项 UI 问题：①标签页关闭 × 等图标没在圆形按钮正中间，要求全面排查所有图标；②浏览器「更多」浮层外圈出现莫名大方框阴影；③进入设置等其它界面后，会话内展开的列表（如「本会话工具权限」）还浮在新界面上；要求改成全局规则：点击展开列表以外区域自动收起，且覆盖以后新增的列表；④全屏界面下多次点右上角退出键无反应——全屏覆盖层盖住了 TitleBar 的窗口按钮。
- **决策**：
  1. **图标居中**：新增纯 Node 几何测量（`scripts/icon-center-lib.mjs` 曲线采样算 alpha bbox，`scripts/icon-center-check.mjs` 扫描 47 个 `public/icons`），对 bbox 中心偏离 viewBox 中心 >2% 的 11 个图标（back/forward/play/settings/agent/edit/check/bolt/download/folders/guide-arrow）在 SVG 内用 `<g transform="translate(dx dy)">` 校正到居中；守卫 `tests/ui/iconCenter.spec.ts`（全量 |偏移|≤2.5% + 11 个修复图标必须保留 translate + 1024 viewBox）。**不做** Icon 组件按图标补偿（保持组件单一职责、避免每个用法都要传参）。
  2. **阴影收敛**：删除 `.chrome-pop-card` 的大投影（`0 18px 48px rgba(0,0,0,.55)` → `none`；独立透明浮层窗口 shell 侧 `hasShadow:false`，内层投影会溢出成方框）；窗口内 Portal 菜单（AnchoredPopover）投影收轻为 `0 10px 26px rgba(0,0,0,.42)`；settings/snapshot/onboarding/ask/Toast/terminal/TopicRail 等保留原有轻微层叠阴影（清单见实现报告），不做一刀切。
  3. **全局收起（单一入口）**：`packages/ui/src/popover.ts` 新增 `dismissAllPopovers()`、`getOpenPopoverId()`、`subscribePopovers()`；`usePopover` 收到广播自动关闭；App 在「进入设置/整页/工作区/快照/向导、切会话、新建会话、切浏览器标签、窗口失焦、`otherInterfaceOpen` effect」统一调用；会话历史下拉迁移到 AgentSidebar 内 `usePopover("app-session")`，删除 App 自维护状态。**不做 preventDefault/stopPropagation**（否则吞掉触发界面切换的第一次点击）。模块头注释 + `tests/ui/popoverDismiss.spec.ts` 静态守卫约定：所有展开列表必须走 usePopover 或响应 dismissAllPopovers。
  4. **全屏层让位窗口按钮**：Settings/ChromePage/WorkspacePanel/SnapshotPanel/Onboarding/PermissionDialog/AskUserDialog 统一从标题栏下方开始（`top = LAYOUT.TITLE_BAR_HEIGHT`，即 40px；CSS 覆盖层用 `inset: 40px 0 0 0`），并加 `data-fullpage-overlay="settings|chrome-page|workspace|snapshot|onboarding|permission|ask"` 标记；TitleBar 关闭按钮先 `dismissAllPopovers()` 再 `api.window.close()`（agent 窗走 `closeAgentWindow`，preload 缺失时 `window.close()` 兜底）。守卫 `tests/ui/fullPageOverlay.spec.ts`。
- **理由**：用户明确要「全局规则」而非逐处打补丁——浮层收起必须只有一个登记/广播产地，未来新增列表只要用 `usePopover` 就自动覆盖；窗口按钮是窗口自身 chrome，任何内容界面都不得遮挡；图标居中问题若在组件层做偏移补偿会散布魔法数字，改 SVG 一次生效且可脚本复核。
- **替代方案**：每个浮层各自加 document 监听（否：漏掉未来新增与界面切换时机）；提高 TitleBar z-index（否：覆盖层仍会吃掉点击，且层级打架）；用 Electron `capturePage` 测图标 bbox（否：本机 Chromium 沙箱/离屏渲染会崩，且不必要）；把全部阴影一刀切删掉（否：合理层叠感会丢失）。
- **后果**：全屏模态顶部留出 40px 标题栏（窗口按钮始终可点）；会话下拉改为 AgentSidebar 内部登记（App 少一个 usePopover）；新增列表必须走统一入口（守卫测试会拦）；11 个 SVG 文件内多了 `<g transform>` 包裹层。
- **验证方式**：`tests/ui/iconCenter.spec.ts`（3）、`tests/ui/popoverDismiss.spec.ts`（5）、`tests/ui/fullPageOverlay.spec.ts`（5）、`pnpm vitest run tests/ui` 22 文件/144 tests 全绿；`pnpm typecheck` 5/5；全量 `pnpm test` 151 文件/1301 tests 全绿；真机 E2E（1600×1000）：会话下拉可打开、`window blur` 后 `.anchored-popover` 计数归 0；从 Composer 权限菜单进入设置后 popover 自动收起、`[data-fullpage-overlay="settings"]` 的 computed top=40px、`document.elementFromPoint` 命中 `.win-btn`、Esc 关闭设置正常；长回复渲染完整（截图 `e2e-evidence/turn8b.png`）。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-08）
- **回退条件**：40px 顶部留白破坏整页视觉 → 改为抬高 TitleBar z-index（保留 data 标记）；全局收起误关用户正在操作的浮层 → dismissAllPopovers 只作用于「界面切换/失焦」时机（不回退 pointerdown 逻辑）；图标 transform 导致某些渲染器偏移 → 撤回对应 SVG（守卫阈值可调 2.5%→3%）。
- **复核时间**：打包阶段（窄窗口、浅色主题、浮层贴边、图标在 4K/125% 缩放下）

## ADR-0047 截断根除（全链路不变量）：任何路径都不允许静默丢正文

- **背景**：用户（m02515）要求「从方方面面彻底根除截断，不论长短回复」，并指出首个试做项目 slime 因早期没发现该问题而长期受困。前一版只修了「上游 max_tokens 截断自动续写」一个点；本轮按链路逐层审计出 9 类截断/丢文风险并全部修复。
- **决策（全链路不变量）**：任何一条助手消息在任意正常/异常路径下必须满足 —— ①流式拼接文本(过滤后) == done.finalText == 持久化文本；②早退（中止/错误/上限/超时/退出）必须保留已产出正文；③不得静默截断：截断必须带显式标记或可见提示。逐层：
  1. **LLM 适配层**（core/llm）：SSE 解析补「无 [DONE] / 末帧无尾换行 / CRLF 事件分隔（\r\n\r\n）」的残留 flush（旧实现会丢掉最后一帧）；超时语义改为「首包超时 + 空闲超时（每收到数据重置）+ 硬总超时默认关闭」，避免 300s 总超时掐断正常长输出；finish_reason/stop_reason 全路径透传（max_tokens→length）。
  2. **工具循环**（core/tool_loop）：长度截断自动同轮续写（默认 8 次，受轮次预算约束）；工具调用参数被长度截断 → 丢弃本轮残缺工具轮并要求重发；续写用尽仍在截断 → 正文末尾追加显式标记「（输出因上游长度上限中断…）」+ progress；**不向上游传显式 max_tokens**（各供应商输出上限差异巨大，传大可能被 400、传小反而制造截断）——长度上限统一交给 finish_reason 续写兜底。
  3. **服务层**（services/chat）：流式过滤器的跨 chunk 尾部在 finally flush 后、done 之前补发；done 携带权威 `finalText`；中止/异常时 finalText 保留已产出正文。
  4. **UI 对账**（packages/ui）：done 用服务端 `finalText` 覆盖本地累积正文（chunk 丢失/乱序也不截断）；迟到 chunk 若已是正文尾部则不重复追加；渲染层无任何正文 clamp/ellipsis（正文以 `m.text` 为权威，timeline body 仅展示）。
  5. **持久化**（shell）：SessionStore 原子写（tmp+rename，避免半截 JSON 让整段历史「消失」）；新增 `appendAssistantPartial` + 退出时 `flushActivePartials`（生成中被关闭也把已流出正文落盘并标注「应用退出时尚未完成」）；异常中断也保存部分回复。
  6. **上下文压缩**（core/contextCompress）：最近消息永远原文保留（只压缩更早消息）；未探测窗口的默认预算 120K→60K 字符、按 contextWindow×1.2 计算且去掉危险的 32K 下限（小窗口模型不再被撑爆）；穷尽收紧仍超预算 → `stillOverBudget` 提示，避免上游静默截断提示词。
- **理由**：截断不是单点 bug 而是「任何一层丢一小段」的链式风险；只有用「文本一致性 + 早退保留 + 可见标记」三条不变量贯穿全部层，才能保证新增功能不会重新引入截断。
- **替代方案**：只在上游层调大 max_tokens（否：上游各异、仍会截断）；只在前端做兜底（否：持久化/异常退出仍丢）；把超时调到很大（否：卡死无法恢复）。
- **后果**：长文可能多次上游续写（token 成本受预算闸与续写上限控制）；/compact 保留最近 14 条语义不变、但预算口径更保守（更早触发压缩）；截断标记会出现在正文末尾（这是刻意的可观测性）。
- **验证方式**：新增/更新 7 组专项测试（`tests/core/streamResidual`、`toolLoopTruncation`、`contextBudget`、`lengthContinuation`、`tests/ui/doneReconcile`、`tests/shell/sessionPartial`、`shutdownFlush`、`tests/services/chat-truncation`）；`pnpm typecheck` 5/5、`pnpm test` **159 文件 / 1348 tests 全绿**；真机 E2E：
  - 真实上游（agnes）：短回复「收到」完整；`~5000字` 长文请求中上游在第 1 轮 5287 字处以 `finish_reason=length` 截断 → 自动续写第 2 轮 2699 字 `stop` → 最终正文 **7986 字**，结尾「潮声没有停。」完整收束（持久化文本与 UI 展示一致；截图 `e2e-evidence/trunc-real-long.png`）。
  - 本地假上游确定性场景：①length 续写 + 第二轮「无 [DONE]、末帧无尾换行」→ 拼接为连续全文；②生成中关闭应用 → 已流出正文+退出标记落盘；③持久化文本与 UI 展示逐字一致。
  - 流式过程中的「正文后置闸门」是既有 UI 设计（流式时阶段占位在正文区、文本走思考历程，done 后正文开闸），E2E 探针曾误判为「不渲染」，非截断缺陷。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-09）
- **回退条件**：空闲超时对超慢上游误杀 → 调大 idleTimeoutMs；续写导致重复内容 → maxLengthContinuations=0（等价关闭续写）；原子写在某些网络盘不可用 → writeJson 已带直接写兜底。
- **复核时间**：打包阶段（长文写作、慢速上游、断网/强杀、超大历史、小上下文模型）

## ADR-0048 供应商模型能力信息补全（上下文/输出/视觉/模态/工具/结构化输出）

- **背景**：用户（2026-11-09）要求「全面完善供应商那端的信息（上下文、输出、是否支持图片等等）」，参考 slime 的供应商能力数据；并明确 slime 的 NVIDIA NIM 数据略旧，NIM 以用户提供的《NVIDIA_NIM_模型池参数大全》（2026-10-07，build.nvidia.com 官方模型卡）为准。现状：Loopsoar 的模型元数据只来自上游 `/models` 返回项；多数官方 API（DeepSeek/OpenAI/Anthropic/NIM 等）只返回模型清单、不返回 context/vision 等，导致设置面板这些列长期为空，用户无法判断模型能力。
- **决策**：
  1. **内置能力表（离线兜底）**：新增 `packages/core/src/modelCapabilities.data.ts`（AUTO-GENERATED，`scripts/gen-model-capabilities.mjs` 生成）：
     - slime `shared/gen/model-capabilities.ts` 的 33 个供应商 / 148 条模型能力正则（thinking/efforts/context/maxOut/endpoint/thinkingParam，**不搬定价**）；
     - NVIDIA NIM 官方模型池 23 个对话/多模态模型（context、官方示例 maxOutput、inputModalities、functionCalling、structuredOutput、reasoning，来源为用户提供的 2026-10-07 文档；其中 maxOutput 是官方示例 `max_tokens`，注释里标注「实际可能更高」）。
  2. **推断与合并**（`packages/core/src/modelCapabilities.ts`）：`inferModelCapabilities(id, {provider, baseUrl})` —— NIM 端点先查官方目录（含 `vendor/` 前缀归一），其余按 slime 表首个命中；非对话模型（embedding/rerank/图像/音频/视频）不推断思考/工具能力；未知模型保持未知（**绝不编造**）。`enrichModelSpec(raw, opts)` = 上游 `/models` 元数据优先 + 内置表补缺，是唯一合并入口。
  3. **落盘与读取都补全**（`ProviderStore`）：保存供应商时自动补全模型缺失字段（显式值不覆盖）；读取旧 `providers.json`（只有 id/model）时也在内存补全并生成默认模型行；默认模型即可看到上下文/输出/视觉等，用户不需要手动填。`settings:listModels` 探测结果同样走 `enrichModelSpec`（上游优先）。
  4. **契约与 UI**：`ProviderModelSchema` / `ProviderModel` 新增 `inputModalities`（text/image/audio/video）、`functionCalling`、`structuredOutput`；设置面板新增列并支持编辑；模型选择弹层补充上下文与图片能力提示。
- **理由**：能力元数据是「用户能不能把模型用对」的前提（上下文预算、图片附件、工具/结构化输出选择都依赖它）；上游普遍不提供，必须内置兜底。NIM 数据用用户提供的一手文档更新，避免沿用 slime 的旧值。**上游优先**保证接入 OpenRouter/new-api 这类带元数据的网关时不被本地表覆盖；**未知不编造**避免把错误能力当成事实。
- **替代方案**：只靠上游 `/models`（否：多数官方 API 无元数据）；手写一份 Loopsoar 自己的小表（否：覆盖不足、会漂移）；直接复制 slime 含定价的全表（否：Loopsoar 无定价模型，且会引入维护负担与旧 NIM 数据）。
- **后果**：`providers.json` 里模型条目会多出能力字段（体积小幅增加）；显式手填/上游值不受影响；上下文窗口自动补全后，历史压缩预算与上下文占用环在更多模型上生效；NIM maxOutput 是示例值，遇到上游 400 时仍按「不传显式 max_tokens」策略处理（ADR-0047）。
- **验证方式**：`tests/core/modelCapabilities.spec.ts`（15 例：NIM 官方规格、命名空间 id、非 NIM 家族兜底、未知不编造、非对话模型、上游字段解析、上游优先合并、数据表守卫 33/148/23）；`tests/shell/providerCapabilities.spec.ts`（5 例：保存自动补全、NIM 数据、显式值不覆盖、旧配置读取补全、落盘持久化）；`tests/ui/providerCapabilities.spec.ts`（13 例）；`pnpm typecheck` 5/5；全量 `pnpm test` 162 文件 / 1383 tests；真机 E2E（2026-11-09，数据副本 + 追加 nvidia-nim 供应商）：设置·模型服务卡片显示「上下文 512K · 输出 66K · 视觉 · 推理」等规格行；编辑 nvidia 供应商后 kimi-k3 行显示 上下文 1049K / 输出 16K / 视觉 ✓ / 模态 text,image / 函数调用 true / 结构化输出 true；编辑 agnes 后 agnes-3.0-flash 行上下文 512K、输出 66K、推理 ✓；模型选择弹层显示上下文提示（512K/1M）与「图」徽标。证据：`e2e-evidence/provider-capabilities.log`（E2E_EVAL ok:true）、`e2e-evidence/provider-capabilities.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-09）
- **回退条件**：内置表某条正则误匹配导致错误能力显示 → 删除/收紧该条（数据与逻辑分离，改生成器即可）；能力字段让 providers.json 过大 → 保存时只写非默认值（后续优化）。
- **复核时间**：打包阶段（各供应商模型上新、NIM 模型池更新、网关返回元数据的兼容性）

---

## ADR-0049 设置面板「获取模型列表与能力」：拉列表同时拉上游能力数据（三态合并 + 结果反馈）

- **背景**：用户（2026-11-09）追问「在供应商界面点『获取模型列表』时，能不能同时把上游的模型能力数据（上下文/输出/是否支持图片等）一起拉下来」。旧实现 `settings:listModels` 已对每行做 `enrichModelSpec`（上游优先 + 内置表补缺），但设置面板的前端合并是 `{ ...刚拉到的上游行, ...本地缓存 }`——本地缓存（可能含旧的自动推断值）会盖掉刚拉到的上游值，导致「再次获取列表也看不到上游更新」；且拉取成功/失败没有结果反馈，用户无法判断上游到底有没有给能力数据。
- **决策**：
  1. **来源诊断随列表返回**：`packages/core/src/modelCapabilities.ts` 新增 `CAPABILITY_KEYS` 与 `describeCapabilitySources(raw, options)`（→ `{ upstreamFields, inferredCaps }`）；`settings:listModels` 响应在原 `{ models, error }` 基础上增加 `capabilityMeta: Record<modelId, { upstreamFields, inferredCaps }>`，让渲染层能区分「上游给了什么」「哪些只是内置表推断」。
  2. **前端三态合并**：`packages/ui/src/modelGroups.ts` 新增纯函数 `mergeFetchedProviderModels(fetched, existing, capabilityMeta, defaultModelId)`，优先级 = **用户显式手填 > 上游实时元数据 > 内置表推断**。「显式手填」判定：本地已有值且与内置推断值不同（推断值由后端回传），因此重复点「获取」能刷新旧的自动填充、但不会覆盖用户手填；勾选状态沿用本地，新模型默认只启用当前默认模型；按模型 id 去重。
  3. **结果反馈**：按钮改为「获取模型列表与能力」，成功后绿色汇总「已获取 N 个模型：X 个带上游能力数据，Y 个已按内置能力表补全」；失败路径仍显示红色错误并保留缓存列表。
- **理由**：多数官方 API 的 `/models` 只返回模型 id，能力数据必须靠内置表兜底；但没有来源标记就无法在「刷新上游」与「保护用户手填」之间做正确取舍。把判定放到前端、把来源诊断随响应回传，改动小、旧配置无需迁移，且不把诊断字段写进 `providers.json`。
- **替代方案**：每次直接覆盖本地值（会丢用户手填）；在 `providers.json` 里持久化逐字段 provenance（改动大、旧配置无标记、文件膨胀）；不做汇总（用户无法判断「没数据」还是「没拉到」）。
- **后果**：上游提供富元数据的网关（OpenRouter/new-api 等）重复点「获取」即可刷新上下文/模态/工具等；用户手填值受保护；非对话/未知模型保持「自动/未知」不编造；刷新结果只存在编辑表单内存，点保存才写回 `providers.json`。
- **验证方式**：`tests/core/modelCapabilities.spec.ts` 新增 3 例（上游字段标记、仅 id 行的内置推断、未知模型不编造）；`tests/ui/providerCapabilities.spec.ts` 新增 5 例（旧推断值被上游刷新、手填值不被覆盖、无上游数据时保留内置值、勾选/新模型默认选中、去重与 upstream 计数）；全量 `pnpm typecheck` 5/5 + `pnpm test` 162 文件 / 1391 tests；真机 E2E（agnes，数据副本）：点「获取模型列表与能力」→ 9 个模型、汇总「0 个带上游能力数据，5 个已按内置能力表补全」，表格上下文 512K / 输出 66K / 推理列自动填充。证据 `e2e-evidence/fetch-models.log`（E2E_EVAL ok:true）、`fetch-models.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-09）
- **回退条件**：上游元数据字段命名不兼容 → 扩展 `parseUpstreamCapabilities` 即可（不影响本决策）；若「显式手填」启发式误判，可改为显式 provenance 字段（后续优化）。
- **复核时间**：新供应商接入、上游 `/models` 返回结构变更、用户反馈手填值被刷新时

---

## ADR-0050 供应商编辑改为大弹窗：打开不再跳页、反馈固定在右上角、文本不挤压

- **背景**：用户（2026-11-09 m03529）反馈供应商编辑界面难用：①无论编辑哪个供应商，一点「编辑」整页就滚到最下面（旧实现把编辑表单以内联 panel-card 追加在供应商列表末尾）；②保存成功提示渲染在设置内容区最底部，用户要滚动去找；③编辑区文字挤压/截断（窄列、长提示与输入框抢宽度）。
- **决策**：
  1. **编辑界面改独立大弹窗**：`Settings.tsx` 的供应商编辑从列表末尾的内联卡片改为 `createPortal(…, document.body)` 的模态弹窗（`role="dialog"` + `aria-modal`，宽 `min(1160px, 96vw)`、高 `min(880px, 92vh)`）；遮罩从标题栏下方（`LAYOUT.TITLE_BAR_HEIGHT`）开始，窗口按钮仍可点；头部固定（标题 + 供应商名/地址 + 关闭）、中部滚动、底部固定操作栏；打开时 `editBodyRef.scrollTo({top:0})`；点遮罩/Esc/取消关闭。必须走 Portal——设置内容区（`.settings-section`）带 `transform` 动画，内联 `position:fixed` 会被当成页面内元素随滚动位移（首版实测弹窗顶部被内容区裁掉）。
  2. **供应商操作反馈固定右上角浮层 toast**：新增 `providerToast`（`providerOk/providerBad`），保存、保存密钥、清除密钥、拉取模型列表等操作都走它；成功 3.2s 自动消失，错误常驻到下次操作；弹窗底部状态栏同时显示测试连接/拉取错误/提示文案。
  3. **不挤压、不截断**：弹窗加宽到 1160px；模型表格 `minWidth: 1080` + 容器横向滚动（列不再被压扁）；长提示 `overflowWrap:anywhere`、字段标签列 `maxWidth:400`、弹窗副标题 `wordBreak:break-all`。
- **理由**：弹窗把「编辑」与「列表滚动位置」解耦，也天然给表单 1160px 宽度；浮动反馈在视线附近，不用再去页面底部找；表格允许横向滚动比压列更可读。
- **替代方案**：把编辑表单移到列表顶部（仍受页面滚动与列表长度影响）；单独开新窗口（重、跨窗口状态与 IPC 复杂）；缩小表格列（已证明会截断）。
- **后果**：编辑时背景列表不可操作（模态语义正确）；小屏（<1200px）弹窗仍按 96vw 自适应并内部滚动；供应商列表本身的滚动位置保持不变，关闭弹窗即回到原位置。
- **验证方式**：`tests/ui/settingsProviderModal.spec.ts`（4 例：弹窗容器/Portal/滚动复位、右上角 toast、宽度与换行样式、i18n 文案）；`pnpm typecheck` 5/5；全量 `pnpm test` 163 文件 / 1395 tests；真机 E2E（数据副本）：打开编辑弹窗 `dialogTopCss=139` 居中、`headerVisible=true`、`pageScrollUnchanged=true`（列表不再跳）、`modalBodyAtTop=true`、`clippedCount=0`（无截断）、保存后 `toastNearTopRight=true` 且弹窗关闭。证据 `e2e-evidence/provider-modal.log`（E2E_EVAL ok:true）、`provider-modal.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-09）
- **回退条件**：弹窗在小屏挤压 → 调 `width/maxHeight` 或改为分步向导；Portal 与全屏设置页冲突 → 改为在设置根节点渲染（不改变交互约定）。
- **复核时间**：设置面板新增供应商字段/模型能力列、窗口最小尺寸变化时

---

## ADR-0051 OpenCode Go / Zen 双计划端点、默认模型与错误提示修复（底部错误提示去重）

- **背景**：用户（2026-11-09 14:18）反馈「opencode go/zen 都用不了了，无论是免费的还是订阅的，你给我修一下」，并附截图：opencode-go（模型 beam-free）连续两次 HTTP 403——「An active OpenCode Go subscription is required to use Go models.」与「This model is not available in your country」；同时要求删掉底部重复的错误提示（「会话内都有说明了，而且这个提示也挡信息了」）。上一轮会话做到一半（改了 providerStore/upstreamError/Settings/useChatStreamEvents 五个文件）被上游 502 中断，没有测试、没有验证，且把 Go 端点误迁移到了按量付费端点。
- **排查结论（以官方文档 + 真实上游实测为准）**：
  1. **两套计划、两套端点、两套 Key（官方文档 /docs/console/harnesses#base-urls）**：按量付费（Zen）base = https://opencode.ai/inference ，Go 订阅 base = https://opencode.ai/inference/go ，聊天路径均为 /openai/v1/chat/completions。**Go 的 Key 打按量付费端点会 403 Model access is disabled，按量付费 Key 打 Go 端点会 403 subscription required，不可互换**（2026-11-09 实测，见证据日志）。
  2. **Go 端点必须带 x-opencode-session**（缺失 → 400 MissingSessionID，实测），Loopsoar 内置默认头原本已带；Go 模型（如 beam-free、gpt-6-luna）仍受地区限制（RegionError 403），免费模型另有免费额度（429 FreeUsageLimitError）。
  3. **「订阅的也用不了」的真实原因在账号侧**：Loopsoar 里保存的 Key（oc_…7lyv）所在工作区没有有效 Go 订阅（403 实测）；本机 DSH 配置里的 OPENCODE_GO_API_KEY（oc_…DO2x）实测可正常调用 Go 端点。本次已把该可用 Key 同步进 Loopsoar 加密密钥库（只写 AES 密文，不落明文/不进日志），同步后 Loopsoar「测试连接」返回 200。
  4. **默认模型停在免费模型上**：beam-free 是 Go 免费模型但有地区限制（中国 403 RegionError），不应作为第三方客户端默认模型。
  5. **模型目录端点拼错**：OpenCode 的模型目录在推理根下（Go /inference/go/v1/models、按量付费 /inference/v1/models），旧实现拼成 /inference/go/openai/v1/models 会 404，导致设置面板「获取模型列表与能力」对 OpenCode 不可用；且该目录返回 limit/modalities/capabilities 富元数据，旧解析器完全不认识。
  6. **底部提示重复**：done 事件把「已中断（error）：上游拒绝访问…」原文再弹到底部 notice（叠在会话红字报错之上、挡住输入区上方内容），error 事件另弹「回复失败」，都属于会话内已有说明的重复信息。
- **决策**：
  1. **端点按计划区分，撤销上一轮的错误迁移**（packages/shell/src/main/providerStore.ts）：新增 OPENCODE_GO_BASE / OPENCODE_INFERENCE_BASE 与 isOpenCodeGoBaseUrl；canonicalOpenCodeBaseUrl **只迁移历史 Zen 路径 /zen/v1 → /inference/openai/v1，/inference/go/openai/v1 原样保留**；不再统一改写。
  2. **默认模型不停在免费模型**：加载与保存时，若 OpenCode 供应商的默认模型是免费模型（id 含 free），回退到首个「非免费且 selected!==false」的模型（用户配置里回退到 deepseek-v4.1-flash）；**不删除免费模型**（额度重置后仍可显式选择）。
  3. **新增 OpenCode Zen 预设 + 修正 Go 预设**（packages/ui/src/Settings.tsx）：「OpenCode Go（订阅）」= /inference/go/openai/v1 + deepseek-v4.1-flash + x-opencode-session 头；「OpenCode Zen（按量付费）」= /inference/openai/v1 + glm-5.3。
  4. **模型目录端点解析单一产地**（新增 packages/shell/src/main/providerModels.ts，resolveModelsUrl）：OpenCode 去推理协议段后拼 /v1/models；其他网关沿用原规则；settings:listModels 改用它。
  5. **能力解析支持 OpenCode 目录形态**（packages/core/src/modelCapabilities.ts）：解析 limit.context/output、modalities.input（MIME 归一为 text/image/audio/video）、capabilities.tools.supported、capabilities.reasoning.effort、capabilities.structured_output，来源诊断随之上报（配合 ADR-0049 三态合并）。
  6. **OpenCode 专项可行动错误提示**（packages/core/src/llm/upstreamError.ts）：Go 订阅未激活/Key 工作区不匹配、免费模型仅官方客户端、地区限制 RegionError、Go Key 打按量付费端点（Model access is disabled）、缺 x-opencode-session、免费额度用尽（含 opencode.ai/go 订阅引导）各自映射为中文可行动提示，并排在通用「订阅/地区」分类之前。
  7. **底部错误提示去重**（packages/ui/src/useChatStreamEvents.ts）：done 为 interrupted（error/stopped/预算中断…）时不再 setNotice(statusText)——原因已在会话气泡里展示；chat:stream:error 不再弹「回复失败」；保留用户主动停止的「已停止」提示。
  8. **数据侧一次性修复**：把可用 Go 订阅 Key（本机 DSH 的 OPENCODE_GO_API_KEY）写入 Loopsoar opencode-go 的加密密钥库（secrets.enc.json 的 cipherFallback，主密文置空按降级备份解密）；写前备份原文件，写后回读校验。
- **理由**：OpenCode 的 Go 与按量付费是两个独立计费/鉴权体系，端点必须跟着 Key 的“计划”走；把两者统一到 /inference 会让订阅用户直接失效（上一轮的推断错误）。免费模型对第三方客户端有地区/额度限制，作为默认模型会稳定复现 403，必须默认回退但不剥夺用户选择。错误提示只有指到「Key 的工作区 / 计划 / 地区」才有行动价值——泛化的「订阅/地区」提示正是用户无法自救的原因。底部重复提示是纯噪声且挡内容，删除不影响信息完整性。
- **替代方案**：①保持统一 /inference 端点（否：Go 订阅实测 403 Model access is disabled）；②删除所有免费模型（否：免费额度重置后可用，且 Go 免费模型是套餐权益）；③自动降级到其他供应商（否：违反 ADR-0043 不做静默降级）；④只在错误发生时才提示计划（否：默认模型已经决定首轮体验，应提前迁移）。
- **后果**：OpenCode Go 用户按 Go 端点 + x-opencode-session 请求（实测 200）；按量付费用户使用 Zen 预设；老配置里 beam-free 默认模型会在启动时自动换成付费模型（一次性写回，幂等）；设置面板「获取模型列表与能力」对 OpenCode 返回 30 个 Go 模型并带上下文/输出/视觉/工具/结构化输出；错误发生时会话内红字与底部提示不再重复。
- **验证方式**：typecheck 5/5 通过（直接调用 tsc）；全量 vitest **166 文件 / 1410 tests 全绿**（新增 opencodeProvider 7、providerModels 2、opencodeNotice 3、upstreamErrors 1、modelCapabilities 2）；真实上游验证（证据 e2e-evidence/opencode-live-probe.log、opencode-live-verify.log）：Go 端点 deepseek-v4.1-flash / glm-5.3 均 200，无 session 头 400 MissingSessionID，按量付费端点用 Go Key 403 Model access is disabled，免费模型 429/RegionError 403；Loopsoar core OpenAi 客户端真实流式回复成功（2 字回复，reasoning 10 chunks）；真机 E2E（数据副本，e2e-evidence/opencode-fix.log E2E_EVAL ok:true，截图 e2e-evidence/opencode-fix.png）：启动后 opencode-go 保持 /inference/go/openai/v1、默认模型 beam-free → deepseek-v4.1-flash、Key 提示 oc_…DO2x；「测试连接」deepseek 200/2315ms、glm-5.3 200/762ms；「获取模型列表」30 个模型、error=null、capabilityMeta 30 条，deepseek 行上下文 1M/输出 384K/视觉/工具/结构化输出全部解析。
- **状态**：✅ 自动化 + 真实上游 + 真机 E2E 已验证（2026-11-09）
- **回退条件**：OpenCode 官方端点策略再变（如取消 /go 段）→ 只改 canonical/预设与测试；免费模型回退策略影响免费用户 → 改为仅在请求失败后提示而不是迁移默认模型；底部提示去重导致用户看不到失败 → 恢复 done 的 notice（但保留 error 事件去重）。
- **复核时间**：OpenCode 文档/端点变更、Go 套餐与按量付费合并、用户反馈默认模型被迁移时

---

## ADR-0052 去掉「默认模型 / 启用」概念：模型菜单列出全部模型，点哪个用哪个

- **背景**：用户（2026-11-09 16:28）反馈「现在怎么模型只能在对应供应商的默认模型」，并明确要求「『默认』这个功能是 slime 那边的一个赘项，之前属于想删删不掉的情况，你给我去掉，没必要搞这个，用户想用哪个是哪个」。
- **根因**：
  1. 模型菜单（`buildModelGroups`）只展示 `selected !== false` 的模型，并额外把每个供应商的 `model` 当「默认模型」强制显示；而「获取模型列表」的合并逻辑（`mergeFetchedProviderModels`）只把 `defaultModelId` 标为启用、其余新模型默认停用 → 拉回 40 个模型的 Zen 供应商在菜单里只剩默认的那一个（外加历史手工勾选的少量模型），用户观感就是「只能用默认模型」。
  2. 「默认模型」在设置里是三处赘项：供应商卡片「默认模型」行、编辑弹窗模型表「默认」单选列、「启用」勾选列；`provider.model` 同时承担「默认」与「当前使用」两种语义，切换模型时互相打架。
  3. ADR-0051 为避免默认模型落在免费模型上加了自动回退（加载/保存时把 beam-free 自动换成 deepseek）——这与「用户想用哪个是哪个」直接冲突。
- **决策**：
  1. **模型菜单展示每个供应商的全部模型**（`packages/ui/src/modelGroups.ts`）：不再按 `selected` 过滤、不再有「默认模型必显示」特例；仅跳过空 id 并去重，供应商还没有模型清单时用当前模型兜底。活动供应商仍置顶。
  2. **删除设置里的默认/启用 UI**（`packages/ui/src/Settings.tsx`）：供应商卡片不再显示「默认模型」行；编辑弹窗模型表删除「默认」单选列与「启用」勾选列（其余能力列保留）；`provider.model` 语义降级为「当前选用/最近使用」——聊天输入区「模型」chip 点哪个就写哪个，保存供应商时保留当前选择，新增供应商取清单第一个作为初始值。
  3. **拉取合并不再自动启用/停用**（`mergeFetchedProviderModels` 去掉 `defaultModelId` 参数）：历史数据里的 `selected` 字段原样保留，但不再参与任何 UI 决策（菜单不再读它）。
  4. **删除免费模型自动回退**（`packages/shell/src/main/providerStore.ts`）：加载/保存都不再改写用户选的模型（哪怕它是 beam-free 这类免费/地区受限模型），只保留历史 `/zen/v1` → 按量付费端点的 URL 迁移。
  5. 配套文案：设置页「模型参数」说明与安全提示改为「全部模型可选、无需先设默认」；删除 `settings.providers.defaultModel` / `col.enable` / `col.default` 等 i18n 键。
- **理由**：模型选择是「活动供应商 + 当前模型」的一次点击全局状态，不是每个供应商一份默认值；slime 的「默认模型/启用」是历史遗留的配置负担，会在拉取新模型列表后把可选范围缩成默认一个。去掉后新增供应商、拉取模型、切模型都是一条路径，符合「想用哪个用哪个」。
- **替代方案**：保留「启用」但拉取时全部默认启用（否：仍有默认/启用两套概念，且用户要的是删掉「默认」）；保留默认模型但不在 UI 显示（否：切换模型仍会被默认语义覆盖，问题会在别处复现）；只在菜单里显示全部模型、设置里保留列（否：用户明确要求去掉这个功能）。
- **后果**：模型菜单条目变多（OpenCode Zen 40 + Go 30 + 其他供应商，实测 72 项），按供应商分组展示仍可快速定位；`providers.json` 里旧的 `selected` 字段成为无害遗留；不再有「新模型要不要勾选/设默认」的步骤；用户若选到地区受限/免费额度耗尽的模型会直接收到上游错误（错误提示已可行动）。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest 166 文件 / 1412 tests 全绿（更新 modelGroups 4、opencodeProvider 6、providerCapabilities 18、opencodeNotice 5 等用例，新增长期守卫：设置页不再出现「默认模型」行/「默认」单选/「启用」列，模型菜单不按 selected 过滤）；真机 E2E（数据副本，`e2e-evidence/model-any.log` E2E_EVAL ok:true，截图 `e2e-evidence/model-any.png`）：模型菜单 72 项（Zen 40 + Go 30 + agnes/note 各 1），历史 `selected:false` 的 `claude-opus-5-5` 可见并点击成功 → 当前模型切到 `claude-opus-5-5`、活动供应商保持 opencode-zen；供应商页与编辑弹窗均无「默认模型」文本/「默认」单选/「启用」表头，Zen 编辑弹窗 40 行模型全部列出。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-09）
- **回退条件**：菜单过长影响选择 → 增加搜索框/折叠（不改「全部可选」语义）；用户想隐藏个别模型 → 后续可加纯展示过滤（不恢复默认/启用语义）；旧数据 `selected` 引发其他模块误用 → 删除该字段并迁移。
- **复核时间**：模型数量继续增长（>200）、用户反馈菜单过长时

---

## ADR-0053 OpenCode 计划边界可视化与账户纠正：Go 订阅额度 ≠ 按量付费余额（402 根因）

- **背景**：用户（2026-11-09 17:05）发截图：`provider: opencode-zen · deepseek-v4.1-flash` 的对话报「上游账户余额不足（HTTP 402: Insufficient account funds）」，并质疑「我还有起码 40% 的额度啊，有问题，给我解决了」。
- **根因（三层）**：
  1. **账户侧**：`opencode-go` 供应商用 Go 订阅 Key（oc_…DO2x，实测 Go 端点 200，40% 是 Go 套餐额度）；`opencode-zen` 供应商用旧 Key（oc_…7lyv，无 Go 订阅、按量付费余额为 0）。同名模型 `deepseek-v4.1-flash` 同时存在于 Go 目录与按量付费目录，用户点到了 zen 组里的那个 → 402。Go 额度与按量付费余额是**两个独立账户**（2026-11-09 实测：Go Key 打按量付费端点 403 Model access is disabled / 402 Insufficient account funds；按量付费 Key 打 Go 端点 403 Go subscription required）。
  2. **可见性**：模型菜单分组头只显示 provider 名（opencode-go / opencode-zen）与截断的 baseUrl，两者同属 opencode.ai、模型 id 大量重叠，UI 没有任何「这是哪种额度」的标记；错误提示也只是泛化的「余额不足」，用户无法判断 402 是因为走错了计划。
  3. **数据侧**：活动供应商被切到 zen 用于试用，`opencode-go` 的当前模型还被改成 `iceman-contributor-free`（免费/地区受限模型），两者叠加使「有额度却用不了」。
- **决策**：
  1. **计划徽标单一产地**（`packages/ui/src/modelGroups.ts`）：新增 `openCodePlanLabel(baseUrl)` → `"go" | "payg" | null`（按 `/inference/go` 判定 Go 订阅、其余 opencode.ai 端点判按量付费，其他供应商 null），并写进 `ModelGroup.plan`；输入区模型菜单分组头显示「Go 订阅 / 按量付费」，设置·供应商卡片显示「Go 订阅额度 / 按量付费余额」。
  2. **错误提示按账户区分**（`packages/core/src/llm/upstreamError.ts`）：`Insufficient account funds` → 明确「Go 订阅额度与按量付费余额是两个账户，有 Go 订阅请把活动供应商切到 opencode-go」；`Model access is disabled` → 明确「Go 订阅 Key 不能用于按量付费端点，请切到 opencode-go」。
  3. **数据纠正**：活动供应商切回 `opencode-go`、当前模型设为 `deepseek-v4.1-flash`（Go 端点实测 200）；legacy `provider.json` 同步，避免旧单供应商回退路径指回错误配置。
  4. **不合并两个供应商、不做跨端点自动切换**（遵守 ADR-0043 不做静默降级）：保留用户显式选择，只把「两个计划/两套额度」做成一眼可见的标记与可行动错误。
- **理由**：这不是代码 bug 而是「计划边界不可见」的可用性问题——模型 id 在两个目录里重名，用户按名字选模型时无法知道自己在花哪份额度；把计划标注在菜单和卡片上、把 402/403 的解释写到具体端点，用户才能自己走对路。数据纠正让用户马上能用回 40% 的 Go 额度。
- **替代方案**：合并成一个 OpenCode 供应商并自动按 Key 探测计划（否：探测需额外请求、自动切换跨账户有静默降级风险，改动面大）；把同名模型去重只留一个（否：无法区分计划，会随机丢额度）；只改数据不改 UI（否：同样的困惑下次还会出现）。
- **后果**：两个 opencode 供应商在菜单/卡片上可区分（「Go 订阅」「按量付费」徽标）；按量付费需要 Console 充值，Go 套餐用户日常应使用 opencode-go；错误发生时会直接提示该切哪个端点，不再只有「余额不足」。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest 166 文件 / 1415 tests 全绿（新增 modelGroups 计划标记 2、upstreamErrors 账户区分 1）；真机 E2E（数据副本，`e2e-evidence/plan-badges.log` E2E_EVAL ok:true，截图 `e2e-evidence/plan-badges.png`）：活动供应商 `opencode-go`、模型 `deepseek-v4.1-flash`、Go 端点 `.../inference/go/openai/v1`、测试连接 **200/2759ms**；模型菜单 72 项且同时出现「Go 订阅」「按量付费」徽标、opencode-go/opencode-zen 两组并存；点击 opencode-go 组内 `glm-5.3` 成功切换（activeId 保持 opencode-go）；设置页两个供应商卡片分别显示「Go 订阅额度」「按量付费余额」。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-09）
- **回退条件**：OpenCode 合并两种计费方式 → 删除 plan 徽标与专项错误分支；徽标对非 OpenCode 供应商误标 → 收窄 `openCodePlanLabel` 的域名判断；用户希望自动跨计划重试 → 需先评估是否违反 ADR-0043（应新增 ADR）。
- **复核时间**：OpenCode 计费/端点策略变化、用户新增 OpenCode 供应商或换 Key 时

---

## ADR-0054 恢复「模型显示拨片」+ 推理强度选择上移（「默认模型」仍然不恢复）

- **背景**：用户（2026-11-09 17:42，附模型菜单截图）反馈两点：①「为什么我的拨片式开关没了？直接全部开了？你给我优化一下供应商内模型的选择」；②「优化一下推理强度的选择渲染，现在每次我想要修改推理强度都要在这个模型列表里面翻到最下面，翻半天」。ADR-0052 在删除「默认模型」时把「启用」拨片也一并删掉了（语义误判：用户要删的是「默认」，不是「显示开关」）；同时推理等级区块原本在模型菜单底部，72 个模型时改推理强度必须先滚到底。
- **决策**：
  1. **恢复模型「显示」拨片**（设置 · 供应商 → 编辑弹窗模型表第一列，`Toggle` + `aria-pressed`）：语义 = 该模型是否出现在输入区「模型」菜单（关闭后仍保留参数与已选状态，只是不在菜单展示）；菜单重新按 `selected !== false` 过滤。**仍然没有「默认模型」**——没有默认行/默认单选列/自动回退，当前使用哪个模型仍由聊天「模型」chip 决定。
  2. **新拉取的模型默认打开**（`mergeFetchedProviderModels`：`merged.selected = prev?.selected ?? incoming.selected ?? true`）：避免重蹈 0052 前「拉列表后只有默认模型可选」的覆辙；本地已有关闭状态保留，用户可自己关掉不想看的模型。
  3. **推理强度区块移到模型菜单顶部**（`Composer.tsx`）：从「模型分组之后、菜单底部」移到「选择模型标题之后、模型分组之前」，打开菜单即可看到「推理等级」，不再需要翻到底。推理强度仍是每轮的全局设置（与模型无关的那一档仍保留「关」选项）。
  4. **数据侧**：把两个 OpenCode 供应商（Go 30 / Zen 40）模型全部设为打开，菜单与开关状态一致（用户可按需关掉）。
- **理由**：模型「是否显示」是列表整理工具，与「谁是默认」是两回事——删掉前者会让 40 个模型的菜单不可控；保留拨片 + 新模型默认打开，既满足「想用哪个用哪个」，又允许用户收起噪声。推理强度是高频操作，位置在长列表底部属于布局缺陷，移到顶部零成本解决。
- **替代方案**：推理强度做成独立 chip/浮层（改动大、与模型菜单割裂，暂不做）；拨片默认全关（否：会回到「只有默认可选」的问题）；菜单加搜索框（可后续，当前 72 项尚可滚动）。
- **后果**：设置里模型表第一列恢复拨片（40 行 = 40 个开关，全部默认打开）；模型菜单只列打开项（当前 72 项全部可见）；推理等级常驻菜单顶部；旧 providers.json 无需迁移（`selected` 字段一直保留）。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest 166 文件 / 1415 tests 全绿（更新 modelGroups「只展示打开项」、merge「新模型默认打开」、opencodeNotice「默认/拨片边界」等守卫）；真机 E2E（数据副本，`e2e-evidence/toggles-effort.log` E2E_EVAL ok:true，截图 `e2e-evidence/toggles-effort.png`）：模型菜单 72 项且「Go 订阅/按量付费」徽标正常；推理等级标题位于第一个模型项上方且开场可见（`effortAboveModels=true` / `effortVisible=true`）；Zen 编辑弹窗 40 行对应 40 个拨片、全部 `aria-pressed=true`，点第一行拨片可切成关闭；无「默认」单选/表头，「显示」表头存在。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-09）
- **回退条件**：拨片导致「以为删了模型」的误解 → 关闭项加置灰/分组；菜单过长 → 加搜索/折叠；推理等级顶部挤压 → 收进二级浮层。
- **复核时间**：模型菜单条目继续增长、用户反馈拨片语义不清时

---

## ADR-0055 模型「显示」开关支持全选 / 取消全选（表头主拨片）

- **背景**：用户（2026-11-09 20:55）要求「加个全选跟取消全选的拨片」。模型表容量大（OpenCode Zen 40 / Go 30），逐个点「显示」拨片整理列表成本高。
- **决策**：
  1. 在设置 · 供应商编辑弹窗模型表表头「显示」列内嵌一个**主拨片**（`data-testid="model-toggle-all"`，复用 `Toggle` 组件并为其增加可选 `title`/`testId`）：`aria-pressed=true` 当且仅当全部模型都显示；hover/aria 文案为「全选 / 取消全选（当前 n/total）」。
  2. 点击行为：全开时 → 全部关闭；否则 → 全部打开（部分开启时主拨片显示为关，点一下即全选）。
  3. 只改 `selected`（是否出现在输入区「模型」菜单），**不改当前使用模型、不改模型参数**；与逐行拨片同一状态源，保存后才落盘。
  4. 无新增持久化字段/契约：复用既有 `selected`；数据侧无需迁移。
- **理由**：主拨片放在「显示」列头是最符合直觉的位置（列级操作对列）；复用逐行开关的状态与交互，零新概念；「部分开启」时点击即全选，避免用户要先判断当前是哪种混合状态。
- **替代方案**：在模型区标题处加「全选/取消」两个文字按钮（可发现性略高但多占一行，且与拨片语义割裂）；三态复选框（原生 checkbox indeterminate，但项目统一用拨片交互，样式要另做）。
- **后果**：40 个模型一键收起/展开；主拨片初始与逐行状态一致（全部打开 = 开）；改变仅存在于编辑草稿，点「保存并设为活跃」后生效。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest 166 文件 / 1416 tests 全绿（opencodeNotice 新增「表头全选拨片」守卫 1 例）；真机 E2E（数据副本，`e2e-evidence/toggle-all.log` E2E_EVAL ok:true，截图 `e2e-evidence/toggle-all.png`）：Zen 编辑弹窗 40 行，主拨片初始 `aria-pressed=true（40/40）`；点击 → 40 行全部关闭（0 开/40 关）；再点 → 40 行全部打开；单独关掉 1 行后主拨片变 `false（39/40）`，再点主拨片 → 恢复 40/40；title 含「全选 / 取消全选」。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-09）
- **回退条件**：主拨片与逐行状态不同步 → 改由同一 reducer 派生（当前已是同一 state）；点击全关造成误操作 → 可加二次确认或改为「仅全开」单向按钮。
- **复核时间**：模型表增加分组/筛选时

---

## ADR-0056 模型表工具条重构（全选移位 + 搜索栏）+ 应用图标身份修复

- **背景**（用户 2026-11-09 21:03，附 slime「编辑供应商」弹窗截图）：①「这个位置很丑啊，你能不能优化一下，你看看，你借鉴一下slime吧，他还有搜索栏。」——指 ADR-0055 把「全选 / 取消全选」主拨片塞进模型表「显示」列表头，40 行表格头被开关+文字挤满，且 72 个模型没有搜索只能滚。②「为什么slime的图标被换成了loopsoar的图标，loopsoar图标直接没了，变成了electron的默认图标？你顺便修一下。」
- **根因（两组）**：
  1. **模型表布局**：`Settings.tsx` 的供应商弹窗只有两行——「模型参数」标题 + 草稿输入/添加；主拨片嵌在 `<th>` 内。slime 参考布局是「标题 → 主开关+摘要行 → 搜索栏 → 表格」。
  2. **图标错位（两层）**：
     a. **slime 仓库（`D:\pilot project`）** 工作树里有未提交的品牌替换，图标资产与 Loopsoar/Quilt 品牌（∞ 破环·化片）完全相同：`gui/build/icon.ico` 92797→35276、`gui/build/icon.png` 974547→72697、`gui/build/notify-icon.png` 60287→16831、`gui/src/renderer/assets/icon.ico` 被覆盖、`gui/src/renderer/assets/slime-icon.png` 被删除 → slime 应用显示 Loopsoar 的 ∞ 图标。
     b. **Loopsoar 主进程**：`iconPath()` 只探测 `path.join(__dirname, "../../resources/icon.png")`。开发态跑的是 `packages/shell/dist/main.bundle.mjs`，`__dirname` = `packages/shell/dist` → 解析到不存在的 `packages/resources/icon.png` → `BrowserWindow.icon = undefined` → 窗口/任务栏显示 Electron 默认图标；资源实际在 `packages/shell/resources/`。且从未调用 `app.setAppUserModelId(APP_ID)`（`APP_ID = "com.loopsoar.app"` 已定义），Windows 任务栏身份落到 electron.exe 默认身份，任务栏图标/分组不受品牌控制；会进任务栏的会话栏独立窗口（`skipTaskbar: false`）也没有传 icon。
- **决策**：
  1. **模型表工具条**：新增 `S.modelToolbar` 行——主拨片（`data-testid="model-toggle-all"`，title 带 `（n/total）`）+「全选 / 取消全选」+ 摘要「共 {total} 个 · 聊天界面只显示已启用（{on} 个）」；表头恢复纯文本「显示」；`S.modelAddRow` 左侧新增模型 ID 搜索框（`data-testid="model-search"`，占满剩余宽度，placeholder 带总数）+ 右侧草稿输入/「添加」。搜索只过滤表格展示（`visibleModels`），用**原始 idx** 回写，保存数据不变；无匹配显示「没有匹配的模型 ID」。
  2. **图标探测单一产地**：新增 `packages/shell/src/main/appIcon.ts` `resolveAppIconPath({dirname, resourcesPath, cwd, platform})`，按 dist bundle（`../resources`）→ src（`../../resources`）→ 打包 `process.resourcesPath`（`icons/`、根）→ dev cwd（`packages/shell/resources`、`resources`）顺序探测；Windows 优先多档 `.ico`、其他平台优先 `.png`。`index.ts` 改用该函数并在主窗口/会话栏窗口传 icon，启动打日志 `[Loopsoar] appIcon=…`。
  3. **Windows 任务栏身份**：主进程启动时 `if (process.platform === "win32") app.setAppUserModelId(APP_ID)`（品牌单一产地 `packages/shell/src/shared/brand.ts` 的 `APP_ID`）。
  4. **slime 图标恢复**：只 `git checkout --` slime 仓库那 5 个图标文件（恢复后 md5 与 HEAD 逐字节一致，`icon.png` = 蓝色史莱姆原图）；**不触碰** slime 其余 215 个未提交改动（那是该仓库自己的在途工作，不属于图标问题）。
- **理由**：模型表是高频操作区，主开关属于「区块级操作」应独立成行，搜索是 72 模型规模的必需能力；图标问题分属两个仓库/两个层次（文件资产被覆盖、主进程路径与任务栏身份错误），必须分别修，否则只修一边仍会错位。
- **替代方案**：把搜索放表头/浮动（否：表头已经很挤，slime 的搜索栏就是独立一行）；给全选做「仅对搜索结果生效」（否：本轮语义仍是全局开关，title 明确 n/total，避免误操作）；打包图标硬编码路径（否：一换运行形态就再坏，多候选纯函数可单测）；把 slime 整个工作树回滚（否：会毁掉该仓库 215 个在途改动）。
- **后果**：模型表结构为「标题 → 工具条（拨片+摘要）→ 搜索/草稿行 → 表」，40 模型弹窗视觉负担明显下降；搜索实时过滤且编辑/删除仍落到正确行；Loopsoar 窗口/任务栏显示品牌图标（`appIcon=` 指向 `packages/shell/resources/icon.ico`），任务栏身份 `com.loopsoar.app` 与 slime 分离；slime 恢复原图标资产（`git status` 图标相关为空）。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **167 文件 / 1422 tests 全绿**（新增 `tests/shell/appIcon.spec.ts` 5 条：dist/src/打包/缺省四种路径探测 + 主进程接线守卫；更新 `tests/ui/opencodeNotice.spec.ts` 工具条/搜索守卫）；`pnpm build`/`pnpm gen`/`pnpm check` 通过；真机 E2E（数据副本，`e2e-evidence/model-toolbar.log` E2E_EVAL ok:true，截图 `e2e-evidence/model-toolbar.png`）：`model-toggle-all` 不在 `thead`、在工具条内，title `全选 / 取消全选（40/40）`，摘要「共 40 个 · 聊天界面只显示已启用（40 个）」；搜索「deepseek」40→3 行、清空恢复 40；主拨片 0/40↔40/40；无匹配提示「没有匹配的模型 ID」；启动日志 `[Loopsoar] appIcon=D:\...\packages\shell\resources\icon.ico`。slime 证据 `e2e-evidence/slime-icons-restored.log`：5 个图标文件 `git status` 为空、md5 与 HEAD 一致，其余 215 项未提交改动保持原样。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-09）
- **回退条件**：模型表需要「按搜索结果全选」→ 改 setAllShown 作用域；icon 打包方式调整（extraResources 路径变化）→ 更新 `resolveAppIconPath` 候选；Windows 图标仍不对 → 检查 AUMID 与快捷方式/安装器图标（打包配置尚未建立）。
- **复核时间**：开始 Electron 打包（安装器/快捷方式图标）时、模型数量再上一个量级（搜索加防抖/分组）时

---

## ADR-0057 密钥关联修复：供应商合并必须迁移密钥、测试连接必须用被测 Key、保存后立即验证

- **背景**：用户（2026-11-10 11:19）强烈否认「某把 Key 无订阅」的判断：「我给的密钥都是有订阅的，不存在『无订阅的 oc_…7lyv』，你别给我滥竽充数。这绝对是密钥方面的大问题！！！」。核查后确认这是**应用侧密钥关联 bug**，不是用户记错 Key。
- **根因（四条，叠加成「切换 Key 永远不生效 + 每次都误判」）**：
  1. **去重合并丢密钥**：旧版切模型每次都会 `upsert` 出重复供应商（副本 id 如 `opencode-go-2`）。`ProviderStore.dedupe()` 合并副本时只保留首条 id，且原注释假设「密钥仍挂在首条 id 上」——但用户把新 Key 保存在**副本**上，副本被合并后密钥成了孤儿，聊天按保留 id 取到**旧 Key** → 上游 403「An active OpenCode Go subscription is required」→ 用户看到「我给的 Key 明明有订阅」却用不了。实测数据正是如此：`providers.json` 只剩 `opencode-go`，而 secrets 里 `opencode-go`=oc_…7lyv（旧）、`opencode-go-2`=oc_…DO2x（新且实测 200）。
  2. **测试连接用错 Key**：`testProvider` 无论测哪条配置，都解析**活动供应商**的密钥。于是：测 B 供应商时把 A 的 Key 发给 B 的端点（全表 403）；用户切 Key 后点「测试连接」测的仍是旧 Key → 「误判新 Key 无效」，进而不敢保存/反复切换。
  3. **副本 id 复活**：`upsert` 收到已不存在于文件里的副本 id（历史 UI 状态）时会新建该 id 的副本，继续制造孤儿 Key。
  4. **保存后无真实验证**：UI 只提示「已保存」，用户无法区分「Key 本身无效」与「Key 根本没生效」。
- **决策**：
  1. **迁移单一产地**：`ProviderStore` 构造可注入 `onAliases` 回调；`load()` 去重合并时把 alias（被合并 id → 保留 id）交给装配层。`index.ts` 改为**先建 SecretStore 再建 ProviderStore**，`migrateAliasedSecrets` 用 `secrets.meta()` 的 `updatedAt` 取胜（用户新保存的 Key 优先）并 `secrets.set(to, key)`；启动时 `reconcileOrphanSecrets()` 按「保留 id」+ 数字后缀兜底迁移历史孤儿（如 `opencode-go-2`），同样只迁移更新的 Key。
  2. **upsert 不复活副本**：显式 id 不存在、或新增时已有同 `provider + baseUrl` 记录 → 复用现存 id；绝不新建副本（否则新 Key 又会挂到孤儿 id 上）。
  3. **testProvider 用被测 Key**：密钥解析顺序改为「表单刚输入的 `apiKey` → 被测供应商自己的 Key（`payload.id` / `provider+baseUrl` 唯一匹配）→ 环境变量」；删除「活动供应商 Key」回退。`SettingsProviderSchema` 增加 `id` / `apiKey`（只用于本次探测，不落盘）；卡片测试与编辑弹窗各自带上 id/typed key。
  4. **保存即验证**：编辑弹窗「保存并设为活跃」与「保存密钥」在保存后立刻用**刚输入的那把 Key** 调 `testProvider`，成功/失败分别 toast（`keyVerified` / `keyVerifyFailed`），让「Key 无效」与「Key 没生效」一眼可分，不再误判。
  5. `SecretStore` 增加 `ids()` / `meta()`（只给 providerId/hint/updatedAt，不泄露明文）。
- **理由**：密钥是用户最敏感的配置，「保存了但不是聊天实际用的那把」会让用户完全失去信任；必须在**数据迁移（去重）**、**探测（testProvider）**、**写入后验证（UI）**三个环节闭环，否则任何一处仍会复现「切换 Key 不生效/误判」。
- **替代方案**：直接删掉去重逻辑（否：旧数据里的副本会重新显示，且请求头/模型合并会丢）；只修 testProvider（否：聊天仍用孤儿旧 Key，403 依旧）；只修 dedupe 迁移（否：用户无法确认新 Key 是否生效，仍会被测试连接的假 403 误导）；在 UI 里按名称匹配密钥（否：id 才能唯一关联，名称可重复）。
- **后果**：历史副本 Key 自动迁到保留供应商（新 Key 优先）；切换/新增 Key 不再产生副本、不再丢关联；测试连接结果只反映被测配置本身；保存 Key 立即得到真实上游验证结果。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **169 文件 / 1437 tests 全绿**（新增：ProviderStore alias 回调与 upsert 复用、SecretStore `ids/meta`、`tests/shell/secret-migration-guards.spec.ts` 5 条接线守卫、testProvider 被测 Key 回归）；真机 E2E（数据副本，`e2e-evidence/key-migration.log` E2E_EVAL ok:true）：先切活动供应商到 agnes-2 → 编辑 opencode-go 粘贴 Key → 测试连接 **200/连接成功**（旧实现用 agnes Key 必失败）→ 保存后供应商仍 3 条、active=opencode-go、keyHint=oc_…DO2x、二次保存仍无副本；启动日志出现 `secret reconciled`/`secret migrated` 迁移记录。
- **数据修复**：真实数据把 `opencode-go` 的 Key 恢复为实测可用的那把（备份 `secrets.enc.json.bak-keyfix`）；另一把 Key 在 Go 端点实测仍返回 403（属上游账户/工作区订阅事实，应用现在会如实提示，不再静默换 Key）。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-10）
- **回退条件**：OpenCode 取消工作区级订阅校验 → 保留迁移逻辑不回退；SecretStore 元信息 API 被替换 → 同步替换 `migrateAliasedSecrets`/`reconcileOrphanSecrets`；未来允许同名多供应商共端点（产品需求）→ 需重新设计 key 归属键，不能只靠 provider+baseUrl。
- **复核时间**：任何供应商存储结构/去重规则变更、或再次出现「Key 明明有效却 403」时

---

## ADR-0058 列表/浮层「点击按钮收起 + 点击外部收起」全局规则修复

- **背景**（用户 2026-11-10 12:04，m02263）：「展开的列表，再次点击展开按钮依旧是闪烁一遍，而非关闭……所有这类列表，一个都没有做，随便遇到一个展开的列表，我点击列表外，都无法收起。」（阴影问题已确认修好，其余两条仍是硬需求）。
- **根因（三层，互相掩盖）**：
  1. **`<html data-popover>` 标记泄漏到主窗口**：`packages/ui/src/PopoverApp.tsx` 在**模块加载时无条件**执行 `document.documentElement.dataset.popover = "1"`。主窗口的 `main.tsx` 为选择渲染哪个根组件而静态 `import PopoverApp`，于是主窗口 `<html>` 也被打上 `data-popover`；而 `popover.ts` 的「点击外部」判定是 `target.closest("[data-popover],[data-popover-trigger]")` —— 任何点击都会命中 `<html>`，**全部被判为「点在浮层内部」**，于是所有内联菜单（模型/权限/会话历史）点击外面都收不起来。E2E 实测主窗口启动即有 `[data-popover]`，其 textContent 是整页内容，坐实此因。
  2. **工具栏浮层 toggle 存在跨窗口竞态**：工具栏浮层是独立子窗口。点击触发按钮时主窗口获得焦点 → 子窗口先 `blur` → 管理器的 `win.on("blur")` 关闭浮层 → 渲染层 click 回调再执行时「已打开」状态已被清空 → 重新打开；观感就是「闪烁一遍，关不上」。上一版加的 `chrome:popoverClosed` 状态同步反而让清空发生在 click 之前，加剧了该竞态。
  3. **点击原生网页面板时 DOM 收不到事件**：网页是 WebContentsView，点击它不会触发渲染层 pointerdown；旧实现只广播 `chrome:dismissPopovers` 收起内联浮层，没有关闭工具栏浮层。
- **决策**：
  1. **打标收窄**：`PopoverApp` 只有 URL 含 `?popover=`（真正的浮层窗口）时才给 `<html>` 打 `data-popover`；主窗口不再被污染。
  2. **点击外判定加防**：`usePopover` 的 outside 检测忽略 `document.documentElement` / `document.body` 被误标的情况，并对 `pointerdown` 与 `mousedown` 双监听兜底（远程桌面/注入环境）。
  3. **工具栏浮层原子 toggle**：契约新增 `ui:togglePopover`（`OpenChromePopoverSchema`），主进程按 `manager.isOpen()` 决定关闭或打开并返回 `{open}`；渲染层点击只调它，不再依赖渲染层记录的 open 状态。点击结果为 `open:false` 时设置 suppressHover，直到鼠标离开按钮才允许 hover 重开（避免收起瞬间又被 hover 打开）。
  4. **主窗口内点击外部**：`App` 挂全局 `pointerdown` → `ui.closePopover()`，跳过 `[data-chrome-popover-trigger]`（触发按钮自身走原子 toggle，避免 pointerdown 先关、click 又开的连闪）；收藏星标按钮点击也会关闭预览。
  5. **点击原生网页**：`onViewFocused` 同时 `chromePopover.close()` + 广播 `chrome:dismissPopovers`。
  6. 该规则统一适用于：工具栏「更多/收藏」浮层、输入区模型菜单、权限菜单、会话历史下拉，其他新列表只要走 `usePopover` 即自动获得点击外收起。
- **理由**：点击按钮→展开、再点→收起、点外面→收起，是同一套心智模型；必须在**标记（数据）**、**事件（pointerdown）**、**窗口（独立子窗口竞态）**三个层面同时正确，任何一层错误都会让用户觉得「一个都没做」。
- **替代方案**：只修 inline 菜单（否：工具栏浮层仍连闪）；只修工具栏（否：所有 inline 菜单点外面依旧无效，因为 `<html>` 污染）；用 CSS `pointer-events` 兜底（否：无法覆盖原生子窗口与 WebContentsView）；把工具栏浮层改成 DOM 浮层（否：DOM 永远在原生网页视图之下，会被网页遮挡——ADR 既有结论）。
- **后果**：所有列表菜单获得一致的「再点按钮收起 / 点外面收起」行为；工具栏浮层不再依赖跨窗口事件时序；原生网页区域点击也能收起。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **170 文件 / 1443 tests 全绿**（新增 `tests/ui/popover-global-dismiss.spec.ts` 6 条 + 更新工具栏守卫 + `ui:togglePopover` 域单测）；真机 E2E（数据副本，`e2e-evidence/popover-dismiss.log` / `popover-dismiss-outside.log` E2E_EVAL ok:true）：
  - run1：模型菜单打开 → 再次点击 chip **收起**；打开 → 点击聊天区 **收起**；工具栏「更多」点击两次后 `E2E_WINDOWS` 仅剩主窗口（无重复打开=不连闪）。
  - run2：工具栏「更多」打开 → 点击主窗口聊天区 → `E2E_WINDOWS` 仅剩主窗口（点击外部收起）。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-10）
- **回退条件**：浮层窗口需要与主窗口共用 `data-popover` 语义（不预期）→ 需同步改 `usePopover` 判定；Electron 子窗口失焦行为变化 → 原子 toggle 仍是主进程唯一判据，不受影响。
- **复核时间**：新增任何按钮展开的列表/浮层时（必须走 `usePopover` 或 `ui:togglePopover`）

---

## ADR-0059 小窗「最小化 → 图标按钮」移植（Slime）+ 输入区左下角圆形「+」菜单

- **背景**（用户 2026-11-10）：
  1. 「对于小窗化……你去看看 slime 那边的小窗，点击最小化不是恢复窗口，而是变成一个图标按钮，只有点击关闭才是恢复正常窗口。直接去 `D:\pilot project` 查，给我搬过来。」
  2. 「在输入框的左下角加一个加号图标，圆形框格就行。现在先把『附件』按钮放进去，其他的我以后再想。」
- **Slime 参考实现（`D:/pilot project/gui/src/renderer/App.tsx`）**：
  - 浮窗标题栏有两个按钮：「─ 最小化（缩小为图标）」→ `minimizeFloat()`：把浮窗几何缩到 `FLOAT_ICON_SIZE`（图标按钮），保留「图标原位置」`floatIconHomeRef`，整窗只显示品牌图标；点击图标 → `restoreFloat()` 还原原尺寸。
  - 「▢ 收起悬浮窗（恢复普通布局：聊天回到中间）」→ `dismissFloat()`：关闭浮窗、恢复常规布局。即：**最小化 = 缩成图标；关闭 = 恢复正常窗口**。
- **Loopsoar 现状**：`?mini=1` 的 Agent 独立窗口是全系统 BrowserWindow（非页内浮窗）。标题栏最小化按钮 `ui:minimizeAgentWindow` 走 `manager.minimize()` → Windows `win.minimize()` 缩到任务栏；域层同时 `push chrome:agentWindowClosed` 让主窗口恢复侧栏——即「最小化就恢复普通布局」，与 Slime 语义相反。
- **决策**：
  1. **窗口侧（`packages/shell/src/main/agentWindow.ts`）**：`minimize()` 改为「缩成图标窗口」——保存当前 bounds 到 `iconRestoreBounds`，窗口缩成 `AGENT_WINDOW_ICON_SIZE`（56px，新增纯函数 `computeAgentWindowIconBounds`：贴原窗口右上角并夹取工作区），`setResizable(false)` + `setAlwaysOnTop(true)`，**先降 minimumSize 再 setBounds**（Windows 会用旧 minimumSize 夹住 setBounds，实测会得到 343×483 的「伪图标」）。新增 `restore()` 还原 bounds/可缩放/最小尺寸/取消置顶。`focus()/open()` 在图标模式下自动走还原。`reposition()` 在图标模式跳过（主窗口移动不拽走图标）。
  2. **语义（`domains/agentWindow.ts`）**：最小化**不再**推送 `chrome:agentWindowClosed`（小窗仍以图标存在，主窗口侧栏保持让位）；只有关闭（`ui:closeAgentWindow` → manager.onClosed）才恢复正常布局。新增 `ui:restoreAgentWindow`（只允许 Agent 窗口自身调用，带 webContents 发送者校验）。
  3. **渲染侧（`App.tsx` / `TitleBar.tsx`）**：监听新事件 `chrome:agentWindowIconMode`；图标模式只渲染一个 56px 圆角窗体：品牌 ∞ 图标按钮（`data-agent-icon`，点击 `ui:restoreAgentWindow`），整窗可拖动（`-webkit-app-region: drag`，按钮 no-drag）；标题栏提示改为「最小化（收起为图标）」（i18n `titlebar.minimizeAgent`）。关闭按钮不变（恢复正常布局）。
  4. **输入区「+」**：`Composer.tsx` 在 chipRow 最左新增 26px 圆形按钮（`button.composer-plus`，`border-radius:50%`），走 `usePopover("composer-plus")` 管理模式；菜单当前只有「附件」（复用 `onPickAttachment`，原「附件」chip 移除，入口收进 + 菜单）。与权限/模型菜单互斥；点击外部/Esc/再次点击按钮均收起（沿用 ADR-0058 的全局规则）。
- **理由**：用户明确要 Slime 的「最小化=图标、关闭=恢复布局」心智；把最小化实现成独立系统窗口缩成图标而不是页内浮窗，是 Loopsoar「小窗=真 BrowserWindow」架构下的自然映射（不引入第二套浮层）。“+” 把低频入口收进一个圆钮，符合用户「以后都往这里放」的扩展意图。
- **替代方案**：用页内浮窗重写 Slime 的 float 实现（否：Loopsoar 小窗是独立窗口，页内浮窗会与原生 WebContentsView 层级冲突）；最小化改为隐藏窗口 + 托盘图标（否：用户要「变成图标按钮」留在桌面，不是托盘）；标题栏最小化仍走系统最小化（否：用户明确否定）。
- **后果**：小窗在桌面以 56px 图标存在，点击还原、关闭才恢复主窗口布局；输入区多一个圆形「+」入口（当前含附件）。图标模式与还原有主进程事件双向同步，状态不会丢。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **170 文件 / 1444 tests 全绿**（新增：`computeAgentWindowIconBounds` 纯函数与图标/还原单测、`ui:restoreAgentWindow` 域测试、最小化不再推 closed 断言；`agentWindow.spec` 43 条全过）；真机 E2E（数据副本，`e2e-evidence/agent-icon.log`）：
  - 打开小窗（422×721）→ 点标题栏最小化 → 窗口 bounds 变 **57×57**（内容 56×56）、渲染层出现 `[data-agent-icon]` + logo → 点图标 → 还原到 424×723（≈原 bounds）。
  - 输入区「+」：在 chipRow 最左、菜单含「附件」、点聊天区外收起；同时打开小窗成功。
  - 图标窗截图：`e2e-evidence/agent-icon-icon.png`（56×56 圆角 ∞ 图标）。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-10）
- **回退条件**：若用户希望最小化回到任务栏（Windows 习惯）→ 保留动作入口、改回 `win.minimize()`；若 56px 图标被系统最小尺寸限制（旧数据）→ 启动时统一重设 minimumSize。
- **复核时间**：小窗交互再调整（拖动/贴边/多显示器）时

---

## ADR-0060 图标窗单层化 + 可拖动 + 最小化/还原衔接动画（Slime 整段移植）

- **背景**：用户 m02794（2026-11-10）：「你看，为什么这个悬浮按钮还有这么大个框？还有，为什么不能拖动，还有，衔接动画呢？你给我去 slime 那边直接搬运这一整段功能吧，你做得这个太差了。」（附图显示：窗口外框 + 内层带边框按钮的双层框；且图标无法拖动、最小化/还原是瞬间尺寸跳变。）
- **根因**：① agent 窗口创建时 `transparent` 未开、`backgroundColor` 不透明、`roundedCorners:true`，渲染层图标视图又画了整窗 `BRAND.inkRaised` 圆角底 + 内层 44px button（`border: 1px solid borderStrong` + `background: ink`）→ 窗口一层框 + 按钮一层框；② 拖动只依赖 `-webkit-app-region: drag`，但 56px 图标窗中间几乎全被可点还原按钮占据（`NO_DRAG_REGION`），实际可拖面积≈边缘 6px；③ `minimize()`/`restoreFromIcon()` 直接 `applyBounds` 跳变，没有几何衔接动画。
- **决策**：
  1. **单层图标**：Agent 窗口创建参数改为 `transparent: true`、`roundedCorners: false`、`hasShadow: false`、`backgroundColor: "rgba(0,0,0,0)"`（`AgentWindowOptions` 增加 `transparent?`/`hasShadow?`）；`packages/ui/index.html` 增加 `html[data-mini-icon]`（含 body/#root）`background: transparent !important`；`App.tsx` 图标态渲染 `<img src="./logo.png">` 铺满 56×56（logo.png 自带圆角底板 = 唯一一层），删除内层 `button` 与整窗圆角底，`data-mini-icon` 由 `agentIconMode` 同步到 documentElement。
  2. **拖动**：图标视图 `pointerdown` 记录 `screenX/Y`，`pointermove` 超过 4px 视为拖动，按屏幕坐标增量调用新 IPC `ui:moveAgentWindow {dx,dy}`（schema `MoveAgentWindowSchema` 限制 ±10000；契约 gen 重新生成；域层 `withAgentSenderGuard` 只允许 Agent 窗口自身）；主进程 `manager.moveBy(dx,dy)` 夹取工作区并固定 56×56；`pointerup` 未过阈值则视为单击 → `ui:restoreAgentWindow`。
  3. **衔接动画**：新增 `AGENT_WINDOW_ICON_ANIM_MS = 180` 与 `animateToBounds`（复用 `runAnimation` + `easeCubicBezier`）；`minimize()` 先 `notifyIconMode(true)` 切图标视图、再收缩到图标 bounds，动画结束后才 `setResizable(false)/setAlwaysOnTop(true)`；`restoreFromIcon()` 先放大到 `iconRestoreBounds`，动画完成后才恢复 `minimumSize`/可缩放、取消置顶并 `notifyIconMode(false)`；动画期间 `moveBy` 忽略输入，避免几何打架。
- **理由**：用户要的是 Slime 那种「点最小化变成一枚可拖动的小图标、点图标带回衔接动画」的手感。窗口层透明 + logo 全幅只留一层视觉；拖动必须在渲染层用 screen 增量驱动（CSS drag 会吞掉点击），动画复用主进程现有逐帧动画机制，跨两个窗口状态仍保持单实例/置顶/还原语义。
- **替代方案**：用 CSS drag region + 双击还原（否：单层 56px 可拖区与点击冲突，体验差）；在渲染层用 transform 假动画（否：窗口是独立系统窗口，尺寸动画必须由主进程 setBounds）；把图标窗口改为无窗口的桌面浮层（否：Electron 实现成本高且失去任务栏/置顶语义）。
- **后果**：图标态只剩一枚 56px 圆角 ∞ 图标（无窗框/无系统阴影/四角透明）；按住可拖、松手未动即还原；最小化/还原各 180ms 几何动画；拖动坐标被工作区夹取，不会拖出屏幕。
- **验证方式**：typecheck 5/5；agentWindow 单测 44 个全过（假 scheduler 逐帧推进动画）；全量 vitest 170 文件 / 1445 tests 全绿；真机 E2E（`e2e-evidence/agent-icon-frame4.log`）：
  · `E2E_AGENT_ICON`：`before=422×720`、`midBounds=259×424`（严格介于 422×720 与 56×56 之间 → 动画存在）、`iconBounds=56×56`；`iconDom.innerButton=false`、`html backgroundColor=rgba(0,0,0,0)`、整窗无边框（radius 0/透明）。
  · `E2E_AGENT_ICON_DRAG`：合成 pointer 序列（screen 增量 75/55）后 bounds `(1020,104)→(1095,159)`、`stillIcon=true`（拖动不误触还原）。
  · `E2E_AGENT_ICON_RESTORED`：单击后回到 `423×720`（≈原 422×720）。
  · 截图 `e2e-evidence/agent-icon-frame4-icon.png`：单层圆角 ∞ 图标（无外框/内框）。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-10）
- **回退条件**：透明窗口在部分 Windows 驱动上出现黑底/闪烁 → 退回不透明窗口但保留单层 logo 渲染（去掉按钮层）；拖动被 DPI 缩放影响 → 以 `screen.getCursorScreenPoint()` 采样替代屏幕坐标增量；动画导致卡顿 → 降为直接 setBounds 但保留图标单层。
- **复核时间**：用户反馈图标拖动/动画手感、或 Windows 透明窗口异常时

---
## ADR-0061 悬浮窗圆角恢复 + 衔接动画改 GPU transform（替代逐帧 setBounds）

- **背景**：用户 m03038（2026-11-11）：「现在有两个问题，首先，怎么悬浮窗成方边了？给我修剪优化一下。其次，现在的收起展开掉帧非常严重，你给我好好优化一下。」
- **根因**：
  1. **方边**：ADR-0060 为做透明图标窗把窗口设为 `transparent:true`、`roundedCorners:false`，但小窗（?mini=1）页面 `html/body/#root` 仍铺 `var(--ls-bg)` 不透明底色、App 根节点是直角 → 窗口四角透出的是页面直角底色，看起来就是方形。透明无边框窗口在 Windows 上拿不到 DWM 原生圆角，必须由渲染层裁出圆角。
  2. **掉帧**：`minimize()/restoreFromIcon()` 用主进程 `setInterval(16ms)` 逐帧 `setBounds` 缩/放**透明窗口**：每帧都要重排整页大 UI（消息列表/侧栏/输入区）并由 DWM 重新合成整窗，透明分层窗口的逐帧 resize 尤其昂贵；同时动画开始/结束切换视图会整树卸载/挂载（React 重渲染）→ 首帧卡顿 + 全程掉帧。E2E 采样虽能看到 ~60fps 的 bounds 序列，但每帧的内容重排/合成在用户侧就是可见卡顿。
- **决策**：
  1. **圆角**：小窗页面 `html[data-mini]`（含 body/#root）底色改为 `transparent`；App 根节点在小窗模式加 `borderRadius: 14` + `overflow: hidden`（`styles.appMiniShell`）；`AgentSidebar` 的 mini 圆角同步为 14。窗口仍是 `transparent:true / roundedCorners:false / hasShadow:false`，圆角由渲染层裁切、窗外为桌面。
  2. **动画改为 GPU transform**：主进程在最小化时 `capturePage()` 抓当前界面快照（dataURL），通过新事件 `chrome:agentWindowTransition` 把 `{phase, shot, durationMs, from, to}` 发给渲染层；渲染层新组件 `AgentTransitionOverlay` 用 `<img>` 全窗铺底 + `transform-origin:0 0` + `translate/scale`（cubic-bezier(0.22,0.61,0.36,1)）做几何动画：
     - **minimize**：窗口几何**保持不动**（不再逐帧 setBounds）；快照从整窗 scale 1 缩向右上角图标矩形；180ms 后主进程一次性 `setBounds(iconBounds)` 落位 + `notifyIconMode(true)`（图标视图 120ms 淡入）。
     - **restore**：窗口**瞬间**跳到目标 bounds（透明、内容只有快照）；快照从图标矩形展开成整窗；180ms 后恢复最小尺寸/可缩放并 `notifyIconMode(false)` 挂回真实 UI。
     - 动画期间 App 内容 `display:none`（`transitionActive`），页面只绘制这一张 `<img>`，不触发大 UI 重排；`html[data-mini-transition]` 底色透明。
     - 截图失败自动退回 ADR-0060 的旧行为（切图标视图 + 逐帧 setBounds），保证功能可用。
  3. **类型/契约**：`onTransition` payload 增加 `from/to` 窗口矩形；新增事件 `chrome:agentWindowTransition`（contracts/schemas + gen + types.d.ts 同步）。
- **理由**：Windows 透明窗口逐帧 resize 是掉帧本质；把视觉运动交给合成器的 CSS transform（GPU）后，主线程只做一次截图 + 一次落位，动画不受页面重排/DWM 重合成影响；圆角在透明窗下本来就必须由渲染层负责，正好与 transform 过渡共用同一套页面。
- **替代方案**：回到不透明窗口（否：拿不到透明圆角，图标窗又会出方角/双层底板）；缩短动画时间掩盖（否：治标不治本，且用户已明确「好好优化」）；把动画做进页面内（窗口尺寸仍要变，无法只靠页面 transform 完成窗口化最小化）。
- **后果**：小窗四角恢复圆角（透明窗外露桌面）；最小化/还原变成 GPU 平滑缩放，动画期间视觉内容为界面快照（与真实 UI 同图，展开结束时无感切换）；窗口几何只在动画起止各跳一次（内容位置对齐，不可见）；图标出现 120ms 淡入消除硬切。
- **验证方式**：
  - `pnpm -r typecheck` 5/5；`pnpm gen`/`pnpm check`/`pnpm build` 通过；`agentWindow` 单测 44 个全过；全量 vitest **170 文件 / 1445 tests 全绿**。
  - 真机 E2E（`e2e-evidence/agent-icon-gpu2.log`）：`midDom={overlay:true, setting:"1", appHidden:"none"}`；minimize 期间 bounds samples 恒为 `420×722`（逐帧 resize 已移除），约 277ms 时一次性落到 `56×58`；`mid.png` 显示快照缩到右上角、窗口其余透明；restore 中途 `overlay:true、iconView:true、bounds=420×723`；`restore-mid.png` 显示快照展开中；还原后 `420×724`。
  - 圆角证据：`agent-icon-gpu2-agent-window.png` 四角 alpha=0（14px 圆角），PIL 合成浅色棋盘底后 `agent-icon-gpu2-corners.png` 可清楚看到圆角；图标态仍是单层 `∞` 图标（`agent-icon-gpu2-icon.png`）。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-11）
- **回退条件**：截图接口在某些 GPU/远程桌面下返回黑图 → 自动退回逐帧 setBounds（已有 fallback）；CSS transform 在极旧内核异常 → 同上；用户觉得快照过渡「不是实时 UI」→ 可把 durationMs 降到 120ms 或改回窗口 resize。
- **复核时间**：用户再反馈悬浮窗口手感、或 Windows/Electron 升级改变透明窗合成行为时

---
## ADR-0062 收起/展开直接搬 Slime float：面板几何过渡 + 内容钉住裁切 + 图标淡入淡出（替代 ADR-0061 快照 transform）

- **背景**：用户 m03326（2026-11-11，附 15s 录屏）：「如视频所示，你现在的展开与收起做得非常烂，实在不行你就去 slime 那边直接『抄作业』吧，现在你的问题在 slime 那边都有过，而且基本都被解决了，你直接去搬代码吧。」录屏显示旧实现：面板收起/展开有明显跳变、出现细条残影、过渡不连续（60fps 录屏里 1~2 帧完成）。此前 ADR-0061 已做「快照 + GPU transform」，但用户仍认为观感差。
- **根因（与 Slime 对照）**：
  1. ADR-0061 是**截图整体缩放**（transform scale），文字/控件跟着缩小变形；Slime 的 float 过渡是**窗口宽高裁切 + 内容尺寸钉死**（`body.slime-freezing .chat-scroll { width: var(--slime-freeze-w) !important; flex: 0 0 auto }`，祖先 `overflow:hidden`）——视觉上「窗口收起、内容被裁掉并淡出」，不是整张图缩小。
  2. ADR-0061 依赖 `capturePage()`，点击最小化后要等截图（几十 ms）才开始动画 → 手感有延迟；Slime 是纯 DOM/CSS 过渡，点击即动。
  3. ADR-0061 的 restore 先 `setBounds(target)` 再发事件，渲染层可能有一帧「整窗/大图标」闪烁；Slime 始终在同一页面里，不存在换窗闪烁问题。
  4. 之前动画时长 180ms 明显快于 Slime 的 `FLOAT_TRANSITION_MS = 400` 与 `cubic-bezier(0,0,0.2,1)`；Slime 用户实测「过渡帧对了但优化不行、表现很卡顿」后，正是用「钉内容尺寸 + 裁切」修掉的。
- **决策（按 Slime `minimizeFloat / restoreFloat / startFloatGeometryFade` 的结构移植）**：
  1. **面板化**：`?mini=1` 内容包进 `[data-agent-panel]`（`position:absolute`、`borderRadius:14`、`overflow:hidden`、底色 `BRAND.ink`）；真实 UI 放内层 `div`，动画期间 `width/height` 钉死为**起始窗口像素尺寸**（`agentFloatFreeze`），只改面板的 `left/top/width/height` → 内容零重排，祖先裁切；普通状态内层 100% 自动布局。
  2. **minimize**（窗口 bounds 不动）：主进程发 `chrome:agentWindowTransition { phase:"minimize", durationMs:400, from:{0,0,w,h}, to:图标相对矩形 }`；面板 `left/top/width/height` 400ms `cubic-bezier(0,0,0.2,1)` 过渡到图标位置；内容透明度由 rAF 按面板宽度进度驱动（Slime `startFloatGeometryFade`：宽度 >90% 区间全亮、90%→45% 区间 smoothstep 淡出），图标层 `opacity 180ms ease 120ms` 淡入（Slime 原参数）；过渡结束主进程一次性 `setBounds(iconBounds)` + `notifyIconMode(true)`，渲染层把面板重置为 56px 窗口铺满（内容仍钉住），视觉与动画终点完全重合。
  3. **restore**：主进程先算「舞台」bounds = 图标 bounds ∪ 目标 bounds（处理图标被拖到远处），`setOpacity(0)` 防换窗闪烁 → 通知 `phase:"restore"` → `setBounds(stage)` → 40ms 后 `setOpacity(1)`；渲染层从图标相对矩形展开到目标矩形（同样 400ms/ease）；结束再 `setBounds(target)` + `notifyIconMode(false)`，渲染层弹回普通布局。图标层固定 56px logo（不随面板缩放），restore 时快速淡出。
  4. 删除快照链路：`capturePage` / `iconTransitionShot` / `AgentTransitionOverlay` / 1500 行级的过渡截图逻辑全部移除；`AGENT_WINDOW_ICON_ANIM_MS = 400`；事件 payload 改为 `{phase,durationMs,from,to}`（不再有 shot）。`from/to` 是窗口内 CSS px 相对矩形。
  5. 起点几何挂载那一帧 `transition:none`（否则浏览器会从上一状态插值出「先摊满再缩」的假动画），下一帧再启用 transition——与 Slime 先设起点样式再触发过渡一致。
- **理由**：Slime 已经在同类问题上给出可复现的解法：过渡只动外框、内容尺寸钉死 + 裁切 → 每帧只有面板几何与合成，不触发大 UI 重排；400ms/ease 是 Slime 实机调过的手感；点击即开始动画（无截图延迟）。
- **替代方案**：继续改进快照 transform（否：视觉是缩放而非裁切，与 Slime 观感不同，且仍需等待截图）；直接换回逐帧 setBounds（否：ADR-0061 已证明掉帧）；把 float 改成主窗口内页面浮层（否：产品形态是独立系统窗口，改动过大且会推翻既有 Agent 窗口语义）。
- **后果**：收起 = 面板从整窗裁切收拢到右上角图标、内容淡出、图标淡入；展开 = 图标位置长回整窗、内容淡入；窗口只在动画起止各跳一次（内容位置对齐，肉眼不可见）；图标被拖远也能从图标位置展开回来。图标态点击/拖动保留。
- **验证方式**：
  - `pnpm -r typecheck` 5/5；`pnpm gen`/`pnpm check`/`pnpm build` 通过；`agentWindow` 单测 44 全过；全量 vitest **170 文件 / 1445 tests 全绿**。
  - 真机 E2E（`e2e-evidence/agent-float-final.log`）：minimize 中途 `midDom.panel = 197×314`（起点 420×722、终点 56×56，`transition: 0.4s,0.4s,0.4s,0.4s`）、窗口 bounds 全程保持 `420×722`（无逐帧 resize）；结束后 `iconBounds = 56×58`；restore 中途 `panel = 279×464`（舞台 488×723，从图标相对位置展开）、结束后窗口回到 `420×724`；`agent-float-final-mid.png` / `-restore-mid.png` 可见「面板裁切 + 内容淡出/淡入 + 图标淡入/淡出」，`-icon.png` 为单层 56px ∞ 图标。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-11）
- **回退条件**：低配机器上 400ms 仍掉帧 → 降 durationMs（200~300）或改为只做透明度淡入淡出；面板裁切在 DPI 缩放下出现缝隙 → 用 `getBoundingClientRect` 整像素取整；用户更喜欢快照缩放观感 → 保留 ADR-0061 的 `AgentTransitionOverlay` 作为可选分支（当前已删除，需要时从 git 历史取回）。
- **复核时间**：用户再反馈收起/展开手感、或后续加入小窗缩放/贴边交互时

---
## ADR-0063 浏览器管理整页/搜索引擎/加载失败页的收口设计

- **背景**：用户 2026-11-11 指出四组问题：① 历史页「清除历史」按钮不可用且颜色暗淡；需要「点击后行内平滑出现勾选框 + 列表下方同宽操作条（全选/取消/删除）」（图一）。② 历史/下载/收藏空态是虚线框、不应有；顶栏三个按钮（保存页面/设置/刷新）全部一样且多是无用入口（图一~三）。③ 设置·通用的「默认搜索引擎」分段只有 Bing 生效，要求删除并单开「搜索引擎」栏目（Chrome 式列表，只保留 Bing/Google/百度）；地址栏左侧放大镜换成引擎图标下拉，开始搜索后恢复无功能放大镜（图四/五/六/七/八）。④ 所有搜索加载/失败界面只有初始页或一条提示，要求补齐加载页与分类失败页（图九/十）。
- **决策**：
  1. **历史批量删除**：`browserHistoryStore.remove(urls)` + 契约 `browser:historyRemove`（urls 1..500，幂等，返回 removed）；历史页点「清除历史」进入选择模式：行首勾选框以 `width/opacity/margin` 140ms 过渡平滑出现，列表下方同宽 `selectionBar`（fadeUp 160ms）含「全选」checkbox（全选/取消全选）、已选计数、取消、删除；删除后重新拉取并退出选择模式。清除历史按钮改品牌赭石色实底（不再是 0.5 透明禁用态）。
  2. **空态与顶栏**：`StateBox` 空态改为纯居中文字（去虚线框/底色），错误态保留淡红提示块；历史/下载/收藏顶栏删除「保存当前页面」「刷新」，改为页面互跳按钮（历史记录/下载内容/收藏夹/设置），设置页仍由返回退出。
  3. **搜索引擎单一产地**：偏好枚举 `bing|google|baidu`（删除 DuckDuckGo；`mergePreferences` 对旧 `duckduckgo` 值静默迁移为 Bing，避免旧配置把整份偏好判非法）；`buildSearchUrl`/`searchUrlFor` 同步；设置新增「搜索引擎」分区（`settings.searchengine.*`），Chrome 式列表：图标 + 名称 + 域名 + 单选圆点，仅 Bing/Google/百度；通用页删除「默认搜索引擎」分段。
  4. **地址栏引擎切换**：新建标签页（`currentUrl` 为空）时地址栏左侧显示当前引擎图标按钮，点开为引擎菜单（`usePopover("browser-engine")` 全局独占/点外收起），显示图标+名称，选中后立即写偏好；一旦有页面 URL（搜索/导航后）恢复为普通无功能放大镜，避免中途切换造成搜索目标不一致。新增 `engine-bing/google/baidu.svg` 品牌图标与 `browser.searchEngineChoose` 文案。
  5. **加载页/失败页**：shell 侧 `WebContentsAdapter` 新增主框架加载事件（`did-start-navigation` 主框架、`did-stop-loading`、`did-fail-load`，过滤 -3 ERR_ABORTED 与非主框架），`BrowserHost.TabState` 增 `loading`/`loadFailure`，并在 `applyLayout` 中对 `loading || loadFailure` 的标签隐藏原生视图 —— 让 DOM 的 `BrowserSurface`（原 StartPage）接管：加载页 = logo 呼吸 + 不确定进度条（不伪造百分比）+ 目标 host + 提示；失败页 = 按 Chromium net error 分类（离线/域名/拒绝/超时/证书/拦截/未知）的图标、标题、一句话解释、错误码、重试/返回上一页。分类函数独立到 `packages/ui/src/browserFailure.ts` 以便单测。
- **理由**：这些页面此前只有「列表 + 一条 toast」，操作入口缺失且空态用虚线框装点，是「能用但不像成品」的典型；加载/失败必须由宿主让出原生视图（WebContentsView 永远盖在 DOM 之上，无法用 DOM 覆盖），否则只能看到 Chromium 白屏/默认错误页。搜索引擎做成「新建页可切、已打开页不可切」正是为了避免用户搜索到一半换引擎导致结果页与预期不符。
- **替代方案**：历史删除做成「一键清空全部」（否：用户明确要勾选式）；搜索引擎继续用设置里的分段（否：用户要求单开栏目 + Chrome 式列表）；地址栏始终可切换引擎（否：中途切换会让地址栏显示的引擎与结果页不符）；错误页用 toast/Chromium 默认页（否：无法分类、无法重试）。
- **后果**：历史支持勾选批量删除；空页/管理页顶栏变成页面跳转；设置多出搜索引擎分区；地址栏有引擎图标切换；加载/失败有专门页面与重试。原生视图在加载期间隐藏，首次加载会有短暂「加载页」过渡（可接受；失败时不再露出 Chromium 默认错误页）。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **171 文件 / 1449 tests**（新增 browserSurface 分类 2 + history remove 2）；`pnpm gen/check/build` 通过；真机 E2E（数据副本，种子历史 3 条，`e2e-evidence/final-ui.log`）E2E_EVAL ok:true：历史行 3、清除按钮可用、勾选框可见宽 >10、全选后已选 3、删除后历史 0；下载/收藏空态文字存在且 `border-style: none`；顶栏有 下载内容/收藏夹/历史记录/打开设置、无 保存当前页面；设置·搜索引擎 3 行且点百度后偏好为 baidu；新建页引擎图标出现、菜单 3 项、切 Bing 后偏好为 bing（图标同步 engine-bing）；加载页（logo+进度条）出现；访问 `http://127.0.0.1:19444/` 出现 `data-browser-error="refused"` 错误页（错误码 -102）且含重试/错误码。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-11）
- **回退条件**：历史数据量过大导致勾选卡顿（改为虚拟列表）；搜索引擎增删需求出现（把静态三引擎改为可配置 store）；Chromium 事件语义变化导致加载页不消失（退回 did-stop-loading 兜底 + 超时强制收）。
- **复核时间**：浏览器加载事件/错误码变化、地址栏交互再调整时

---
## ADR-0064 浏览器管理三页：左侧索引栏（搜索 + 分类）+ 批量操作条上移/对齐修复

- **背景**：用户 m04298 对 ADR-0063 的成品提两点：① 历史页「全选」那一行应放在列表**最上方**，且这一行「是凸出来的」——与上方/下方记录没有对齐；② 希望像 Edge 的下载/收藏/历史页那样，在三个管理页**左侧**做一个搜索索引 + 分类栏，利用每行左侧的大片空白。
- **根因**：
  1. **凸出/不齐**：`ChromePage` 的行用 `button`/`div` 且 `width: 100%`，但未设 `box-sizing`（content-box 下 100% + 左右 padding 20px + 边框 2px = 超出容器 22px）；操作条没有显式宽度（按容器宽），于是行比操作条宽 22px → 视觉上「凸出去」；同时操作条在列表下方，与行不同宽所以更明显。
  2. **左侧空白**：列表直接满宽铺在内容区，标题/URL 只占左侧一小段、右侧只剩时间/徽标，中间大片留白；没有搜索与分类入口，只能整页滚动。
- **决策**：
  1. **布局改为三栏（Edge 式）**：`main` 非设置页用 `bodySplit` = 左 `aside`（固定 216px：顶部搜索框 + 分类列表）+ 右 `contentCol`（可滚动内容）。设置页保持整页 Settings 不变。
  2. **搜索**：`searchQuery` 内存过滤（历史匹配 title/url；下载匹配 filename/savePath；收藏匹配 title/url），大小写不敏感；无匹配显示「没有匹配的内容」空态。
  3. **分类**：历史=全部/今天/昨天/更早（按 `visitedAt` 与本地零点比较）；下载=全部/进行中/已完成/已取消/失败（按 state）；收藏=全部/最近 7 天/更早（按 createdAt）。分类在本地数组上过滤，不额外拉数据；切换页面时清空搜索/分类/批量选择。
  4. **批量操作条**：移入 `listWrap` 顶部、位于列表行之前；`listWrap`/`list`/`selectionBar`/`row`/`dlRow` 全部 `box-sizing: border-box` 且宽度 100%，操作条与每一行严格同左缘/同右缘；全选只作用于**当前可见**（搜索/分类过滤后）的行，筛选/搜索变化时清空已选，避免误删被过滤掉的条目。
- **理由**：搜索+分类是列表页的基本导航能力，且三栏布局天然把「行内右侧留白」变成左栏，不再需要横向撑满；对齐问题本质是盒模型少写 `box-sizing`，不修的话任何 `width:100%` + padding 的控件都会溢出容器。
- **替代方案**：把操作条固定在页面顶栏下方（否：会与顶栏页面按钮混在一起，且搜索/分类切换后视觉断层）；用完整虚拟列表 + 多列（否：数据量 500 内，三栏足够）；分类走后端查询（否：数据已在内存，多一次 IPC 无收益）。
- **后果**：三个管理页左栏可搜索/按类筛选；批量操作条在列表最上方并与行严格对齐；设置页不受影响。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **171 文件 / 1449 tests 全绿**；`pnpm gen/check/build` 通过；真机 E2E（数据副本，`e2e-evidence/final-ui.log`）E2E_EVAL ok:true：历史页 aside 搜索框存在、分类 4 项；搜索 "zzz-not-found" → 无行 + 「没有匹配的内容」，搜索 "example" → 3 行，清空恢复 3 行；「更早」分类 → 0 行；批量操作条 `barAboveRows=true`、与首行左右缘偏差 ≤1.5px；后续删除 3 条历史仍 ok。截图 `e2e-evidence/final-ui-history.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-11）
- **回退条件**：后续需要「按站点分组/按目录分类」等更强索引 → 换成可折叠分组或后端聚合接口；行数超过虚拟列表阈值 → 只虚拟化右侧内容列，左栏保持静态。
- **复核时间**：浏览器管理页再增加新页面类型（扩展/权限等）时统一套用该三栏布局

---
## ADR-0065 新建标签页重做：搜索 / Vibecoding 拨片 + 模型胶囊 + 会话页平滑过渡

- **背景**：用户 m04399 指出：① 启动应有「新建标签页」，且像正常浏览器一样，关闭最后一个标签页要关闭浏览器（当前无初始标签、关闭语义缺失）；② 新标签页要有搜索输入框，搜索引擎用设置里用户选的引擎（布局参考 Edge 新标签页）；③ 搜索框上方做左右拨片，切换「搜索 / 进入 Vibecoding」；进入 Vibecoding 后输入区变成发送栏、下方出现模型选择（参考图三）；发送后出现正常会话页（参考图四），发送栏平滑下移、整页渐入为会话页。
- **决策**：
  1. **初始标签页**：`App` 启动后一次性检查 `browser.listTabs()`，为空则 `newTab({})` 补一个空白标签；空 URL 标签在标签条统一显示 i18n「新建标签页」（`BrowserTabs` 以 `tab.url ? tab.title : tr(...)` 渲染）。
  2. **关闭最后一个标签页 = 关闭浏览器**：`App.closeTab` 在 `tabs.length <= 1` 时调用 `api.window.close()`（主窗口关闭 → 应用退出），其余情况仍走 `browser.closeTab`。
  3. **StartPage 重构为三态**：`loading`（加载页）、`error`（分类错误页，沿用 ADR-0063 的分类）、`ntp`（新建标签页，含 search/vibe 两个子模式）、`chat`（Vibecoding 会话页）。错误/加载态仍是原生视图隐藏时的 DOM 接管。
  4. **搜索页**：品牌 logo + 「搜索 / Vibecoding」滑块式拨片（thumb `translateX` 过渡 220ms）+ 大标题 + 52px 搜索框（左侧显示偏好搜索引擎图标，回车/按钮提交；`App.navigate` 用偏好引擎解析 URL/搜索词）+ 「最近访问」快捷入口（`browser.history` 前 6 条，没有则隐藏）。
  5. **Vibecoding 输入态**：自动增高的 textarea + 底部「模型胶囊」（预载 `modelGroups`，点开分组列出所有供应商模型，选择即 `chooseModel` 切活跃供应商/模型）+ Enter 发送 / Shift+Enter 换行提示 + 发送按钮。
  6. **发送 → 会话页**：`App.startVibe(text)`：当前会话没有消息就直接用它，否则先 `chat.newSession()` 再向新会话发送（避免把新标签页的 vibe 混进旧对话）；`StartPage` 收到动作后立即切 `chat` 视图。会话页复用 `MessageList`（含思考/回滚/重新生成）渲染当前会话，底部发送栏支持继续发送与停止；CSS `vibeComposerDrop` 380ms（从上方 -38vh 滑入）+ `vibePageIn` 260ms 实现「发送栏下移、整页渐入」。发送栏再次发送走 `sendText`，会话由 App 统一流式管理。
  7. **入口复用**：新标签页动作全部通过 App 注入（`onSubmitSearch/onOpenUrl/onStartVibe/onSendMessage/onStop/onChooseModel`），StartPage 不持有会话状态；模型清单在 App 启动后预载一次，胶囊点开不额外请求。
- **理由**：新标签页是「无事可做」时最高频的界面，搜索与 Vibecoding 是两个明确意图，用拨片分流比在地址栏里塞模式更直观；会话页复用既有 `MessageList` 与 App 流式状态，避免在浏览器区重建一套聊天状态机。关闭最后标签=关窗是浏览器肌肉记忆，缺失会让人误以为关不掉。
- **替代方案**：Vibecoding 直接跳到右侧会话栏（否：用户明确要「整页渐入为正常会话页」）；搜索框只做 URL 导航（否：用户要求用设置的搜索引擎）；模型选择复用侧栏 Composer 弹层（否：Composer 弹层锚点在侧栏，跨区复用会同时打开两个菜单）。
- **后果**：启动即有「新建标签页」标签，关闭它即退出主窗口；新标签页可在搜索/编程两种意图间切换；Vibecoding 发送后进入整页会话（右侧栏仍同步显示同一会话）；模型可在此处直接切换。真实模型回复仍由既有 chat 流式链路驱动。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **171 文件 / 1449 tests 全绿**；`pnpm gen/check/build` 通过；真机 E2E（`e2e-evidence/ntp.log`，E2E_EVAL ok:true）：启动含「新建标签页」标签、拨片双按钮存在、搜索引擎图标 `engine-bing`；输入 `loopsoar agent` 提交后活动标签 URL 变为 `https://cn.bing.com/search?q=loopsoar%20agent`；切 Vibecoding 出现输入框与模型胶囊（菜单 8 项）；点击发送后出现 `data-browser-state="chat"`、底部输入 `vibe-composer-drop` 存在、用户消息「快速排序」可见。截图 `e2e-evidence/ntp-search.png`、`ntp-vibe.png`、`ntp-chat.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-11）；关闭最后标签→关窗为源码路径（E2E 不主动退出被测进程，未纳入自动断言）
- **回退条件**：会话页在浏览器区与右侧栏双写造成状态分叉 → 收敛为单向（侧栏只读或隐藏）；搜索引擎需要更多家 → 与 ADR-0063 的搜索引擎设置共用枚举；关闭最后标签改为「保留空标签」产品决策 → 仅改 App.closeTab 一行。
- **复核时间**：新标签页交互再调整、或浏览器管理页需要与 Vibecoding 互通时

---
## ADR-0066 Vibecoding 会话页卷轴只显示上半截/歪斜：MessageList 不能套额外滚动容器的修复

- **背景**：用户 m04564 截图（Vibecoding 会话页）指出：右侧卷轴拖拽条「歪了、只有上半部分」。截图里卷轴（TopicRail 双股波浪线）只画在内容顶部约 1/3 高度，且不跟随整页高度。
- **根因**：`VibeChatView` 把 `MessageList` 包进了一个自建的 `chatScroll` 容器（`overflowY:auto` + 自己滚到底），而 `MessageList` 内部结构是 `messageArea`（`position:relative; flex:1`）→ `chat-scroll`（自身滚动容器）。父级不是 flex 时 `flex:1` 不生效，`messageArea` 高度塌成内容高度；`TopicRail` 是 `position:absolute; top:6; bottom:6`，于是只在「内容高度」范围内绘制 → 看起来只画了上半截；外层再滚动，视觉上更歪。E2E 断言 `TopicRail` 高度 < 400px 即可复现。
- **决策**：`chatScroll` 改成**纯布局容器**（`flex:1; minHeight:0; display:flex; flexDirection:column`，无 `overflow`、无自建 padding），让 `MessageList` 作为直接 flex 子项撑满整个会话区，由 `MessageList` 自己的 `chat-scroll` 负责滚动与卷轴定位；删除 `VibeChatView` 里「外层滚到底」的 effect（MessageList 已自带跟随逻辑）。新标签页/加载页/错误页不变。
- **理由**：卷轴是「聊天滚动容器」的装饰层，必须挂在同一个滚动容器上；多套一层滚动会让「可视高度/内容高度」分裂成两份，任何按百分比/绝对定位的装饰都会错位。这是布局契约问题，不是 TopicRail 的 bug。
- **替代方案**：给 MessageList 加 `hideRail` 选项并在外层自绘一个简化滚动条（否：丢失卷轴交互与既有 Parameters）；把 TopicRail 移到外层（否：它依赖内部 scroller 的 scrollHeight 计算锚点与拖动映射）。
- **后果**：Vibecoding 会话页卷轴恢复贯穿整页高度、跟随内部滚动；`MessageList` 原有跟随/折叠/回滚等行为不变。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **171 文件 / 1449 tests 全绿**；`pnpm gen/check/build` 通过；真机 E2E（`e2e-evidence/ntp.log`）：会话页 `.topic-rail` 高度 > 400px、rail 底边与聊天区底边偏差 < 40px、发送栏下移类存在、用户消息可见；截图 `e2e-evidence/ntp-chat.png` 可见卷轴贯穿整页右侧。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-11）
- **回退条件**：若后续要在会话页加「外层统一滚动」的产品需求，需要同步改造 TopicRail 以接受外部 scroller（而不是把 MessageList 塞进滚动容器）。
- **复核时间**：会话页再调整滚动/高度结构时

---
## ADR-0067 新标签页模型菜单被拨片文字穿透：浮层改用 portal 脱离页内层叠上下文

- **背景**：用户 m04624 截图：Vibecoding 输入态的模型胶囊展开供应商/模型菜单后，上方「搜索 / Vibecoding」拨片的文字和图标**穿透显示在菜单之上**（菜单被压在拨片下面），用户要求修复。
- **根因**：菜单虽然 `position:absolute; z-index:60`，但它挂在 `.modelChipWrap → .vibeBar → .vibeBox → .modeBody` 内部；`.modeBody` 带 `animation: vibePageIn`（keyframes 含 `transform`），**动画/变换会创建新的层叠上下文**，把菜单的 z-index 封在内部；而拨片按钮 `position:relative; z-index:1` 在更外层上下文里，于是拨片内容能盖在菜单上。仅调大菜单 z-index 无效（逃不出祖先层叠上下文）。
- **决策**：
  1. 模型菜单改为 `createPortal(..., document.body)` + `position:fixed`：打开时读取胶囊按钮 `getBoundingClientRect()`，按视口计算 `left`（夹在 8..innerWidth-328）与 `bottom`（胶囊上方 8px），z-index 1000，彻底脱离页内层叠上下文与动画影响。
  2. 保留 `usePopover("vibe-model-chip")`：点菜单外/Esc 收起、其它浮层打开时互斥；portal 菜单带 `data-popover`，外部点击检测按 DOM 归属判断，仍生效。
  3. 菜单宽度固定 320、最大高度 320 滚动，与原先一致。
- **理由**：页面内浮层只要祖先链上存在 transform/animation/filter/will-change 就可能被「降级」到局部层叠平面，z-index 不再是全局排名；portal 到 body 是唯一稳定解，也让菜单不受 `.ntpInner`/`overflow` 裁切影响。
- **替代方案**：去掉 `.modeBody` 的入场动画（否：会损失体验且其它祖先仍可能变化）；把拨片 z-index 降到 0（否：治标不治本，换个动画又复现）；用原生窗口 Popover（否：轻量菜单不值得开独立窗口）。
- **后果**：模型菜单始终浮在最上层（含覆盖拨片/标题），点击选择/外点收起行为不变；会话页下方的紧凑模型胶囊复用同一实现。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **171 文件 / 1449 tests 全绿**；`pnpm gen/check/build` 通过；真机 E2E（`e2e-evidence/ntp-menu.log`，E2E_EVAL ok:true）：打开菜单后取「菜单与拨片重叠点」的 `elementsFromPoint` 最顶层元素 → `closest("[data-vibe-model-menu]")` 为真；`menu.parentElement === document.body`；菜单 8 个可选项。截图 `e2e-evidence/ntp-menu.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-11）
- **回退条件**：后续改用统一的全局浮层管理器（例如把所有菜单都走 portal）→ 删除本组件内联定位；窗口缩放/滚动时菜单需要跟随 → 增加 resize/scroll 重算锚点（当前打开期间不跟随，先关闭再开即可）。
- **复核时间**：新标签页/会话页浮层再增加时，优先直接复用 portal 方案

---
## ADR-0068 Vibecoding 主页面：控制条（工作区/模型/推理/模式）+ 右侧会话列表（工作区树/搜索）+ 收起态会话竖条

- **背景**：用户 m04698 指出：① 主页面直接会话目前只有模型选择，推理强度等控制缺失；② 会话工作区选择放进「+」里（点击展开列表，含已有工作区与「新加工作区」，后者弹原生文件夹选择器）；③ 不在会话列表里主动选会话而直接回话时，应自动新建会话；④ 会话选择放在右侧栏；⑤ 选择 Vibecoding 后侧栏会话按钮平滑变为「会话列表」按钮，展开后按工作区嵌套（工作区 → 会话，默认全展开）；⑥ 侧栏收起时在右侧空白列显示简易会话竖条：悬停显示标题、最下方加号新建会话、悬停约 1 秒自动展开会话列表，列表顶部有标题搜索（相关度排序、精确优先）。
- **决策**：
  1. **Vibe 控制条**（`StartPage.tsx`）：输入区底部统一为 `[+ 工作区] [模型胶囊] [推理 chip] [Build/Plan]`。模型胶囊仍是现有跨供应商分组菜单；推理 chip 使用模型声明的 `effortOptions`（为空则不显示），菜单用 portal 固定定位（ADR-0067 同款）；Build/Plan 一键切换。新标签页输入态与会话页底部输入栏复用同一 `VibeControls`。
  2. **工作区选择**：`+` 打开 portal 菜单列出 `workspaces`（活动项打勾）+「新加工作区…」；新建调用 `api.workspace.create({})`（原生文件夹选择器）并设为活动工作区；选择调用 `api.workspace.select`。App 启动预载 `workspace.list()`，新建会话沿用 shell「活动工作区」绑定（`chat.newSession` 使用 `getActiveWorkspaceId`）。
  3. **直接回话 = 新会话**：新增 `pickedSessionRef`，只在用户从会话列表主动 `switchSession` 时置 true；`startVibe` 仅在该标记为真时续接当前会话，否则**总是** `chat.newSession()` 再发送（发送后清标记）。会话页内继续发送仍走 `sendText` 保持同会话。
  4. **会话列表面板**（`SessionListPanel.tsx`）：替换侧栏原扁平下拉；顶部搜索框；无搜索词时按工作区分组（默认展开、点组头折叠）；搜索用纯函数 `sessionSearch.ts` 打分（标题精确 1000 > 前缀 800 > 包含 600 > 预览 300 > 多 token 200），同分按更新时间倒序，精确命中自然排第一；底部「新建会话」。
  5. **侧栏按钮两态**：`AgentSidebar` 接收 `vibeMode`；会话 chip 用双层交叉淡入（180ms）在「会话标题 / 会话列表」之间切换图标与文案。弹层宽度 300→340 以容纳工作区树。
  6. **收起态会话竖条**：`mode === "collapsed"` 时在 48px 列渲染 `sidebar-collapsed-rail`（不卸载侧栏内容，保持宽度动画）：会话首字头像（`title` 原生悬停标题）、当前会话赭石高亮、最下方加号；整条悬停 1000ms 触发 `onExpandFromRail` → App 切回 docked 并在宽度过渡后（380ms）打开会话列表；点竖条条目 = 切会话 + 展开。
- **理由**：工作区是会话归属的唯一上下文，放在发送栏 `+` 比藏在设置/侧栏更深的位置更贴近「开始写之前先选项目」的心智；直接回话默认新会话避免把新想法接进旧对话；工作区→会话树与收起竖条是文件式导航的自然延伸，也让 48px 列不再空白。
- **替代方案**：工作区选择放顶栏下拉（否：用户明确要「+」）；搜索走后端索引（否：会话量级小，内存打分即可）；收起竖条点击才展开（否：用户要求悬停一段时间自动展开）；Vibecoding 按钮直接整体重绘（否：交叉淡入更平滑）。
- **后果**：主页面可完整控制工作区/模型/推理/模式；直接发送默认开新会话；侧栏会话列表按工作区嵌套并支持相关性搜索；收起态出现可悬停展开的会话竖条。`pickedSessionRef` 是唯一「是否续接」的判据，后续若增加「从列表选中并回到新标签页」的显式状态，需同步维护该标记。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **171 文件 / 1451 tests 全绿**（新增 `tests/ui/sessionSearch.spec.ts` 2 条）；`pnpm gen/check/build` 通过；真机 E2E（`e2e-evidence/sidebar.log`，E2E_EVAL ok:true）：Vibe 控制条/工作区 + 菜单/模型/推理 chip/Build→Plan 切换均通过；工作区菜单含「新加工作区…」；直接发送后会话数 +1（before=1 → after=2）且当前会话变化；Vibecoding 下侧栏按钮显示「会话列表」；面板含搜索框、1 个工作区分组、2 条会话、新建按钮，精确标题搜索排第一；收起后竖条出现 2 个会话条目（含 title）+ 加号，悬停约 1.65s 后侧栏恢复 docked 且会话列表自动打开。截图 `e2e-evidence/vibe-controls.png`、`session-list.png`、`sidebar-collapsed.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）；「新加工作区…」打开的是原生文件夹选择器（受系统模态限制，E2E 只断言入口存在，不自动操作系统对话框）
- **回退条件**：会话量级变大（>2000）后搜索需要后端索引；工作区树需要拖拽排序时改用手写树组件；收起态竖条若与悬浮小窗冲突，改为点击展开。
- **复核时间**：会话列表/工作区模型再调整时

---
## ADR-0069 Vibecoding 输入区加号/胶囊统一、侧栏按钮图标平滑切换与会话列表面板版式

- **背景**：用户 m04963（附 4 张对照图）指出：① 左侧 Vibecoding 输入区的「+ 工作区」不对，要和右侧会话输入区的「+」一样（点开是「更多操作 → 附件」），并在其上增加「工作区」项（点击弹原生文件资源管理器选文件夹作为工作区）；常态应像右侧一样只显示一个圆框包住的加号；② 其余胶囊按钮深/浅不一，末尾还有省略号，需要统一；③ Vibecoding 下右侧边栏的「展开会话」按钮应**平滑变成列表图标**（图二 → 图三），点击展开的会话列表按图四版式排好（工作区为标题、会话单行 + 右侧时间）。
- **根因**：① `WorkspaceControl` 是「+ 工作区名」文本胶囊，样式与右侧 `Composer` 的圆形 `+`（`.composer-plus`）不同；且其菜单只有工作区，没有附件入口。② 模型胶囊自带深色底（`BRAND.ink`）+ 自己的 maxWidth/ellipsis，工作区/推理/模式胶囊依赖全局 `.chip` 的浅底；模型与推理胶囊末尾还有 `more`（三点）图标，被误认为省略号。③ Vibecoding 判断只让会话 chip 整块交叉淡入；用户期望的是**图标**（星标/会话图标 → 列表图标）单独平滑切换；同时会话面板的版式是两行 meta，与参考图四的「工作区标题 + 单行会话 + 右侧时间」不一致。
- **决策**：
  1. **圆形 + 菜单**（`StartPage.tsx`）：`WorkspaceControl` 改为 `PlusControl`：26×26 圆形按钮（与 `Composer` 的 `plusBtn` 同尺寸/边框）、常态无文字；菜单顺序 = 「工作区」标题 → 已有工作区（当前打勾）→「新加工作区…」（`workspace.create` 原生文件夹选择器）→ 分隔线 →「更多操作」→「附件」。附件选择与右侧输入区共用 App 的 `pickAttachmentPath()`（原生文件选择器），路径以 `composer.insertAttachment` 模板插入当前草稿。
  2. **胶囊统一**：新增单一 `controlChip` 样式（height 24、padding 0 9、border-radius 999、同一边框与同一半透明白底、字号 11），模型/推理/模式全部使用它；删除末尾 `more` 图标；模型文案改为纯 `provider.model`（不再拼接 provider 前缀导致超长截断），推理文案保持「推理：x」。`compact` 会话页只改高度（22）。
  3. **侧栏按钮图标平滑切换**：`.sidebar-toggle` 的星标改为双层图标（`agent` ↔ `list-details`），`vibeMode` 时交叉淡入 + scale 180ms；会话 chip 仍保留标题/「会话列表」文案交叉淡入。
  4. **会话列表面板版式**（`SessionListPanel.tsx`）：工作区标题改为主标题（12px 加粗、不再大写化）；会话条目改为单行 flex（标题 flex1 + 右侧相对时间「刚刚/x 分钟前/x 小时前/x 天前/日期」），去掉第二行 meta；搜索命中项同样单行显示时间。
- **理由**：圆的 `+` 是「新增/更多」的通用心智，把工作区选择放在 `+` 的第一项而不是做成一个占位胶囊，既统一视觉又省横向空间；胶囊深浅/省略号来自不同样式来源与多余三点图标，收敛到单一 `controlChip` 后不再漂移；图标 morph 比整块 chip 交叉淡入更符合用户对「按钮变图标」的预期；参考图四的版式（工作区标题 + 单行会话 + 时间）信息密度更高。
- **替代方案**：把加号直接复用右侧 `Composer` 组件（否：右侧 Composer 绑定主会话输入/权限/模型菜单，嵌入 Vibecoding 会重复状态）；只改模型胶囊宽度不删三点（否：用户明确嫌省略号）；会话面板保持 popover 浮层（暂保留：点击右侧「会话列表」仍以浮层展开，宽度/内容按图四改版；若后续要求完全内嵌侧栏再改布局）。
- **后果**：Vibecoding 输入区常态只有一个圆形加号；菜单含工作区（切换/新选文件夹）与附件；所有胶囊同底色/同高/无多余省略号；Vibecoding 下侧栏按钮图标平滑变列表图标，会话面板工作区→会话单行+时间。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **171 文件 / 1451 tests 全绿**；`pnpm gen/check/build` 通过；真机 E2E（`e2e-evidence/sidebar.log`，E2E_EVAL ok:true）：`vibe-workspace-plus` 为圆形、无文字；三个胶囊均为 24px 且同底色、无尾随省略号；菜单文本「工作区 默认工作区 新加工作区… 更多操作 附件」；Vibecoding 下 `.sidebar-toggle` 双层图标第二层（列表）可见；会话面板工作区标题 12px 非大写、会话行 flexDirection=row 且含相对时间；原有「直接发送自动新会话/收起竖条悬停展开」断言仍通过。截图 `e2e-evidence/vibe-controls.png`、`sidebar.png`、`sidebar-collapsed.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）
- **回退条件**：附件菜单需要更多动作时扩为分组列表；若用户要求会话列表完全内嵌右侧栏（非浮层），需要重排 AgentSidebar 的 docked 布局（chat 与列表二选一或分栏）。
- **复核时间**：Vibecoding 输入区/会话列表面板再改版时

---
## ADR-0070 Vibecoding 右栏改为会话列表（对话归左侧主页）+ 侧栏按钮图标对齐与过渡修复

- **背景**：用户 m05149（附两张图）指出：① 侧栏展开按钮从星标切换到列表图标时**错位**，且**没有过渡衔接**（图一）；② Vibecoding 页面右侧边栏里**依旧是会话内容**（聊天记录 + 输入框），而期望「会话转移到左侧主页，右侧边栏在 Vibecoding 时变为会话列表」（图二）。
- **根因**：
  1. **图标错位/无过渡**：ADR-0069 的 `toggleIconLayer` / `toggleIconLayerOverlay` 两个样式键**没有真正写入** `styles` 对象（插入锚点与实际 `toggleChevron` 文本不符，替换静默未命中）。于是列表图标层只是普通文档流里的第二个 `inline-flex`，被排在星标右边 16px；同时没有 `position:absolute`、没有 `transition` → 两层图标横向偏移、切换瞬间跳变（E2E 实测 starLeft=1301 / listLeft=1316，dx=14px）。
  2. **右栏重复聊天**：`AgentSidebar` 只把会话 chip 的文案/图标换成「会话列表」，但内容区仍渲染 `{children}`（`MessageList` + `Composer`）。Vibecoding 的对话本来已在左侧主页 `VibeChatView`，右栏继续显示同一会话 → 两处聊天、与「右栏=会话列表」不符。
- **决策**：
  1. **补全双层图标样式**：`toggleIconLayer` 固定 16×32、`display:inline-flex` 居中、`transition: opacity 200ms ease, transform 200ms ease`；`toggleIconLayerOverlay` 绝对定位到同一 16×32 槽位（left/top 0）。星标层与列表层共用同一槽位，`vibeMode` 时 opacity 交叉淡入 + scale(0.78↔1) 平滑切换，不再横向错位。
  2. **Vibecoding 右栏 = 会话列表**：`AgentSidebar` 在 `vibeMode` 时：头部标题换为「会话列表」+ list 图标；隐藏「复制整段会话」按钮；跳过 workspaceBar / sessionBar / `children`（聊天与输入框不再渲染）；主体直接内嵌 `SessionListPanel`（新增 `inline` 变体：占满剩余高度、隐藏面板自带标题、搜索框不抢焦点），工作区→会话树、搜索、相对时间、新建会话全部保留。
  3. **收起态联动**：Vibecoding 下从收起竖条悬停展开后不再额外弹旧的下拉浮层（右栏本身就是列表）；`expandSidebarWithSessions` 在 `vibeModeActive` 时跳过 `setSessionOpen(true)`。
- **理由**：Vibecoding 的对话载体是左侧主页（发送后整页渐入），右栏继续放聊天会形成重复信息源与双输入框；右栏在 Vibe 下承担「在哪个会话/工作区里」的导航职责，直接把会话列表内嵌进侧栏比「点开浮层」更符合参考图四的形态。图标问题的教训是：样式键必须真正落在 `styles` 对象里（引擎/静态替换不能只看是否打印成功），并用 E2E 几何断言（两层 left 偏差 ≤2px、透明度=1）兜住「看起来没坏但实际没动画」的情况。
- **替代方案**：保留右栏聊天，用上方 chip 切换为列表（否：用户明确右栏要变成列表）；会话列表仍用浮层（否：内嵌更贴近图四且避免浮层遮挡聊天）。
- **后果**：Vibecoding 下左侧主页是唯一对话区（含发送栏），右侧栏固定为会话列表；侧栏收起时竖条按钮图标与列表层同槽位平滑切换。非 Vibecoding 模式下右栏仍保持原聊天 + 会话下拉行为不变。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **171 文件 / 1451 tests 全绿**；`pnpm gen/check/build` 通过；真机 E2E（`e2e-evidence/sidebar.log`，E2E_EVAL ok:true）：`toggleMorphLayers=true`、列表层 opacity=1，几何实测 starLeft=1301 / listLeft=1300（dx=-2px，scale 取样误差内）；Vibecoding 下 `.agent-sidebar` 头部含「会话列表」、`sidebarHasNoChat=true`（侧栏无 textarea）、内嵌 `session-list-panel` 直接可见（无需点击）；原有「加号圆形/胶囊统一/附件菜单/工作区/搜索/竖条悬停展开」断言全部仍通过。截图 `e2e-evidence/sidebar.png`、`vibe-controls.png`、`sidebar-collapsed.png`（Vibe 态收起竖条），日志 `e2e-evidence/sidebar.log`、`vibe-controls.log`、`sidebar-collapsed.log`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）
- **回退条件**：若以后要求「右栏可切换聊天与列表」→ 增加显式 tab，不再依赖 vibeMode 单态；图标过渡若在低配机器掉帧，降级为仅 opacity 过渡。
- **复核时间**：侧栏结构/图标资源再调整时

---
## ADR-0071 会话列表（工作区树）：标准箭头 + 悬浮操作（工作区 更多/添加会话、会话 更多/置顶/删除）

- **背景**：用户 m05281 对右侧会话列表提交互要求：① 展开/收起箭头换成标准箭头（展开向下、收起向右、带旋转过渡）；② 工作区标题行与会话行右侧改为**鼠标悬浮才出现**的操作：工作区 = 更多（省略号）+ 添加会话；会话 = 更多（省略号）+ 删除（归档可选）+ 置顶；可参考 Edge / 常见会话面板；③ 其余细节自行按最佳实践处理。
- **决策**：
  1. **箭头**：新增 `chevron-down.svg`（1024 viewBox，经图标居中守卫校验）；工作区分组头用它，展开 `rotate(0deg)`、收起 `rotate(-90deg)`，`transition: transform 160ms ease`，不再用旋转的 guide-arrow。
  2. **悬浮操作与时间/数量「同一位置互斥」**：会话行平时右侧显示时间、工作区行显示会话数；行 hover 时时间/数量 `opacity:0` 淡出，操作按钮（绝对定位到同一右缘）淡入，不额外预留空白列。操作容器默认 `opacity:0; pointer-events:none`，`:hover` 时 `opacity:1; pointer-events:auto`（120ms）；操作按钮不加单独深色底，直接显示在行底色上（用户 m05550 反馈）；高亮 `rowActive` 背景挂在整行 div（不是内部标题按钮），hover 也加整行底色，保证高亮覆盖整行。
  3. **工作区标题行**：右侧 [省略号 more] [加号 add-session]。更多菜单（portal + fixed，`usePopover` 保证互斥/点外收起）：重命名工作区、在文件夹显示、删除工作区；加号 = 在该工作区新建会话。
  4. **会话行**：右侧 [省略号 more] [pin] [close(删除)]。更多菜单：置顶/取消置顶、复制会话 ID、删除会话；pin 直接切换，删除直接调 `chat.deleteSession`。
  5. **置顶持久化**：renderer `localStorage["loopsoar.pinned-sessions"]` 存 sessionId 数组（不新增主进程 schema）；组内排序「置顶优先，其余 updatedAt 倒序」，置顶行标题前显示 pin 图标；取消置顶从数组移除。
  6. **工作区操作通道**（此前只有 list/create/select/remove）：新增主进程 `workspace:rename`（`WorkspaceStore.rename`，名称 trim 后 1..64 字符，只改显示名）与 `workspace:openFolder`（index 注入 `shell.openPath`，打开工作区根目录），生成 IPC 与 preload 白名单；App 新增 `renameWorkspace/removeWorkspace/openWorkspaceFolder/newSessionInWorkspace` 并注入 `AgentSidebar`→`SessionListPanel`。
  7. **在工作区下新建会话**：App 先 `workspace.select(id)` 再 `chat.newSession()`（shell 的会话只绑定活动工作区），随后刷新 sessions/currentSession；不切换主视图。
  8. **归档不做**：会话/工作区存储没有归档字段，用户也允许「不做或自研」；当前用删除 + 置顶覆盖需求，不引入半成品归档状态。
- **理由**：悬浮才出现的操作能保持列表干净、同时不牺牲可发现性（更多菜单承载低频/破坏性动作）；每个工作区行自带「添加会话」符合「先选项目再开工」的心智；箭头旋转是最低成本的层级反馈；置顶走 localStorage 避免为一个小 UI 功能扩散主进程 schema，后续需要跨设备再迁移。
- **替代方案**：hover 用 JS onMouseEnter 记录 state（否：CSS 即可，少一次渲染）；归档自研（否：无存储/检索链路，半成品更差）；重命名用 window.prompt（否：原生 modal 打断列表，改为标题行内联输入）。
- **后果**：会话列表更接近 Edge 的交互密度；工作区可重命名/在文件夹显示/删除；会话可置顶/复制 ID/删除；在任意工作区下可直接新建会话。置顶是 renderer 本地状态，多窗口（Agent 独立窗）之间不共享（可接受；后续若需共享再上主进程）。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **173 文件 / 1455 tests 全绿**（新增 `tests/ui/sessionListActions.spec.ts` 4 条守卫）；`pnpm gen/check/build` 通过；真机 E2E `e2e-evidence/sidebar.log` E2E_EVAL ok:true：工作区/会话悬浮操作默认 `opacity=0`、按钮齐全；工作区更多菜单含 重命名/在文件夹显示/删除工作区；会话更多菜单含 置顶/复制会话 ID/删除会话；箭头展开角 0°、收起 -90°；工作区加号新建会话数 +1；活跃行背景非透明（高亮整行）、时间默认可见、时间与操作右缘差 ≤6px（同一位置互斥）。截图 `e2e-evidence/sidebar-actions.png`（模拟 hover 态 + 工作区菜单）、`sidebar.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）；归档未实现（见决策 8）
- **回退条件**：悬浮操作在触屏/无 hover 设备不可达 → 补长按或右侧常驻按钮；置顶需要跨窗口同步 → 迁到会话元数据/主进程；工作区重命名需要改目录 → 另立持久化迁移方案。
- **复核时间**：会话列表增加批量操作/多选时统一交互语言

---
## ADR-0072 侧栏宽度：全屏可调 + Vibecoding 独立窄区间 + 退出键兜底

- **背景**：用户 m05586 提出三点：① 全屏时右侧边栏比例无法调整（拖 splitter 没反应）；② 切到 Vibecoding 时右侧栏占空间过大，最窄宽度应约为当前最小宽度的 1/2，并规定 vibe 模式最大宽度不超过（标准）当前最小宽度的 3/5；③ 搜索 → Vibecoding 切换时侧栏要平滑收缩到最窄宽度；④ 右上角退出键「老生常谈」总是失效。
- **根因**：
  1. 侧栏最小宽度 = `round(视口宽 × 0.35)` 并夹到 `[240, 720]`；全屏/超宽屏下 `视口宽 × 0.35` 已超过 720 → min=720；而 max = `min(720, 视口宽-320)` 也=720 ⇒ **min === max，拖拽区间为 0**。2048 窗口下区间也只有 [717,720]（3px），实际上等于拖不动。
  2. Vibecoding 复用标准侧栏宽度（默认 360、下限 240、上限 720），会话列表不需要这么宽；且没有独立的最小/最大值与切换过渡。
  3. 退出键链路：`dismissAllPopovers()` 同步执行，任一监听异常会中断后续 `api.window.close()`；主进程 `window:close` 只调用一次 `win.close()`，没有兜底（老 bug 用户 m02115 曾提过「点多次关闭没反应」）。
- **决策**：
  1. **全屏可调**：`computeSidebarMinWidth` 在比例下限与绝对上限之间强制预留 `SIDEBAR_MIN_DRAG_RANGE = 200px` 拖拽区间：`min = clamp(baseMin, FLOOR, maxForWindow - 200)`；max 保持 `min(720, 视口宽-320)`。这样全屏/超宽屏可拖区间 ≥200px，而窄窗口仍保留 ADR-0037 的比例下限语义。
  2. **Vibecoding 独立区间**：新增 `computeVibeSidebarBounds(viewportWidth)`：`min = max(120, round(normalMin × 0.5))`，`max = max(min, round(normalMin × 0.6))`（3/5，用户要求），`normalMin` 是标准模式当前最小宽度。新增偏好 `vibeSidebarWidth`（100..720，可选）保存用户拖出的 vibe 宽度；标准模式仍用 `sidebarWidth`，两种宽度互不污染。
  3. **平滑衔接**：进入 Vibecoding 的 effect 把 vibe 宽度设为区间最小值；侧栏 wrapper 宽度已有 320ms CSS 过渡，原生 WebContentsView 走 `browser:setSidebarWidth({animate:true})` 同曲线让位，因此是整列平滑收缩而不是瞬跳。退出 vibe 恢复标准宽度，同样走过渡。
  4. **拖拽按模式分治**：splitter 的 mousedown 根据 `vibeModeActive` 选择区间与状态；松手时 vibe 模式持久化 `vibeSidebarWidth`，标准模式持久化 `sidebarWidth`；`AgentSidebar` 内容宽度不再硬夹 `Math.max(240, …)`。
  5. **退出键兜底**：渲染层 `dismissAllPopovers()` 加 try/catch；`api.window.close()` 返回 `ok:false` 或 reject 时回退标准 `window.close()`；主进程 `window:close` 对 `win.close()` 加 try/catch，并在 800ms 后检查窗口是否仍存活、仍存活则 `win.destroy()` 强制销毁，确保「点了没反应」不再发生。
- **理由**：比例下限的意义是「窗口较窄时侧栏别太窄」，不是「全屏时锁死」；用拖拽区间兜底既保留原语义又让全屏可用。vibe 模式是阅读会话列表而不是主聊天区，需要窄而稳定的第二套宽度；用独立偏好避免污染标准布局。退出键是高频破坏性操作，必须走「先清理 UI、再 IPC、失败回退、主进程强制」的多层兜底。
- **替代方案**：全屏时直接取消比例下限（否：会丢失窄窗口语义）；vibe 宽度固定 260（否：不同屏幕/缩放不可移植）；退出键改为 `app.quit()` 直连（否：会跳过 BrowserWindow close 的清理与持久化钩子，且仍可能被窗口销毁流程卡住）。
- **后果**：全屏侧栏可拖；vibe 进入时自动收窄到标准最小宽度的一半，最多可拖到 3/5，退出恢复；退出键有两层兜底与主进程强制销毁。
- **验证方式**：`pnpm -r typecheck` 5/5；`tests/core/sidebar-width.spec.ts` 9 条契约测试（含全屏 1920/2560/3840 区间 ≥200、vibe 260~312、小窗 120 下限）；全量 vitest **173 文件 / 1457 tests** 全绿；真机 E2E：普通窗口拖拽 717→477→720（区间 243px，innerWidth 1362；全屏路径由 1920/2560/3840 契约单测覆盖，本机 Electron 全屏 E2E 在沙箱下崩溃，未作门禁）；Vibecoding 切换 E2E：`正常 717 → vibe 239（收缩）→ 拖宽 286 → 再拖窄 239 → 偏好 vibeSidebarWidth=239 → 切回 717`；退出键 E2E：点击 `.win-close` 后 renderer disposed / 应用退出（无 hang）。
- **状态**：✅ 契约单测 + 真机 E2E（普通窗口拖拽 / vibe 收缩 / 关闭键）已验证（2026-11-12）
- **回退条件**：全屏区间影响窄窗口拖拽手感 → 把 `SIDEBAR_MIN_DRAG_RANGE` 只在 `视口宽 > 1800` 时启用；vibe 宽度需要跨窗口同步 → 迁到主进程偏好广播；退出键强制销毁造成数据丢失 → 回退 try/catch 兜底并排查渲染层卸载钩子。
- **复核时间**：侧栏布局/窗口模式（小窗化、工作区）再调整时

---
## ADR-0073 会话小窗化/恢复/置顶/删除图标替换（用户提供资产）

- **背景**：用户 2026-11-12（m05830）提供 4 个 SVG（`D:\下载\小窗化.svg`、`退出小窗.svg`、`置顶.svg`、`删除.svg`），要求替换会话相关操作的图标：会话的小窗化与恢复、会话置顶、会话删除。
- **决策**：
  1. **资产归一**：用户 SVG 为 iconfont 导出（1024 viewBox、路径填充黑色），直接作为 `public/icons` 的 mask 图标使用；重命名为 ASCII kebab-case：`float.svg`（小窗化，覆盖 `小窗化.svg`）、`float-exit.svg`（退出小窗）、`pin.svg`（覆盖原手绘 pin）、`delete.svg`（删除）。`delete.svg` 的可见图形中心偏右 3.3%，按图标居中守卫加 `<g transform="translate(-33.8 0)">` 修正，不改路径本身。
  2. **会话行/菜单**：`SessionListPanel` 的置顶按钮、置顶菜单项继续用 `pin`（内容已换成用户图标）；会话行删除、会话菜单删除、工作区菜单删除工作区统一改用 `delete`（垃圾桶），不再用 × close 图标。
  3. **小窗化/恢复**：
     - `AgentSidebar` 头部的「小窗化 / 退出小窗」按钮：`isFloat ? float-exit : float`，文案 `chat.sidebarDock` 从「恢复常驻」改为「退出小窗」（英文 Exit mini window），与图标语义一致；
     - Agent 独立小窗的 `TitleBar`：最小化（收起成图标）使用 `float`（小窗化），关闭（退出小窗回到主窗口）使用 `float-exit`（退出小窗），即用户所说的「小窗化 / 恢复」两个动作。
- **理由**：用户提供的是成套视觉资产，保留原路径几何比手绘更符合预期；统一用 mask（`currentColor`）保证主题/禁用态自动换色；删除图标语义比 × 更清晰（破坏性操作）。
- **替代方案**：继续用手绘 pin/close（否：用户明确要求替换）；把新图标直接放进组件 public 目录而不进图标库（否：破坏 1024/居中/引用守卫）；改图标颜色（否：mask 由 CSS 着色，不改填充）。
- **后果**：会话列表置顶/删除、侧栏小窗化/退出小窗、Agent 小窗标题栏都使用用户提供的 4 个图标；图标守卫（1024 viewBox、居中、引用存在）通过。
- **验证方式**：`tests/ui/icons.spec.ts` + `tests/ui/iconCenter.spec.ts` 全过（含新 `delete.svg` 居中）；`pnpm -r typecheck` 5/5；全量 vitest **173 文件 / 1457 tests** 全绿；`gen/check/build` 通过；真机截图 `e2e-evidence/icons-rows.png`（hover 置顶/删除图标）、`icons-actions.png`（侧栏小窗化图标 + 菜单删除图标）。
- **状态**：✅ 图标守卫 + 全量测试 + 真机截图已验证（2026-11-12）
- **回退条件**：图标在小尺寸（11~13px）下辨识度差 → 单独出一套 16px 简化版；用户后续更新 SVG → 覆盖同名资产并重跑守卫（居中偏移可能需要重新补偿）。
- **复核时间**：图标库批量更新/主题换色时

---
## ADR-0074 图标与列表细节：行内左上微调、Vibecoding 隐藏小窗化、Agent 小窗标题栏图标

- **背景**：用户 m05915 反馈三点：① 图一里会话行内容略偏、右侧时间几乎贴到高亮框边缘，希望整体往左上挪几个像素（不要多）；② 图二 Vibecoding 内不应出现「小窗化」按钮，小窗化是搜索侧专属，从搜索切到 Vibecoding 时要让小窗化图标慢慢淡出消失；③ 图三 Agent 小窗标题栏图标太小看不清——「最小化为图标」改用常规横杠最小化图标，「退出窗口化」改用新提供的 `收起侧边栏.svg`。
- **决策**：
  1. **会话行对齐**：`SessionListPanel` 行容器 `padding: "0 8px 2px 0"`（右侧留 8px 给时间/操作，底部 2px 让内容上移约 1px），会话按钮内边距 `4px 6px 6px`（左/上各收 1~2px），悬浮操作容器从 `right:2` 调到 `right:6` 与时间右缘对齐；工作区标题同样左/上各收 1px，会话数右边距 8→10。E2E 实测时间右缘距行右缘 8px（原约 2~3px），不再贴边。
  2. **小窗化只属于搜索侧**：`AgentSidebar` 头部的小窗化按钮包一层 `sidebar-float-slot`，`vibeMode` 时 `width: 0 / opacity: 0 / pointer-events: none`，离开 vibe 恢复 `width: 26 / opacity: 1`；过渡 `width 240ms + opacity 220ms`，即「慢慢淡去 + 收窄」。该状态与 Vibe 会话列表切换同一帧生效。
  3. **Agent 小窗标题栏**：最小化按钮改回标准横杠（`minimize`，isAgent 时 14px）；关闭按钮（退出窗口化、回到主窗口）改用用户新提供的 `收起侧边栏.svg`（图标库 `sidebar-collapse.svg`，1024 viewBox，居中守卫通过），isAgent 时 14px，解决「图标太小看不清」。
  4. 新增资产 `sidebar-collapse.svg`；`float-exit.svg` 保留给侧栏 `isFloat` 态的「退出小窗」按钮（主窗口默认不会进入该态，但组件契约保持完整）。
- **理由**：行内容微调是最小侵入（只改 padding，不改行高/字号）；小窗化是搜索模式的特有能力，Vibe 模式列表不需要它，淡出比瞬间消失更连贯；Agent 小窗空间小，图标必须优先可辨识，横杠最小化与「收起侧边栏」都比自定义小图标清晰。
- **替代方案**：整行 `transform: translate(-2px,-1px)`（否：会影响高亮/点击区域）；Vibe 直接不渲染小窗化按钮（否：没有过渡）；退出窗口化继续用 float-exit（否：用户明确要求换收起侧边栏图标）。
- **后果**：会话行内容整体左上移 1~2px、时间离右缘 8px；Vibecoding 下小窗化图标淡出并收宽；Agent 小窗标题栏两个按钮更大更易辨认。
- **验证方式**：`pnpm -r typecheck` 5/5；图标守卫（1024 viewBox/居中/引用存在）通过；全量 vitest **173 文件 / 1457 tests** 全绿；`gen/check/build` 通过；真机 E2E `e2e-evidence/icons-tuning.log` E2E_EVAL ok:true：搜索态小窗化 slot 26px/opacity1 → vibe 0px/opacity0 → 切回 26px/1；会话行时间右缘距行右缘 8px；Agent 小窗成功打开（桌面截图 `icons-tuned-desktop.png` 可见标题栏横杠 + 收起侧边栏图标）。截图 `e2e-evidence/icons-tuned.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）
- **回退条件**：14px 图标在 Agent 小窗标题栏仍偏挤 → 改 13px 或只保留一个按钮；悬浮操作 right 偏移与时间对不齐 → 统一用 CSS 变量同一右缘。
- **复核时间**：会话行高/密度调整、Agent 小窗布局再改时

---
## ADR-0075 侧栏过渡收口：小窗内去小窗化按钮、内容宽度冻结、头部按钮槽位化淡出

- **背景**：用户 m05992（附截图 + 录屏）反馈三个衔接问题：① 小窗化后 Agent 独立窗口里仍然显示「小窗化」按钮（图一），表达冗余；② 非全屏、窗口变小时，搜索 ↔ Vibecoding 切换的 320ms 收窄/变宽过程中有几帧文字被挤压换行；③ 变宽还原时，下方会话文本从右侧被「拉出来」，上方变化不大的按钮也从右侧「飞出来」；希望按钮只是在原位淡入/滑出消失（图三/图四两模式那一行实际变化很小）。
- **根因**：
  1. `AgentSidebar` 不区分「主窗口」与「Agent 独立小窗」；小窗内也渲染小窗化按钮（点了还会再开小窗，语义重复）。
  2. 外层 wrapper 用 320ms 宽度过渡，但内层 `.agent-sidebar-inner` 的 `width` 直接取新值：收缩瞬间内容宽度就变窄，在还没收完的宽 wrapper 里提前换行；窗口越小越明显。
  3. 头部按钮是条件渲染（`vibeMode ? null : <button/>`），模式切换时元素被移除/插入，整行重新排布，视觉上按钮像从右侧飞入/飞出。
- **决策**：
  1. **小窗内隐藏小窗化**：`AgentSidebar` 新增 `embeddedInAgentWindow` prop（App 传 `miniWindow`）；为真时小窗化槽位 `display:none`，其他入口（复制、会话列表）保留。主窗口行为不变。
  2. **内容宽度冻结**：新增 `liveWidth` prop（App 传 `sidebarDragging || miniWindow`）。非 live 时 `frozenContentWidth` 保持过渡前的宽度，等 `MOTION.sidebarDuration + 20ms`（≈340ms）后再切到新宽度；过渡期间内容由 wrapper `overflow:hidden` 裁切，不再提前换行。拖拽/铺满（liveWidth=true）仍逐帧跟手。
  3. **头部按钮槽位化**：复制按钮与小窗化按钮都包进固定槽位，`vibeMode` 时 `width: 0 / opacity: 0 / pointer-events: none`，过渡 `width 240ms + opacity 220ms`；两模式共用同一 DOM 顺序（复制 → Agent 名 → Loopsoar → 小窗化 → 收起），按钮在原位收缩淡出/展开淡入，不再整行重排。
- **理由**：小窗化只对主窗口侧栏有意义；冻结内容宽度是 Slime float 同款做法（过渡期间内容不重排，只被裁切）；槽位化让「变化很小的同一行」保持布局稳定，符合用户「只需淡入滑出消失按钮图标」的表达。
- **替代方案**：内容宽度也加 320ms 过渡（否：仍会逐帧换行）；Vibe 模式直接隐藏整行头部（否：Loopsoar/收起按钮仍需保留）；Agent 小窗内重做一个精简 header（否：当前隐藏一个按钮已足够，避免双实现）。
- **后果**：Agent 小窗不再出现小窗化；模式切换时侧栏宽度平滑过渡且文字不会中途换行；头部复制/小窗化按钮在原位淡出/淡入。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **173 文件 / 1457 tests** 全绿；`gen/check/build` 通过；真机 E2E `e2e-evidence/sidebar-freeze.log` E2E_EVAL ok:true：收缩中（110ms）`inner=717` 而 `wrapper=503`（内容冻结、只有 wrapper 收缩）、过渡后 `inner=239`；变宽中 `inner=239` 而 `wrapper=525`、结束后 `inner=717`；复制/小窗化槽位 `24/26 → 10/11 → 0` 再恢复 `24/26`，无瞬时消失；打开 Agent 小窗成功，桌面截图 `agent-window` 内头部不再有小窗化图标。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）
- **回退条件**：冻结导致变宽后内容「瞬切」明显 → 在切换点加 80ms 交叉淡入；小窗内还需要其他主窗口操作 → 按 `embeddedInAgentWindow` 逐个裁剪。
- **复核时间**：侧栏模式/窗口形态（小窗化、工作区）再调整时

---
## ADR-0076 侧栏过渡再修正：内容宽度与 wrapper 同曲线同步（替代 ADR-0075 的「内容冻结」）

- **背景**：用户 m06058 截图指出侧栏在模式切换的「几帧」里严重变形：`Agent 对话` 标题被压成两行、右侧聊天正文变成一条窄竖列、左侧大片空白，「越调越烂」。这是 ADR-0075「内容宽度冻结」方案的副作用。
- **根因**：ADR-0075 为了让文字不在过渡中重新换行，让 `.agent-sidebar-inner` 在 320ms 内保持**旧宽度**，只让外层 wrapper 过渡。于是：
  - 收缩中：inner 仍是 717px，wrapper 已缩到 503px，内容被裁切；
  - 变宽中（截图场景）：inner 仍是 239px，wrapper 已涨到 ~570px，inner 因 `marginLeft:auto` 钉在右侧 → 右侧一条 239px 窄内容、左侧空白，标题/正文被挤成竖列。
  这是「过度优化」：为了避免换行帧引入了更明显的错位帧。
- **决策**：撤销行内内容冻结，改为 **inner 与 wrapper 用同一条 320ms 曲线同步过渡**：
  1. `contentWidth = fill ? "100%" : width`（不再有 frozenContentWidth 状态/定时器）；
  2. `.agent-sidebar-inner` 的 style 增加 `transition: width 320ms ease, opacity 320ms ease`；拖拽/铺满（`liveWidth`）时只保留 opacity 过渡，避免跟手延迟；
  3. 外层 wrapper 本来就用同一 `MOTION.sidebarDuration/MOTION.ease` 过渡，因此任意一帧 `inner ≈ wrapper`，内容宽度始终等于可见栏宽；文字只在「该宽度下正常换行」，不会出现宽栏里的窄内容。
- **理由**：两种约束（不换行 vs 不错位）在纯 CSS 宽高动画下不可同时满足；用户明确不接受错位（截图），而同步过渡只会在过渡过程中按当前真实宽度自然重排，没有「几帧假状态」。这是更接近 Slime/浏览器侧栏的常规做法，也让复制/小窗化槽位的淡出与宽度过渡保持同拍。
- **替代方案**：恢复内容冻结 + 把右侧空白用背景填充（否：治标不治本，文字仍窄）；用 transform scale 缩放内容（否：文字拉伸、更差）；直接不做宽度动画（否：用户要求平滑衔接）。
- **后果**：搜索 ↔ Vibecoding 的 320ms 收缩/展开过程中，内层内容宽度逐帧等于 wrapper 宽度；无挤压竖列、无右侧拉出；模式切换后布局正常。头部按钮槽位化淡出（ADR-0075 的另两项：小窗内去小窗化、槽位淡入）保留不变。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **173 文件 / 1457 tests** 全绿；`gen/check/build` 通过；真机 E2E `e2e-evidence/sidebar-sync.log` E2E_EVAL ok:true：收缩中（110ms）`inner=519 / wrapper=519`，过渡后 `239/239`；变宽中 `inner=525 / wrapper=525`，结束 `717/717`（此前冻结方案为 717 vs 503、239 vs 525 的错位）；槽位仍按 24/26 → 11/12 → 0 过渡；Agent 小窗打开正常。截图 `e2e-evidence/sidebar-sync.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）
- **回退条件**：同步过渡在小窗口下仍有换行抖动 → 改用 `will-change: width` 或减少过渡时长到 220ms；若未来必须冻结内容，需同时把 inner 右缘换成左缘（`marginRight:auto`）并用背景遮罩，不能只冻结宽度。
- **复核时间**：侧栏过渡/头部布局再调整时；ADR-0075 的内容冻结部分已被本 ADR 替代

---
## ADR-0077 模式切换的最后挤压帧：切换期间内容遮罩（先隐后现）

- **背景**：用户 m06108 又截到「最后一帧」挤压换行：侧栏标题被压成两行、聊天正文变成窄竖列。ADR-0076 已让 inner 与 wrapper 同曲线同步变宽，但动画中途总存在某个中间宽度，内容在该宽度下会真实重排——只要内容在过渡期间可见，就必然有一帧窄排版。
- **根因**：宽度是连续动画，而文字布局是按当前宽度即时计算的；「内容可见 + 宽度连续变化」两者同时成立时，中间宽度的换行帧无法从 CSS 层面消除。
- **决策**：在**模式切换**（搜索 ↔ Vibecoding，即 `vibeMode` 变化）期间给内容加遮罩：
  1. `AgentSidebar` 监听 `vibeMode` 变化，设置 `modeSwitching=true`；
  2. 切换瞬间 inner 的 `opacity` 置 0（`transition: opacity 0ms`，立即隐藏、不可点），宽度仍按 320ms 过渡（宽度变化对用户表现为「栏在收/展」）；
  3. `MOTION.sidebarDuration + 20ms`（≈340ms）后 `modeSwitching=false`，内容以 160ms 淡入，此时宽度已落定，排版是最终正确状态；
  4. 拖拽调宽/窗口缩放不触发遮罩（只与模式切换绑定），避免日常拖拽时内容闪烁。
- **理由**：与其在过渡中展示「被挤扁的文字」（用户明确反感，且截图说明任何中间排版都会被看到），不如让内容在切换的 320ms 内不参与视觉——只有侧栏外壳在动，结束后干净地淡入新布局。这是 Chrome/Edge 侧栏切换的常见处理方式，也保留 ADR-0076 的宽度同步（避免宽栏窄内容的错位）。
- **替代方案**：保留内容可见（否：任何中间宽度都会产生换行帧）；冻结内容宽度（否：ADR-0076 已证明会产生宽栏窄内容错位）；截图快照过渡（否：为 320ms 引入 capturePage 成本与异步复杂度，收益低）。
- **后果**：搜索 ↔ Vibecoding 切换的 320ms 内侧栏内容不可见（外壳宽度动画正常），随后 160ms 淡入最终内容；不再出现挤压换行帧。拖拽/缩放窗口时内容始终可见且宽度跟手。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **173 文件 / 1457 tests** 全绿；`gen/check/build` 通过；真机 E2E `e2e-evidence/sidebar-mask.log` E2E_EVAL ok:true：收缩中（110ms）`inner=554 / wrapper=554 / opacity=0`，收缩结束 `239/239/opacity=1`；变宽中 `inner=512 / wrapper=512 / opacity=0`，结束 `717/717/opacity=1`；槽位与 Agent 小窗检查保持通过。截图 `e2e-evidence/sidebar-mask.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）
- **回退条件**：用户觉得 320ms 空白观感差 → 把遮挡改成快速淡出 80ms + 缩短宽度过渡到 220ms，或只遮住正文、保留头部（需接受头部仍可能换行）。
- **复核时间**：侧栏过渡体验再调整时；ADR-0076 的宽度同步与 ADR-0075 的小窗化/槽位改动仍然有效

---
## ADR-0078 模式切换「概率性一帧」的确定性修复：paint 前遮罩 + NTP 内容块等高

- **背景**：ADR-0077 用 `modeSwitching` 遮罩后，用户 m06158 仍反馈「还是有一帧问题」「现在好多了，但还是有概率发生」。逐帧分析其录屏（30.5s/1080p/30fps）发现两处独立问题：① 侧栏内容在切换瞬间偶尔仍露出一帧旧宽度排版（概率性，取决于 React 调度时机）；② 新标签页的「搜索 / Vibecoding」拨片在切换时整体上下跳 42px、横向滑 235px，录屏相邻帧叠加后呈现重影/错位。
- **根因**：
  1. `AgentSidebar` 的 `modeSwitching` 由 `React.useEffect` 设置——effect 在浏览器 paint **之后**执行，某些帧调度下第一帧已经用「新宽度 + 旧内容」绘制出来，形成概率性挤压帧。
  2. `StartPage` 的 `onVibeModeChange` 也在 `React.useEffect` 里上报 → App 的 `vibeModeActive` 晚一帧才更新，侧栏宽度动画与遮罩整体比 NTP 模式切换晚一帧，放大时序不确定性。
  3. NTP 内容在 `ntp` 容器里垂直居中，而搜索态与 Vibecoding 态的 `.modeBody` 高度不同（实测 114px vs 199px）→ 居中位置重算，拨片整体上跳 42px（实测 `toggleTop` 407→365）；同时 `.vibe-page-in` 的 `translateY(10px)` 又叠加了额外位移。
- **修改**：
  1. `AgentSidebar`：`modeSwitching` 的设置/清除改 `React.useLayoutEffect`（paint 前同步 setState，首帧即 opacity 0）。
  2. `StartPage`：Vibecoding 模式上报改 `React.useLayoutEffect`，App 状态与侧栏宽度/遮罩在同一帧内提交。
  3. `StartPage`：`.modeBody` 增加 `minHeight: 204`（两种模式内容块等高，拨片位置不再随内容高度变化）；`.vibe-page-in` 关键帧去掉 `translateY(10px)`，只保留透明度渐入，避免额外的纵向位移进入录屏帧。
- **理由**：遮罩必须发生在 paint 之前才是确定性的；高度差异导致的居中重排是真实布局跳动（不是动画），必须靠等高容器消除，不能用动画掩盖。横向 235px 的位移来自侧栏宽度 320ms 的平滑过渡（NTP 在可变宽的浏览器面板内居中），属于有意的连续动画，本 ADR 不改变它。
- **替代方案**：把遮罩改成 1 秒的延迟隐藏（否：会让侧栏空白时间变长）；去掉 NTP 横向居中、改为左对齐（否：观感偏斜，且与「平滑收缩」的既有要求冲突）；把侧栏宽度切换改为瞬时（否：回退 ADR-0072/0075/0076 的平滑过渡）。
- **后果**：切换不再有概率性的一帧挤压；NTP 拨片垂直位置稳定（实测切换前后 top 均为 362）。录屏中仍可能看到 NTP 内容随侧栏宽度变化做平滑横移，这是动画本身，不是错位帧。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **173 文件 / 1457 tests 全绿**；`pnpm gen/check/build` 通过；真机 E2E（`e2e-evidence/sidebar-firstframe.log`，E2E_EVAL ok:true）：
  - NTP 拨片 `toggleTop` 切换前/后均为 362（修复前 407→365，Δ-42）；
  - 连续 6 次搜索↔Vibecoding 切换，每次点击后的**第一帧** `.agent-sidebar-inner` opacity 均为 0、inner 宽度与 wrapper 宽度相等（477/477、239/239）；
  - 修复前同一断言曾出现一帧 opacity=1（概率性漏遮），现全部为 0。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）
- **回退条件**：若未来把 NTP 内容改为非居中布局，可移除 `minHeight` 约束；若改为共享布局动画库，需确认遮罩仍在 paint 前生效。
- **复核时间**：模式切换/侧栏宽度过渡再调整时

---
## ADR-0079 悬浮小窗/图标最终方案：独立 56px 图标窗口（不再 resize / setShape）

- **背景**：用户 m06420（录屏）反馈：最小化后只有图标局部可点、图标↔小窗闪烁、恢复侧栏拖尾；m06958 进一步反馈「仍闪烁，且时常变成黑色像素方块」，并附逐帧录屏。
- **根因（逐轮排查结论）**：
  1. **命中区被窗口拖拽区吃掉**：图标态内容仍以 420×722 钉在窗口里，其 TitleBar 的 `-webkit-app-region: drag` 是窗口级区域，不受 opacity/pointer-events 影响，抢走图标点击；Windows thick frame 再吃边缘。
  2. **窗口 resize 与渲染层布局的跨进程竞态**：minimize 先 `setBounds(56)` 再通知渲染层，面板旧偏移会让图标错位一帧；restore 固定 40ms 后显示同样有概率闪。
  3. **`win.setShape` 在 Windows 透明窗口上会触发合成黑块/闪烁**：把大窗口裁成 56px 的方案虽然消除了 resize 竞态，但 DWM 在 shape 变化/透明区域重绘时出现整块黑色像素与抽搐（m06958 视频逐帧确认）。
  4. **关闭逐帧移动透明窗口**：160ms 逐帧 `setBounds` 滑动重 UI 透明窗，每帧重排/重合成 → 拖尾掉帧。
- **最终修改**：
  1. **独立 56px 图标窗口**：新增静态页 `packages/ui/public/icon.html`（不加载整个 App），透明无边框、skipTaskbar；Agent 窗口打开时预创建并隐藏。
  2. **minimize**：Agent 大窗口内面板照旧做 400ms 几何过渡（窗口 bounds 不变）；结束时把图标窗口 `show()` 到图标屏幕位置，并在同一帧 `hide()` Agent 大窗口——两个窗口在同一位置画同一个 56px 图标，切换无视觉差。**全程没有 resize / setShape。**
  3. **restore**：把隐藏的 Agent 窗口原点对齐到「图标窗口屏幕位置 − 图标相对偏移」，`show()` Agent 窗口、`hide()` 图标窗口，然后让面板从图标矩形反向展开；窗口显示与动画起点在同一帧对齐。
  4. **拖动**：`icon.html` 用 pointer 事件按屏幕增量调用 `ui:moveAgentWindow`，主进程直接移动 56px 图标窗口并夹取工作区（不再放大窗口）。点击（位移 <4px）→ `ui:restoreAgentWindow`。
  5. **关闭**：普通态 Agent 窗口改为原地 160ms 透明度淡出（DWM 合成，零几何动画）；图标态直接销毁两个窗口并通知主窗口恢复侧栏。
  6. 保底：图标窗口创建/显示失败时保持 Agent 大窗口可见（面板已收成图标，仍可点击还原），不会出现「侧栏消失、小窗不可见」。
- **理由**：透明窗口的 resize/shape 在 Windows 上都有合成副作用；把「图标」交给一个天然小尺寸的独立窗口，两个窗口切换时像素完全一致，就同时消掉了闪烁、黑块与跨进程竞态；关闭不再移动窗口，拖尾来源消失。
- **替代方案**：继续用 setShape（否：黑块/抽搐，已回退）；缩回 56px 单窗口 + ack（否：仍会有一帧窗口 resize 的闪烁）；把图标做成主窗口内 DOM（否：主窗口最小化/被遮挡时图标要独立悬浮）。
- **后果**：图标悬浮、拖动、点击还原均稳定；图标态任务栏不出现空窗；主 Agent 窗口在图标态隐藏（skipTaskbar）。代价：图标是本应用的第二个窗口，Alt-Tab/任务栏行为按「隐藏主窗 + 图标窗」处理。
- **验证方式**：`pnpm -r typecheck` 5/5；全量 vitest **173 文件 / 1457 tests 全绿**（minimize/restore 单测改为断言「Agent 窗口隐藏 + 图标窗口显示/移动 + 还原后原点对齐」）；`pnpm gen/check/build` 通过；真机 E2E（`e2e-evidence/agent-iconwin.log`）：最小化后图标窗口 bounds=(1632,225,56×57)、visible=true、URL=`loopsoar://app/icon.html`；注入 pointer 拖动后图标窗口移到 (1712,285)（+80,+60）；点击后 `isIconMode=false`、Agent 窗口 visible、图标窗口 hidden，恢复后的 Agent 窗口原点 (1356,277) = 图标位置 − 图标相对偏移（356,8）精确对齐。打开 Agent 窗口后 `getFocusedWindow()` 为 Agent 窗口（不再藏主窗口后面）。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）；黑块/闪烁来源（透明窗 resize/setShape）已从架构上移除
- **回退条件**：若未来 Electron/Windows 修复透明窗 shape 合成问题，可回到单窗口方案；若图标需要承载更多信息（未读数等）再把 icon.html 换成 React 小页。
- **复核时间**：悬浮小窗/图标交互再调整时

## ADR-0080 普通态 Agent 小窗拖动：拖动会话固定起点尺寸（修复「越拖越大」）

- **背景**：用户 m07288：「悬浮窗口怎么会随着拖动越变越大？有bug」——拖动普通态 Agent 小窗时，窗口高度持续增长。
- **根因**：
  1. 拖动每帧 `safeBounds(current)` 读 `getBounds()` 再 `setBounds` 写回；Windows 125% DPI 下 DIP↔物理像素取整误差逐帧累积（E2E 连续写固定 722 高，bounds 仍从 722 爬到 728；拖动约 60 帧/秒，肉眼即「越拖越大」）。
  2. 原生 `-webkit-app-region: drag` 在该透明无边框 Agent 窗口上不生效（真机鼠标验证：主窗口标题栏可拖、Agent 标题栏拖不动），此前只能改走显式 pointer + IPC 移动，于是取整误差直接暴露给用户。
  3. 另测 `setPosition` 在 125% DPI 下会隐式重算尺寸（每帧 +4~8px），比 setBounds 更糟，弃用。
- **决策**：
  1. 新增拖动会话：`ui:dragAgentWindow` payload 增加 `phase: "start" | "move" | "end"`；渲染层在 pointerdown/move/up 分别上报；主进程 `beginAgentWindowDrag()` 捕获起点位置，宽高取最近一次写入的目标尺寸（不取 getBounds 回报值，避免 722 被报成 724 后每轮 +2px），`dragBy(dx,dy)` 用「起点 + 累计屏幕增量」计算位置，宽高始终取起点值；`endAgentWindowDrag()` 清会话。
  2. 无显式 begin 时首个 `dragBy` 自动捕获起点（兼容旧调用）。
  3. 工作区夹取保留（x 至少留 120px、y 不越过顶部/底部 80px）；图标态忽略拖动会话（图标窗口自己 `moveBy`）。
  4. Agent 窗口 `thickFrame: true`（图标态已由独立 56px 图标窗口承担，不再需要 thickFrame:false 的图标边缘命中）；拖动用 setBounds 写固定 base 宽高，不用 setPosition。
- **理由**：尺寸只取一次起点值，单次拖动最多一次 ±2px DPI 取整误差、后续帧不再累积；显式 pointer 拖拽不依赖 app-region，透明窗同样可用。
- **验证**：真机 E2E `e2e-evidence/agent-window-drag.log`：连续 5 次拖动 (1276,217)→(1476,367)，高度在 721～722 之间 ±1 取整波动、无累积增长；真实鼠标拖动 (1276,217)→(1358,267)、尺寸 420×721→421×723。新增单测 4 条（累计位移/自动捕获起点/工作区夹取/图标态拒绝）；typecheck 5/5、全量 vitest 173 文件 / 1461 tests、gen/check/build 全绿。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-12）
- **回退条件**：Electron/Windows 修复 DPI 下 setBounds 取整问题后可简化回直接 setBounds。
- **复核时间**：Agent 窗口拖动交互再调整时。

## ADR-0081 悬浮小窗头部收敛：只留会话列表图标，点开 Vibecoding 同款会话列表

- **背景**：用户 m07603（三张截图）：悬浮小窗上方「会话切换 + 工作区切换」排布很乱；点工作区会打开为宽栏设计的 WorkspacePanel，在 420px 小窗里被挤成变形的两栏（右侧出现竖排溢出的工作区说明）；要求整理成 Vibecoding 的常规列表，悬浮窗左上角只保留一个会话列表图标，点击展开列表。
- **根因**：Agent 小窗直接复用了主侧栏的完整头部 + workspaceBar + sessionBar；WorkspacePanel 是双栏宽布局，窄窗下无法自适应，于是出现「变形界面」。
- **决策**：
  1. `AgentSidebar` 在 `embeddedInAgentWindow` 时进入 mini 分支：头部只渲染一个 `list-details` 会话列表图标按钮（`data-testid="agent-mini-session-toggle"`，`aria-pressed` 表示列表开合），隐藏标题/复制/agentLabel/小窗化槽位。
  2. mini 分支移除 workspaceBar 与 sessionBar，不再有「点工作区 → 打开 WorkspacePanel」的变形路径；会话/工作区切换统一走列表。
  3. 列表打开时用 `SessionListPanel inline` 以**浮动下拉层**覆盖在对话之上（不替换界面；从头部下方展开，高度 = 小窗内容区实时高度的约 1/4（最小 120px），下方仍可见对话与输入区），与 Vibecoding 右栏完全同款（搜索框、工作区分组、悬浮更多/置顶/删除、新建会话）；再次点图标、点击外部、按 Esc、选择会话或新建会话都会收起。
  4. 主窗口侧栏保持原布局不变；WorkspacePanel 仍可从主窗口进入。
- **理由**：小窗只有 420px 宽，双栏工作区面板与双行切换栏天然放不下；直接复用已在 Vibecoding 验证过的单栏会话列表，交互一致且不需要新组件。
- **验证**：typecheck 5/5；全量 vitest 173 文件 / 1461 tests 全绿；gen/check/build 通过；真机 E2E `e2e-evidence/agent-session-list.log`：点击小窗左上角图标后 `aria-pressed` false→true，列表浮层与 `session-search` 出现，工作区条文案消失，列表含 3 条会话，对话/输入框仍在 DOM 中（浮层覆盖而非替换）；再点一次 `aria-pressed` 回到 false、浮层关闭、输入框恢复；Esc 同样可关闭；截图 `e2e-evidence/agent-session-list-session-list.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-13）
- **回退条件**：若小窗后续需要更多入口（工作区管理/设置等），以图标 + 弹出菜单补充，不恢复宽栏 WorkspacePanel。
- **复核时间**：悬浮小窗/侧栏头部再调整时。
## ADR-0082 Vibecoding 侧栏切换判定：不再要求 currentUrl 为空

- **背景**：用户 m07821（截图）：地址栏仍是 `https://www.douyin.com/jingxuan`，左侧页面显示新建标签页的 Vibecoding（搜索/Vibecoding 拨片停在 Vibecoding、显示「今天想聊点什么？」），右侧栏却仍是聊天会话（Agent 对话 + 工作区条 + 会话条），没有变成会话列表。
- **根因**：`StartPage` 上报 Vibecoding 状态时用了 `!currentUrl && (mode === "chat" || tabMode === "vibe")`。当 NTP 在「地址栏仍有 URL、原生网页视图暂时隐藏」的状态下显示（用户截图场景）时 `currentUrl` 非空，判定恒为 false → App 的 `vibeModeActive` 一直是 false，侧栏不切换、宽度也不收窄。
- **决策**：上报条件改为 `mode === "chat" || tabMode === "vibe"`，不再依赖 `currentUrl`；导航发生时已有的 `currentUrl` 变化 effect 会把 `mode` 复位为 `ntp`、`tabMode` 复位为 `search`，因此正常浏览网页时不会误保持会话列表。
- **理由**：侧栏形态应当跟随用户当前看到的界面，而不是地址栏是否有值；URL 与可见页面可能短暂不一致（原生视图隐藏/切换中），以 StartPage 内部模式为准更可靠。
- **验证**：真机 E2E `e2e-evidence/vibe-sidebar-mode.log`：空白 NTP 点 Vibecoding → 侧栏 header 变为「会话列表」且 `session-list-panel` 出现；随后 `browser.newTab(https://example.com)` 导航 → 侧栏 header 恢复「Agent 对话」、列表消失。typecheck 5/5、全量 vitest 173 文件 / 1461 tests、gen/check/build 通过。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-13）
- **回退条件**：若未来 NTP 与网页视图可能长期并存，需要改为由主进程上报当前可见页面类型，而不是继续在渲染层加条件。
- **复核时间**：Vibecoding / NTP 切换逻辑再调整时。

---
## ADR-0083 Vibecoding 主页面承载会话正文：切到 Vibecoding 或从右栏选会话时自动进入会话页

- **背景**：用户 m07865（两张截图）：搜索页切到 Vibecoding 后，左侧主页面仍是「今天想聊点什么？」初始页，原来右侧栏里的会话内容没有移到主页面；再点右栏列表里对应会话依然是初始页。
- **根因**：切拨片只把 `tabMode` 设为 `vibe`（右栏变会话列表），StartPage 的 `mode` 仍是 `ntp`；只有发送消息（`submitVibe`）才 `setMode("chat")`。从右栏选择会话时 App 只更新 `messages/currentSession`，StartPage 的 `mode` 不变，因此即使有消息也继续显示初始页。
- **决策**：StartPage 增加 `useLayoutEffect`：当 `tabMode === "vibe"` 且当前会话 `props.messages.length > 0` 时 `setMode("chat")`。切拨片和从右栏选择已有会话都会触发；没有消息的新会话仍停留在初始页（Vibe 输入区），不强行显示空会话页。发送消息时已有的 `setMode("chat")` 保留。
- **理由**：Vibecoding 的设计是「对话只留左侧主页、右栏是会话列表」；主页面是否显示会话应由当前会话是否有内容决定，而不是要求用户先发一条消息。
- **验证**：真机 E2E（种子数据两个会话，标题「你好」「hi」）：搜索→Vibecoding 后主页面出现「你好」正文、右栏为会话列表（页面文本 `hasHello=true, hasHi=false`）；点击右栏「hi」会话后主页面切换到 hi 正文（`hasHi=true, hasHello=false`），右栏列表保持；截图 `e2e-evidence/vibe-main-chat.png`、日志 `e2e-evidence/vibe-main-chat.log`。typecheck 5/5、全量 vitest 173 文件 / 1461 tests、gen/check/build 通过。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-13）
- **回退条件**：若未来 Vibecoding 增加「多会话并行标签」，需要把当前会话来源从 messages 改为显式 active session 路由。
- **复核时间**：Vibecoding 主页面/侧栏会话列表再调整时。

---
## ADR-0084 会话绑定标签页、标签页绑定工作区：新标签/启动 = 新会话，修复「Vibecoding 回不到搜索」

- **背景**：用户 m07920：上轮只是「左右两边内容同步」，真正的痛点是切到 Vibecoding 后**回不到搜索**。用户规定：每次进入 Loopsoar、新建标签页都是**一个新会话**（除非主动进入某个会话）；**会话绑定标签页，标签页绑定工作区**；因此从 Vibecoding 回到搜索可以直接新建标签页或新建工作区。
- **根因**：① `StartPage` 的 `mode`（ntp/chat）与 `tabMode`（search/vibe）是单实例状态，新建标签不会重置，在聊天态点「+」仍显示会话页；② `newTab` 有「当前已是空白页就只聚焦地址栏」的守卫，而 Vibecoding 聊天页 URL 为空，正好被守卫拦下，无法新建标签；③ shell 的标签组本就按会话隔离（`BrowserHost` session→tabs），但新标签只是加进当前会话组，没有「新标签=新会话」的语义。
- **决策**：
  1. App 新增 `createFreshSessionAndTab()`：先切到目标工作区（可选）→ `chat.newSession()`（会话绑定当前活动工作区，shell 同步切到该会话标签组）→ 若标签组为空补一个空白标签（标签页绑定会话）→ 清空消息/待发队列/输入/URL → `freshSessionToken++`。
  2. `newTab` / `newSession` / `newSessionInWorkspace` 全部改走该函数；App 启动在 bootstrap 的 `boot` 状态就绪后也调用一次，实现「每次进入 Loopsoar = 新会话」。
  3. `StartPage` 新增 `resetToken`：令牌变化时 `mode=ntp`、`tabMode=search`、清空 draft，确保新标签一定回到搜索初始页（修复回不到搜索）。
  4. 标签页继承会话的工作区；「新加工作区」成功后自动新建该工作区下的「会话 + 标签页」（新建工作区 = 新的搜索会话）。旧会话保留各自标签组，从会话列表主动进入仍切回该会话及其标签。
- **理由**：把「会话」作为标签页的唯一业务实体，新建标签就新建会话；StartPage 只跟随当前标签/会话，不再需要「从聊天态硬切回搜索」的特殊路径——新标签天然就是新的搜索页。
- **验证**：真机 E2E（`e2e-evidence/session-tab-binding.log`）：启动后 `currentId` 为新会话、1 个空白标签、搜索 NTP 可见；点「+」→ 会话 ID 变化且仍 1 个空白标签 + 搜索 NTP；在会话列表主动选「你好」→ 切到该会话（URL 仍空、主页保持搜索 NTP）；切 Vibecoding → 主页显示「你好」正文；再点「+」→ 新会话 ID、1 个空白标签、回到搜索 NTP。typecheck 5/5、全量 vitest 173 文件 / 1461 tests、gen/check/build 通过；截图 `e2e-evidence/session-tab-binding.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-13）
- **回退条件**：若用户希望恢复「同一会话多标签」，需要把「标签→会话」改为显式映射并允许一个会话绑定多个标签，不能只在 App 层建会话。
- **复核时间**：标签页/会话/工作区模型再调整时。

---
## ADR-0085 侧栏/列表/工作区 UI 收口：新建会话不跳搜索、统一会话列表、输入框下工作区选择 + 默认工作区自动认领

- **背景**：用户 m08041（四张截图 + `新增文件夹.svg`）：① 点「新建会话」总是跳回搜索页，没必要；② 搜索页侧栏的工作区/会话两行改成悬浮窗那样的单图标展开列表；③ 统一各处会话列表表示（搜索页侧栏浮层、悬浮窗浮层），并在搜索框下加「添加工作区」按钮（用新 SVG）；④ 新规则：新建标签页/会话暂不认领工作区，用户也没设置时，首次对话自动落「默认工作区」；⑤ 输入框下方加可展开的工作区选择按钮，列表最下面显示添加工作区。
- **决策**：
  1. `createFreshSessionAndTab()` 增加 `reset: "search" | "keep"`：新标签页/启动用 `search`（重置回搜索页）；`newSession`/`newSessionInWorkspace` 用 `keep`——只通过 `sessionResetToken` 把主页面切回初始页，保留搜索/Vibecoding 模式（Vibecoding 下右栏列表不消失，不再跳搜索）。
  2. 搜索页侧栏去掉 workspaceBar/sessionBar：header 左侧只保留一个会话列表图标（`data-testid="agent-sidebar-session-toggle"`，`aria-pressed` 表示浮层开合），点击展开与悬浮窗同一套 `SessionListPanel` 浮层；对话仍常驻在下面。
  3. `SessionListPanel` 统一：搜索框下新增「添加工作区」按钮（`workspace-add.svg`、`data-testid="workspace-add"`），搜索页侧栏、悬浮窗、Vibecoding 右栏三处使用同一组件与同一按钮。
  4. 侧栏 Composer 与 Vibecoding 输入框下方新增工作区选择 chip（可展开已有工作区列表 + 最下面「添加工作区」）；显示的是**当前会话实际绑定**的工作区，未认领时显示「选择工作区」。
  5. 新规则：新标签页/新会话 `workspaceId = null`；`workspace:bindSession` 支持用户主动绑定；首次发送时 shell 在 `chat:send` 前把未认领会话自动写入「默认工作区」（由 `getDefaultWorkspaceId` 注入，取名为「默认工作区」的工作区，回退活动工作区）。
- **理由**：新建会话是「在当前界面里换一个会话」，不应改变用户正在看的界面；工作区选择从两行常驻 chip 收进输入框下方的按需按钮，减少常驻噪声；默认工作区保证「用户什么都没设置」时也会有稳定归属，避免空工作区会话。
- **验证**：真机 E2E（`e2e-evidence/ui-list-overhaul.log`）：搜索页侧栏单图标存在、旧 workspaceBar/sessionBar 消失、浮层列表与「添加工作区」出现；侧栏 Composer 与 Vibecoding 输入框下工作区选择器存在且菜单含「添加工作区」；Vibecoding 下点「新建会话」→ 右栏列表保留、左页初始页、不出现搜索 NTP；新会话发送前 workspaceId=null、发送后自动等于「默认工作区」id。typecheck 5/5、全量 vitest 173 文件 / 1461 tests、gen/check/build 通过。截图 `e2e-evidence/ui-list-overhaul3.png`。
- **补充（2026-11-13，用户 m08251/m08310/m08323）**：工作区选择 chip 必须在输入框**外**且**左对齐**。`StartPage.tsx` 的 `VibeComposer` 原把 `styles.vibeWorkspaceRow` 放在 `styles.vibeBox` 内，改为 `vibeBox` 的同级兄弟（Fragment 根，row 位于输入卡片下方、`width:100%` 左对齐），并给 `vibeBox` 加 `data-testid="vibe-composer-box"` 供几何断言；侧栏 Composer 的 `composer-workspace` 本就在 `composerBox` 外。工作区菜单在「添加工作区」下方新增「更多」(`data-testid="vibe-workspace-picker-more"`)，点击打开原详细工作区面板 `WorkspacePanel`（App 注入 `onOpenWorkspacePanel` → `dismissAllPopovers()+setWorkspacePanelOpen(true)`）。E2E `e2e-evidence/workspace-more.log`：`box.left=202`、`picker.left=202`、`outside=true`、`leftAligned=true`，「添加工作区」下方紧接「更多」，点击后 `workspacePanelOpen=true`、菜单关闭；截图 `e2e-evidence/workspace-more-menu.png`、`workspace-more.png`。
- **补充 2（2026-11-13，用户 m08395）**：工作区选择按钮太暗淡 → 改为品牌强调色（`BRAND.ochreSoft` 底、`rgba(200,118,60,0.55)` 描边、文字 `BRAND.ochreHover`、height 26、fontWeight 600、细微投影；去掉 `.chip` class 以避开 soft 主题的 `border-color: transparent !important`）；菜单原向上展开 → 改为**向下展开**：`useFloatingMenu(width, "up"|"down")` 支持 top 锚点，`FloatingMenu` 对向下锚点加 `maxHeight = innerHeight - top - 12` + `overflowY:auto`，避免小窗口溢出。E2E `e2e-evidence/workspace-down.log`：chip background=`rgba(217,138,79,0.14)`、border=`rgba(200,118,60,0.55)`、color 品牌色、fontWeight 600；menu.top=611 ≥ picker.bottom=603（downward=true）；截图 `e2e-evidence/workspace-down.png`。
- **补充 4（2026-11-13，用户 m08473）**：工作区设置面板只作为详情查看器：点击工作区只切换右侧详情，不再调用 `workspace:select`、不更新 `lastUsedAt`、不改变活跃工作区（因此列表不再重排，也不影响输入框下方的工作区选择）；选中样式只保留背景高亮，移除 `wsRowActive` 的描边。聊天输入区（Composer）的工作区按钮同步改为与 Vibecoding 选择器一致的品牌色胶囊（ochreSoft 底 + 0.55 描边 + 品牌文字色、height 26、字重 600、radius 999；去掉 `.chip` class 以避开 soft 主题透明边框强规则）。E2E `e2e-evidence/workspace-panel.log`：点击非活跃工作区后 `orderUnchanged=true`、`activeUnchanged=true`、选中行 border 透明、背景高亮、右侧详情=被点工作区；`composer-workspace` 背景/描边/圆角/字重生效。截图 `e2e-evidence/workspace-panel.png`。
- **补充 3（2026-11-13，用户 m08444/m08446）**：按钮去掉 `.chip` 后失去圆角变方框 → `styles.workspacePickChip` 加 `borderRadius:999`（保留胶囊形）；删除 Vibecoding 初始页输入框下方提示行「Vibecoding 会在当前会话里继续，发送后输入区平滑下移为对话页。」（移除 `styles.vibeFoot` 的渲染）。E2E `e2e-evidence/workspace-pill.log`：picker 107×26、`border-radius:999px`、提示文案不存在、菜单仍向下；截图 `e2e-evidence/workspace-pill.png`。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-13）
- **回退条件**：若工作区需要在多个会话间共享更复杂关系，需要把「会话→工作区」从单值改为显式多对多模型；本轮仍保持单绑定。
- **复核时间**：侧栏/列表/工作区选择交互再调整时。


## ADR-0086 站点图标（favicon）抓取与展示：标签页 / 历史记录 / 新标签快捷入口

- **背景**：用户 m08518 指出默认主页的标签、历史浏览记录头部的网址 logo 截取不到，而竞品（slime）已有。
- **根因**：浏览器只监听导航/标题，没有监听 Electron `page-favicon-updated`；TabState/HistoryEntry 没有 favicon 字段；渲染层 CSP 为 `img-src 'self' data:`，也不能直接引用外网图标 URL。
- **决策**：
  1. `packages/shell/src/browserAdapter/backends/webContentsView.ts` 监听 `page-favicon-updated`，取第一个图标；`data:image/*` 直接透传，http(s) 交给主进程 `fetchFaviconDataUrl` 用 `session.fetch` 抓取并转 base64 data URL（限 96KB、6h 缓存、失败缓存空结果）。
  2. `BrowserHost` 的 TabState/TabEntry 增加 `favicon`；图标到达时 emitTabs + `onFaviconChanged`；历史存储 `GlobalHistoryEntry` 增加 favicon，新增 `updateFavicon(url, dataUrl)`，读取时净化（只接受 `data:image/`、≤96KB）。
  3. UI：`BrowserTabs` 在标题左侧显示 14px favicon（缺失时用首字母 tile / globe）；`ChromePage` 历史行显示 15px favicon（缺失首字母）；`StartPage` 新标签快捷入口显示 22px favicon（缺失保持首字母）。
- **理由**：主进程统一转换 data URL 同时满足 CSP 与离线历史显示；抓取放主进程避免网页环境限制；历史图标用「迟到更新」不改变排序/访问次数。
- **验证**：`e2e-evidence/browser-tab-favicon.png`（标签页橙色图标）、`e2e-evidence/history-favicon.png`（历史行图标 + 首字母回退）；E2E `browser-favicon.log`：tabFaviconOk/historyFaviconOk/domTabFaviconImgs=true；单测 `tests/shell/faviconHistory.spec.ts`（净化/合并/重启恢复）。
- **状态**：✅ 已验证（2026-11-13）
- **回退条件**：若图标抓取造成明显网络开销，可加「仅本地缓存/关闭」偏好。

## ADR-0087 浏览器开发者工具（F12）：每标签 detach 调试 + 请求守卫放行 devtools 协议

- **背景**：用户 m08518 要求补齐 F12 调试能力并跟上最新调试面板。Electron 的 DevTools 前端本身来自 Chromium（devtools:// 协议）。
- **根因**：① 浏览器没有暴露任何 DevTools 入口；② `browserRequestGuard` 把 devtools:// 与 chrome-extension:// 当作非安全协议拦截，DevTools 前端加载报 `ERR_BLOCKED_BY_CLIENT`（E2E 实测）；③ 网页有独立焦点，主窗口收不到 F12，需在 webContents 上监听。
- **决策**：
  1. 契约新增 `browser:toggleDevTools`（`BrowserTabRefSchema`，缺省当前活动标签）；`BrowserHost.toggleDevTools` 用 `webContents.openDevTools({ mode: "detach" })` / `closeDevTools`，返回 `{ok, open}`（WebContentsView 用独立窗口，避免和视图抢布局）。
  2. `WebContentsAdapter` 在每个标签的 `before-input-event` 里识别 F12 / Ctrl(⌘)+Shift+I；主窗口 `BrowserChrome` 增加工具栏按钮 `data-testid="browser-devtools"` 和 window keydown 快捷键。
  3. 请求守卫同步策略放行 `devtools:`/`chrome-extension:`/`chrome:`；异步 DNS 层对非 http(s)/ws(s) 协议直接放行（否则会拿 hostname=devtools 去解析并误杀）。
- **理由**：DevTools 属于 Chromium 内部信任面，不是网页可控的 SSRF 入口；放行这两种协议也修复扩展资源加载。
- **验证**：E2E `browser-favicon.log`/主进程日志：open=true → 再切 open=false（状态机），主进程无 ERR_BLOCKED_BY_CLIENT；`tests/shell/browserRequestGuard.spec.ts` 新增 devtools/chrome-extension 放行 + 不触发 DNS 的用例。
- **状态**：✅ 已验证（2026-11-13）
- **回退条件**：若未来改为 dock 式调试器，需同步浏览器视图几何（applyLayout）。

## ADR-0088 浏览器扩展适配（Chrome/Edge 系）：本地未打包安装 + Chrome 应用商店 CRX 安装 + 持久化

- **背景**：用户 m08518 要求 Loopsoar 能适配市面上流通的浏览器插件市场（Chrome、Edge 等）。Electron 官方只支持未打包扩展与 Chrome API 子集（https://www.electronjs.org/docs/latest/api/extensions），且 `.crx` 不能直接 loadExtension。
- **决策**：
  1. 新增 `packages/shell/src/main/browserExtensions.ts`：`BrowserExtensionHost` 管理安装目录 `<dataDir>/browser-extensions/<id>` + `state.json`；开机 `loadAll()` 逐个 `session.extensions.loadExtension`（persist:loopsoar-browser 分区）。
  2. 两种安装：**本地未打包目录**（校验 manifest、复制到管理目录）；**Chrome 应用商店链接/32 位扩展 ID**（官方 update2 端点下载 CRX → 解析 CRX2/CRX3 头 → 内置极简 ZIP 解包（stored/deflate，拒绝路径穿越）→ loadExtension）。
  3. IPC：`browser:listExtensions` / `browser:installExtension` / `browser:removeExtension`；设置新增「浏览器扩展」分区（商店链接输入、安装文件夹、列表、错误原因、卸载）。
  4. 兼容性说明落在设置页：Electron 支持 content_scripts/background/storage/scripting/webRequest/devtools 等子集；打包扩展/不支持的 API 会显示失败原因。
- **理由**：不引入第三方扩展桥依赖，保持主进程可测（纯逻辑 + 假 API 单测）；CRX 解包用 node:zlib 自研避免新增依赖。
- **验证**：单测 `tests/shell/browserExtensions.spec.ts`（8 条：商店 ID/CRX 头/ZIP 解包+穿越拒绝/folder 安装重启恢复/卸载/坏 manifest）；真机 E2E `browser-favicon.log`：安装测试扩展 → 重新导航 → 内容脚本把 `loopsoar-extension-ok` 注入页面（`contentScriptOk=true`）→ 列表 enabled → 卸载；设置截图 `e2e-evidence/settings-browser-extensions.png`。
- **状态**：✅ 已验证（2026-11-13，Electron 子集；商店下载依赖网络）
- **回退条件**：若商店安装体验/兼容性不足，可切到 electron-chrome-extensions 之类的桥接方案重新评估。

## ADR-0089 终端系统收口：环境自检面板 + CLI 依赖探测 + Windows .cmd 解析

- **背景**：用户 m08518 要求彻底完善终端、整合 Loopsoar 专用 terminal、检查下方终端是否正常，并在设置中加入系统终端依赖检测。
- **现状**：持久终端已有（cmd / PowerShell / Git Bash / Python / Node / C++ 六种配置档、profiles 探测、ANSI 渲染、回放、空闲回收、并发上限）；缺的是面向用户的「依赖是否可用」自检与设置入口。
- **决策**：
  1. 新增 `packages/shell/src/main/terminalDiagnostics.ts`：复用 `detectTerminalProfiles`，并探测 git/node/npm/pnpm/python/rg/curl 的版本；命令白名单硬编码、5s 超时、环境走 `buildTerminalEnv` 白名单；Windows 上 npm/pnpm 用 `.cmd` 候选并 `shell:true` 执行（CreateProcess 不解析 .cmd），python 依次尝试 `py -3`/`python`/`python3`。
  2. 契约新增 `terminal:diagnose`（null → 诊断对象）；设置新增「终端环境」分区：平台/默认 shell/终端可用徽标、Shell 配置档表、解释器/工具链表、常见 CLI 表、安装提示、重新检测。
- **验证**：真机 E2E `terminal-panel-live.log`：终端面板打开、6 个配置档、点「新建终端」创建 cmd 会话、输出 `D:\试验场>`、state=就绪；E2E `browser-favicon.log`：`api.terminal.diagnose()` ready=true、npm/pnpm/python/git/node/curl 可用（rg 缺失有安装提示）、API 持久会话 echo 回放 `LOOP_TERM_OK`；设置截图 `e2e-evidence/settings-terminal-env.png`、面板截图 `terminal-panel-live.png`。
- **状态**：✅ 已验证（2026-11-13）
- **回退条件**：若新增诊断项导致启动变慢，可改为按需触发（当前已是设置页按需）。


## ADR-0090 浏览器交互收口：底部 DevTools 面板、状态栏调试入口、商店安装点击拦截、图标替换

- **背景**：用户 m09003/m09029/m09137/m09249 连续反馈：① 调试面板是独立窗口，应该像终端一样停靠在 Loopsoar 底部、点击向上展开；② 调试按钮要移到状态栏「终端」按钮左侧并用「操作-调试」图标；③ harness 扩展图标、浏览器插件图标要换成指定 SVG；④ 在浏览器里点应用商店的「添加至 Chrome / 获取」按钮毫无反应；⑤ 状态栏「调试/终端」两按钮间距过大。
- **实现**：
  1. **底部 DevTools 面板**：新增 `BrowserDevToolsPanel`（electronBrowser.ts）。用 `WebContentsView` 作为 DevTools 前端画布：主窗口 contentView 挂载 → `inspected.setDevToolsWebContents(view.webContents)` → `openDevTools({mode:"detach"})`，面板从窗口底部向上占 `panelHeight`（默认 360，120–1200 夹取），窗口 resize 自动重算；`devtools-closed` 自动清理并通知渲染层。契约新增 `browser:setDevToolsPanel`（open/height）与事件 `chrome:devToolsPanel`。
  2. **状态栏布局**：DOM 顺序改为「内容 → StatusBar → 调试面板占位」，占位高度从 0→360 的 240ms 过渡会把状态栏平滑顶上去，成为展开面板的顶栏（用户要求）；`browser.setBottomInset` 同步让网页视图让位。调试按钮移到「终端」左侧并加「调试」文字，两个按钮包进 gap 6px 的 `bottomActions` 组，取消原来 18px 间距。
  3. **商店安装点击拦截**：新增浏览器 preload `packages/shell/src/preload/browser.cjs`（仅 Chrome/Edge 官方商店域名生效），捕获「Add to Chrome / 添加至 Chrome / 获取」按钮点击 → `preventDefault/stopPropagation` → 通过专用 IPC `loopsoar-browser:install-extension` 交给主进程；主进程用 `BrowserHost.hasWebContents(event.sender.id)` 校验来源必须是 Loopsoar 浏览器标签，再走 `BrowserExtensionHost.installFromStore`（Chrome update2 / Edge crx 端点），页面内显示「正在安装/已安装/失败」toast。设置页增加「打开 Chrome 商店 / 打开 Edge 商店」按钮。
  4. **图标**：`D:/下载/操作-调试.svg` → `icons/devtools.svg`（状态栏调试按钮）；`D:/下载/扩展功能.svg` → `icons/extension-feature.svg`（设置·扩展）；`D:/下载/组件、插件.svg` → `icons/browser-plugin.svg`（设置·浏览器扩展）。
- **验证**：真机 E2E `e2e-evidence/devtools-panel3-window.png`：DevTools 停靠底部（窗口数仍只有 Loopsoar 主窗口，无独立调试窗）、状态栏 `footer.bottom=502 = slot.top`、占位 360；`E2E_WINDOWS` 仅主窗口。商店链路：`E2E_STORE_INSTALL` 用真实 Chrome 商店成功安装 Dark Reader 4.9.135（`kkldpplicfanelpckfpkcgmhdiiggjdk`）；模拟商店页（host-resolver 映射 chromewebstore.google.com → 本地页）点击「Add to Chrome」→ preload 拦截生效（页面自身点击计数 0，页面出现「Loopsoar 正在安装扩展…」toast）。单测 `tests/shell/browserPreload.spec.ts`（3 条：商店 URL/ID/按钮文案）与 `browserExtensions.spec.ts` Edge 用例。
- **已知边界**：① DevTools 前端自身语言仍为英文（用户 m09223 同意本轮先不处理）；② Edge 商店 CRX 端点在测试环境返回 500（页面可正常访问，安装通道已实现，待用户网络验证）；③ Electron 扩展 API 仍是子集（见 ADR-0088）。
- **ADR-0090 验证补记**：全量 vitest **176 文件 / 1476 tests 全绿**；typecheck 5/5、gen/check/build 通过。
- **状态**：✅ 真机 E2E 已验证（2026-11-13）
- **回退条件**：若底部 DevTools 在低分屏/小窗口不可用，可恢复 `openDevTools({mode:"detach"})` 独立窗口作为降级。


## ADR-0091 会话按需创建 + 标签/工作区语义收口 + favicon 回抓 + 图标居中

- **背景**：用户 m09384：① 设置里「从商店安装」和「打开商店」按钮语义重复；② 新建页会自动跳转/新建会话，不对——「我与 Agent 对话之前都不算新建会话」，只有对话才算创建；③ 网页左侧要有工作区箭头下拉，选择后新建页/会话都在该工作区活动；④ 会话/网页在工作区内活动，新建网页不等于新建会话；右侧在对话前只是无工作区归属的会话栏；只有完全没绑定工作区的新用户直接对话才落「未归属工作区」；⑤ 明显域名（bing/bilibili/douyin/baidu/Microsoft）的 favicon 仍抓不到；⑥ 标签页关闭按钮图标不居中，需全程序排查。
- **决策/实现**：
  1. **会话按需创建**：`createFreshSessionAndTab` 重写为「草稿态」（清空 currentSession/messages，必要时补空白标签），不再调用 `chat:newSession`；启动、新建标签页、显式「新建会话」都只进入草稿。新增 `ensureSessionForSend()`：首次发送时才 `chat:newSession({ workspaceId: activeWorkspaceId ?? null })`，并记录 `tabSessionRef`（标签页 ↔ 会话绑定）；`send()` / `startVibe()` 都先 ensure。切标签时按 `tabSessionRef` 恢复该页会话；未对话的新页保持草稿。
  2. **工作区语义**：`BrowserChrome` 最左侧新增工作区下拉（`data-testid="browser-workspace-toggle"`，folder+chevron，向下展开 workspaces + 添加工作区）；选择只改「后续活动工作区」，已有会话不迁移；草稿态 `bindWorkspaceToCurrentSession` 只 `workspace.select`，有会话才 `bindSession`。`sessionWorkspaceId` 在草稿态显示 `activeWorkspaceId`。shell `domains/chat.ts` 移除 startStream 时自动绑定「默认工作区」：只有完全没选工作区时 `workspaceId=null` → 未归属工作区。
  3. **favicon 回抓**：新增 `resolveFaviconForPage(pageUrl)`（主进程）：抓页面 HTML 的 `<link rel=icon>`，否则退回 `/favicon.ico`、`/favicon.png`，复用 `fetchFaviconDataUrl` 转 data URL；契约 `browser:resolveFavicon`，成功后 `history.updateFavicon`。`StartPage` 快捷入口与 `ChromePage` 历史页对缺图标条目按 URL 回抓（每 URL 一次）并原地刷新，旧历史/在线抓取失败也能显示图标。
  4. **设置扩展安装区**：主行改为「打开 Chrome 商店 / 打开 Edge 商店 / 安装本地文件夹…」，次行「或粘贴商店链接 / 扩展 ID 在线安装：输入框 + 从商店安装」，消除语义重复。
  5. **图标居中**：根因 `.icon-btn` 未重置浏览器默认 `padding`；全局 `.icon-btn { padding:0; line-height:0; }`。E2E 实测标签关闭按钮 close 中心与 icon 中心一致（110,25）。
- **验证**：真机 E2E `e2e-evidence/turn51.png` / `turn51.log`：bing 标签 + 历史 favicon 均为 data URL；点「新建标签页」后 session 数不变（`noSessionOnNewTab=true`）；工作区菜单「试验场/默认工作区」；选「默认工作区」后首次发送创建会话且 `workspaceId=ws-mvxwl64p-h1jt`；草稿态右侧无会话项、输入框可用。设置截图 `settings-browser-extensions3.png`。全量 vitest 176 文件 / 1476 tests 全绿。
- **状态**：✅ 真机 E2E 已验证（2026-11-13）
- **回退条件**：若「切标签恢复会话」需要跨重启持久化标签↔会话映射，需把映射落到会话 store；当前仅运行期内存映射。


## ADR-0092 工作区入口归位标题栏左上角 + 设置内跳转直接生效

- **背景**：用户 m09567（两图）：① 工作区下拉被放在第二行浏览器工具条最左侧，和标签页/地址栏挤在一起「乱七八糟，一坨」，位置也错——应该在顶部导航栏、标签页最左侧，也就是 Loopsoar 左上角；② 设置（浏览器整页设置）里点「打开 Chrome/Edge 商店」后只是背后新建标签，必须退出设置界面才能看到，要求直接跳转。
- **决策/实现**：
  1. 新增 `packages/ui/src/WorkspaceSwitcher.tsx`：34×40 的标题栏入口，**只显示一个 chevron 箭头**（用户 m09840：左上角不要文件夹图标，参考图只留箭头；菜单项内仍用 folder/check 区分）；菜单用 `createPortal` 挂到 `document.body`、`position:fixed`（按触发按钮 `getBoundingClientRect()` 锚定在标题栏正下方，`usePopover("titlebar-workspace")` 负责外部点击/Esc/互斥收起），列出工作区（当前项高亮勾选）+「添加工作区」。
  2. `TitleBar` 增加 `tabsLeading` 插槽，渲染在 `tabsSlot` 内、标签页之前（整条标签区 no-drag，按钮可点）；`App` 传入 `<WorkspaceSwitcher workspaces activeWorkspaceId onSelectWorkspace=bindWorkspaceToCurrentSession onAddWorkspace=addWorkspaceForChat />`。
  3. 删除 `BrowserChrome` 里的工作区状态/菜单/按钮与 4 个 props（工具条恢复「后退/前进/刷新 + 地址栏 + 快照/更多」），工作区概念只保留在标题栏与设置界面。
  4. 设置跳转：`Settings` 增加 `onOpenUrl?`，`BrowserExtensionsSection` 的「打开 Chrome 商店 / 打开 Edge 商店」优先走它；`ChromePage` 增加 `onOpenUrl` 并透传给整页 Settings。`App` 的处理器：先 `dismissAllPopovers()`、关闭设置/整页遮罩，再 **延迟 90ms**（等遮罩关闭、原生视图恢复布局后）调用 `browser.newTab({url})`，避免同一 tick 建标签被仍在遮罩状态的主进程布局隐藏。
- **验证**：真机 E2E `e2e-evidence/titlebar-workspace.png` + `titlebar-workspace.log`：入口 rect `(0,0,34,40)`（窗口左上角，chevron-only，无文件夹图标），第一个标签 left=40（紧接其后）；点开后菜单 rect `(4,44,212,149)`，含「试验场/默认工作区/添加工作区」，选中后 title 变为「工作区：默认工作区」且菜单收起。设置跳转（ChromePage 整页设置 → 浏览器扩展 → 打开 Edge 商店）：点击后设置整页消失、标签页新增/切到「Microsoft Edge 加载项」并 active；窗口级截图 `settings-chromepage-jump4-window.png` 显示直接落在商店页（本机网络返回 Chromium 连接错误页，属预期），无需再手动退出设置。typecheck 5/5；全量 vitest 见 PROGRESS 四十五；gen/check/build 通过。

### 追加修订（m09840 / m09866 / m09937 / m10007）

- **只留箭头**（m09840）：触发按钮不再显示 folder 图标，只保留 chevron。
- **尺寸与标签页齐高**（m09866）：30×30 圆角（8px）方块，`marginTop:10px` 与标签页上下沿对齐；箭头放大到 18px；实测按钮 rect `(6,10,30,30)` 与标签页 `(42,10,193,30)` 同高同顶底，展开菜单 rect `(6,44,212,149)`。
- **高光替代边框**（m09937）：常态无 border、无底色；悬停/展开仅用橙色半透明高光（`rgba(200,118,60,0.18)`），不再出现一圈边框。
- **再次点击必须收起**（m09937）：`usePopover` 的「点外部收起」在 pointerdown 阶段触发；若触发按钮没有 `data-popover-trigger`，会先被收起、click 再 toggle 成展开（每次都重新打开）。修复：按钮外层加 `data-popover-trigger`，pointerdown 视为浮层内部，click 正常 toggle。E2E：连点两次后 `aria-expanded` true→false，`E2E_WINDOWS` 始终只有主窗口。
- **展开菜单不被网页遮挡、且不引入掉帧**（m10007）：曾尝试「独立透明置顶浮层窗口」（复用工具栏 popover 子窗口）让菜单浮在 WebContentsView 之上，实机在带视频/轮播的网页上出现严重卡顿掉帧，已回退。最终方案：菜单仍是主窗口 DOM + `createPortal`，展开期间 App 通过 `browser.setOverlay({open:true})` 临时隐藏原生网页视图（关闭即恢复），并把 `workspaceMenuOpen` 合并进现有 overlay 计算；不再创建任何副窗口，避免透明置顶窗的 DWM 合成开销。副作用是菜单打开期间网页让位（DOM 背景），换取菜单可见与帧率。
- **验证证据**：`e2e-evidence/ws-toggle-twice.log`（二次点击收起、0 副窗口）、`ws-menu-open.log`（菜单 rect/文案、展开态高光）、`ws-menu-outside.log`（点页面外收起、`aria-expanded=false`）；截图 `ws-menu-open.png`。


### 追加修订 2（m10071）——回退「展开菜单时隐藏网页」

- 上一版为了让 DOM 菜单浮在网页上，在菜单展开期间调用 `browser.setOverlay({open:true})` 临时隐藏原生 WebContentsView；用户实测「一点击左上角展开，网页界面就没了」，明确否掉（而且对卡顿没有实际帮助）。
- 最终：工作区菜单改回**独立浮层子窗口**（`PopoverApp` 的 `workspaces` 类型），网页全程保持可见、菜单天然浮在网页之上；不创建 DOM 菜单、不隐藏原生视图、无阴影（浮层窗口 `hasShadow:false` + 卡片 `box-shadow:none`）。
- **再次点击收起的根因与修复**：点回主窗口时浮层窗口先 `blur`，主进程若立即 `close()`，渲染层 click 的 `togglePopover` 会看到「已关闭」→ 又打开。修复：`chromePopover.ts` 的 blur 处理增加判断——若主窗口此刻已获得焦点则不立即关，交给 hover 轮询（指针移出菜单/锚点才关）与 click 的原子 toggle；点其它应用时主窗口未聚焦，仍立即关闭。
- E2E：打开时 `E2E_WINDOWS`=2（主窗口 + 浮层），浮层 URL `loopsoar://app/index.html?popover=workspaces&lang=zh-CN`，菜单 3 项（试验场/默认工作区/添加工作区）220×160、卡片 `box-shadow:none`；连点两次后 `aria-expanded` true→false、`E2E_WINDOWS` 回到 1。证据 `e2e-evidence/ws-popover-open.log`、`ws-popover-toggle.log`。

- **状态**：✅ 真机 E2E 已验证（2026-11-13）
- **回退条件**：若后续需要「在设置里打开链接但保留设置页」，可让 `onOpenUrl` 不关闭遮罩；当前按用户要求选择直接离开设置。


## ADR-0093 有网页时侧栏展开/收起的掉帧修复（初版：不再逐帧 resize → 后经 m10244 恢复同拍，保留性能缓存）

- **背景**：用户 m10071 反馈「卡顿仅限于有网页的时候，各个栏目的展开、收起掉帧严重到了极点」。此前侧栏宽度动画（320ms）由主进程 `setInterval` 逐帧插值，每一帧 `applyLayout()` → 对所有会话/标签的原生 WebContentsView 调 `setBounds`；有网页时每帧触发 Chromium 表面重排与 DWM 合成，造成严重掉帧（无网页时不明显）。
- **决策/实现**：
  1. **停止逐帧 resize 原生视图**：`App.tsx` 不再调用 `browser.setSidebarWidth({animate:true})`。侧栏宽度变化时：
     - **侧栏变宽（展开）**：原生网页视图一次性缩到目标宽度（否则网页在 DOM 之上会盖住正在滑入的侧栏），DOM 侧栏随后用 CSS 过渡滑入空出的区域。
     - **侧栏变窄（收起）**：原生视图先保持当前窄宽等 DOM 动画结束（网页不会盖住收起动画），340ms 后再一次性让网页铺满。
     - 拖拽/启动水合仍为瞬时 `animate:false`，保持跟手与不误播。
  2. **动画期间隐藏侧栏内容**：`App` 增加 `sidebarWidthAnimating`（约 360ms），`AgentSidebar` 新增 `widthTransitioning` prop；宽度过渡期间 inner `opacity:0`、`pointer-events:none`，结束再 160ms 淡入。避免 320ms 内文字逐帧重排（与 ADR-0077 的模式切换遮罩同思路）。
  3. **主进程动画帧只更新活动标签**：`browserHost.ts` 的 `applyLayout(activeOnly)`，在侧栏 `setInterval` 插值帧中只处理当前会话的当前标签（其余标签视图本就隐藏），把每帧 N 个 `setBounds/setVisible` 降到 1 个；动画结束再全量 `applyLayout()` 对齐所有标签。保留逐帧插值接口给未来需要原生跟随的场景。
- **验证**：E2E `e2e-evidence/sidebar-anim.log`：collapsed 48 → 点击展开，120ms 时 wrapper=315、inner `opacity:0`，结束 477、`opacity:1`；再点击收起，120ms 时 wrapper=210、inner 淡出，结束 48、`opacity:0`。`e2e-evidence/rail-hover.log`：竖条悬停 1.5s 后侧栏 48→477，但会话/工作区列表不再自动打开（`session-list-panel` 与任何 `data-popover` 均不存在）。typecheck 5/5、gen/check/build 通过、全量 vitest 见 PROGRESS。

### 追加修订（m10183）：杜绝「缝隙漏初始页」

- 现象：有网页时收起/展开侧栏，原生网页视图与 DOM 页列宽度在动画期间不一致，缝隙里会漏出新建标签页（NTP）的搜索框/快捷入口残影；极端情况下延迟对齐定时器被取消，会让原生视图一直停在窄宽，残影变成常驻。
- 修复：
  1. **动画期间隐藏 DOM 起始页**：`StartPage` 新增 `hidden` prop；当侧栏宽度动画进行中且当前标签是已加载的真实网页（`currentUrl` 非空、非 loading、无 loadFailure）时，DOM 层 `visibility:hidden`，缝隙只露出统一背景，不再漏 NTP 内容。空白页/加载页/错误页/Vibecoding 页不受影响。
  2. **延迟对齐不再可被取消**：收起侧栏后「延迟铺满网页」的定时器改为 ref 持有，新的宽度变化先清理再重排，组件卸载时兜底清理；不再挂在 effect cleanup 上被无关重渲染取消。
  3. **动画结束兜底同步**：360ms 遮罩结束时再强制对齐一次原生视图目标宽度（幂等），即使延迟定时器意外错过也不会留下错位。
- 验证：E2E `e2e-evidence/ntp-leak.log`：真实网页加载后展开侧栏（110ms 时 `StartPage visibility=hidden`、wrapper 305；结束 477、visible），再收起（110ms hidden、232；结束 48、visible）；窗口级合成截图 `ntp-leak2-window.png` 收起后网页铺满、右侧只剩 44px 收起点，无 NTP 残影。


### 追加修订（m10244）：恢复左右同拍动画，同时保留性能优化

- 用户反馈更偏好之前的观感：「左右栏目跟进一起平滑变化」。因此恢复「原生网页视图与 DOM 侧栏同曲线逐帧同步」的方案（ADR-0093 最初的逐帧动画），但把上一轮排查出的性能问题逐项消除后再启用：
  1. **动画帧只处理活动标签**：`applyLayout(activeOnly)` 仍然生效，逐帧插值只对当前会话的当前标签 `setBounds`，隐藏标签/其他会话完全不参与（这是当初「有网页时掉帧」的最大头）。
  2. **几何/可见性缓存**：`TabEntry` 增加 `lastBounds`/`lastVisible`，`setBounds` 仅在矩形真正改变时调用，`setVisible` 仅在可见性改变时调用；动画帧不再重复调用这两个昂贵原语。
  3. **DOM 起始页动画期间隐藏**：保留 `StartPage hidden` 守卫，原生视图与 DOM 列在动画中间不一致的瞬间不再漏出 NTP 内容（详见前一节修订）。
  4. **侧栏内容恢复可见**：取消 `widthTransitioning` 内容遮罩（上一版为降负载加的），侧栏与网页一起滑动的观感与之前一致；仅保留搜索↔Vibecoding 切换遮罩。
- 实现：`App.tsx` 宽度 effect 恢复 `browser.setSidebarWidth({width, animate:true})`（启动水合/拖拽仍为 `animate:false`），`sidebarWidthAnimating` 仅用于动画期间隐藏 DOM 起始页。
- 验证：E2E 动画 110ms 时 `sidebarW=293`、侧栏 inner 可见；窗口级合成截图 `e2e-evidence/sync-mid-window.png` 显示网页与侧栏处于同一中间态（网页右缘随之收缩、侧栏内容可见），证明两边同拍。


### 最终修订（m10584/m10603）：渲染层 rAF 驱动 + 原生同拍，帧率提升到 ~60fps

- **背景**：快照跟随方案在收起/展开时出现「默认页 ↔ 网页」闪帧（截图/遮罩时序无法完全消除）、拉伸或缩放闪回，用户明确否掉；改为纯原生同拍后又出现「约 30fps」的掉帧观感。
- **排查结论（含公开资料）**：
  - 主进程 `setInterval(16ms)` 在 Windows 上实测实际间隔约 20–25ms（约 40fps），这是掉帧的直接原因；主进程计时器会被系统合并/延迟。
  - Electron/Chromium 在 Windows 上通过 DirectComposition + swapchain 呈现网页；窗口/视图 resize 涉及 compositor 输出表面与 clip/viewport 的异步提交，逐帧 resize 本身就难以稳定 60fps（参考 Electron 官方文章 [Tech Talk: Improving Window Resize Behavior](https://www.electronjs.org/blog/tech-talk-window-resize-behavior)：Windows 上 resize 会出现旧帧/黑边，Electron 39.2.6 才修复 stale pixels；相关实现见 Chromium `direct_renderer.cc` / `root_compositor_frame_sink_impl.cc`）。
  - 评估过但不可行：`app.disableHardwareAcceleration()`（整体性能大幅下降）、ANGLE 后端切换（驱动兼容/性能不可接受）、对 WebContentsView 做 CSS transform（Electron 不支持）、逐帧截图快照（闪烁/拉伸）。
- **最终方案**：
  1. **渲染层 `requestAnimationFrame` 驱动**：`App.tsx` 在侧栏宽度变化时启动 rAF 循环，按 `performance.now()` 做 320ms 时间插值（cubic-bezier(0.2,0,0.2,1)），每帧调用 `browser.setSidebarWidth({width, animate:false})`；渲染层 rAF 跟随合成器刷新（60/120Hz），实测 DOM 宽度按 ~16ms 一档平滑推进（`e2e-evidence/raf-anim.log`）。
  2. **主进程只做即时落位**：`setSidebarWidth(false)` 直接更新活动标签 view bounds；保留 `applyLayout(activeOnly)` 与 `lastBounds/lastVisible` 缓存，避免动画帧对隐藏标签/未变化几何重复调用昂贵原语。
  3. **不再使用快照/遮罩**：网页全程真实渲染，默认页不会闪现；已加载网页时 `StartPage` DOM 保持隐藏（防止任何缝隙漏出新建页）。
  4. 主进程的 `setInterval` 动画路径保留为兼容接口，但改为按真实时间插值（避免被合并后动画变长）。
- **验证**：E2E `e2e-evidence/raf-anim.log`：收起动画 477→48，320ms 内每 ~16ms 一档平滑下降（476/461/413/…/48），无跳变；页面全程可见。typecheck 5/5、gen/check/build 通过、全量 vitest 见 PROGRESS。
- **状态**：✅ 真机行为验证（2026-11-13）；这是在不引入闪帧前提下的最优方案（原生视图逐帧 resize 的物理上限受 Windows 合成器约束）。

- **状态**：✅ 真机行为验证（2026-11-13）；帧率为主观体验项，已消除每帧原生视图 resize 这一主要来源。
- **回退条件**：若未来需要在动画中让网页与侧栏严格同拍，需要把网页视图改为 DOM 渲染层（如 WebContentsView 画面流）或接受掉帧；当前优先流畅度。


## ADR-0094 工作区 > 会话 > 网页：关系与关闭语义

- **背景**：用户 m10643 明确层级：**工作区 > 会话 > 网页**；网页与会话高度绑定但**不是一对一**——一个会话可以拥有多张网页；关网页不删会话；删会话可关网页；工作区是它们的「母、源」，记忆也应挂在工作区（下一阶段）。
- **关系定义（实现口径）**：
  1. **工作区是根**：会话属于工作区（`session.workspaceId`）；网页（标签页）挂在会话下（`BrowserHost` 每个会话一个 tab group）。
  2. **一个会话可有多张网页**：会话内的链接/新标签页在同一 group 内；关掉其中一张只影响该网页。
  3. **网页需要会话**：页面在会话的 group 中活动；新建页可以是草稿，首次对话才创建会话（ADR-0091），但一旦页面对话，它就归属该会话。
  4. **关网页 ≠ 删会话**：关闭标签只移除该 tab；会话列表保留，之后仍可在该会话下继续开网页。
  5. **删会话 ⇒ 关网页**：删除会话时先关闭该会话 group 下全部网页，再删除会话数据（避免留下无主网页与恢复状态）。
  6. **关掉最后一个网页 = 退出程序**（浏览器惯例）；退出前必须先真正关闭标签并等待标签状态落盘，否则下次启动会恢复刚关掉的网页——修复后下次启动显示空白新建页。
  7. **记忆**：下一阶段按工作区维度延伸（当前记忆仍为全局/会话注入，作为工作区记忆的前置）。
- **实现**：
  - 新增契约 `browser:closeSessionTabs`（`BrowserSessionIdSchema`）+ `BrowserHost.closeSessionTabs(sessionId)`：关闭该会话名下的全部标签并移除 group，返回关闭数量；`domains/browserAdapter.ts` 接线。
  - `App.closeTab` 在只剩最后一个标签时：不再直接 `window.close()`，而是 `browser.closeTab(tabId)` → 等待 **560ms**（主进程标签状态保存有 400ms 防抖）→ `window.close()`；此时会话持久化的 `browser.tabs` 为空，下次启动恢复为空白新标签页。
  - `App.deleteSession`：先 `browser.closeSessionTabs({sessionId})`，再 `chat.deleteSession`（顺序保证会话文件删除前网页已关闭，持久化不会把旧网页写回）。
- **验证**：
  - 单测（`tests/shell/browserHost.spec.ts` 新增 2 条）：同一会话两张网页 → `closeSessionTabs` 关闭 2 张并销毁 WebContents；关闭会话最后一张网页后会话组仍可新建网页（关网页不删会话）。
  - 真机 E2E：关闭最后一个标签后程序退出、会话文件 `browser` 变为 `undefined`；同一数据目录重启后 `listTabs` 只有 `{url:"", title:"新标签页"}` 一张空白页，NTP 可见（`e2e-evidence/close-last.log`、`relaunch-blank.log`）。
  - 全量 vitest **176 文件 / 1478 tests 全绿**；typecheck 5/5；gen/check/build 通过。
- **状态**：✅ 真机 E2E 已验证（2026-11-13）。
- **后续（下一阶段）**：工作区级记忆（召回/写入按 workspace 隔离）、会话删除时的工作区统计与记忆保留策略。

## ADR-0095 会话级「浏览器控制」开关 + 工具面单次解析（P0-1 修复）

- **背景**：用户第二阶段指令：vibecoding 输入框「+」菜单要一个类似 slime「联网搜索」位的开关，但语义换成浏览器控制——开启后用户可直接用自然语言指挥 Agent 操控内嵌浏览器。框架审计（docs/FRAMEWORK-AUDIT-P2.md）P0-1 同时发现：services/chat.ts 把 registry.toolSchemas() 全量广播给模型，allowlist 只拦执行——「模型看得见却调不了」既浪费上下文又诱导失败重试（plan 模式现状即如此）。
- **决策**：
  1. **会话级开关**：`PersistedSession.browserControl`（缺省/非布尔脏值=关，fail-closed；文件与索引双写、读取统一净化）；契约新通道 `chat:setBrowserControl`（sessionId 用既有单源 SessionIdSchema）；SessionMeta 带初值供 UI 水合。新会话默认关；草稿态只记标志，`ensureSessionForSend` 建会话后**先落库再发首条消息**（否则首条消息的工具面按「关闭」解析，用户会看到「开了开关但 Agent 说没有浏览器能力」）。
  2. **工具面单次解析（P0-1）**：`getToolAllowlist(mode, sessionId)`；新纯函数 `resolveToolSurface({base, allNames, exclude})`：exclude 为空→原样返回 base；base 为 undefined（=全部可见）→用注册表名字全集重构剔除后的名单（绝不能返回 undefined，否则被剔除的工具又回到可见面）；base 非空→过滤。同一份 resolvedAllowlist 既进 `registry.toolSchemas()`（模型可见面）也进执行闸，两边永远同源。plan 模式只读收窄语义不变，只是再交上浏览器开关。
  3. **单源名单**：contracts 导出 `BROWSER_AGENT_TOOLS`（当前 7 个 browser_*，后续切片扩展），守卫测试锁死 shell 注册名与名单一致；`web_fetch` 属网络权限域、不随本开关（能力语义不混用）。
  4. **UI**：Composer「+」菜单第二项（role=menuitemcheckbox + aria-checked + 勾选态），开启时 chip 行渲染品牌色胶囊并同步 measureRow 挤压测量；VibeControls 的「+」菜单（与工作区/附件同菜单，避免双加号）加同款开关；App 乐观更新、失败/会话不存在回滚、切会话按 meta 水合。
- **理由**：开关是「能力授权」而不是「权限策略」：用户显式开启 = 会话内授权浏览器操控，浏览器工具才进入模型可见面（权限最小化=上下文最小化，调研 docs/research/agent-browser-survey.md §6.5）；P0-1 修复让可见面与执行闸同源，是后续一切会话级工具门控（C/D/G 片）的地基。
- **验证**：vitest **180 文件 / 1500 tests 全绿**（新增 4 spec：resolveToolSurface 矩阵与 ChatService→toolSchemas 传参、sessionStore 落盘/重启/脏值净化、chat:setBrowserControl 域通道、BROWSER_AGENT_TOOLS 名单守卫）；typecheck 5/5；pnpm gen && pnpm check 逐字节一致；pnpm build 全绿。真机 E2E 于阶段末统一补录（见 docs/规划/第二阶段-Agent与浏览器打通.md Slice F）。
- **状态**：✅ 自动化已验证（2026-11-13）
- **回退条件**：若未来需要「模型可见但逐次确认」形态，应引入 risk 元数据（调研 §8-10）而不是回退可见面过滤。
- **复核时间**：Slice G（浏览器交互权限档）落地时，复核「开关=会话级授权」与权限类别的正交性。

## ADR-0096 偏好单源统一（contracts z.infer）+ 设置·通用「Agent 打开网页时的窗口布局」

- **背景**：审计 P1：偏好 Preferences 曾有三份定义（contracts/schemas.ts、core/preferences.ts、ui/types.d.ts），故障链是「只改 core+UI 不改 contracts → 受信入口 zod safeParse 默认 strip 未知键 → 字段被静默丢弃 → 落盘回默认值」，全程不报错。同时第二阶段功能②需要新偏好 `browserOpenLayout`（Agent 打开网页前的布局策略）作为布局询问弹窗的默认策略来源。
- **决策**：
  1. **contracts 为唯一 schema 产地**：`PreferencesSchema` 新增 `browserOpenLayout: z.enum(["ask","docked","agentWindow","keep"]).optional()`（缺省 ask），并导出 `export type PreferencesData = z.infer<typeof PreferencesSchema>`。
  2. **core 收敛为纯行为层**：删除自有 zod schema，改从 `loopsoar-contracts/schemas` 导入 schema/类型；保留 `DEFAULT_PREFERENCES`、`mergePreferences`（含 duckduckgo→bing 历史迁移与各字段 `??` 归一）、`searchUrlFor`；`AnimationsSchema` 由 `PreferencesSchema.shape.animations` 派生（引用而非第二份）。core→contracts 依赖在守卫白名单内（tests/guards/layering.spec.ts 的 ALLOWED_RUNTIME_DEPS.core 已含 loopsoar-contracts）。
  3. **ui/types.d.ts 消费契约类型**：手写 `interface Preferences` 删除，改为 `export type Preferences = PreferencesData`（该文件本就是模块，消费方 import 路径零改动）；字段漂移由编译期消灭，无需运行时对齐守卫。
  4. **设置·通用新增一行**「Agent 打开网页时的窗口布局」四选一：每次询问（ask，默认）/ 总是收到右侧（docked）/ 总是小窗（agentWindow，独立 Agent 窗口，ADR-0020）/ 保持不动（keep）；沿用通用分区 400ms 防抖自动保存，附说明行；i18n 中英成对。语义与产品意图写进 schema 注释，供 Slice E 消费。
- **理由**：三份定义是典型的「静默漂移」屎山风险（不报错、只丢数据），单源化是后续所有设置项的地基；`ask` 缺省符合用户「默认询问一遍」的产品要求。
- **验证**：vitest **180 文件 / 1503 tests 全绿**（新增 3 个 it：缺省 ask、四值保留、未知值拒绝；并断言 `PreferencesSchema.parse(DEFAULT_PREFERENCES)` 与 DEFAULT 深等——schema 缺字段会被 strip 导致不等，等价于 key 覆盖守卫）；typecheck 5/5；`pnpm gen && pnpm check` 逐字节一致（生成器只序列化通道元数据、不序列化 schema 字段内容，prefs 字段变化本就不改 gen——已实跑核实，非漏回填）；`pnpm build` 5/5 全绿。
- **状态**：✅ 自动化已验证（2026-11-13）
- **回退条件**：若未来偏好按域拆分（供应商/外观/Agent 各自独立 schema），按域拆多个 z.infer 类型并保持 contracts 单源，不回到多份手写定义。
- **复核时间**：Slice E 读取 `browserOpenLayout` 时，复核「ask=每会话问一次」语义与设置文案一致。

## ADR-0097 稳定元素引用与语义快照（P0-2：观察-动作闭环重建）

- **背景**：审计 P0-2 + 调研 §8-1/2/3/7/13：旧实现 `browser_snapshot` 打印 `[#N]` 编号，但 `browser_click` 只做 `document.querySelector(target)`——编号传进去必然失败；能解析编号的 `selectorFor` 在适配器里**生产不可达**；编号是 `querySelectorAll` 顺序号，SPA 重渲染后指向别的元素；`MARKERS_SCRIPT` 每次快照往 DOM 打 `data-loops-el` 且从不清理；`BrowserSnapshot` 类型没有 `elements`（两处 `as` 强转）；`browser_type` 直接赋 `el.value`，React 19 受控组件会回滚（「返回成功但页面没变」）。这是「AI 自动浏览器」最致命的断裂：观察与动作对不上号。
- **决策**：
  1. **ref 由适配器生成并解析，工具层只透传**：新增 `packages/shell/src/browserAdapter/refs.ts` 作为闭环单一产地。快照脚本**不写任何 DOM 属性**（问题从根上消失），在页面内为可交互元素 + 标题 + 地标计算**稳定性打分句柄**（唯一 id > name > aria-label > data-testid > 精确文本(a/button，≤60 字，附 matchText 判别串) > `tag:nth-child` 结构路径，`{selector, why}` 逐级回退）。`e1..eN` 只是按文档顺序的显示别名。
  2. **注册表生命周期**：每标签一个 `RefRegistry`（`createTabRegistry` 令牌 + 注册表），每次快照重建并 `gen+1`；`did-navigate` / `did-navigate-in-page`（主框架）清空 → 旧 ref 立即失效（宁可报 STALE_REF，也不误击别的元素）。
  3. **解析顺序向后兼容**：`target` 依次尝试 ① ref（`e5` / `5`）→ 注册表句柄；② CSS 选择器；③ `text=` 前缀。`querySelector` 只出现在 refs.ts 生成的脚本里，适配器 `click/type` 与工具层共用 `resolveTarget/performClick/performType`，不再各写一份。
  4. **语义快照输出**：首行 `[快照 #gen | URL | 标题]`，正文按 `maxChars` 截断，元素区一行一个（`[#e2] textbox "搜索" (value="")` / `[#e4] button "提交" (disabled)` / `[#e1] link "登录" → /login`），显示上限 80 条并提示总数，页面内最多为 200 个元素计算句柄（防巨型页面卡死）。
  5. **可行动错误**：`STALE_REF`（引用过期，提示重新快照）/ `ELEMENT_NOT_FOUND`（带 ≤3 个按 name/role 相近的候选 `#eN`）/ `INVALID_SELECTOR` / `TYPE_NOT_EFFECTIVE`（附页面回读值）。
  6. **原生 setter 输入**：`Object.getOwnPropertyDescriptor(HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement.prototype,'value').set.call(el, text)` + `InputEvent` + `change`，**输入后回读比对**，不一致即报「输入未生效」。
  7. **类型正式化**：`BrowserSnapshot` 增加 `elements: BrowserElementSnapshot[]`、`snapshotGen`、`elementTotal`、`tabToken`，两处 `as` 强转删除。
- **理由**：调研结论是「观察格式已收敛到语义树 + 稳定引用」，且引用必须能跨一次 DOM 变更存活、动作失败必须可行动；DOM 打标方案在 SPA 下天然不可靠（不清理 + 重排漂移），因此选择「页面内算句柄 + 进程内注册表 + 导航即失效」——多花一次页面脚本计算，换来动作的确定性。
- **验证**：vitest **181 文件 / 1524 tests 全绿**（新增 `tests/shell/browserRefs.spec.ts` 13 例：脚本合法性、注册表 e1..eN 与代数、ref 归一化、解析顺序、STALE_REF、候选、原生 setter、适配器注册表生命周期；重写 `tests/shell/browserTools.spec.ts` 11 例：新快照形态、gen 单调、80 截断 + 总数、ref 点击、STALE_REF、ELEMENT_NOT_FOUND + 候选、CSS/text= 回归、输入脚本、输入未生效）；另用最小假 DOM 真跑快照脚本核对句柄类型（id/文本/路径三类均命中）。typecheck 5/5、`pnpm gen && pnpm check` 逐字节一致、`pnpm build` 5/5。Lead 复核时补一处缺陷：`buildTypeScript` 原本直接 `querySelector(selector)`，会让「精确文本型」ref 句柄打到同标签首个元素——已改为与 click 共用 `locateJs` 定位段，24 例相关测试保持全绿。
- **状态**：✅ 自动化已验证（2026-11-14）
- **已知局限**：`snapshotTokens` 目前是会话级（工具面只有「活动标签」，无 tabId 参数）→ Slice D 扩多标签工具时必须改为标签级，否则切标签后旧令牌可能解析到另一标签的注册表。
- **回退条件**：若将来改用 CDP `backendNodeId` 作句柄（更强稳定性），保留 `RefRegistry` 接口不变、只替换句柄来源。
- **复核时间**：Slice D 接入多标签后，复核令牌与标签的绑定；Slice G 引入交互权限档时复核失败码与确认流程的组合。

## ADR-0098 多标签工具 + 动作扩展 + 动作后状态增量 + 点击命中验证

- **背景**：Slice C 打通的闭环只覆盖 7 个基础动作，且留了两个缺口：(a) 引用令牌是**会话级**——用户手动切标签后旧令牌可能解析到另一标签的注册表；(b) 动作只回「已点击」，模型要再花一轮快照才知道发生了什么（调研 §5.1：每步多一次 round-trip，长任务成本翻倍），点击也没有命中验证（被浮层遮挡时 `el.click()` 仍可能「成功」）。
- **决策**：
  1. **标签级引用绑定**：`BrowserHost.snapshot/executeScript` 增加可选 `tabId`（缺省=活动标签，行为不变），快照回传 `tabId`；工具层令牌表改以 `${sessionId}::${tabId}` 为键。跨标签使用旧 ref 时直接给 `[STALE_REF] 引用来自标签 A，当前操作标签是 B…`，不再猜测。
  2. **动作扩展**（7 个新工具，全部进 `BROWSER_AGENT_TOOLS` 门控名单）：`browser_tabs`（list/new/select/close，返回 index/tabId/标题/URL/active 列表）、`browser_back` / `browser_forward` / `browser_reload`（可选 tabId）、`browser_press_key`（**按键白名单**：Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown + 单个可见字符；非法键直接 `INVALID_KEY` + 可用清单）、`browser_select`（原生 setter + input/change + `selectedOptions` 回读）、`browser_hover`（pointerover/enter + mouseover/enter + mousemove 五事件）。
  3. **动作后状态增量**：所有动作统一追加紧凑状态行 `[状态] ✓ <动作> | URL … | 标题 … | 已就绪/仍在加载 | 发生导航/未发生导航`；先做 120ms 短探测（点击触发的导航可能晚于脚本返回），再按 100ms 轮询、1.5s 上限，`loading` 一变 false 立即返回——**不自动附完整快照**（省 token），发生导航时补一句「可 browser_snapshot 查看新页面」。
  4. **点击命中验证**：`el.click()` 前在元素中心点做 `document.elementFromPoint`，命中必须是 `el` 或其后代；否则返回 `BLOCKED_BY_OVERLAY` + 遮挡元素摘要（tag/id/class/文本 ≤60 字）+ 可行动建议。
  5. **失败码扩展**：`INVALID_KEY / NOT_A_SELECT / OPTION_NOT_FOUND / SELECT_NOT_EFFECTIVE / BLOCKED_BY_OVERLAY`（沿用「失败必须可行动」原则，每条都带建议）。
  6. **死代码收口**：删除适配器里生产不可达、且零测试覆盖的 `scroll`/`wait` 实现（审计 P1「浏览器动作两套实现」）；`click/type` 自 Slice C 起与工具层共用 `refs.ts` 的同一套函数，不另做入口（否则新动作只能走 executeScript、又会分裂成两套编排）。
- **理由**：多标签必须有「归属」语义（调研 §5.5），否则并发会话会互相串页；状态增量与命中验证是把「模型盲点」变成「确定性反馈」的最便宜手段；按键/下拉/悬停是把「能点能打字」升级为「能操作真实网站」的必要动作面。
- **验证**：vitest **182 文件 / 1562 tests 全绿**（新增 `browserTabTools.spec.ts` 24 例；`browserTools.spec.ts` 11→15；`browserRefs.spec.ts` 13→22；`browserHost.spec.ts` +1）；typecheck 5/5；`pnpm gen && pnpm check` 逐字节一致（名单常量不进 gen 产物，已 grep 核实）；`pnpm build` 5/5。命中验证有测试锁定顺序（`script.indexOf("elementFromPoint") < script.indexOf("el.click()")`）。
- **状态**：✅ 自动化已验证（2026-11-14）
- **已知边界**：click/type/press_key/select/hover 只作用于活动标签（需要指定标签的只有 back/forward/reload 与 tabs）；`browser_scroll` 未加状态行（保持既有行为）。
- **回退条件**：若状态行让模型误判（例如把「未发生导航」当作失败），改为可在设置里关闭的开关，而不是删除反馈。
- **复核时间**：Slice E 接入开网页前的布局询问时（navigate 是唯一有前置拦截的动作）；Slice G 的权限档落地后复核「开关=授权、权限=策略」两级语义。

## ADR-0099 浏览器操作权限档（browser）：让「AI 自动浏览器」真正跑得动

- **背景**：Slice D 把工具面扩到 14 个浏览器工具，但它们沿用了 `permissions: { network: true }`，而「设置·权限」里 network 默认 **confirm** —— Agent 每点一个链接、每输入一次就弹一次确认框，长任务根本跑不完（调研 §8 末尾点名这是「实际不可用」的根因）。可另一方面，会话级「浏览器控制」开关（ADR-0095，默认关）本身就是用户对「让 Agent 操控浏览器」的显式授权，每步再问一次属于重复授权。
- **决策（三层职责分离，缺一不可）**：
  1. **① 会话「浏览器控制」开关 = 是否授权**：默认关，`BROWSER_AGENT_TOOLS` 同时收窄模型可见面与执行闸（ADR-0095/0097）。
  2. **② 权限策略 `browser` 档 = 要不要问**：策略层新增独立类别 `browser`（比 `network` 更具体：network 是「抓网页/调服务」的粗粒度授权，browser 才是「Agent 操控内嵌浏览器」这件事本身）；默认 `allow`，用户可在设置·权限改成 `confirm` / `deny`；`categoryForToolPermissions` **先判 browser 再判 terminal/network**（否则 browser 档永远不生效）；`decisionFor` 类别联合同步放宽。
  3. **③ 敏感步骤写死确认 = 逐次必问**：`classifySensitiveStep`（登录/支付/不可撤销）+ `sensitiveAlwaysConfirm` 原样保留，`needsConfirm` 公式一字未改——**这是 browser=allow 之后唯一的登录/支付闸门，代码里有「不许删」注释**；「本次会话总是允许」对敏感步骤也只降级为 allow-once。
  4. **沙箱层不扩档**：`PermissionKind` 仍是 read/write/terminal/network（L0–L5 形式化分级与 `tests/core/permissionLevels.spec.ts` 的等式断言不动）；`kindOfTool` 把 browser 映射成 network，即「策略按 browser 档、沙箱按 network/L4 级」，两层各管各的。`levelForTool` 补 browser→4，避免落进「无法归类 → L5 fail-closed」。
  5. **工具声明**：11 个动作型浏览器工具 `{network:true}` → `{browser:true}`；`browser_snapshot/screenshot/wait` 保持 `{read:true}`（只读探测不该被浏览器档影响）；`web_fetch` 保持 `{network:true}`（不是浏览器操控，语义不混用）。
  6. **契约必须同步加字段**：`handleTrusted` 用契约 schema 校验后把 `parsed.data` 交给 handler，`z.object` 会剥掉未声明字段——契约不认 `browser`，用户选的 `confirm/deny` 会在 IPC 边界被静默丢弃并回落 allow（安全语义错位）。故 `packages/contracts/src/schemas.ts` 的权限 schema 增加 `browser` 枚举（只加字段，不改通道，gen 产物不变）。
  7. **UI 暴露**：设置·权限新增「浏览器操作」行（三态与其余四类同一控件，行由 shell 返回的 `PERMISSION_CATEGORIES` 驱动，自动成行）；输入区权限菜单增加第 5 项；i18n 中英成对，说明文案写明「总开关；登录、支付与不可撤销操作不受此项影响，始终逐次确认」。
- **理由**：把「授权闸」「策略闸」「敏感闸」分开，是本阶段安全模型的关键——用户用一次显式授权换来可用的自动化，而不可逆动作仍被独立的第三道闸逐次拦住；同时保留 `confirm/deny` 让谨慎用户随时收紧。相比「每步都问」（不可用）与「全放开」（危险），这是唯一既安全又可用的一档。
- **验证**：vitest **183 文件 / 1573 tests 全绿**（新增 `tests/services/chatBrowserPolicy.spec.ts` 8 例：browser=allow 不弹窗且沙箱 kind=network、confirm 弹窗、deny 拒绝、browser=allow 不放行 web_fetch 的 network 确认、只读工具不受牵连、**browser=allow 下点「立即支付」/导航 `/checkout/pay` 仍 confirm**、敏感步骤 allow-session 不写白名单；core 偏好 +2、权限等级 +1；shell 守卫断言 11 个动作型工具全部 browser 且只读/web_fetch 归类正确；settings 域回读 `browser:"deny"` 不被吞）。typecheck 5/5、`pnpm gen && pnpm check` 逐字节一致、`pnpm build` 5/5。
- **状态**：✅ 自动化已验证（2026-11-14）
- **已知遗留**：输入区权限 chip 的摘要文案（App.tsx 的 `permissionLabel`）只聚合 write/terminal/network，尚未反映 browser 档 → Slice E 一并修。
- **回退条件**：若 `browser: allow` 在某些场景被认为过宽，把默认改回 `confirm` 即可（改动只有一行），安全模型不变。
- **复核时间**：真机 E2E 验证「开关开 → 连续点击不弹窗 / 点支付仍弹窗」时。

## ADR-0100 Agent 打开网页前的布局询问 + 真机端到端验收（第二阶段收口）

- **背景**：用户第二阶段指令的功能②：浏览器控制开启的会话里，Agent 在执行任务、打开网页之前要问用户一次——「会话收到右侧（常规布局）」还是「变为小窗（独立 Agent 窗口）」；默认策略放进设置·通用（Slice B 已落 `browserOpenLayout`），并且询问窗里必须把两种安排解释清楚。
- **决策**：
  1. **决策纯函数化**：新增 `packages/shell/src/main/browserLayoutChoice.ts`——只吃「开关状态 / 设置策略 / 会话记忆 / 语言 / 目标 URL」+ 三个注入回调（`ask` / `remember` / `apply`），零 electron、零 fs、零全局状态，分支全覆盖可单测。中英询问文案集中在此（AskBus 的 question 是跨进程字符串，主进程无法 import UI 词典，两处各存一份必然漂移，故只在主进程保留一份、UI 只留失败提示 key）。
  2. **语义**：① `ask` + 会话无记忆 → 询问一次并记住；② `ask` + 已有记忆 → 不再问、按记忆应用；③ 设置写死 `docked`/`agentWindow` 属于「每次都这样」，**不写**会话记忆（否则用户改了设置，旧会话还按当年那次选择走）；④ `keep` → 既不问也不动布局；⑤ **取消/超时 → 不写记忆、不导航（fail-closed）**；⑥ 会话没开浏览器控制 → 直接放行（工具此时本不可见，这里只做防御）。
  3. **询问文案**（写清两种安排 + 可去设置改）：
     「Agent 准备在当前会话打开网页：{url}\n\n请选择会话窗口的布局（本次会话只需选择一次）：\n· 收到右侧（常规布局）——网页占据主区域，会话栏停靠在窗口右侧，适合边看边聊；\n· 变为小窗（独立 Agent 窗口）——会话独立成一个小窗浮在桌面上，主窗口的网页铺满全屏，适合专注浏览网页。\n\n选择会记在本会话；之后可以在「设置 · 通用 → Agent 打开网页时的窗口布局」修改默认行为。」
  4. **落点**：`browser_navigate` 在真正导航前过 `hooks.beforeOpenPage`（`browser_tabs new` 不挂钩子，面收敛并注释说明）；壳层装配读会话/偏好 → 决策 → `pushToRenderer("chrome:applyLayout")`（EVENTS 新增）→ 渲染层执行真窗口动作（`ui.openAgentWindow` / `ui.closeAgentWindow` + `sidebarMode:"docked"` 落库）；工具结果追加 note。
  5. **顺带修 Slice G 遗留**：输入区权限 chip 的 `permissionLabel` 纳入 `browser` 档。
- **真机端到端验收（本轮新建、可重复）**：
  - `scripts/mock-openai-server.mjs` 增加 `MOCK_TOOL_ARGS_SEQ`（按第 N 次工具调用取第 N 组参数；原先只有单一 `MOCK_TOOL_ARGS`，表达不了「导航→快照→点击→快照」这种不同参数的序列）。
  - 新增 `scripts/e2e-p2-eval.js`（渲染层场景：配 mock 供应商 → 建会话并开浏览器控制 → 发指令 → **用真实按钮回答布局询问** → 取 `chat.history()` 取证）与 `scripts/e2e-p2-run.mjs`（起本地页服务 + mock 服务 → 独立数据目录启动 Electron → 落 log/截图 → 退出后核对会话落盘真值）。
  - **实测结果（2026-11-14 13:43）**：`E2E_EVAL {"ok":true, ... "evidence":{"askDialogShown":true,"askDialogClosed":true,"navigated":true,"snapshotWithRefs":true,"clickedMarker":true}}`；mock 侧 `MOCK_TOOL_RESULT [快照 #2 | http://127.0.0.1:19443/ | Loopsoar E2E 本地页] … 点我 按钮已点击 … [#e1] heading … [#e2] button "点我"`；会话落盘 `browserControl:true`、`browserLayoutChoice:"docked"`。即：**Agent 自主完成「打开网页 → 读快照 → 点按钮 → 再读快照 → 汇总」全链路，布局询问在界面上真实弹出并被真实点击回答**。
- **验证**：vitest **187 文件 / 1605 tests 全绿**（新增 `browserLayoutChoice.spec.ts` 13、`sessionBrowserLayoutChoice.spec.ts` 9、`browserNavigateHook.spec.ts` 6、`browserLayoutEvent.spec.ts` 4）；typecheck 5/5；`pnpm gen && pnpm check` 逐字节一致；`pnpm build` 5/5；真机 E2E 如上。
- **状态**：✅ 自动化 + 真机 E2E 已验证（2026-11-14）
- **已知边界**：小窗已打开时再次 apply 只聚焦、不换会话（`agentWindow.ts` 窗口管理器暂不支持换会话，已在代码注释标注）；E2E 的 `chat.history()` 取证依赖助手消息回灌文本（时间线持久化的独立校验留待后续）。
- **回退条件**：若「每会话问一次」被认为打扰，把设置默认改为 `keep` 即静默（无需删代码）。
- **复核时间**：第三阶段接入多会话并发浏览时，复核「布局询问只对打开网页的会话生效」。

## ADR-0101 第二阶段收口后的 UI 打磨（用户 2026-11-14 反馈 5 项）

- **背景**：第二阶段交付后，用户实测提出五处观感/交互问题：① 搜索页会话列表浮层四周阴影太重；② 浮层展开后「会话列表」开关被盖住，只能点外部关闭；③ Vibecoding 里所有点击展开的菜单，再点同一按钮是「重新展开」而非收起；④ 推理等级文案中英混杂；⑤ 收起态竖条里的图标带边框底色、缺分隔线、会话按钮未与网页顶边对齐；另要求把「浏览器控制」开关从「+」菜单移到工作区选择同行。
- **决策**：
  1. **浮层去阴影 + 开关可再点收起**：`sidebarSessionOverlay`/`miniSessionOverlay` 删除 `boxShadow: SHADOW.float`（保留边框）；浮层 `top` 由 0 改为 52（浮层实测起点 y=92，头部 40–88，天然不遮头部）——开关可再点即收起（`onToggleSession` 本就是 toggle，此前只是被浮层挡住）。
     **回归与修正**：一度给 `sidebarHeader` 加 `position:relative; zIndex:45`，结果把头部的层叠抬到绝对定位的收起按钮（`.sidebar-toggle` zIndex:3）之上，**收起按钮整块失效**（用户 2026-11-14 实测）。已回退 header 的定位/z-index；实测收起按钮 `docked→collapsed→docked`、Vibecoding 同样可用、会话列表开关在浮层展开时仍可点（`elementFromPoint` 命中按钮自身或其图标）。
  2. **浮层开关二次点击收起**：Vibecoding 的模型胶囊/「+」/工作区/推理四个触发器此前没加 `data-popover-trigger`，`usePopover` 的「点外部」判定先把菜单关了，随后 click 又把 open 置 true（观感像「重复展开」）。统一补 `data-popover-trigger`（Composer 早已如此）。
  3. **推理等级英文**：`effortLabel` 不再做中英映射，直接返回模型声明的档位名（`low/medium/high/max…`），关闭态 `off`；两处菜单的「关闭」项同步用 `effortLabel("")`。菜单标题仍走 i18n（「推理强度 / Reasoning effort」）。
  4. **收起态竖条（只动会话按钮，不动展开按钮）**：用户复核「展开列表的按钮不用改，只改下面的会话按钮」→ `.sidebar-toggle` 保持原样（品牌底 + hover 高亮）；`.rail-item` 去掉边框与底色，仅 hover 高亮、选中 `rgba(200,118,60,0.16)`；**底色/文字色必须写在 CSS 而不是内联样式**——内联优先级更高，曾在 `railItem` 里写 `background:transparent` 把 `:hover` 压掉，导致悬浮毫无反馈（用户 2026-11-14 复核）；新增 `.sidebar-rail-separator`（26×1，`linear-gradient(90deg, transparent, rgba(255,255,255,.22), transparent)`，`top:56`）——**分隔线上边界**与网页内容区上边界（窗口 y=96 = TITLE_BAR 40 + TOP_BAR 48 + INSET 8；竖条原点在标题栏下方 y=40）齐平；竖条 `padding-top` 改 66，会话按钮从分隔线下方 9px 开始（实测 `sepTop=96`、`firstItemTop=106`）。
  5. **浏览器控制入口搬家**：从 Composer「+」菜单与 Vibecoding「+」菜单移除，改为工作区选择同行右侧的胶囊（`composer-browser-chip` / `vibe-browser-chip`）：开启时品牌色底+描边，关闭时中性透明，点击即切换。
- **验证（真机 E2E，逐项测量）**：
  - 会话列表：`panelShadow="none"`、`toggleHittable=true`、`closedBySameButton=true`、`reopened=true`（`e2e-evidence/p2-fix-session-panel.png`）。
  - Vibecoding：`modelClosedBySameChip=true`、`plusClosedBySameButton=true`、`effortItems=["off","low","medium","high"]`、`vibeChipExists+s何ameRow=true`（`e2e-evidence/p2-fix-vibe-menus.png`）。
  - 收起态：`firstItemTop=96`（与网页顶边齐平）、`separatorTop=88/宽26`、`itemBorder=0px`、`itemBg=transparent`、`toggleBg=transparent`（`e2e-evidence/p2-fix-collapsed-rail.png`）。
  - 回归：typecheck 5/5、vitest **187 文件 / 1605 tests**、`pnpm build` 5/5。
- **状态**：✅ 真机验证（2026-11-14）
- **回退条件**：若「浮层不遮头部」导致可用高度不足，可改为浮层覆盖但把开关 z-index 抬到浮层之上（不恢复阴影）。

---
---
## ADR-0102 Agent 浏览器可视化：页内虚拟光标 + 窗口外侧呼吸灯 + 会话隔离

- **背景**：用户 m00802/m00860 实测反馈「Agent 在浏览器里操作时根本看不到它在做什么」，要求像真人一样能看见指针/点击位置，并对「正在被操作的会话」给出持续的可见反馈；同时强调**会话隔离**——只有进入对应会话才显示对应浏览器的活动，不能串。调研见 `docs/research/agent-browser-visualization.md`（520 行 / 29 来源）。
- **关键约束（调研结论）**：Electron 的原生 `WebContentsView` 永远绘制在 DOM 之上，任何「画在会话栏那一侧」的边框都不可能盖住网页；呼吸灯只能画在**原生视图外侧的留白**（页面面板 inset 2px 的画布），几何复用 `computeBrowserViewBounds`。页内视觉只能注入到网页本身。
- **决策**：
  1. **页内虚拟光标**：`packages/shell/src/browserAdapter/refs.ts` 新增 `buildCursorScript`——closed shadow root 挂 `host[data-loopsoar-agent]`（页面 CSS 与选择器都碰不到内部），指针 + 目标高亮框 + 点击涟漪全部由逐条 CSSOM 内联写入，`pointer-events:none` 不挡命中；涟漪用 WAAPI（页面禁用动画时不阻塞动作）。`performClick`（带涟漪）与 `performType` 在真正动作前先注入，`CURSOR_LEAD_MS=170` 给人眼可感知的提前量——**不是为了动画，而是让「Agent 要动哪里」先可见**。
  2. **窗口外侧呼吸灯**：contracts 新增事件 `chrome:agentActivity`（`{sessionId, tool, phase:"start"|"end"}`）；壳层在 `registerBrowserTools` 之后给 `BROWSER_AGENT_TOOLS` 逐个包一层 `execute`，start/end 推送；UI 在 `pageColumn` 渲染 `[data-testid="agent-browser-glow"]`（inset 2px、双 ring box-shadow、`agentGlowPulse 1.5s`），尊重 `data-animations`（reduced/off 时不动画）。
  3. **会话隔离（用户明确要求）**：UI 只在该事件的 `sessionId` 等于当前会话时点亮呼吸灯，并在 `start` 时把「宿主当前活动标签」切到可见（用户手工切走的标签，Agent 动作时拉回来）；**跨会话的事件一律不动界面**——后台会话动网页不会把你的窗口切走。
  4. **截图守卫**：`browser_screenshot` 截图前临时隐藏浮层、截图后恢复，避免 Agent 把自己的光标/涟漪拍进证据图。
- **验证**：单测（脚本生成与执行次数、浮层与截图顺序）→ vitest **187 文件 / 1605 tests**；真机 E2E：API 驱动会话 `starts=4/ends=4`、UI 驱动会话 `glowSeen=true/glowAtEnd=true`（监听器挂得比事件晚，计数为 0，属探针时序而非功能缺陷），证据 `e2e-evidence/p2-agent-glow.png`。
- **状态**：✅ 真机验证（2026-11-14）
- **回退条件**：若某站点 CSP 禁止注入内联样式导致浮层失效，可改为只画呼吸灯（窗口外侧），页内光标降级为「动作后高亮目标一次」。

## ADR-0103 布局选择改到首启向导（去掉「每次询问」策略；用户 m00974）

- **背景**：用户实测后明确要求：「把那个 agent 操作浏览器时的选择页换到新用户时的弹窗那，这个设定只在用户第一次打开 loopsoar 时出现，以后想改直接去设置里面改就行，不要每次 agent 操作时都弹这个选项。」
- **决策**：
  1. **删除「每次询问」策略**：contracts `PreferencesSchema.browserOpenLayout` 由 `ask|docked|agentWindow|keep` 收敛为 `docked|agentWindow|keep`，缺省 `docked`；`mergePreferences` 把老配置里的 `"ask"` 迁移为 `"docked"`（不迁移会让整份偏好校验失败、设置页直接报错）。
  2. **删除整条询问链路（避免死代码）**：`packages/shell/src/main/browserLayoutChoice.ts` 与 `tests/shell/browserLayoutChoice.spec.ts`、会话记忆字段 `browserLayoutChoice`（`SessionStore` 字段/净化/`setBrowserLayoutChoice`）及 `tests/shell/sessionBrowserLayoutChoice.spec.ts` 一并删除——它们只为「询问一次并记住」服务，留着就是没人读的状态。
  3. **壳层钩子只做「按偏好应用」**：`beforeOpenBrowserPage` 读偏好 → `keep` 完全不动窗口 → `docked/agentWindow` 推 `chrome:applyLayout`；新增 `appliedLayoutBySession` 去重，同一会话同一布局只推一次（否则每次导航都会动窗口）。
  4. **首启向导承担「选一次」**：`Onboarding` 由 3 步扩为 4 步，欢迎页后新增「Agent 打开网页时，窗口怎么摆？」——两张卡片各自解释两种安排（收齐到右侧＝网页占主区域、会话栏停靠右侧；独立小窗＝会话浮在桌面、网页铺满主窗口），完成时把选择交给 App 落库（`api.settings.setPreferences`），**与当前偏好相同则不写**（从设置·关于重开向导不会把用户设置冲掉）。
  5. **设置 · 通用**同步改为三选一，提示文案写明「首次启动向导里选过一次，随时可在这里改」。
- **验证**：vitest **185 文件 / 1585 tests**（净 −20：删 13 + 9，新增偏好迁移 1 + 守卫 1）、typecheck 5/5、`pnpm gen && pnpm check` 逐字节一致、`pnpm build` 5/5。真机 E2E：向导第 2 步标题命中、卡片高度 70/70 不重叠、选中态 `aria-pressed=true`；走完向导后 `prefs="agentWindow"` 已落库，Agent 打开网页时 `asks=0`（**没有任何询问弹窗**）、`chrome:applyLayout` 只收到一次 `agentWindow`；证据 `e2e-evidence/p2-onboarding-layout.png`、`p2-onb-behavior.png`。
- **状态**：✅ 真机验证（2026-11-14）
- **回退条件**：若用户仍希望在某个会话里临时切布局，可加「本次会话」菜单项，但不恢复全局默认询问。

---

## ADR-0104 会话级浏览器隔离：标签组按会话 + UI 绑定方向修正（用户 m01148）

- **背景**：用户澄清「会话隔离」指的是**浏览器本身**互不串扰——「我切换会话，让另一个会话的 agent 操作另一个网页时，不会出现上一个 agent 翻过来影响这个 agent 操作的网页」。
- **现状核查**：壳层早已按会话分组——`BrowserHost` 持有 `groups: Map<sessionId, SessionGroup>`，工具用 `ctx.sessionId` 解析`group`；可见性只在 `sessionId === activeSession && id === group.activeId` 时置 true，切会话由 `switchSession` 换组并隐藏旧组。因此**主进程不缺隔离**，缺的是 UI 侧与这套模型一致的绑定方向。
- **发现的真实问题（UI）**：`App.switchSession` 在切换时把「当前活动标签」写入 `tabSessionRef` 并归到**新会话**名下——方向反了（把上一个会话的页面改判给新会话）；随后 `activeTabId` 变化的副作用发现映射里查不到该页面，就执行「重置为草稿」（清空消息/当前会话）。表现正是「切到有网页的会话时，界面像是串了/对话没了」。
- **决策**：
  1. **不新增第二套归属**：以主进程的会话标签组为唯一事实来源；UI 只维护「空白新标签页 = 草稿」这一条产品规则。
  2. **修正绑定方向**：切换会话后，把**该会话自己的活动标签**记到它名下（从 `api.browser.listTabs()` 的结果写入），不再改写上一个会话的标签归属。
  3. **收紧草稿重置条件**：只有「映射缺失 **且** 该标签是空白页（无 URL）」才回到草稿；带 URL 的页面永远属于当前会话，不因一次无关重渲染清空对话。
  4. 页内可视化与会话隔离的关系：活动呼吸灯/跟随标签只在 `sessionId === 当前会话` 时生效（ADR-0102），跨会话动作不动界面。
- **验证**：
  - 单测：`tests/shell/browserSessionHost.spec.ts` 新增「后台会话的动作只落在自己的 WebContents」——A 会话执行脚本只打到 A 的 view（`callsA=1`）、B 的 view 零调用、可见会话与 B 的页面不变；文件共 5 用例。
  - 真机（真实 Electron + 真实 IPC）：会话 A 跑 Agent（`tab-2`，127.0.0.1:19443）→ 新建会话 B，切换后 `listTabs()` 为空（**没有 A 的页面渗过来**）→ B 跑 Agent 得到独立 `tab-3`（`sharedTabIds=0`）→ 切回 A，`tab-2` 与其 URL 原样恢复，地址栏同步。`E2E_EVAL {"tabsA":["http://127.0.0.1:19443/"],"idsA":["tab-2"],"tabsB_before":[],"tabsB":["..."],"idsB":["tab-3"],"sharedTabIds":0,"backA":["..."],"backIdsA":["tab-2"]}`。
  - UI 真机：切走再切回后会话消息仍在（751 字符，含快照/点击结果）、地址栏为该会话的页面；证据 `e2e-evidence/p2-session-isolation.png`、`p2-session-switch.png`。
  - 全量：typecheck 5/5、vitest **185 文件 / 1586 tests**、gen 逐字节一致、build 5/5。
- **状态**：✅ 真机验证（2026-11-14）
- **回退条件**：若「空白标签页 = 草稿」被产品改掉，删除该副作用即可；主进程分组不受影响。

---

## ADR-0105 Agent 工作区（折叠标签组）+ 运行期接管锁

- **背景**：用户（m01270）要求——Agent 一旦开始操作浏览器，它操作的那个网页（以及之后新建的）就与该会话的 Agent「深度绑定成一个整体」；顶部标签栏要出现一个「折叠」标签页代表 Agent 工作区，点开后向下展开它绑定/启动的网页，点哪个进哪个；进入后用户**不能操作**该网页，除非停止 Agent 的运行（停止会话）。跨会话点网页时直接切到那个会话。
- **设计（不新增第二套归属）**：会话 ↔ 标签组仍由 `BrowserHost.groups` 承担（ADR-0104），本片在它之上加两个概念：
  1. **绑定标记**：`TabState/TabEntry` 增加 `agentBound`——由 Agent 工具发起（origin=`agent`）的导航/新建把目标标签置 true，用户自己打开/导航的标签为 false，且**用户后续在同一标签操作不会撤销绑定**（否则 Agent 的页面会因为用户点了一下就从折叠组里掉出去）。
  2. **接管锁**：网页里的 closed-shadow 遮罩（`buildUserLockScript`），只拦截 `isTrusted === true` 的真实输入（指针/滚轮/键盘/右键/拖拽），**放行合成事件**——Agent 的 `el.click()` / `dispatchEvent` 的 isTrusted 恒为 false，因此锁不会把 Agent 自己锁死。视觉上给出「Agent 正在操作此页面 · 停止会话后可自行操作」。
- **关键决策**：
  1. **锁由壳层按「轮次」下发，而不是渲染层按 busy 下发**。第一版把锁放在 UI 的 `busy` effect 里，实测**从不触发**（UI 的 busy 与本轮真实生命周期不同步）；更根本的是锁的对象是网页、归属会话——后台会话、独立小窗、没有窗口时 Agent 都可能跑起来。改为 `ChatDeps.onTurnStarted/onTurnSettled`：`chat:stream` 一开始就上锁，`.finally` 解锁（成功/异常/用户停止都覆盖，绝不能只在成功分支解锁）。
  2. **只锁 Agent 绑定过的标签**：同一会话里用户自己开的页在 Agent 运行时保持可操作（`agentBound === false` 的标签一律跳过）。
  3. **弹层与命中验证的相容**：锁遮罩常驻在页面上，`buildClickScript` 的 `elementFromPoint` 遮挡校验会把自家人判成第三方遮罩，导致「锁一开 Agent 就点不动」。因此在命中校验里对本应用自己的锁宿主（id/`data-loopsoar-lock`）开例外。
  4. **注入时机与重试**：新标签 / 导航完成时在 `emitTabs` 里补注入（`retryUserLocks`），每个文档最多 3 次；加载中或空 URL 的标签跳过（此刻注入会被下一次文档销毁，白费预算）；注入失败吞掉，绝不阻断 Agent 会话。
  5. **会话绑定方向修正（连带修复）**：UI 的「标签 → 会话」映射只服务「空白新标签页 = 新对话草稿」这一条规则。此前的实现在标签还是空白（Agent 刚新建、url 尚未回填）时把会话重置成草稿，表现为「Agent 一开始操作，对话就没了」。现在：未知标签（state 晚一帧）、有 URL 的标签、`agentBound` 标签都不触发重置。
- **UI**：标签栏把 `agentBound` 标签收进最前面的「Agent 工作区 · n 个网页」chip（普通区只显示用户标签）；点开在 chip 下方展开列表面板（打开时通过 `browser:setOverlay` 隐藏原生网页视图，否则会被网页盖住），列表项显示图标/标题/当前活动勾选，点击切到该页；切会话、切标签、绑定清空时自动收起。
- **验证**：
  - 单测：`agentBound` 标记、锁只注入绑定标签、解锁清理、锁定期新标签补注入、锁不串会话、用户标签不被锁、`splitAgentTabs` 分组、`buildUserLockScript` 的 isTrusted 放行与转义；新增 `chatTurnHooks.spec.ts` 钉住「开始即锁、异常也解锁」。全量 **187 文件 / 1604 tests**。
  - 真机：Agent 跑完一轮后标签栏出现 `Agent 工作区 · 1 个网页`，展开面板列出「Loopsoar E2E 本地页」并带活动勾（`e2e-evidence/p2-agent-workspace.png`）；锁脚本对真实页面生效的像素证据：加锁前后页面平均亮度 **27 → 19 → 27**（`browser:screenshot` 采样，采样时遮罩为 `rgba(10,12,16,.55)`）。
  - 基线：typecheck 5/5、`pnpm gen && pnpm check` 逐字节一致、`pnpm build` 5/5、`pnpm bundle:shell` 通过。
- **状态**：✅ 真机验证（2026-11-14）
- **已知边界**：`agentBound` 不持久化，重启后恢复的标签回到普通标签条（与「恢复出来的标签保持 false」一致）；页面早期注册的 window-capture 监听会先于我们的 handler 执行，极端站点仍可能收到事件（`preventDefault` 仍然生效）。

---

### 修订（用户 m01968，2026-11-14 真机实测反馈）

1. **运行期不再压暗页面**：接管锁的输入拦截层改为**完全透明**（只吞真实事件），整页变暗的观感取消；「Agent 在操作」改由**网页四周的呼吸灯**表达（DOM 只能画在原生视图外侧 8px 留白里，固用 1px 定位 + 3px 环 + 外发光）。锁内提示改成顶部居中、无边框、中心最实向四周渐隐的径向渐变（不再是一个深色胶囊块）。
2. **呼吸灯按「轮次」而不是按单次工具调用**：新增事件 `chrome:agentTurn`（`{sessionId, running}`），由 `onTurnStarted/onTurnSettled` 推送。原因：工具调用只有几百毫秒，用户几乎永远看不到灯；轮次才是「Agent 正在操作」的真实窗口期（与接管锁同一生命周期）。
3. **展开工作区不再隐藏网页**：新增 `browser:setTopInset`（`topInset` 进 `computeBrowserViewBounds`），展开面板时把原生视图整体下移、面板占住顶部让出的区域，页面保持可见。面板高度由 DOM 实测上报（不再按条数估算）。实测：展开前后同一标签的页面截图高度 **908 → 848**（面板 60px）。`browser:setOverlay` 不再因工作区展开而隐藏页面。
4. **提示改为独立透明子窗口**：DOM Toast 会被原生网页盖住（用户截图实证）。新增 `ui:toast` 通道 + `toastWindow.ts`（注入窗口工厂，不 import electron）：无边框、透明、点击穿透、跟随主窗口**下方居中**，HTML 为「胶囊圆角 + 径向渐隐 + 文本处最实」，自动 4.5s/8s 关闭；主窗口不再渲染 DOM Toast，只有独立小窗模式保留内联版。
5. **折叠标签组去边框**：chip 与展开面板一律去边框，交互反馈只用高亮（用户多次强调）。
6. **提示是「胶囊」不是椭圆**：只靠 `radial-gradient` 背景会渲染成椭圆（用户先看到方边、再去掉方边后仍像椭圆）。最终形状交给 `border-radius:999px`（平顶平底 + 半圆端头），渐隐交给 `mask-image: radial-gradient(ellipse 100% 190% …)`——两者叠加即「胶囊 + 四周渐隐」，文字处最实。**色调按用户后续要求定为浅灰 + 微透**（`rgba(118,122,130,.55)` + 轻微文字投影；深色底会让提示像一块实心黑条）。E2E 直接截浮窗自身帧（`LOOPSOAR_E2E_TOAST_SHOT`，325×90）核对形状。
6. **回归**：新增 `toastWindow.spec.ts`（居中/宽度夹取/胶囊 CSS/转义）与 `chatTurnHooks.spec.ts`（开始即锁、异常也解锁）；`browserSessionHost.spec.ts` 覆盖绑定标签才上锁、新标签补锁、不串会话。全量 **187 文件 / 1607 tests**。

### 修订 2（用户 m02333，2026-11-14）

1. **Agent 工作区改为独立浮层**：展开列表不再把网页往下挤、也不隐藏页面——复用工具栏浮层机制（新增 `workspace` 浮层种类），浮层窗口天然压在原生网页之上。实测点开前后同一标签的页面截图尺寸完全一致（1088×908），页面既不动也不消失。
2. **虚拟鼠标/键盘**：光标换成用户提供的两张 SVG（导航/忙），26px、白描边+投影（深色页面也可见）、点击时按压反馈、移动带缓动；输入/按键时在光标旁显示「⌨ 输入中 / ⌨ Enter」胶囊提示。之前 14px 圆点在网页里几乎看不见。
3. **提示样式统一（写死）**：页面内的「Agent 正在操作」提示与全局 Toast 使用同一套：胶囊圆角 + 中灰 `rgba(64,68,76,.86)` + 轻投影 + 文白字投影；Toast 增加**到点前 260ms 自动淡出**（CSS 动画，主进程同步关窗），不再「啪」地消失。
4. **登录弹窗自动关闭**：`browser_click` 命中被遮挡（BLOCKED_BY_OVERLAY）时，先按「可见 + 文案/属性像关闭 + 位于上半屏/右侧」启发式点掉一个关闭控件（找不到就按 Esc），再重试原点击并回报做了什么；新增 `browser_dismiss_popup` 供模型主动调用。
5. **会话右侧截断**：未能稳定复现（简单会话的 overflow 探针无越界元素），先做兜底：消息区横向溢出由 `hidden` 改为可滚动（宁可出现细滚动条也不把内容切在屏幕外），工具卡/详情框/diff 行补 `min-width:0`、`max-width` 与换行。
6. **浮层夹进程序窗口**：浮层原来只按显示器工作区夹取，展开列表会跑到窗口外（并被窗口边界切出方角，看起来像「高亮有方边」）。现在取「显示器工作区 ∩ 主窗口内容区」再夹取，浮层永远留在程序界面内。
7. **虚拟鼠标不再用 `<img data:>`**：部分站点 CSP 禁止 img data:，图片加载失败会在网页左上角留一个破图小方块、光标也看不见。改为在 shadow root 里内联 `<svg>`（CSP 不拦、矢量清晰）。
8. **工具卡右侧截断**：`.think-tool-btn` 是 `width:100%` + padding/border 且没有 `box-sizing:border-box`，实际宽度比列宽多出 ~18px，右缘被裁掉。补 `box-sizing:border-box`（详情框同理）。
9. 说明：操作进程暂停/继续仍未完成，见规划文档待办。
## ADR-0106 虚拟鼠标/键盘改为应用级覆盖层 + 真实输入注入（按用户新定义）

- **背景**：ADR-0102 把光标/键盘提示画在网页 DOM 里，ADR-0105 修订又改成页内内联 SVG。用户（m02991）指出这是理解错了：虚拟鼠标应当被当作「用户的鼠标」，不是网页的一部分，而是**程序最上层**的一个指针；把网页视作电脑屏幕，光标由 Loopsoar 在程序内绘制并控制，用精准坐标移动并点击。光标消失、破图方块、样式不统一等问题的根因都是「画在别人家的文档里」。
- **设计**：
  1. **应用级覆盖窗口**（packages/shell/src/main/agentPointerWindow.ts）：无边框、透明、focusable:false、setIgnoreMouseEvents(true)、hasShadow:false、parent 为主窗口；内容是一张 data:text/html 页面（内联用户提供的箭头 SVG + 高亮框 + 涟漪 + 键盘胶囊）。指针窗口**懒创建**（第一次动作才建），空闲 1.6s 自动隐藏，setArea(null) 立即隐藏。
  2. **几何单源**：BrowserHost.applyLayout 在算完原生视图 bounds 后回调 onViewLayout(rect | null)；index.ts 只做「主窗口内容区原点 + 视图矩形」的平移得到屏幕坐标，16ms 防抖跟随窗口 move/resize/侧栏动画。没有可见网页（无标签/加载中/浮层打开/非活动会话）时回传 null，覆盖层随之隐藏——后台会话的 Agent 动作不会把光标画到前台。
  3. **真实输入**：browser_click 拆成「只定位（performTargetPoint，不点击）→ 光标移动/高亮/涟漪 → BrowserHost.agentClick」。后者用 webContents.sendInputEvent 依次派发 mouseMove/mouseDown/mouseUp，坐标按页面缩放换算；browser_press_key 走 agentKey（keyDown/char/keyUp，命名键映射 Electron keyCode）；browser_type 走 agentType——先真实点进输入框，再 Ctrl+A 全选、逐字派发 keyDown/char/keyUp（CJK 等单键无法表达的文字走 insertText，等价输入法上屏），多行用 Enter 换行、单行折成空格，最后轮询回读校验（输入事件异步到达，不能按键刚排队就下结论）。视图不支持 sendInputEvent（测试假件/旧后端）或回读不通过时回退原生 setter，保证兼容。browser_hover/browser_select 复用落点做视觉。
  4. **接管锁放行**：buildAgentDrivingScript(on) 在页面置位 window.__loopsoarAgentDriving，并把锁宿主/遮罩临时设为 pointer-events:none；锁的 capture handler 在标志为真时直接返回。事件派发后 120ms 恢复（事件是异步到达的，立刻恢复会把事件挡在遮罩上）。E2E 与单测都覆盖了「锁开着时真实点击仍然生效」。
  5. **后台页面必须仍可交互**：Windows 的原生遮挡检测会把「被其它窗口盖住」的页面标成 hidden，Chromium 随即**丢弃注入的输入事件**（实测：hidden 时 probe 收不到任何事件，visible 时 pointerdown/mousedown/mouseup/click 全到）。因此启动时 app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")，并对网页视图设 backgroundThrottling:false，保证用户切到别的窗口时 Agent 的点击/按键仍然有效。
  6. **删除页内痕迹**：buildCursorScript / buildKeyHintScript / 页内 __loopsoarAgentOverlay 一并移除；browser_screenshot 不再需要「先隐藏浮层再截图」（覆盖层不在 capturePage 里），截图天然干净。
- **关键决策**：
  1. **不用 CDP Input.dispatchMouseEvent 作为主路径**：实测两者都能工作，但 CDP 需要 attach debugger（与 DevTools 面板争用），sendInputEvent 是官方公开 API、无副作用；CDP 只在排障时验证过。
  2. **点击仍然先做命中验证**：落点脚本用 elementFromPoint 确认目标没有被第三方遮罩挡住（自家锁开例外），失败时保留「自动关登录弹窗再重试一次」的既有行为；真实点击只负责「按下去」。
  3. **视觉与动作分离**：鼠标移动/按压动画只在覆盖层里，实际输入直接注入页面；两者共用同一个页面坐标，所以「看到点哪里」与「点到哪里」永远一致。
- **验证**：
  - 单测新增 agentPointerWindow.spec.ts（懒创建/几何跟随/涟漪序号/键盘胶囊/空闲隐藏/关闭）、browserAgentInput.spec.ts（坐标按缩放换算、可信事件顺序、驱动标志、键盘映射、不支持时回退、onViewLayout 推送与清空），browserRefs.spec.ts 增加落点脚本/驱动脚本/锁放行断言；受影响工具测试按新链路更新。
  - 真机 E2E（node scripts/e2e-p2-run.mjs）：mock 模型驱动 navigate → snapshot → click → snapshot，页面按钮文案从「等待交互」变为「按钮已点击」，E2E_EVAL ok=true；只截指针覆盖窗口自身的 PNG 为 1089×909（显示缩放 1.25），光标像素包围盒 60×60 正好落在被点按钮中心，证明覆盖层与页面坐标对齐。桌面/窗口截图会拍到用户自己的窗口，已从 E2E 移除，避免隐私泄露。
  - 逐字键盘 E2E（node scripts/e2e-type-run.mjs）：navigate → browser_type(#name, "Loopsoar 中文 123") → snapshot。快照里输入框 value 完整出现，页面自建的 keydown 计数器为 **15**（13 个 ASCII 字符 + Ctrl+A + Backspace；两个汉字走输入法上屏不产生 keydown）——原生 setter 路径该计数恒为 0，因此这条证据能区分「真的在敲键盘」和「直接改值」。
  - 基线：typecheck 5/5、全量 vitest **192 文件 / 1625 tests**、pnpm build、pnpm bundle:shell。
- **状态**：✅ 自动化 + 真机 E2E（真实点击生效）；视觉细节待用户目视复核。
- **已知边界**：CJK 走 insertText（等价输入法上屏），没有模拟 IME 的候选词/组合态中间过程；超长文本仍逐字排队派发（受页面处理速度约束，工具侧以回读轮询兜底）；覆盖层是子窗口，主窗口最小化时随之不见；「暂停/继续操作进程」仍待办。

## ADR-0107 会话/网页解耦（阶段一）：关页不退出、开会话不拖网页、首次动作克隆任务页、会话分支

- **背景**：用户 m03744 系统反馈了三个拧巴点——①关最后一个网页会退出整个程序，只剩一页时无法自由开关；②会话与网页强绑定：进会话连带开它上次的网页，想纯净 vibecoding 时关网页又会连累会话；③折叠标签页（Agent 工作区）重启即丢。用户同时给出目标模型：网页 ＜ 折叠标签页 ＜ 会话 ＜ 工作区；只有「浏览器控制」开启才有任务化联动；Agent 操作时应克隆原页进折叠工作区，原页保持原样。并附了一份《Loopsoar 会话标签解耦方案 v1》草案。
- **调研**：方向与 Dia（多标签 + 侧栏聊天，标签是全局对象）、Manus Browser Operator（独立浏览器实例、用户标签不被占用）、ChatGPT agent（沙箱浏览器）同构；分支能力对标 Claude Code /rewind 与 checkpoint、ChatGPT 消息分支、Open WebUI/LibreChat 消息树、LangGraph time-travel——共同点是「对话前缀复制 + 运行态不继承」，不是把旧会话整体搬走。Cline checkpoints 的「撤销代码但不丢对话」也支持同一结论：工作区状态与对话分叉要分开处理。
- **本阶段决策（已在代码落地）**：
  1. **关最后一个网页不再退出程序**：关页只关页，回到空白搜索页；退出只认窗口关闭/菜单退出等显式手势。此前 UI 在最后一个标签时调用 api.window.close()，是「关网页=退程序」的直接原因。
  2. **打开会话不再自动拖出网页**：chat:switchSession 只在「任务会话」（持久化浏览器状态里含 agentBound 标签）时才恢复页面；普通会话打开后只显示对话。任务会话恢复自己的 Agent 工作区属于预期。
  3. **首次动作克隆任务页**：动作类工具（navigate/click/type/press_key/scroll/hover/select/dismiss_popup/back/forward/reload）执行前，BrowserHost.ensureAgentTab 用当前用户页 URL **新开**一个标签并标 agentBound，原页完全不动；同一会话复用同一个 Agent 标签。只读工具（snapshot/screenshot/wait/tabs 读取）不触发克隆——「看」不是「工作」。克隆发生在权限闸放行之后、真正执行之前，且是幂等的。
  4. **折叠标签持久化 + 可关闭**：PersistedBrowserTab 增加 agentBound（只认布尔 true），随会话浏览器状态落盘；恢复时写回 TabEntry.agentBound，重启后 Agent 工作区不会凭空消失。Agent 工作区浮层每行新增关闭按钮（chrome-pop-close → closeTab 动作 → 与标签条同一条关闭链路），关掉最后一个绑定页后 chip 自然消失；关页仍然不等于关会话。
  5. **会话分支（手动）**：新增 chat:forkSession（sessionId? / keepCount / title?）。SessionStore.fork 把源会话前 keepCount 条消息**逐条复制**成新会话：新 id、forkedFrom {sessionId, keepCount, at}、继承 workspaceId/browserControl，不继承运行态（allow-session、流、压缩状态、浏览器标签）。消息悬停行新增「从此分支」按钮（用户/助手消息都有），分支后自动切到新会话，原会话一条消息都不动。
  6. **分支会话是「特殊会话」而不是隐形工作区**：仍在原工作区、列表可见，标题默认「分支 · 原会话标题」。理由：隐形工作区会破坏工作区作用域与可发现性（用户方案一），而「特殊标记 + 同工作区」成本低、可检索、可继续分支（用户方案二）。
  7. **Agent 默认像用户一样操作**：工具描述明确「搜索/输入框用 browser_type 点进去逐字输入、提交用 browser_press_key（Enter），不要用脚本改值或 el.click()」；配合真实鼠标/键盘注入，Agent 不需要用户额外叮嘱就能完成「点搜索框→输入→回车」。
- **验证**：
  - 单测：sessionFork.spec.ts（前缀逐条一致、源会话不变、越界夹紧、非法/不存在 fail-closed、forkedFrom 元信息）；browserTaskTabs.spec.ts（首次动作克隆、原页保留、重复调用复用、空会话空白任务标签、agentBound 随快照恢复）；browserSessionState.spec.ts（agentBound 脏值丢弃）；browserTools.spec.ts（动作工具先 ensureAgentTab、只读快照不触发）。
  - 真机 E2E（node scripts/e2e-p2-run.mjs）：先像用户一样打开页面（userTab），再让 Agent 导航→点击；结束时 userTabs=1、agentTabs=1，页面按钮文案变为「按钮已点击」，证明「原页保留 + 克隆页操作」同时成立。
  - 基线：typecheck 5/5、全量 vitest **196 文件 / 1643 tests**、pnpm build、pnpm bundle:shell。
### 修订（用户 m03384，2026-11-15 真机反馈）

1. **折叠标签两种关闭**：浮层每行 × 关闭单个网页；折叠 chip 右上角 × 关闭整个 Agent 工作区（等价关闭全部绑定页，任务会话保留）。关页仍然不等于关会话。
2. **特殊会话真正成立**：会话新增 task 标记（独立于页面是否存在），首次任务化即落库；会话列表显示「任务」徽标（分支会话显示「分支」徽标）；任务会话的页面全部关掉后，**保留最近一次任务页快照**（浏览器状态保存时跳过「无 agentBound 页面」的覆盖），重新打开该会话时折叠工作区按原样恢复。
3. **虚拟光标常驻 + 平滑移动**：不再只在点击时闪一下。轮次开始/首次克隆出可见页面时 hold(true)，光标固定在页面中央或最后位置常驻；轮次结束 hold(false) 后才按空闲时长隐藏。页面加载完成晚于轮次开始时，由 onViewLayout 补显示。位移改为脚本按距离缓动（easeOutCubic，140–260ms，requestAnimationFrame），不再用 CSS transition；覆盖窗口只在几何变化时 setBounds、只在不可见时 showInactive，避免每个动作都重新显示造成「这里闪一下那里闪一下」。点击/输入前的等待同步覆盖最长缓动时间。
4. **思考截断修复**：流式过滤器为跨 chunk 匹配保留 20 字符尾巴，但工具调用等非流式事件到达时没有 flush，尾巴被推到工具之后、与下一段思考拼成新段——表现为每段开头缺半句、东一句西一句。现在任何非流式事件（tool/progress/done/error，heartbeat 除外）前按「最近一段是正文还是推理」的顺序 flush 两条过滤器；新增 chat-reasoning-order 回归测试（工具前推理必须完整，工具后推理不得以旧尾巴开头）。历史会话里已存下的碎片不会自动重排，新生成的轮次恢复正常。
6. **切会话先收起网页**：switchSession 不再把网页直接铺在会话旁。`viewSuppressed` 时 applyLayout 隐藏原生视图，UI 显示空白页（StartPage），点标签 / 新建页 / 明确导航 / Agent 动手才展开；任务会话恢复工作区时直接展开。这解决了「同一运行期切回某个会话，它内存里的网页又冒出来」的最后一个口子：进会话先得到干净对话，想看网页再点标签。
5. **鼠标手势更仿真**：悬停改为真实 mouseMove（CSS :hover 由可信事件驱动）；滚动 down/up 改为 mouseWheel（按 120px notch 分帧派发，滚动监听/吸顶/懒加载都会响应），滚动前光标滑到页面中心并显示「滚动 ↑/↓」；新增 browser_drag（mouseDown → 分帧 mouseMove → mouseUp，用于滑块/拖拽排序/画布）；点击的 mouseDown→mouseUp 之间保留 35ms 按压时间。所有手势都先让光标滑到位再执行，不使用系统鼠标。

- **状态**：✅ 自动化 + 真机 E2E（阶段一）。「用户标签彻底脱离会话（全局用户标签层）」与「任务条跨会话常驻/收起态恢复」列为下一阶段，见风险边界。
- **风险与边界**：
  - 当前标签仍按会话分组（BrowserHost.groups）；阶段一只做到「普通会话开关不恢复页面 + 动作时克隆」，**还没有**把用户标签移出会话。因此：同一运行期切回某会话时，它内存里仍开着的标签会照常显示（页面确实还开着）；重启后普通会话的页面不再自动恢复。彻底的「网页 ＜ 折叠标签页 ＜ 会话」层级（用户标签全局、任务标签独立）是下一阶段的主改造。
  - 克隆 = 同 URL 新开标签，不是页面状态克隆（表单/滚动/SPA 页内状态不迁移；登录态靠共享 partition 天然带过去）。
  - 自动分支（首次动作时把会话也 fork 并迁移本轮输出）未做：它需要在流式回合中切换消息归属，风险高；当前用「同会话 + 手动从此分支」覆盖讨论诉求。
  - 分支不继承 allow-session 权限、进行中的流、压缩状态与浏览器任务页（符合分支语义，但用户若期望「连任务一起复制」需要下一阶段显式设计）。
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
| ADR-0031 | 卷轴突起幅度调小（视觉轻重） | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0032 | 卷轴凹陷防裁切 + 突起参数可调 + 删除拖拽提示 | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0033 | 卷轴悬停流动开关：默认不暂停、由用户选择 | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0034 | 收紧网页/会话分区间隙（splitter 2px/内容铺满）+ 删除会话顶部阴影 | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0035 | 网页面板右侧留白再收紧（4px）+ 会话内容右侧收窄 6px | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0036 | 拖拽命中区对齐视觉交界（6px 热区）+ 会话内容再收窄 4px | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0037 | 会话栏最小宽度 = 窗口宽度比例（当前比例即下限，单一夹紧产地） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0038 | 引导/插入队列（slime 移植）：入队不打断 + 同轮续轮注入 + 回执折进思考历程（重启仍可见） | ✅ 已验证（自动化 + 真机 E2E） |
| ADR-0039 | 界面隔离与换界面收起：浮层随界面收起、草稿按会话隔离、去掉「生成中…」脚注 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0040 | 模型可见墙钟时间：每条消息带 `[YYYY-MM-DD HH:mm]` 前缀、当前时间放 volatile 段 | ✅ 自动化已验证 |
| ADR-0041 | 中断立即生效 + 上游额度/鉴权错误快速失败（signal 透传/abort 竞速/错误分类） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0042 | 启动优化：记忆加载后台化 + 非关键任务首帧后移 + 启动计时锚点 + UI 面板懒加载 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0043 | 不做跨供应商静默降级：模型 chip 与实际调用一致，用不了直接报上游错误 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0044 | 回复元信息下移 + 复制图标统一 + 模式提示归状态栏 + 思考时间线图标化 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0045 | 长度截断自动续写：finish_reason=length 透传 + 同轮续写（修复长回复断在半句） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0046 | 图标几何居中 + 浮层阴影收敛 + 全局点外/切界面收起 + 全屏层不挡窗口按钮 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0047 | 截断根除：全链路不变量（SSE 残留/超时语义/续写/对账/退出落盘/压缩） | ✅ 自动化 + 真机 E2E 已验证（含真实上游 5000 字截断续写） |
| ADR-0048 | 供应商模型能力补全：上下文/输出/视觉/模态/工具/结构化输出（slime 表 + NIM 官方文档） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0049 | 设置面板「获取模型列表与能力」：拉列表同时拉上游能力 + 三态合并（显式 > 上游 > 推断）+ 结果反馈 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0050 | 供应商编辑改大弹窗：不跳页 + 右上角反馈 + 文本不挤压（Portal/滚动复位/表格横向滚动） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0051 | OpenCode Go/Zen 双计划端点与错误提示修复（撤销错误迁移/默认模型去免费/模型目录/提示去重） | ✅ 自动化 + 真实上游 + 真机 E2E 已验证 |
| ADR-0052 | 去掉「默认模型/启用」概念：模型菜单列出全部模型、点哪个用哪个（删默认行/单选列/勾选列/自动回退） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0053 | OpenCode 计划边界可视化：Go 订阅额度 ≠ 按量付费余额（计划徽标 + 402/403 账户提示 + 活动供应商纠正） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0054 | 恢复模型「显示」拨片（新模型默认打开，无默认模型）+ 推理强度选择移到模型菜单顶部 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0055 | 模型「显示」开关支持全选/取消全选（表头主拨片，部分开启点一下即全选） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0056 | 模型表工具条重构（全选移位 + 搜索栏）+ 应用图标身份修复（多候选路径 / AUMID / slime 图标恢复） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0057 | 密钥关联修复：供应商去重必须迁移密钥 / 测试连接用被测 Key / 保存后立即真实验证 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0058 | 列表/浮层全局收起规则：html data-popover 泄漏修复 + 工具栏浮层原子 toggle + 全局点击外部收起 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0059 | 小窗「最小化→图标按钮」移植（Slime 同款）+ 输入区左下角圆形「+」菜单（附件） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0060 | 图标窗单层化/可拖动/衔接动画（Slime 移植：透明窗口 + logo 单层 + screen 增量拖动 + 180ms 几何动画） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0061 | 悬浮窗圆角恢复 + 衔接动画改快照 transform | ⚠️ 动画机制已被 ADR-0062 替代（圆角/单层图标结论保留） |
| ADR-0062 | 收起/展开按 Slime float 重做：面板几何过渡 + 内容钉住裁切 + 图标淡入淡出（替代 ADR-0061 快照 transform） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0063 | 浏览器管理整页/搜索引擎/加载失败页：历史勾选批量删除、空态与顶栏互跳、引擎图标下拉（仅 Bing/Google/百度）、加载页 + 分类错误页 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0064 | 管理三页左侧索引栏（搜索 + 分类，Edge 式三栏）+ 批量操作条上移且与行严格对齐（box-sizing 修复） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0065 | 新建标签页重做：搜索/Vibecoding 拨片 + 模型胶囊 + 发送后平滑过渡到整页会话；初始标签 + 关闭最后标签=关窗 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0066 | Vibecoding 会话页卷轴只画上半截：MessageList 不可再套滚动容器（改纯 flex 布局，卷轴由内部 scroller 驱动） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0067 | 模型菜单被拨片文字穿透：浮层改 createPortal 到 body + fixed 锚点 + z-index 1000，脱离页内层叠上下文 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0068 | Vibecoding 主页面：工作区/模型/推理/Build·Plan 控制条 + 工作区→会话树 + 标题相关度搜索 + 收起态会话竖条（悬停 1s 展开） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0069 | Vibecoding 圆形加号（工作区/附件菜单）+ 胶囊统一 + 侧栏按钮图标平滑切换 + 会话面板「工作区标题+单行+相对时间」版式 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0070 | Vibecoding 右栏改为内嵌会话列表（对话只留左侧主页）+ 侧栏图标双层同槽位交叉淡入（修复错位/无过渡） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0071 | 会话列表：标准 chevron 箭头 + 工作区/会话悬浮操作（更多/添加会话/置顶/删除）+ 工作区重命名/打开文件夹 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0072 | 侧栏宽度：全屏可调（最小拖拽区间 200px）+ Vibecoding 独立窄区间（min=标准最小×0.5、max×0.6，进入平滑收缩）+ 退出键多层兜底 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0073 | 会话小窗化/恢复/置顶/删除图标替换（用户提供 4 个 SVG；delete 居中补偿 + float/float-exit 接线） | ✅ 图标守卫 + 全量测试已验证 |
| ADR-0074 | 会话行左上微调 + Vibecoding 隐藏小窗化（淡出收宽）+ Agent 小窗标题栏横杠最小化/收起侧边栏图标 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0075 | 侧栏过渡收口：小窗内去小窗化 + 内容宽度冻结（防中途换行）+ 头部按钮槽位淡入淡出 | ⚠️ 内容冻结已被 ADR-0076 替代（其余两项保留） |
| ADR-0076 | 撤销侧栏内容冻结：inner 与 wrapper 用同一条 320ms 曲线同步变宽/收窄（内容宽度逐帧等于可见栏宽） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0077 | 模式切换内容遮罩：搜索↔Vibecoding 期间先隐藏内容、宽度落定后淡入，彻底消除中间宽度换行帧 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0078 | 模式切换「概率性一帧」确定性修复：遮罩改 useLayoutEffect（paint 前生效）+ App 状态同帧上报 + NTP 两模式内容块等高（拨片不再上下跳 42px） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0079 | 悬浮小窗/图标最终方案：独立 56px 图标窗口（静态 icon.html）顶替大窗口，彻底移除 resize/setShape → 无闪烁无黑块；拖动移动图标窗、点击对齐还原；关闭改原地淡出 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0080 | 普通态 Agent 小窗拖动会话：起点尺寸冻结 + 显式 pointer 拖拽（修复 Windows 125% DPI 下越拖越大） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0081 | 悬浮小窗头部收敛：只留会话列表图标，点开 Vibecoding 同款 SessionListPanel（去掉 workspaceBar/sessionBar 与窄窗变形的 WorkspacePanel） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0082 | Vibecoding 侧栏切换判定：去掉 currentUrl 前置条件，NTP 在地址栏有 URL 时也能切到会话列表（导航后自动复位） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0083 | Vibecoding 主页面承载会话正文：切到 Vibecoding 或从右栏选会话时自动进入会话页（messages 非空 → mode=chat） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0084 | 会话绑定标签页、标签页绑定工作区：启动/新建标签 = 新会话 + 空白 tab + 搜索页，修复 Vibecoding 回不到搜索 | ⚠️ 新建会话保留当前界面（ADR-0085 修正） |
| ADR-0085 | 侧栏/列表/工作区 UI 收口：新建会话不跳搜索 + 统一会话列表 + 输入框下工作区选择 + 首次对话自动落默认工作区 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0086 | 站点图标（favicon）：标签页/历史/新标签快捷入口；主进程转 data URL + 历史迟到更新 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0087 | 开发者工具（F12）：每标签 detach 调试 + 请求守卫放行 devtools/chrome-extension 协议 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0088 | 浏览器扩展适配：本地未打包安装 + Chrome 商店 CRX 下载解包 + 持久化 + 设置管理（Electron 子集） | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0089 | 终端环境自检：设置页依赖探测（profiles + git/node/npm/pnpm/python/rg/curl）+ Windows .cmd 解析 | ✅ 自动化 + 真机 E2E 已验证 |
| ADR-0090 | 浏览器交互收口：底部 DevTools 面板 + 状态栏调试入口 + 商店安装点击拦截（Chrome/Edge）+ 图标替换 | ✅ 真机 E2E 已验证 |
| ADR-0091 | 会话按需创建 + 标签/工作区语义 + favicon 回抓 + 图标居中 + 扩展设置层级 | ✅ 真机 E2E 已验证 |
| ADR-0092 | 工作区入口归位标题栏左上角 + 设置内跳转直接生效 | ✅ 真机 E2E 已验证 |
| ADR-0093 | 有网页时侧栏展开/收起不再逐帧 resize 原生视图（掉帧修复） | ✅ 行为验证 |
| ADR-0094 | 工作区 > 会话 > 网页：关系与关闭语义（关最后网页不恢复、删会话关网页） | ✅ 真机 E2E 已验证 |
| ADR-0095 | 会话级「浏览器控制」开关（+菜单/胶囊）+ 工具面单次解析修 P0-1（可见面=执行闸同源） | ✅ 自动化已验证 |
| ADR-0096 | 偏好单源统一（contracts z.infer，消灭三份定义静默漂移）+ 通用「Agent 打开网页时的窗口布局」browserOpenLayout | ✅ 自动化已验证 |
| ADR-0097 | 稳定元素引用与语义快照：DOM 零打标 + 页面内稳定性句柄 + ref 注册表（导航即失效）+ 原生 setter 输入 + 可行动失败码（修 P0-2） | ✅ 自动化已验证 |
| ADR-0098 | 多标签工具（tabs/back/forward/reload）+ 按键/下拉/悬停 + 动作后状态增量 + 点击命中验证 + 标签级 ref 绑定 | ✅ 自动化已验证 |
| ADR-0099 | 浏览器操作权限档 browser（策略独立档，默认 allow；敏感步骤仍逐次确认；沙箱仍按 network/L4） | ✅ 自动化已验证 |
| ADR-0100 | Agent 打开网页前的布局询问（docked/小窗，纯函数决策 + 会话记忆 + fail-closed）+ 真机端到端验收脚本 | ✅ 自动化 + 真机 E2E |
| ADR-0101 | 收口后 UI 打磨：浮层去阴影/开关可再点收起、Vibecoding 菜单二次点击收起、推理等级英文、收起态去框+分隔线+对齐、浏览器控制移到工作区同行 | ✅ 真机验证 |
| ADR-0102 | Agent 浏览器可视化：页内虚拟光标（closed shadow root）+ 窗口外侧呼吸灯 + 会话隔离 + 截图守卫 | ✅ 真机验证 |
| ADR-0103 | 布局选择改到首启向导（删除「每次询问」与会话记忆死代码；壳层按偏好应用并按会话去重） | ✅ 真机验证 |
| ADR-0104 | 会话级浏览器隔离：标签组按会话（壳层唯一事实来源）+ 修正 UI 绑定方向与草稿重置条件 | ✅ 真机验证 |
| ADR-0105 | Agent 工作区（折叠标签组，agentBound）+ 运行期接管锁（按轮次由壳层下发，只拦真实输入） | ✅ 真机验证 |
| ADR-0106 | 虚拟鼠标/键盘改应用级覆盖层 + sendInputEvent 真实输入（点击 + 逐字键盘）+ 锁放行 + 关 Windows 遮挡检测（后台也可交互） | ✅ 自动化 + 真机 E2E |
| ADR-0107 | 会话/网页解耦（阶段一）：关最后页不退出、开会话不拖网页、首次动作克隆任务页、agentBound 持久化、会话分支（特殊会话） | ✅ 自动化 + 真机 E2E（阶段二待做：全局用户标签层） |
