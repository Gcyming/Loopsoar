# Agent 浏览器操作：理论与方法综述（第二阶段调研）

- **日期**：2026-11-13
- **范围**：LLM/多模态 Agent 操作真实浏览器的架构、观察表示、动作空间、控制循环、安全治理与公开基准；面向 Loopsoar「AI 自动浏览器」第二阶段的架构决策。
- **读者**：架构师与实现者。
- **资料口径**：优先官方文档、包内 README、论文摘要/正文页；版本与抓取时间见文末「参考资料」。文中所有数字均标注来源；无法核实之处在「不确定项」中明说。

---

## 0. 结论先行

1. **观察格式的事实标准已经收敛到「可访问性树（a11y tree）+ 稳定元素引用」**：Playwright MCP、Chrome DevTools MCP、Stagehand、browser-use 默认路线都以结构化语义树为主观察，截图退居「验证/兜底/CAPTCHA/Canvas」。
2. **动作空间有三种成熟形态**：封闭小动作集（MCP 系、Loopsoar 现状）、自然语言动作（Stagehand act）、代码即动作（browser-use 1.0 的 Python REPL、Playwright CLI）。封闭集确定性强、易治理；代码路线上限高但攻击面与不确定性大。工程上更稳的是「分层动作集 + 逃生舱」。
3. **成功率的量级差异主要由「观察 + 模型 + 评测口径」共同决定，不能简单归因于 DOM 或视觉**：WebVoyager 59.1%（2024，截图+元素文本）、WebArena GPT-4 14.41%（人类 78.24%）、OSWorld 最佳 12.24%（人类 72.36%）、OpenAI Operator 87%/58.1%/38.1%（2025-01，自报）、Claude 3.5 Sonnet 计算机使用 14.9%/22.0%（OSWorld）。这些数字不可直接横向比较，但共同说明「长程、写操作、跨站」仍是难点。
4. **安全的核心不是「加一个确认弹窗」，而是把确认绑定到具体动作参数与人类可读意图**：Playwright MCP 的 element 描述、Operator 的 takeover/下单确认、agent-in-chrome 的「不可逆操作先问」都是同一模式。
5. **Loopsoar 现状的最大缺口不是「没有浏览器工具」，而是「观察与动作没有形成闭环」**：快照打印的编号没有被 browser_click 使用（工具层自己 querySelector，绕过了 adapter 的 id→selector 解析）；动作后不自动返回新状态；没有标签页工具、console/network 观察、点击命中验证。详见第 8 节。

---

## 1. 调研方法与边界

- 英文为主、中文补充；覆盖官方文档、npm/PyPI 包内 README、论文摘要与正文页、厂商安全说明。
- 一手来源 10+：Playwright MCP 官方文档与 README、Chrome DevTools MCP README/源码、Stagehand v4 文档、browser-use PyPI/文档、Skyvern PyPI、AgentQL 官网/文档、Anthropic 计算机使用公告、OpenAI CUA 页面（经二手转述核对数字）、agent-in-chrome README、WebVoyager/WebArena/Mind2Web/OSWorld/Set-of-Mark/Online-Mind2Web 论文页。
- **环境限制（影响可复现性）**：本次执行环境无法直连 github.com / raw.githubusercontent.com，GitHub README 通过 unpkg 的 npm 包镜像读取；platform.claude.com、developer.chrome.com、blog.google 的部分页面为 JS 渲染或跨域重定向，未能取到全文，相关结论以可读取的官方公告与二手核对为准。凡属此类，正文会标注。

---

## 2. 主流方案盘点

### 2.1 总览

| 方案 | 架构 | 观察 | 动作空间 | 元素定位 | 适用场景 |
|---|---|---|---|---|---|
| browser-use | Python/TS 库；1.0 起「模型写 Python → 持久 REPL → 原始 CDP」 | 页面状态 + 可访问性/DOM 助手函数 | 代码即动作（早期为封闭动作集） | 元素编号/选择器，由 REPL 里的 helper 解析 | 研究、批量任务、需要复杂逻辑的自动化 |
| Playwright MCP | MCP server + Playwright；有头/无头；可 --extension 接管真浏览器 | a11y 快照（YAML，ref=eN），动作后自动附带新快照 | 70+ 封闭工具，按 caps 分组 | ref（eN / f1e12）或 Playwright selector | 通用 Agent 浏览器、需要确定性交互 |
| Chrome DevTools MCP | MCP server + Puppeteer + CDP；面向调试与性能 | a11y 文本快照（uid）+ 截图 + 网络/console/性能 trace | 页面/输入/网络/性能/脚本等工具族 | uid（每次快照最新） | 调试、性能分析、开发期自动化 |
| 直接 CDP | 自建 WebSocket 客户端，发 CDP 命令 | DOM.getDocument / Accessibility.getFullAXTree / Page.captureScreenshot | 原始协议（Input.*、Runtime.*、Page.*） | backendNodeId / nodeId / 坐标 | 深度集成、Electron 内嵌、需要完全控制 |
| Stagehand | Playwright/CDP 之上的 AI 原语层（act/extract/observe/agent） | 页面快照（合并 iframe 的 a11y 树）+ 自愈选择器 | 自然语言单步动作，可回放 Action | 推理出的 selector/xpath，可缓存 | 脚本增强、录制回放、渐进式 AI 化 |
| Skyvern | 服务/工作流引擎；视觉 + DOM；任务/Workflow 编排 | 截图 + DOM + 视觉模型 | 任务级目标 + 工作流块 | 视觉+DOM 融合 | RPA 替代、表单/下载/登录等写操作 |
| AgentQL | 查询语言 + SDK（Playwright 之上） | 结构化查询结果 | 查询元素 + 常规 Playwright 动作 | AI 查询语言（含自然语言提示） | 数据抽取、稳定选择器 |
| Anthropic CU / OpenAI Operator | 纯视觉：截图 → 坐标点击/键盘 | 截图（+ 少量文本） | 鼠标/键盘/滚动/截图 | 像素坐标 | 跨应用、无 DOM 的桌面/远程环境 |
| Chrome 扩展注入（agent-in-chrome） | 扩展 + native messaging / CDP；复用用户已登录 Chrome | 可交互元素表（ref_N，含坐标/跨源 iframe）+ 正文 | 30+ 工具，分 observe/full 档 | ref_N / CSS / 文本 / 坐标 | 复用登录态、后台标签、企业内网 |

### 2.2 逐项要点

**browser-use。** 经典版本的核心是「浏览器状态 → LLM → 动作」的循环：抽取可交互元素与页面文本，给每个元素编号，模型输出 click(index)/input(index, text) 等动作。2026 年的 1.0 版本发生了明显架构转向：PyPI 描述为「模型在真实浏览器里写 Python：一个持久 REPL、browser-harness helpers 与原始 CDP」，示例是 new_tab(url)、bu.click(41)、js(...)，最后 finish(result)。这说明它把「动作空间」从封闭枚举换成了「代码 + 运行时」，优点是表达力强、可写循环/条件/数据清洗，缺点是任意代码执行、错误面大、审计困难。其文档同时保留 ultrafast 模式（按可访问性树 id 行动）作为低延迟选项。
来源：https://pypi.org/project/browser-use/ ；https://docs.browser-use.com/open-source/introduction

**Microsoft Playwright MCP。** 明确定位「用结构化可访问性快照，而不是截图，绕过对视觉模型的依赖」。工具面很大（README 中可数出 70+ 个 browser_* 工具），但按能力分组：核心自动化、表单、键盘鼠标、标签页、对话框、上传、等待、网络与存储、开发者工具、截图、代码执行、追踪/视频、测试断言。关键设计：**每个动作工具返回后自动附带一份新快照**，模型无需额外 round-trip；快照中的 ref 是 eN（iframe 内为 f1e12），失效时明确报错「Ref <ref> not found in the current page snapshot. Try capturing new snapshot.」；动作工具的 target 同时接受 ref 与 Playwright selector。README 还直言：coding agent 场景下 CLI+Skills 比 MCP 更省 token，MCP 更适合需要持续浏览器上下文的长程探索。
来源：https://playwright.dev/mcp/introduction ；https://playwright.dev/mcp/snapshots ；https://unpkg.com/@playwright/mcp@latest/README.md

**Chrome DevTools MCP。** 基于 Puppeteer 驱动真实 Chrome，主打「调试 + 性能」：录制 trace 并给出性能洞察、抓网络请求、看 console（带 source map 栈）、截图、a11y 文本快照。其 take_snapshot 的工具描述是「基于 a11y 树的文本快照，元素带唯一 uid；**始终使用最新快照**；优先快照而非截图」。2026 年的版本还带 Lighthouse、内存、WebAuthn、WebMCP、扩展等工具族，并默认采集使用统计（可用 --no-usage-statistics 关闭）。优点是「调试视角」最全；缺点是工具面偏开发期，业务自动化需要的等待/确认语义要自己补。
来源：https://www.npmjs.com/package/chrome-devtools-mcp （v1.13.0）；包内源码 take_snapshot 定义

**直接 CDP。** 不走框架，直接对 Chromium 发协议命令。观察可用 Accessibility.getFullAXTree（语义树）、DOM.getDocument（节点树）、Page.captureScreenshot；动作可用 Input.dispatchMouseEvent、Input.insertText、Runtime.evaluate；还能拿到网络、下载、弹窗、iframe 的底层事件。优点是零中间层、可控性最强，且 Electron 的 webContents.debugger 天然可用；缺点是所有「等待、重试、引用稳定、权限」都要自己实现，等于自建一个 MCP。
来源：Chrome DevTools Protocol 文档（https://chromedevtools.github.io/devtools-protocol/）

**Stagehand（Browserbase）。** 在 Playwright 之上提供四个 AI 原语：act（单步自然语言动作）、extract（结构化抽取）、observe（发现可执行动作，返回可缓存的 Action）、agent（多步）。其文档明确「把复杂动作拆成小步」、支持 selfHeal（选择器失效时重新推理）、支持 Action 回放（零推理、确定性执行）、自动合并 iframe 的 a11y 树。它代表「自然语言动作 + 缓存回放」的中间路线：首次靠模型，稳定后靠缓存，兼顾灵活性与成本。
来源：https://docs.stagehand.dev/v4/basics/act.md ；https://docs.stagehand.dev/v4/basics/observe.md

**Skyvern。** 定位「用 LLM + 计算机视觉自动化任意网站的工作流」，产品形态是 Tasks（一次目标）与 Workflows（Browser Task / Action / 数据抽取 / 校验 / 循环 / 条件 / 邮件 / HTTP 等块）的编排引擎。PyPI README 自报 WebBench 64.4%，并强调在「写操作」（填表、登录、下载）上表现最好；官网强调 CAPTCHA、2FA、代理、livestream 可视化和人工接管。它更接近「RPA 的 AI 替代品」，而不是给 Agent 用的底层浏览器工具。
来源：https://pypi.org/project/skyvern/ （1.0.57）；https://www.skyvern.com/

**AgentQL。** 提供一套「Web 查询语言 + 解析器」：用类似 GraphQL 的查询描述页面元素与数据，例如 { products[] { product_name product_price(include currency symbol) } }，括号里可写自然语言提示；SDK 架在 Playwright 上，既可取数据也可定位元素后交互。它的价值在于「把选择器写成意图」，降低站点改版导致的脆弱性；但查询本身仍需模型/人工编写，且对复杂交互的覆盖不如通用动作集。
来源：https://www.agentql.com/ ；https://docs.agentql.com/concepts/query-language

**Anthropic Computer Use / OpenAI Operator（视觉路线）。** 两者都是「截图 → 坐标/键盘」的纯视觉闭环：Anthropic 的工具集包含 screenshot、mouse_move、left_click、left_click_drag、right_click、middle_click、double_click、scroll、type、key、cursor_position 等；OpenAI CUA 则是「观察—计划—执行」循环，配合 takeover（用户随时接管，接管期间不记录）与敏感操作确认。它们的优势是跨应用、无需 DOM、对 Canvas/远程桌面天然可用；劣势是坐标定位脆弱、分辨率敏感、每步成本高、难以做细粒度权限。
来源：https://www.anthropic.com/news/3-5-models-and-computer-use ；https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool ；https://openai.com/index/computer-using-agent/

**Chrome 扩展注入（agent-in-chrome）。** 用扩展 + native messaging（或直连 CDP）把 Agent 接到「用户正在用的那个 Chrome」，直接继承登录态，后台标签操作不抢前台。其 README 给出了少见的一手工程细节：可交互元素表带 ref_N、像素坐标、跨源 iframe 顶层坐标；browser_read_page 会报告 activeDialog（含无 ARIA 角色的登录墙）；点前验证点得到、点后验证打中；browser_set 设值后回读校验；工具分 observe/full 两档（observe 档 tools/list 约 20KB，full 约 36KB）；凭据默认打码；不可逆操作要求先确认；页面内容一律当数据。它证明了「扩展/内嵌浏览器」路线在登录态与后台操作上的独特优势，也暴露了它的代价：需要处理标签归属、弹窗、原生权限。
来源：https://www.npmjs.com/package/@liang-hz/agent-in-chrome （README，0.55.5）

---

## 3. 观察：三种表示及其代价

### 3.1 可访问性树（a11y tree）

把浏览器算出的可访问性树序列化成缩进文本，节点带 role/name/state，交互节点带 ref。Playwright 的格式是事实标准：

    - heading "todos" [level=1] [ref=e3]
    - textbox "What needs to be done?" [ref=e5]
    - list [ref=e8]:
      - listitem [ref=e9]:
        - checkbox "Toggle Todo" [ref=e10]
    - link "All" [ref=e20]

优点：语义化、体积远小于原始 DOM、对模型友好、跨站点稳定、天然支持键盘/读屏语义；ref 让「观察→动作」形成确定性映射。缺点：看不见纯视觉信息（Canvas、图片里的按钮、CSS 伪元素、部分自定义组件）；不同浏览器/框架的树差异；iframe/shadow DOM 需要额外合并（Playwright 用 f1e12 前缀，Stagehand 默认合并所有 frame）。

### 3.2 CSS 选择器标注的 DOM

在 DOM 上打属性、编号，再把精简后的节点表交给模型（Loopsoar 现状即此类）。优点是能精确控制「哪些元素可见、带什么元数据」，可附带 bbox、disabled、checked 等；缺点是 DOM 规模不可控、语义弱（div 按钮 vs role=button）、站点改版即碎。Mind2Web 的实测很能说明规模问题：真实网页平均候选元素 1,135 个，用一个小模型先过滤到 580 个仍保持 94.7% 的目标召回——也就是说「不筛选的 DOM 全量」对上下文是不可承受的。
来源：https://arxiv.org/abs/2306.06070 （正文 §3）

### 3.3 截图 + Set-of-Mark（SoM）

对截图做区域分割并在图上叠加编号/掩码，让多模态模型「指着编号说话」。SoM 原论文证明这种视觉提示能显著提升 GPT-4V 的 grounding（在 RefCOCOg 上零样本超过全监督的指代理解模型）。WebVoyager 正是「截图 + 交互元素文本 + 在截图上标注元素」的组合，取得 59.1% 的成功率。优点是贴近人类、覆盖纯视觉元素；缺点是每步一张图（成本固定但高）、坐标/编号会随滚动与重排失效、对分辨率敏感、难以做无障碍与键盘路径。
来源：https://arxiv.org/abs/2310.11441 ；https://arxiv.org/abs/2401.13919

### 3.4 成本与成功率：能说的与不能说的

- **规模**：真实页面原始 HTML 常在 10^5–10^6 字符量级；a11y 树通常压缩到几 KB 到几十 KB；截图是「每张固定成本」，与页面复杂度无关但与分辨率相关。
- **一次实测（第三方自报，2026-08）**：同一含跨源 iframe 的页面，单次「读页面」返回字节数：agent-in-chrome 4,146 B、Playwright MCP 8,235 B、Chrome DevTools MCP 6,954 B。样本极小，只能说明「同量级」，不能当基准。
- **成功率**：没有「同一模型、同一任务、只换观察格式」的干净对照。WebVoyager（截图+文本）59.1%、WebArena（文本/a11y）GPT-4 14.41%、OSWorld（纯截图）12.24%，任务集与模型都不同，不能据此断言「DOM 一定优于视觉」。可以确定的是：**在 DOM 可用的常规网页上，a11y 路线的单位成本更低、可重复性更好；视觉在 Canvas/验证码/跨应用场景不可替代。**

---

## 4. 动作空间设计

### 4.1 封闭小动作集

代表：Playwright MCP 的核心工具、Chrome DevTools MCP、Loopsoar 现有 6 个工具。特点是每个动作一个工具、参数强类型、可审计、可做权限。代价是「表达力上限」：循环、条件、批量填表要么靠模型多轮，要么靠复合工具（fill_form、browser_batch）。Playwright MCP 的经验是：工具不是越多越好，而是按 caps 分组、默认只暴露常用集；它甚至提供 --snapshot-mode=none 来关掉每步自动快照以省 token。

### 4.2 自然语言动作

代表：Stagehand act。模型只输出「click the add to cart button」，由框架推理 selector 并执行；observe 先返回可执行 Action 列表，act 可直接回放 Action（零推理）。优点是脚本可读、可缓存、可在选择器失效时 selfHeal；缺点是首次推理有额外延迟与不确定性，复杂动作仍需拆步。

### 4.3 代码即动作

代表：browser-use 1.0（持久 Python REPL + CDP）、Playwright CLI + Skills。模型写代码，代码在浏览器上下文执行。优点是表达力最强（循环、解析、条件、复用函数）、token 效率可能更高（一次写多步）；缺点是任意代码执行 = 最高权限、错误难归因、审计与确认困难。Playwright 官方也承认 CLI 路线对 coding agent 更省 token，但 MCP 更适合需要持续状态与丰富内省的长程任务。
来源：https://playwright.dev/mcp/introduction

### 4.4 建议的形态：分层

- L0 观察：snapshot / find / screenshot / console / network。
- L1 语义动作：navigate、click(ref)、type(ref)、select、press、scroll、wait_for。
- L2 复合动作：fill_form、click_and_wait、download、upload、tabs。
- L3 逃生舱：evaluate / cdp / run_code，默认不暴露，单独权限 + 每次确认。

这套分层与 Playwright MCP 的 caps、agent-in-chrome 的 observe/full 档位是同一思路：**能力分级 = 权限分级 = token 分级**。

---

## 5. 循环、等待、恢复与多标签

### 5.1 act–observe 循环

成熟实现的共同点：**动作返回即附带新观察**（Playwright MCP），或至少返回「动作是否生效 + 页面是否变化」；ref 失效有明确错误码；快照可增量（browser_find 只回匹配节点及上下文）。反面是「动作只回 OK，模型再花一轮 snapshot」——每步多一次 round-trip，长任务成本翻倍。

### 5.2 等待与加载完成

- Playwright 的 actionability 等待（可见、稳定、可接收事件、未被遮挡）是业界最完整的实现；Chrome DevTools MCP 也强调「automatically wait for action results」。
- 通用做法：条件等待（selector 出现/可点击、文本出现、URL 变化、network idle、load 事件）优先，固定 sleep 只作兜底。
- Stagehand 提供 nextChunk/prevChunk（翻屏）与 scrollTo，把「滚动加载」变成一等动作。
- 反例：Loopsoar 的 browser_wait 只能轮询 selector/text 或纯等待，缺少「可点击/可见/网络空闲」条件。

### 5.3 错误恢复

常见错误分类：元素找不到、ref 过期、被遮挡、导航超时、需要登录、验证码、下载被拦。恢复策略：重新快照 → 重新定位（selector→text→role）→ 换路径（搜索/直达 URL）→ 请求人工。Stagehand 的 selfHeal、agent-in-chrome 的「点前验证 + 点后验证」都是把「验证」塞进动作本身，而不是等模型发现。

### 5.4 防死循环

工程上有效的手段：动作指纹去重（同工具+同目标+同参数连续 N 次即中止）、URL/标题长时间不变检测、全局步数/时长/token 预算、失败次数上限、循环时强制「换策略或求助」。这些必须在 harness 层做，不能指望模型自觉。

### 5.5 多标签

- Playwright MCP：browser_tabs 支持 list/new/close/select，并可用 isolatedContext 把新标签放进独立上下文（cookie/storage 完全隔离）。
- Stagehand：active page 跟随 Chrome 最后聚焦的窗口/标签，点开新标签后自动切换。
- agent-in-chrome：标签组 + 会话归属 + browser_tab_use 显式接管 + browser_tab_release 归还；默认不接管用户已开的页。
- 共同结论：**标签必须有「归属」与「生命周期」语义**，否则多会话并发时会互相串页；新窗口默认不自动接管（防钓鱼弹窗），但「用户主动点击导致的新标签」应可配置为自动跟随。

## 6. 安全与治理

### 6.1 敏感操作人工确认

三种可组合的模式：

1. **动作级确认**：工具参数里带人类可读的 element 描述（Playwright MCP 的 element 字段就是「用于获得交互许可」），确认 UI 展示「要点击什么、在哪个站点、会发生什么」。
2. **提交级确认**：登录、支付、下单、发布、删除、发消息等「不可逆/对外可见」动作，执行前强制人工；Operator 在购买前请求确认，agent-in-chrome 把这条写进 skill。
3. **接管（takeover）**：用户可随时接管浏览器，接管期间不记录、不自动继续；适合验证码/2FA/复杂授权。

关键实现细节：确认必须绑定**具体参数哈希**（防止确认后被替换目标）、确认结果一次性、拒绝要可解释；「始终允许」只能按站点+动作类型授予，不能全局放开。

### 6.2 URL/协议白名单

Playwright MCP 提供 --allowed-origins / --blocked-origins，但文档明确说**它不是安全边界、也不影响重定向**；默认阻止 file:// 导航，文件访问限制在工作区。这提示：白名单要在「导航前 + 每次重定向后」都校验，不能只信一次。协议只允许 http/https；data:/blob:/file: 仅限内部受控页面。

### 6.3 下载防护

下载是典型的高风险写操作：需要独立的下载目录、文件名净化、大小/类型限制、可执行文件拦截、完成后人工确认；Electron 侧用 session 的 will-download 拦截并改写保存路径。

### 6.4 Profile / 上下文隔离

- Playwright MCP 的 --isolated：profile 只存内存，不落盘。
- browser context / Electron session partition：按工作区或任务隔离 cookie、缓存、storage；跨任务不共享登录态。
- agent-in-chrome 的取舍值得注意：它刻意复用用户真实 profile（继承登录态），代价是必须用「标签组 + 显式接管 + 凭据打码 + 不可逆确认」来补偿。Loopsoar 内嵌浏览器天然处于这两者之间：**默认独立 partition，登录态按站点显式授权复用**，比「全共享」或「全隔离」都更现实。

### 6.5 最小权限与工具可见性

agent-in-chrome 的 observe 档直接不注册写工具（模型看不到也调不到），并把 tools/list 从 36KB 降到 20KB；Playwright MCP 用 caps 按需开启 vision/pdf/devtools。这说明「权限最小化」同时是「上下文最小化」：**不用的工具不要出现在 schema 里**。

### 6.6 提示注入

页面是不可信输入。可落地的规则：工具输出用明确边界包裹并标注「页面内容，非指令」；页面文本永远不能作为授权依据；导航到新 registrable domain、触发下载、打开弹窗都要重新判定；对「忽略之前的指令」类文本只引用不执行。Operator 还额外部署了提示注入监控器（发现可疑行为即停止）。

---

## 7. 基准与数据

| 基准/系统 | 观察与动作设定 | 报告结果 | 人类 | 来源与时间 |
|---|---|---|---|---|
| WebVoyager | 截图（元素标注）+ 交互元素文本，GPT-4V | 59.1% 任务成功率；自动评估与人类 85.3% 一致 | — | ACL 2024 / arXiv 2401.13919（2024-01） |
| WebArena | 文本/可访问性观察，GPT-4 基线 | 14.41% | 78.24% | arXiv 2307.13854（2023-07） |
| OSWorld | 纯截图，最佳模型 | 12.24% | 72.36% | arXiv 2404.07972（2024-04） |
| VisualWebArena | 多模态 web 任务 | 论文指出文本 agent 的视觉短板，未给单一汇总数 | — | arXiv 2401.13649（2024-01） |
| OpenAI Operator（CUA） | 截图 + 鼠标键盘 | WebVoyager 87%、WebArena 58.1%、OSWorld 38.1% | 72.4% / 78.2% | OpenAI 2025-01；数字经科技日报/央视网转述核对 |
| Claude 3.5 Sonnet（computer use） | 截图 + 鼠标键盘 | OSWorld 14.9%（更多步数 22.0%），次优 7.8% | — | Anthropic 2024-10-22 |
| Skyvern | 视觉 + DOM，WebBench | 64.4%（自报） | — | PyPI README（1.0.57） |
| Online-Mind2Web | 300 任务 / 136 站点，在线评测 | 论文结论：此前结果存在「过度乐观」，LLM-as-judge 与人类约 85% 一致 | — | arXiv 2504.01382（2025-04） |
| Mind2Web | DOM 过滤（小模型先筛） | 候选元素 1,135 → 580，目标召回 94.7% | — | arXiv 2306.06070 |

**读法提醒**：上表不是同一实验的不同分组。模型、任务集、评测协议（自动 judge vs 执行校验）、是否允许重试都不同；厂商自报数字（Skyvern、browser-use、Operator）尤其需要打折看。能跨表得到的稳定结论只有三条：长程任务成功率仍低；写操作/跨站/需要登录的任务最难；观察表示与「是否给模型可执行的下一步」比「用不用视觉」更影响体验。

---

## 8. 对 Loopsoar 的设计启示（14 条）

> 现状基线：browserTools.ts 注册 6 个工具（snapshot/navigate/click/type/scroll/screenshot，另有 wait/web_fetch）；BrowserHost 已按 sessionId 管理标签组（SessionGroup/tabId）；adapter 的 MARKERS_SCRIPT 会给可交互元素打 data-loops-el 编号，selectorFor() 支持「数字 → 属性选择器」；ToolRegistry 只有 read/write/terminal/network 四类权限，network 默认每次确认。

**1. 元素引用必须端到端统一，工具层不得自己解析。**
现状：browser_snapshot 打印 [#N]，但 browser_click 的脚本直接 document.querySelector(target)，数字 N 会被当成非法选择器；adapter 的 selectorFor() 明明支持数字却未被使用。这是「观察-动作」闭环断裂的第一处。
做法：ref 由 adapter 生成并解析；工具只透传 ref；ref 结构建议 tabId:frameId:gen:n，gen 每次快照递增；失效返回 STALE_REF + 最新快照，而不是「未找到元素」。

**2. 引用要能跨一次 DOM 变更存活，而不是「快照时的位置序号」。**
现状：编号是 querySelectorAll(...) 的顺序号，SPA 重渲染/插入节点后同一编号可能指向别的元素。
做法：优先用 CDP backendNodeId 或「稳定性打分的选择器」（id > name > aria-label > 文本 > 结构路径）作为句柄，编号只是显示层别名；快照与动作之间做 generation 校验。

**3. 快照格式升级为「语义树 + 交互态 + 预算」。**
现状：正文 20,000 字符 + 最多 200 个元素，只有 tag/type/text/href，没有 role、可编辑/勾选/禁用状态、bbox、层级。
做法：输出 role/name/value/state/bbox；默认只给「可交互 + 标题/地标」，正文按段落截断；提供 depth/maxChars/selector 子树参数；大页面用 browser_find 局部检索（Playwright 的 browser_find 就是为此设计）。

**4. 动作后自动附带「状态增量」，不要让模型再调一次快照。**
返回：url/title/loading/readyState、是否发生导航、是否弹窗/下载、可见文本 diff 摘要、新快照（可裁剪）。这一步能直接把长任务的 round-trip 减半。

**5. 动作分层，逃生舱默认不可见。**
L0 观察、L1 语义动作、L2 复合动作、L3 evaluate/cdp。L3 不注册进默认工具表，需要显式开启 + 每次确认；这与 ToolRegistry 现有「按类别决策」兼容，只需新增 risk 元数据。

**6. 点击要有「命中验证」，不能只信 el.click()。**
现状：scrollIntoView 后直接 el.click()，不检查是否被遮罩、是否真的触发了导航/请求。
做法：点前 elementFromPoint 校验中心点归属；点后监听 did-start-navigation / did-frame-finish-load / 弹窗 / 下载事件，超时返回 BLOCKED_BY_OVERLAY 并给出遮挡元素；必要时回退到 CDP 坐标点击。

**7. 输入要走原生 setter 或 CDP insertText。**
现状：直接赋值 el.value 再 dispatch input/change，React 19 受控组件可能不认（value tracker 不更新），表现为「返回成功但页面没变」。
做法：用 HTMLInputElement.prototype 的 value setter 调用后再发 InputEvent，或直接 Input.insertText；输入后回读 value 校验。

**8. 等待条件化，禁止把 sleep 当默认。**
browser_wait 升级为 wait_for(condition)：selector visible/clickable、text、url、network idle、event；默认超时 10s，返回「等到了什么/没等到什么 + 当前快照摘要」。

**9. 把标签页暴露给模型，并绑定会话归属。**
现状：BrowserHost 已有 SessionGroup/tabId，但没有 tabs 工具；模型只能操作「当前活动标签」。
做法：browser_tabs(list/new/select/close/adopt/release)；参数可选 tabId，默认活动标签；快照与动作必须同 tab；后台标签不抢焦点；setWindowOpenHandler 控制弹窗，默认不自动接管，用户点击产生的标签可配置跟随。

**10. 确认流程嵌入工具调用，而不是外挂弹窗。**
schema 增加 risk: read/interact/commit/credential；commit 级（支付/登录/发布/删除/发消息）强制人工；确认卡展示「站点 + 元素描述 + 参数摘要 + 截图缩略」；确认结果绑定参数哈希、一次性；「始终允许」按站点+动作类型授予。

**11. 敏感数据默认不进入模型上下文。**
password/card/CVV/OTP 输入只回「已填写（N 字符）」；快照与日志对 type=password、autocomplete=cc-* 打码；网络头 Cookie/Authorization 打码；截图可选遮罩。agent-in-chrome 把这条做成了默认行为，值得直接抄。

**12. 域与下载策略在「导航前 + 每次重定向后」双重校验。**
只允许 http/https；跨 registrable domain 首次导航需确认；下载走隔离目录 + 类型/大小限制 + 完成确认；file:/data:/blob: 禁止页面导航。注意 Playwright 的教训：allowed-origins 不是安全边界，也不管重定向。

**13. 失败信息要「可行动」。**
统一错误码：ELEMENT_NOT_FOUND / STALE_REF / BLOCKED_BY_OVERLAY / NAV_TIMEOUT / AUTH_REQUIRED / CAPTCHA / DOWNLOAD_BLOCKED / DOMAIN_DENIED；返回人类可读说明 + 当前 URL/标题 + 候选元素 top3 + 建议下一步（重新快照/换选择器/请求人工）。只回「失败」会迫使模型盲目重试。

**14. 防死循环与可回放是 harness 的责任。**
动作指纹（tool+ref+text hash）连续 3 次相同、或 URL+标题 8 步不变 → 中止并上报；步数/时长/token 预算；每步 trace（时间、工具、参数摘要、前后 URL、截图引用、耗时、错误）落盘，支持人工接管与审计。现有 .loopsoar/screenshots 可直接复用。

**（补充）权限模型要适配「高频交互」。**
现状 network 默认 confirm，意味着每次点击/输入都弹窗，实际不可用。建议：浏览器交互单独归为 browser.interact，按「会话 + 站点 + 动作类型」授予，任务开始时确认一次；commit 级仍逐步确认。这样既不破坏 confirmDangerousAlways，也不会让 Agent 每点一次就被打断。

---

## 9. 建议的落地顺序

1. 修闭环：ref 统一 + 点击命中验证 + 输入原生 setter + 动作后状态增量（1–4、6–7）。
2. 扩观察：a11y/语义快照 + find + console/network + 等待条件（3、8）。
3. 扩控制：tabs + 复合动作 + 错误码（9、13）。
4. 治理：risk 元数据 + 确认卡 + 打码 + 域/下载策略（10–12）。
5. 运营：trace/回放 + 防死循环 + 预算（14）。

---

## 10. 参考资料

**官方文档 / 包 README**

1. Playwright MCP 介绍：https://playwright.dev/mcp/introduction
2. Playwright MCP 快照格式：https://playwright.dev/mcp/snapshots
3. Playwright MCP README（npm 包镜像）：https://unpkg.com/@playwright/mcp@latest/README.md
4. Chrome DevTools MCP：https://www.npmjs.com/package/chrome-devtools-mcp （v1.13.0）
5. Stagehand act：https://docs.stagehand.dev/v4/basics/act.md
6. Stagehand observe：https://docs.stagehand.dev/v4/basics/observe.md
7. Stagehand 多标签：https://docs.stagehand.dev/v4/best-practices/using-multiple-tabs.md
8. browser-use PyPI：https://pypi.org/project/browser-use/ （1.0.3）
9. browser-use 文档：https://docs.browser-use.com/open-source/introduction
10. Skyvern PyPI：https://pypi.org/project/skyvern/ （1.0.57）
11. Skyvern 官网：https://www.skyvern.com/
12. AgentQL 官网：https://www.agentql.com/
13. AgentQL 查询语言：https://docs.agentql.com/concepts/query-language
14. agent-in-chrome README：https://www.npmjs.com/package/@liang-hz/agent-in-chrome （0.55.5）

**厂商安全/能力说明**

15. Anthropic 计算机使用公告：https://www.anthropic.com/news/3-5-models-and-computer-use
16. Anthropic 计算机使用工具文档：https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
17. OpenAI CUA：https://openai.com/index/computer-using-agent/
18. 科技日报/央视网对 Operator 数字的转述：https://5gai.cctv.com/2025/01/26/ARTIWJ9CqIsJUEYu313n3g0Q250126.shtml
19. Chrome 安全博客（Agentic 能力的安全架构）：https://blog.google/security/architecting-security-for-agentic/

**论文**

20. WebVoyager：https://aclanthology.org/2024.acl-long.371/ ；https://arxiv.org/abs/2401.13919
21. WebArena：https://arxiv.org/abs/2307.13854
22. Mind2Web：https://arxiv.org/abs/2306.06070
23. OSWorld：https://arxiv.org/abs/2404.07972
24. Set-of-Mark：https://arxiv.org/abs/2310.11441
25. VisualWebArena：https://arxiv.org/abs/2401.13649
26. Online-Mind2Web：https://arxiv.org/abs/2504.01382

**Loopsoar 代码（本次阅读）**

27. packages/shell/src/main/browserTools.ts（工具注册与动作实现）
28. packages/shell/src/browserAdapter/backends/webContentsView.ts（快照/编号/点击/输入）
29. packages/shell/src/main/browserHost.ts（SessionGroup/标签生命周期）
30. packages/core/src/permissions.ts（权限类别与等级）

---

## 11. 不确定项与未验证

1. **无法直连 GitHub**：Playwright MCP / Chrome DevTools MCP / browser-use / Skyvern / agent-in-chrome 的 GitHub README 未能直接读取，改用 npm 包镜像与 PyPI 描述；可能与仓库主干存在版本差。
2. **OpenAI CUA 的 87%/58.1%/38.1% 来自 OpenAI 官方页面，但该页为 JS 渲染**，本次通过科技日报/央视网转述核对；建议架构评审前用官方页面复核一次。
3. **Anthropic 工具 schema 的完整参数**（坐标范围、是否支持缩放等）未能在本次环境读到 API 文档全文，文中只列了公开动作名，未引用具体参数约束。
4. **Chrome 安全博客与部分 Chrome DevTools 博客未能取到正文**，第 6 节的安全结论主要来自 Playwright MCP 参数说明、agent-in-chrome README 与 Operator 公告，而非 Chrome 官方安全架构文。
5. **基准数字不可横向比较**：模型、任务集、评测协议不同；Skyvern、browser-use、Operator 均为厂商自报。本文只把它们当作「量级参考」。
6. **agent-in-chrome 的 4,146/8,235/6,954 字节为第三方自测**（样本为单一页面），不构成性能基准。
7. **未验证 Loopsoar 现有实现的运行时行为**：本文对 browser_click/browser_type 的判断基于源码静态阅读，未启动应用复现；建议以一次端到端冒烟测试确认。

---

（完）

