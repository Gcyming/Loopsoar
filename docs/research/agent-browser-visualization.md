# Agent 浏览器操作的可视化反馈：业界做法与 Loopsoar 落地设计

- **日期**：2026-11-14
- **范围**：Agent 通过 browser_* 工具操控内嵌 WebContentsView 时，如何把「正在操作什么」实时、低干扰地呈现给用户；含页外边框呼吸灯与页内虚拟光标/键盘两部分。
- **读者**：桌面端（packages/shell、packages/ui）实现者与交互设计者。
- **资料口径**：优先官方文档、官方仓库源码提交、issue 原文；所有结论附来源 URL，抓取时间为 2026-11-14。文末「不确定项」明说无法核实之处。本文不含任何源码改动。

---

## 0. 结论先行

1. **实时可视反馈在业界几乎只有一条成熟路线：往页面里注入一个隔离浮层**。Playwright 的 locator.highlight()、Hermes Agent 的「agent 在页面上做什么」浮层、社区 pw_glow/playglow 走的都是这条路；它们都不依赖 WebContentsView 或浏览器窗口层的叠加。
2. **Electron 的原生视图是硬约束，不是样式问题**：WebContentsView 画在渲染进程 DOM 之上，z-index/portal 一律无效；且没有 setTopBrowserView 之类的层级 API。因此「边框呼吸灯」不能画在网页之上，只能画在网页视图的**外侧**（宿主 DOM 的可见环带）或页面**内部**。
3. **Loopsoar 已经具备理想落点**：网页面板四周有 8px 留白（LAYOUT.BROWSER_VIEW_INSET=8）、右侧 4px、圆角 14（BROWSER_VIEW_RADIUS，原生视图已用 setBorderRadius 对齐）。这圈留白天然就是呼吸灯的画布，**不需要改任何几何**。
4. **页内浮层四件套**：closed Shadow DOM（隔离样式与选择器）+ 逐属性 CSSOM 写样式（绕开严格 CSP 与站点样式战）+ Web Animations API（不解析 CSS 文本）+ pointer-events:none（永不吃点击）。不用 style 标签、不用 innerHTML、不用 data URI 图标（后三者都会被部分站点的 CSP 挡住）。
5. **时序比样式更影响体感**：动作前先亮目标框 120ms 再点，点后涟漪 520ms，光标步进移动 220–320ms；连续动作复用同一浮层实例，只改节点属性，绝不重建。
6. **最大的坑不是隔离，是观测污染**：页内浮层会出现在 capturePage() 与 CDP 截图里，Agent 的下一次「观察」会看到自己的光标与涟漪。截图路径必须先 suspend() 浮层，双 rAF 后再截，截完 resume()。
7. **行业留有空白**：Stagehand 的 act() 没有任何可视反馈；OpenCode 明确拒绝实现 agent pointer overlay；Chrome DevTools MCP 用「录屏 mp4」替代实时反馈。实时、可关、低干扰的可视化仍是差异化点。
8. **默认策略建议**：边框灯默认开（零风险、零页面侵入）；页内光标默认开但可逐项关闭，且只在浏览器面板可见、窗口聚焦时播放（避免拖慢 Agent 与后台耗电）。

---

## 1. 问题与目标

### 1.1 现状

Agent 通过 browser_* 工具（navigate/click/type/press_key/select/hover/tabs 等）驱动内嵌浏览器。当前的可视反馈只有「结果」：

- 点击瞬时生效，页面直接跳走，用户只看到跳转后的样子；
- 用户反馈「浏览器界面没反应，只能在工作区截图里看到」——即操作发生时，界面上没有任何「此刻有人在动我的页面」的信号；
- 长任务中模型思考的几十秒里，界面完全静止，用户无法区分「在跑」与「卡死」。

### 1.2 目标与非目标

| 目标 | 可观测的验收标准 |
|---|---|
| 任何时刻可判断 Agent 是否在操作 | 工具执行期间 200ms 内出现边框呼吸灯；空闲 600ms 内停止 |
| 能看出「点了哪里」 | 点击/输入前目标元素有框，落点有涟漪，光标从上一位置移到落点 |
| 不改变页面行为 | 浮层 pointer-events:none；页面的点击/滚动/焦点/DOM 事件序列与无浮层时逐字节一致 |
| 不被站点样式与 CSP 破坏 | 在带 style-src 'self' 严格 CSP 的页面、以及大量全局 CSS reset 的页面表现一致 |
| 可关闭、可减少动效 | 设置项三档（关 / 仅边框 / 完整）；prefers-reduced-motion 时不呼吸、光标瞬移 |
| 空闲零开销 | 无动作时不跑 rAF、不持有动画，浮层 DOM 节点 ≤ 8 |

**非目标**：不做操作回放（那属于 trace/录制，另立需求）、不做「用户可接管」的控制权交接（安全模型不同）、不把页面文本回传到宿主 UI（隐私）。

---

## 2. 业界做法盘点

### 2.1 总览

| 项目 / 产品 | 反馈形态 | 技术手段 | 实时 | 来源 |
|---|---|---|---|---|
| Playwright Locator.highlight() | 目标元素描边 | 页内注入 | 是 | https://rubydoc.info/gems/playwright-ruby-client/1.26.0/Playwright%2FLocator:highlight ；https://github.com/microsoft/playwright/issues/36780 |
| Playwright Trace Viewer | 动作时间线 + 前后快照 + 胶片条 | 录制回放 | 否 | https://playwright.dev/docs/trace-viewer |
| Chrome DevTools MCP | 录屏 mp4、截图、a11y 快照、坐标点击 | CDP screencast / CDP 输入 | 否（录制型） | https://github.com/ChromeDevTools/chrome-devtools-mcp (docs/tool-reference.md) |
| CDP Overlay 域 | 元素/矩形高亮、标尺、命中测试 | inspector overlay 层 | 是 | https://chromedevtools.github.io/devtools-protocol/tot/Overlay/ |
| browser-use Cloud | liveUrl iframe 直播、录制、人类接管 | 远程浏览器流 | 是 | https://browser-use.com/live-view.md |
| Stagehand act() | 无可视化，只回传 selector/action | — | — | https://docs.stagehand.dev/v3/basics/act.md |
| Hermes Agent 桌面端 | 页内浮层：目标框 + 指针 + 闲置脉冲 | closed shadow root 注入 | 是 | https://github.com/NousResearch/hermes-agent/commit/f262e684d80119c8aeeaeae087b83bf0e4961f18 |
| OpenCode 集成浏览器 | 提议「箭头 + 点击涟漪」，被拒 | 讨论：页内 vs presenter | — | https://github.com/anomalyco/opencode/issues/60440 |
| Claude Computer Use / OpenAI CUA | 虚拟鼠标键盘、坐标动作；画不画由客户端决定 | OS 级 | 是 | https://platform.claude.com/docs/zh-TW/agents-and-tools/tool-use/computer-use-tool ；https://openai.com/index/computer-using-agent/ |
| pw_glow / playglow（社区） | 动作时元素发光（glow） | patch locator | 是 | https://socket.dev/npm/package/pw_glow ；https://www.npmjs.com/package/playglow |

### 2.2 Playwright：最高频被抄的两件事

**locator.highlight()**：官方 API，语义是「把对应元素在屏幕上高亮，用于调试，不要提交到测试代码」。这确立了「高亮只是调试/演示设施，不是产品行为」的定位，也说明它是**页内绘制**而非浏览器窗口层绘制。

社区 issue #36780 请求给它加 color / duration / cycle 参数，并描述期望：'200ms on / 200ms off，重复 4 次'。这条需求本身就是「呼吸灯」的原始形态，同时暴露了官方实现的短板：**样式与时序都写死，不能表达状态**（思考中 / 执行中 / 失败）。

**Trace Viewer**：Actions 面板逐条列出每个动作、使用的 locator、耗时；悬停动作可在 DOM 快照间切换，Before/After 两个标签页对比动作前后，Screenshots 生成胶片条。它的价值不在实时，而在**事后可解释**：动作 → 目标 → 前后状态的三元组是排障的最小信息单元。

**可借鉴**：动作条目要能表达「动作类型 + 目标 + 结果」；**不可借鉴**：它是录制型，用户必须等任务结束。

### 2.3 Chrome DevTools MCP：官方选择用「录屏」而不是「实时浮层」

其自动生成的工具参考（docs/tool-reference.md，本次抓到 5 万余字符）把能力分成输入自动化（click / drag / fill / hover / press_key / type_text / click_at…）、导航、仿真、性能、网络、调试（evaluate_script / take_screenshot / take_snapshot / screencast_start / screencast_stop…）等组。

两个关键事实：

- 有 screencast_start / screencast_stop（录制为 mp4），却**没有任何「在页面上画指针」的工具**；
- click_at 明确标注 needs flag: --experimentalVision=true，即坐标级操作是实验能力。

结论：官方把「让用户看见」交给**录制**，把「让模型看见」交给 a11y 快照与截图。这是一个可用的兜底，但不是用户要的「当下就知道在点什么」。

### 2.4 CDP Overlay 域：能力最强、表达力最弱的绘制层

Overlay 域提供 highlightNode / highlightRect / highlightQuad / setInspectMode / setShowGridOverlays 等命令，HighlightConfig 可分别设置 content / padding / border / margin 颜色与 showInfo、showRulers。它由浏览器 inspector overlay 绘制，**不受页面 CSS 与 CSP 影响**，也不吃点击。

但它的表达能力受限于「方框 + 色块 + 文本」：没有圆角、没有涟漪、没有光标、没有过渡动画曲线。适合做「元素框」的兜底，不适合做完整的手势语言。

### 2.5 browser-use：把「看」做成产品能力

Cloud 版每个浏览器都返回 liveUrl，可开新标签页或嵌 iframe 实时观看；readOnly=true 或把 iframe 包进 inert + pointer-events:none 可切成只读；开启 enableRecording 后拿到 mp4；留出交互态即「人类接管」，登录、过验证码、批准动作时由人接手，Agent 的 Playwright/Puppeteer 代码继续跑同一个浏览器。

**启示**：可视化的终局不是「好看的动画」，而是**可观察 + 可接管**。Loopsoar 的第一步应是「看得见」，第二步才是「能暂停/接管」。

### 2.6 Hermes Agent：目前最接近我们要做的事的开源实现

提交 f262e68「feat(desktop): an overlay that shows what the agent is doing to the page」及其后续提交 10115e4 的 diff 片段里，有几条判断值得直接吸收：

- **closed shadow root 是隔离手段**：注释写明「closed shadow root is what keeps the overlay out of the act engine's [refs/inventory]」——浮层不能污染 Agent 自己用于定位的元素清单，这与「不改页面」是同一件事的两面；
- **IDLE PULSE**：注释写「keeps the preview overlay alive while the model reasons」——模型思考期间必须有持续信号，否则界面看起来像挂了；这正是「呼吸灯」的动机；
- **步进而非瞬移**：「Stepped rather than teleported: a page learns it is hovered from a stream of moves, and one jump to the target skips everything in between」——指针要分步移动，既符合直觉，也让 :hover 依赖的页面行为（下拉菜单、tooltip）被真实触发；
- **跳过不可点目标**：测试用例覆盖「aria-inert 控件」「被其它层盖住的控件」——指针不能飞到一个点了也没用的元素上。

### 2.7 OpenCode：一个被拒绝但信息量很大的需求

issue #60440 原文：集成浏览器执行 click / hover / fill 时**没有可见指针**，「页面变了，但用户看不到 Agent 在哪里操作」，提议用一个箭头 + 点击涟漪，覆盖 click / hover / fill / select / drag / 文件拖放，画成「不能被页面重新样式化、也不挡自己输入」的样子。

维护者回复归纳了方案，随后以「This isn't something we plan to build」关闭。评论区留下的架构争论极有价值：

- 该 issue 关联的 #53861 把 agent 标签页改成 offscreen tab + presenter 视图，于是「浮层画在页面里还是画在 presenter 里」成为分叉；
- 提议者的判断：**画在页面里更省事**——offscreen tab 的帧被 presenter 展示时，页内浮层随帧一起缩放、坐标系与 Agent 的点击完全一致；若改到 presenter 画，就需要页面把指针坐标上报（新事件），或 presenter 自己解析目标坐标。

这条结论对 Loopsoar 直接成立：我们的 WebContentsView 就是「presenter 直接显示页面本身」，页内浮层天然在正确坐标系里。

### 2.8 小结：四条共识 + 一处空白

1. **绘制位置**：实时反馈都放页内；页外层只做「窗口级状态」（branding、录制红点）。
2. **隔离要求**：必须能抵抗站点 CSS、必须不吃点击、必须不污染 Agent 的元素清单。
3. **时序**：先指示、后执行；执行后保留一小段；连续动作不重建。
4. **可关闭**：所有实现都把它当调试/演示设施（Playwright 文档原话：don't commit the code that uses it）。
5. **空白**：没有人把「状态化呼吸灯（思考/执行/失败）+ 页内手势语言 + 可在设置里逐项关闭」做完整。Loopsoar 有机会一次做对。

---

## 3. 技术方案对比

### 3.1 四种「把东西画在网页上」的方式

| 方案 | 能覆盖网页内容 | 受页面 CSS/CSP 影响 | 吃不吃用户点击 | 跨导航是否保持 | 成本 |
|---|---|---|---|---|---|
| A. 页内 DOM 浮层（注入脚本） | 能 | 部分（可用 Shadow DOM + CSSOM 规避） | 不吃（pointer-events:none） | 丢失，需在 dom-ready 重注入 | 极低 |
| B. CDP Overlay 域 | 能 | 不受 | 不吃 | 丢失 | 低，但只能画方框/色块 |
| C. 透明 WebContentsView 叠在上层 | 能 | 不受 | **吃**（View 无 setIgnoreMouseEvents） | 保持 | 高：多一个渲染进程 + 透明合成缺陷 |
| D. 宿主 DOM 环带（画在视图外侧） | 不能（在视图外） | 不受 | 不吃 | 保持 | 极低 |

**关于 C 的两个硬事实**：

- 原生视图绘制在渲染进程 DOM 之上，任何 z-index / portal 都盖不住它。社区项目 omnigent 的 PR #3984 把这条写成 bug 根因：「The embedded Browser tab's native WebContentsView paints above ALL renderer DOM — no z-index or portal can put a modal over it」，其修法是浮层出现时 setVisible(false)。Loopsoar 的 browserHost.ts 注释里已有同一结论（「浮层打开时隐藏原生视图」）。
- 透明视图本身也是坑：Electron 官方迁移文档说明 WebContentsView 默认白底，要透明必须 setBackgroundColor('#00000000')；而 issue #42335 记录了透明 WebContentsView 的合成缺陷（动画/半透明内容出现残影、累积绘制）。

**关于层级 API**：issue #42061 确认 WebContentsView 没有 setTopBrowserView 等价物，只能 removeChildView + addChildView 重排。

→ 结论：**C 直接排除**；A + D 组合是唯一同时满足「覆盖网页」「不吃点击」「跨导航可用」的方案。

### 3.2 页内浮层的隔离与抗干扰清单

| 威胁 | 做法 | 为什么 |
|---|---|---|
| 站点 CSS 命中浮层 | 宿主元素 + closed shadow root；宿主元素用 all:initial 切断继承（font / color / direction / zoom） | shadow 边界让页面选择器进不来，也让浮层样式出不去 |
| 严格 CSP 拦 style 标签 | 不建 style 节点；逐条用 el.style.setProperty(prop, value, 'important') 写 CSSOM | CSP 的 style-src 管的是样式表与 style 属性字符串，CSSOM 属性赋值不受其约束（MDN style-src；GolemUI 的 strict-CSP 指南明确「element.style 走 CSSOM，style-src 允许」） |
| 需要动画 | 用 Web Animations API（el.animate([...], {...})） | 关键帧是 JS 对象，不解析 CSS 文本，不受 CSP；同时能拿到 finished Promise 做清理 |
| 需要复杂样式表 | 可选 adoptedStyleSheets + replaceSync | 在严格 CSP 下可用（WICG construct-stylesheets issue #98），但 replaceSync 解析 CSS 字符串，新规范可能要求 'unsafe-eval'，**只作增强、不作依赖** |
| z-index 竞争 | 2147483647 + 追加为 documentElement 的最后一个子节点 + isolation:isolate | 同层级下后插入者胜；isolate 阻断混合模式外泄 |
| 改变页面行为 | 宿主与所有子节点 pointer-events:none；浮层 aria-hidden=true | 不吃指针事件、不进可访问性树 |
| 页面有全局 * { box-sizing }、*::before 等 | 浮层内部样式显式声明 box-sizing / all 复位 | 继承与通配符选择器都进不了 shadow，但仍需自己复位 |
| 页面 html 上有 transform / filter / perspective | 检测：getComputedStyle(document.documentElement).transform !== 'none' 时，position:fixed 会相对该元素而非视口 → 降级为 absolute + 监听 scroll 补偿，或回退 CDP Overlay | 这是 fixed 定位的规范行为，不是 bug |
| 页面 JS 删除浮层 | 引用放闭包 + Symbol 私有槽，不挂可枚举属性；需要时 MutationObserver 低频自愈（≥1s 节流） | 多数站点不会主动删未知节点，别为极端情况付每帧成本 |
| 页面自己也有 #__loopsoar 之类 id | 宿主 id 带随机后缀，模块内保存引用 | 避免被站点脚本 querySelector 命中 |

### 3.3 手势语言（画什么）

| 原语 | 形态 | 关键实现 |
|---|---|---|
| 虚拟光标 | 12×18 的箭头 SVG + 半透明「AI」标记 | 内联 createElementNS 构建（不用 data URI：img-src 可能被 CSP 限制）；transform: translate3d 移动 |
| 目标框 | 2px 描边 + 4px 外发光，圆角 min(8, 目标圆角) | 用两圈 box-shadow 画在**元素外侧**，不覆盖内容 |
| 点击涟漪 | 落点扩散圆，scale 0.2→2.4，opacity 0.45→0 | WAAPI，520ms，ease-out；同时长只允许一个 |
| 输入提示 | 光标旁按键 chip（Enter / Ctrl+A / 文本长度） | 位置随视口边缘翻转；只显示按键名，不回显用户输入内容 |
| 拖拽轨迹 | 起点到终点的虚线 + 起终点两个小圆 | 一次绘制，120ms 后随框一起淡出；不在每帧重绘路径 |
| 滚动提示 | 视口边缘的箭头闪一次 | 滚动本身有视觉反馈，不额外画 |
| 选择/下拉 | 目标框 + chip 显示「选择 · 第 n 项」 | 页面内文本可显示（它本来就在页面里），但不回传宿主 |

### 3.4 时序与动效规范（建议值，需实测微调）

| 阶段 | 时长 | 曲线 | 说明 |
|---|---|---|---|
| 目标框亮起（dwell） | 120ms | 线性淡入 | 低于 100ms 人眼难捕捉；高于 200ms 开始明显拖慢 Agent（每次点击多 200ms，10 步就多 2s） |
| 光标移动 | 220–320ms（按距离插值，速度上限约 1400px/s） | cubic-bezier(.2,.8,.2,1) | 分 6–10 步插值，不瞬移：:hover 依赖的菜单/tooltip 需要过程 |
| 点击涟漪 | 520ms | cubic-bezier(.16,.84,.44,1) | 与系统「触摸反馈」同量级 |
| 目标框保留 | 700ms 后淡出 | ease-out | 足够让用户视线追过去；下一个动作到来时立即接管 |
| 边框灯：执行中 | 1100ms / 周期 | ease-in-out | 明显「在动」 |
| 边框灯：思考中（模型轮次） | 2600ms / 周期 | ease-in-out | 慢到不烦人，但不静止 |
| 边框灯：失败 | 常亮 | — | 静态高对比，不用闪烁（避免焦虑与无障碍问题） |
| 收尾 | 600ms 淡出 | ease-out | 动作结束后不要立刻消失 |

**连续动作不闪烁的三条规则**：

1. 浮层实例随文档存在，动作之间**只改节点属性**，不重建节点；
2. 上一个目标框不立刻销毁，等新目标框出现时用 120ms 交叉淡出；
3. 涟漪允许重叠但最多 2 个，超过时强制结束最旧的（el.getAnimations().forEach(a => a.finish())）。

### 3.5 性能：如何不每帧重排

- 只动 transform 与 opacity（合成层属性）；**不要**动画 box-shadow / filter / width 这类触发 paint 的属性；边框灯的做法是「静态模糊阴影 + 只动 opacity」。
- 一次动作只在开始时读一次 getBoundingClientRect；rAF 回调里**只写不读**，杜绝 layout thrash。
- 空闲即停：没有活动动画时取消 rAF、断开 MutationObserver；不为「可能到来的动作」保留每帧循环。
- will-change 只加在正在移动的光标节点上，动画结束即移除。
- 单个浮层 DOM 节点数 ≤ 8（宿主 + 光标 + 框 + 涟漪 + chip），避免在低端机/大页面上拖慢合成。
- 后台/隐藏不播：document.visibilityState === 'hidden' 或窗口失焦时跳过 dwell 与动画，直接执行（Agent 不该为用户看不见的动画付延迟）。

---

## 4. 面向 Loopsoar 的落地设计

### 4.0 分层与状态机

三层职责（自下而上）：

1. **状态源（主进程）**：Agent 轮次（thinking）、工具执行（acting）、导航（navigating）、失败（error）。它是唯一产地，页面与渲染层都只是消费者。
2. **页内浮层（注入到 WebContentsView）**：光标、目标框、涟漪、按键 chip、内侧 2px 描边。
3. **宿主 DOM 环带（packages/ui）**：把网页面板四周那 8px 留白当画布，画外发光呼吸灯。

状态机：

| 状态 | 进入条件 | 边框灯 | 页内浮层 |
|---|---|---|---|
| idle | 无轮次、无工具 | 关闭（淡出 600ms） | 全部节点隐藏 |
| thinking | 模型轮次开始，尚未出工具调用 | 2600ms 慢呼吸 | 保留上一次目标框的残影（≤700ms）后清空 |
| acting | 工具开始执行 | 1100ms 快呼吸 | 目标框 + 光标 + 涟漪 |
| navigating | did-start-navigation | 保持快呼吸，颜色转为「加载」色 | 文档销毁，自然消失，dom-ready 重新注入 |
| error | 工具返回失败 | 常亮警示色 | 框转为失败色，停留 1.2s |

数据流（一次点击）：

    browserAdapter (packages/shell/src/browserAdapter/refs.ts: performClick)
      ├─ 1. 解析目标 → rect（页内 getBoundingClientRect）
      ├─ 2. overlay.highlight(rect)    → 目标框亮起
      ├─ 3. overlay.moveCursor(rect)   → 光标步进到位
      ├─ 4. 等待 dwell（默认 120ms，可配 0）
      ├─ 5. 真正执行 click（现有 performClick 不变）
      ├─ 6. overlay.ripple(rect)       → 涟漪 520ms
      └─ 7. overlay.settle()           → 700ms 后淡出

关键接缝：**不要新开一条 IPC 往返**。第 2–4 步与第 5 步应合并进同一段注入脚本（一次 executeJavaScript），既省一次跨进程往返，又保证坐标与点击目标严格一致。

### 4.1 浏览器边框呼吸灯

#### 4.1.1 为什么画在「视图外侧」而不是「页面内部」

| 维度 | 页外环带 | 页内 fixed 描边 |
|---|---|---|
| 跨导航 | 保持（DOM 不随页面销毁） | 丢失，导航中有一段时间完全没有灯 |
| 页面兼容 | 完全无关 | 受 transform/filter 站点影响 |
| 视觉 | 光晕在页面外，像「设备指示灯」 | 光晕压在页面边缘内容上 |
| 成本 | 0 额外进程 | 0 额外进程 |

结论：**主用页外环带**；页内只补一条 2px 的 inset 描边（当需要「贴边内发光」时），二者共用同一状态。

#### 4.1.2 几何：完全复用现有单一产地

packages/contracts/src/layout.ts 已经定义了 LAYOUT.BROWSER_VIEW_INSET = 8、BROWSER_VIEW_INSET_RIGHT = 4、BROWSER_VIEW_RADIUS = 14，并由 computeBrowserViewBounds() 统一算给主进程 setBounds。渲染层要画的发光层，用**同一个函数、同一份 LAYOUT** 得到矩形，避免第二次几何计算带来的错位。

注意两点：

- 发光层是 absolute 定位的兄弟节点，不参与 flex 布局（不占位、不改变面板宽度）；
- 发光层向外扩散的部分会盖到标题栏/状态栏/分隔条上——它必须 pointer-events:none，否则会挡住 SPLITTER_WIDTH=2 的拖拽热区（这不是理论风险，layout.ts 里已经为热区让过位）。

#### 4.1.3 三层阴影 + 只动 opacity

    .browser-panel-glow {
      position: absolute;
      pointer-events: none;
      border-radius: 14px;              /* = LAYOUT.BROWSER_VIEW_RADIUS */
      opacity: 0;
      transition: opacity 240ms cubic-bezier(.2, .8, .2, 1);
      /* 三层：1px 亮边 / 10px 中层 / 26px 外晕；静态阴影，只动 opacity */
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--agent-glow) 65%, transparent),
        0 0 10px 1px color-mix(in srgb, var(--agent-glow) 40%, transparent),
        0 0 26px 6px color-mix(in srgb, var(--agent-glow) 18%, transparent);
    }
    .browser-panel-glow[data-state="thinking"] { animation: loopsoar-breathe 2600ms ease-in-out infinite; }
    .browser-panel-glow[data-state="acting"]   { animation: loopsoar-breathe 1100ms ease-in-out infinite; }
    .browser-panel-glow[data-state="error"]    { opacity: .92; }
    @keyframes loopsoar-breathe {
      0%, 100% { opacity: .35; }
      50%      { opacity: 1;   }
    }
    @media (prefers-reduced-motion: reduce) {
      .browser-panel-glow { animation: none !important; opacity: .55; transition: none; }
    }

为什么是「静态阴影 + opacity」而不是动画 box-shadow：后者每帧触发 paint，24 英寸屏上等于每帧重绘整个面板边缘；前者只在合成层改 alpha。

#### 4.1.4 颜色语义

建议与 existing design token 对齐（见 docs/design/soft-theme.md），只定义三个语义色，不新增装饰色：

| 状态 | 色 | 用途 |
|---|---|---|
| acting | 品牌主色 | Agent 正在执行 |
| thinking | 主色 60% 饱和度 | 模型推理中 |
| error | 警示橙/红 | 工具失败、需要人 |

#### 4.1.5 与「原生视图被隐藏」的既有逻辑协同

browserHost.ts 已有「浮层打开时隐藏原生视图」的路径（setVisible）。当原生视图被隐藏时（对话框、终端全宽、崩溃页），边框灯应切换为「静态描边」而不是呼吸——因为此时没有页面在动，呼吸会误导。

### 4.2 页内虚拟光标 / 键盘

#### 4.2.1 注入时机与生命周期

| 时机 | 做什么 |
|---|---|
| dom-ready / did-finish-load | 注入引导脚本（只装壳，不建节点）；SPA 的 history 跳转不重建文档，无需重复注入 |
| 首次动作 | 懒创建 shadow root 与节点（避免为不操作的页面付初始化成本） |
| did-start-navigation | 什么都不做：文档销毁即浮层消失；边框灯负责「还在跑」的信号 |
| 工具全部结束 | overlay.clear()，节点保留供下次复用 |
| 设置改为「关」 | 立即 removeChild 并清空引用 |
| 页面不可注入（devtools: / chrome-extension:// PDF 查看器 / 崩溃页） | executeJavaScript 会 reject，静默降级为只有边框灯 |

#### 4.2.2 宿主与样式（代码要点）

    const HOST_ID = '__loopsoar_overlay_' + Math.random().toString(36).slice(2, 8);

    function ensureRoot() {
      if (root) return root;
      const host = document.createElement('div');
      host.id = HOST_ID;
      // 关键：all:initial 切断页面继承（字体/颜色/direction/zoom）
      host.style.setProperty('all', 'initial', 'important');
      host.style.setProperty('position', 'fixed', 'important');
      host.style.setProperty('inset', '0', 'important');
      host.style.setProperty('pointer-events', 'none', 'important');
      host.style.setProperty('z-index', '2147483647', 'important');
      host.style.setProperty('isolation', 'isolate', 'important');
      host.setAttribute('aria-hidden', 'true');
      root = host.attachShadow({ mode: 'closed' });
      document.documentElement.appendChild(host);
      return root;
    }

注意：**不要**用 contain:strict —— 它会让 fixed 子元素的包含块变成宿主自身，反而把坐标系搞乱；也不要给宿主设 background 或 border（页面缩略图/截图里会看到一块遮罩）。

#### 4.2.3 目标框与光标

    function box(rect) {
      const b = document.createElement('div');
      const s = b.style;
      s.setProperty('position', 'fixed', 'important');
      s.setProperty('left', (rect.x - 2) + 'px', 'important');
      s.setProperty('top', (rect.y - 2) + 'px', 'important');
      s.setProperty('width', (rect.w + 4) + 'px', 'important');
      s.setProperty('height', (rect.h + 4) + 'px', 'important');
      s.setProperty('border-radius', Math.min(8, rect.r + 2) + 'px', 'important');
      // 两圈外发光，画在元素外侧，不覆盖内容
      s.setProperty('box-shadow', '0 0 0 2px rgba(74,144,255,.9), 0 0 12px 2px rgba(74,144,255,.45)', 'important');
      s.setProperty('pointer-events', 'none', 'important');
      return b;
    }

光标用 SVG（createElementNS），箭头尖端对准落点，主体在左上方向外偏 2px，避免正好压住按钮文字。

#### 4.2.4 涟漪与按键 chip

    function ripple(x, y) {
      const el = document.createElement('div'); // 圆形，24px
      overlay.appendChild(el);
      el.animate([
        { transform: 'translate(-50%,-50%) scale(.2)', opacity: .45 },
        { transform: 'translate(-50%,-50%) scale(2.4)', opacity: 0 },
      ], { duration: 520, easing: 'cubic-bezier(.16,.84,.44,1)' }).finished.then(() => el.remove());
    }

按键 chip：显示 Enter / Ctrl+A / Esc 这类键名（不是用户输入的内容）。位置默认在光标右下，靠近视口右/下边缘时翻转到左上。

#### 4.2.5 坐标与缩放

- 一律用页内 getBoundingClientRect()（CSS px，视口坐标），**不要**在主进程用元素偏移量重算；
- 页面缩放（webContents.getZoomFactor()）不影响 CSS px 与浮层坐标的一致性（浮层同在页面坐标系），只影响 capturePage 的图像尺寸；
- 跨 iframe：iframe 内的 rect 是 iframe 局部坐标，需要在父文档里加 iframe 元素的 rect 偏移；若拿不到（跨域），退化为在父文档高亮 iframe 元素本身。

#### 4.2.6 观测污染：必须先 suspend 再截图

这是本设计里**唯一会让 Agent 变笨**的风险：浮层是页面 DOM 的一部分，会出现在 webContents.capturePage() 与 CDP Page.captureScreenshot 的结果里。

规则：

1. 所有截图路径（工具的 take_screenshot、工作区缩略图、E2E 断言）统一走一个 helper：overlay.suspend() → 双 rAF（等一帧提交）→ capturePage() → overlay.resume()；
2. overlay.suspend() 设 host.style.visibility='hidden'，resume() 还原；
3. 若截图与动画并发（Agent 连续行动），suspend 期间不排队新动画，直接丢弃（视觉上少一帧涟漪，代价可接受）。

### 4.3 协议、开关与契约

**状态事件（主进程 → 渲染层，单向）**：在 packages/contracts/src/schemas.ts 增加一条 event（不是 request/response），例如 browser:agent-activity，载荷 { state: 'idle'|'thinking'|'acting'|'navigating'|'error', tool?: string, tabId?: string, at: number }；gen/ipc.ts 由 pnpm gen 生成，不要手改生成物。

要点：

- 事件要节流（≥100ms 合并一次），状态机在**主进程**收敛，渲染层只负责画；
- 不要把 selector 或页面文本放进事件载荷（会进日志与遥测）；只放工具名与状态；
- tabId 用于「非活动标签页上的动作」在标签条上闪一次，而不是在看不见的页面上动画。

**页面命令（主进程 → 页面，executeJavaScript）**：单一入口，载荷是一个小对象，避免每加一个手势就改注入脚本：

    __loopsoarOverlay({ cmd: 'highlight', rect, radius, tone })
    __loopsoarOverlay({ cmd: 'cursor', x, y, duration })
    __loopsoarOverlay({ cmd: 'click', x, y })
    __loopsoarOverlay({ cmd: 'key', label, x, y })
    __loopsoarOverlay({ cmd: 'clear' })
    __loopsoarOverlay({ cmd: 'suspend' }) / { cmd: 'resume' }

**设置项**（新增偏好，默认值见括号）：

| key | 取值 | 默认 | 含义 |
|---|---|---|---|
| agentFeedback | 'off' / 'border' / 'full' | 'full' | 关 / 仅边框灯 / 边框 + 页内光标 |
| agentFeedbackDwellMs | 0 / 120 / 200 | 120 | 动作前停留；0 = 只要涟漪不要延迟 |
| agentFeedbackReduceMotion | boolean | 跟随系统 | 关闭呼吸与步进动画 |

三档而不是布尔，是因为「只想确认它在跑」的用户不该被迫接受页面上的光标。

### 4.4 分阶段实施

**P0（1–2 天，零页面侵入）**

1. packages/contracts：加 browser:agent-activity 事件与偏好 schema；pnpm gen；
2. packages/shell：在工具执行前后收敛状态机（browserAdapter 的 dispatch 处是唯一入口）；
3. packages/ui：网页面板容器内加发光层，几何复用 computeBrowserViewBounds；
4. 设置页加三档开关。

验收：Agent 执行任意工具 → 200ms 内出现呼吸灯；结束 → 600ms 内停；面板隐藏/对话框打开 → 不误呼吸；prefers-reduced-motion → 静态描边。

**P1（3–5 天，页内光标）**

1. 新增 packages/shell/src/main/browserOverlayScript.ts（注入源码，纯函数、无依赖、可单测）；
2. 新增 packages/shell/src/main/browserOverlay.ts（控制器：ensure / highlight / cursor / ripple / clear / suspend）；
3. 接缝放在 packages/shell/src/browserAdapter/refs.ts 的 performClick / performType 内部（它们已经是唯一产地，见文件头注释）；把高亮与点击合并进同一段注入脚本；
4. 截图路径统一接 suspend/resume。

验收：点击前 120ms 出现框与光标；点击后 520ms 涟漪；连续 10 次点击浮层节点数不增长（内存与 DOM 双稳）；capturePage 结果里不含浮层。

**P2（可选）**

拖拽轨迹、按键 chip、失败态、非活动标签页的标签条脉冲、演示模式（更大更慢，适合录屏）。

### 4.5 关键取舍（写给评审）

| 取舍 | 选择 | 理由 |
|---|---|---|
| 页内 vs 页外 | 页外做灯，页内做手势 | 灯要跨导航，手势要贴元素 |
| 是否给每次动作加 120ms | 仅前景播 | 后台/失焦时加延迟是纯损失 |
| 是否用 CDP Overlay 做框 | 不用 | 无圆角/无淡出，与我们的动效规范冲突；留作站点兼容兜底 |
| 是否做接管 | 本期不做 | 需要工具栏与安全模型，另立需求 |
| 是否记录动作 | 不做回放，只做实时 | 回放是另一类产品能力（见 Trace Viewer） |

---

## 5. 风险与回退

| # | 风险 | 触发条件 | 影响 | 缓解 | 回退 |
|---|---|---|---|---|---|
| R1 | 截图污染 | Agent 截图观察、工作区缩略图 | 模型看到自己的光标，误判页面 | 截图前 suspend + 双 rAF | 无条件 suspend：截图工具一律先隐藏浮层 |
| R2 | 严格 CSP | style-src 'self' 且无 unsafe-inline | style 标签注入失效 | 全用 CSSOM 属性 + WAAPI | 若仍失败，降级 CDP Overlay 画框、无涟漪 |
| R3 | 页面 html 有 transform/filter | 少数站点 | fixed 坐标偏移 | 启动时检测并降级 absolute | 完全不注入，仅保留边框灯 |
| R4 | 页面删除浮层 | 极少数反调试站点 | 浮层消失 | 低频 MutationObserver 自愈 | 不做自愈，接受退化 |
| R5 | 性能 | 大页面 + 低端机 + 长动画 | 掉帧 | 只动合成属性、≤8 节点、空闲停 | 自动降级为「只画框，不画光标与涟漪」 |
| R6 | 后台节流 | 标签页不可见 | rAF 被冻结，动画不播 | visibilityState 检查，直接跳过 | 无 |
| R7 | 无障碍 | prefers-reduced-motion、屏幕阅读器 | 呼吸灯引发不适；浮层被读出 | 静态模式 + aria-hidden | 无 |
| R8 | 与 DevTools 并存 | F12 打开 | DevTools 自身 overlay 与浮层叠加 | 两者互不影响（不同层） | 若视觉打架，DevTools 打开时关浮层 |
| R9 | 用户误以为可点 | 光标太像系统指针 | 用户去抓「AI 的鼠标」 | 光标带 AI 标记、半透明、不跟随真实指针 | 关闭页内指针，只留边框灯 |
| R10 | 隐私 | 浮层渲染页面文本 | 文本进宿主日志/遥测 | 页面内可显示，**不回传**宿主 | 只显示图标不显示文本 |

**总回退开关**：一个偏好位（agentFeedback='off'）必须在**一次 IPC 内**生效，且不要求重启；关闭后页面内不得残留任何节点（removeChild + 清引用），宿主不得保留动画。

---

## 6. 不确定项

1. Hermes Agent 的浮层实现细节，本次只拿到 commit 摘要与 diff 片段（raw.githubusercontent 与 patch 端点在当前网络不可达），未读到完整源码；引用仅限片段原文。
2. OpenCode 拒绝该需求的产品理由，官方只写了「不计划实现」，未给技术解释。
3. 各家「动作前停留」的具体毫秒数没有公开数值；第 3.4 节的时间来自交互经验与 Hermes 的「步进移动」思路，需要在 Loopsoar 内实测（建议用 5 名内测用户的「是否能跟上」主观评分校准）。
4. Electron 透明 WebContentsView 的合成缺陷 issue #42335 报告于 31.x；未验证 45 是否修复（本设计不依赖透明视图，故不影响结论）。
5. Playwright locator.highlight() 的默认颜色/时长未在文档中给出；issue #36780 只说明当前不可配置。

---

## 7. 参考资料

**产品与官方文档**

1. Playwright Trace Viewer：https://playwright.dev/docs/trace-viewer
2. Playwright Locator#highlight（Ruby 客户端镜像，含官方 API 说明原文）：https://rubydoc.info/gems/playwright-ruby-client/1.26.0/Playwright%2FLocator:highlight
3. Playwright issue #36780「Customize locator.highlight()」：https://github.com/microsoft/playwright/issues/36780
4. Chrome DevTools MCP 工具参考（自动生成）：https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md
5. Chrome DevTools Protocol Overlay 域：https://chromedevtools.github.io/devtools-protocol/tot/Overlay/
6. Browser Use Live view / session recording：https://browser-use.com/live-view.md
7. Stagehand act()：https://docs.stagehand.dev/v3/basics/act.md
8. Anthropic Computer Use 工具文档：https://platform.claude.com/docs/zh-TW/agents-and-tools/tool-use/computer-use-tool
9. OpenAI CUA / Operator：https://openai.com/index/computer-using-agent/

**实现参考**

10. NousResearch/hermes-agent commit f262e68「an overlay that shows what the agent is doing to the page」：https://github.com/NousResearch/hermes-agent/commit/f262e684d80119c8aeeaeae087b83bf0e4961f18
11. 同上后续提交 10115e4：https://github.com/NousResearch/hermes-agent/commit/10115e44a4ef81633e87611262811a6106daa6b4
12. OpenCode issue #60440「Agent pointer overlay in the integrated browser」（已关闭）：https://github.com/anomalyco/opencode/issues/60440
13. pw_glow（Playwright 元素发光）：https://socket.dev/npm/package/pw_glow
14. playglow：https://www.npmjs.com/package/playglow
15. omnigent PR #3984（原生视图盖住 DOM 的根因修复）：https://github.com/omnigent-ai/omnigent/pull/3984

**平台与规范**

16. Electron WebContentsView：https://www.electronjs.org/docs/latest/api/web-contents-view
17. Electron View（setBackgroundColor / setBorderRadius）：https://www.electronjs.org/docs/latest/api/view
18. Electron 从 BrowserView 迁移到 WebContentsView（透明背景说明）：https://www.electronjs.org/blog/migrate-to-webcontentsview
19. Electron issue #42061（WebContentsView 无层级 API）：https://github.com/electron/electron/issues/42061
20. Electron issue #42335（透明 WebContentsView 合成缺陷）：https://github.com/electron/electron/issues/42335
21. MDN Content-Security-Policy: style-src：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src
22. WICG construct-stylesheets issue #98（adoptedStyleSheets 与 CSP）：https://github.com/WICG/construct-stylesheets/issues/98
23. GolemUI strict CSP 指南（CSSOM 写样式合规说明）：https://golemui.com/components/docs/guides/strict-csp/

**本仓库内相关文件（只读参考，本次未改动）**

24. packages/contracts/src/layout.ts（LAYOUT 常量与 computeBrowserViewBounds）
25. packages/contracts/src/schemas.ts 与 packages/contracts/gen/ipc.ts（IPC 契约与其生成物）
26. packages/shell/src/main/browserHost.ts（视图生命周期、几何、浮层时隐藏）
27. packages/shell/src/main/electronBrowser.ts（WebContentsView 创建、executeJavaScript 适配）
28. packages/shell/src/browserAdapter/refs.ts（SNAPSHOT_SCRIPT 与 performClick/performType 的单一产地）
29. packages/shell/src/main/domains/browserAdapter.ts（browser:* 工具分发）