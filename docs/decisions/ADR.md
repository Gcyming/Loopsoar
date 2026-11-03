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
