# 侧栏 / 会话窗衔接动效规范（v1）

> **依据**：只读参考 `D:\pilot project`（slime）的 `gui/src/renderer/index.css`（5154 行，注释保留 A-980/A-1146…A-1227 历史 bug）与 `gui/src/renderer/App.tsx.bak-comments`（4391 行，10-05 版本，注释未剥离）。Loopsoar 现状以当前工作区为准（2026-11-03 20:30，含未提交改动；`git diff --stat` 25 文件）。
> **范围**：右侧会话栏三态（docked / collapsed / 独立窗口）、原生 `WebContentsView` 让位、Agent 独立窗口进出、拖拽调宽。**只给规范与改法，不改代码、不搬参考实现源码**。
> **适用对象**：后续改 `packages/ui/src/App.tsx`、`AgentSidebar.tsx`、`packages/ui/index.html`、`packages/shell/src/main/browserHost.ts`、`agentWindow.ts` 的任何任务。

## 0. 一句话结论

侧栏动效只回答三个问题：**哪条边在动、谁和谁同拍、稳态在哪恢复**。Loopsoar 当前实现（m001—in-flight 修复后）已经把「wrapper 承载宽度过渡 + 内容右锚裁剪」做对，但仍有 6 个缝合点会重新制造「位置反逻辑」：**DOM 与原生视图曲线不同源、窗口化与侧栏收起不同拍、Agent 窗口 24px 微移冒充滑入、关闭事件早于滑出动画、splitter 恒扣 6px、启动/恢复阶段误播动画**。slime 的历史 bug 全部可归入 13 条不变式，本规范把它们变成可断言条款。

## 1. 不变式清单（I1–I14，违反任一条即视为回归）

| # | 规则 | 为什么（slime 历史 bug / 机制） | 出处（slime） |
|---|---|---|---|
| I1 | **右栏必须钉住窗口右缘**：宽度变化时右缘不动、左缘移动；容器用 `margin-left:auto` / `justify-content:flex-end` 无条件生效 | 只给 exit 类挂时，退浮层那一帧 float-layout 先摘、wrapper 未缩到位 ⇒ 右栏右侧露 135px 空白 408–450ms | `index.css:1773-1802`（`.right-sidebar{margin-left:auto}`）；A-1173 `1756-1772` |
| I2 | **wrapper 不得用 `auto` 宽度参与过渡**：过渡期宽度必须是可插值的 px（CSS 变量或内联值） | `auto` 不参与插值 ⇒ 旧值存在时整块硬跳；退场时不写 `--right-target-w` ⇒ `var()` IACVT ⇒ width 变初始值 `auto` ⇒ 400+ms 纹丝不动后整块跳 | A-1179 `index.css:1620-1628`；A-1157-R2 `1571-1588` |
| I3 | **过渡期目标宽用 px + `!important` 盖内联**；稳态才交回 `width:100%` | 内联 `width:712px` 吃掉 `--right-target-w`，wrapper 同帧 712→1092，右缘先空 380px，done 后 `100%!important` 从 wrapper 左缘向右拉 ⇒「从左向右合上」 | A-1157 `index.css:1685-1755` |
| I4 | **wrapper 与内容必须同 duration、同 curve**；JS/主进程动画也必须用同一条曲线 | 「左侧边栏动画慢于动作……右侧已经让开（秒让），左侧才跟上」：rw 内联宽随点击当帧 1332→1092，左栏 CSS 0.5s 慢慢长；trace 显示 t=514 rw=268 / rs=725，空白峰值 380px = 一帧黑屏 | A-1176 `index.css:1589-1619`；A-1179 `1710-1755` |
| I5 | **退场用独立 exit 类，不复用 anim 类** | `right-wrapper-anim` 声明 `width:var(--right-target-w)!important`；退场不写该变量 ⇒ IACVT + `!important` 仍压内联 ⇒ 冻结 411ms、整块右跳、右缘再左退空 92px | `index.css:1571-1588` |
| I6 | **内容常驻 DOM，宽度只裁切不重排**：内容固定 px 宽（预捕获），不能用 `%` 跟随动画容器 | 内容只有一段（620/62% 实测 fillRatio 0.568，左右各空 236px）；`content-visibility:auto` 逐帧重算可见区 + 丢弃已渲染部分，更卡 | A-1156 `index.css:1629-1670`；A-1152 `1850-1874`、`2110-2132` |
| I7 | **先预捕获，再写终态；不逐帧 setState**。逐帧只写元素 style 由 CSS/rAF 引擎驱动 | 旧「测量驱动 + 5 条魔数」收工时刻随帧率漂；纯时间驱动曲线才确定 | `App.tsx:816-881`；A-1162 |
| I8 | **过渡起点补做上轮清理；done 之后才恢复稳态**；清理不得与异步 state 提交交错 | 漏清 `--right-body-pin` ⇒ 永久残留 441px，内容右缘 1487 > vw 1332；done 里同步 remove 变量夹一帧 IACVT ⇒ 右栏一帧缩 661px 再弹回（layout-shift 0.3891） | A-1155、A-1175 `App.tsx.bak-comments:3636-3702` |
| I9 | **时长/曲线唯一产地在 CSS token，JS 读回**，不双写常量 | `GEOM_FADE_MS=280` 而 CSS 500ms ⇒ 后 220ms 全不透明还在缩；`FLOAT_TRANSITION_MS=400` vs 几何 280 ⇒ 最后 36px 硬切 | `collapseTiming.ts:1-38`（正则 `/^([\d.]+)\s*(ms|s)?$/`）；A-1186、A-1173 |
| I10 | **动画与拖拽互斥**：拖拽第一帧就 `transition:none`；pointer-events、命中区/裁剪边距同步 | 等 140ms 才禁 ⇒「手在前面，内容才跟上」；拖过对话区出现蓝色选区 =「一拖就闪」 | `index.css:1943-1979`、`1980-1991`；A-1153/A-1154/A-1177 |
| I11 | **淡入淡出与位移同拍**：fade 时长由同一套窗口反解，不与主过渡各调一个数 | 曾用 `opacity 0.12s linear` 对 500ms 侧栏 ⇒ 用户说「刻意错开」；正解 135ms out / 275ms in，475ms 完成与侧栏内容淡入同拍 | A-1190 `index.css:2040-2132` |
| I12 | **同窗 DOM 浮层禁止进场动画**（以终态瞬现，只让主栏过渡顺） | opacity 0→1 ⇒ 浮层与右栏卡片叠印；`scale(0.985)` ⇒ 唯一可见边界剧烈抖动、class 抖一下重播、给 fixed 后代造包含块 | A-1160 `index.css:1879-1909` |
| I13 | **逐帧不要让 OOPIF/内容重排**；用「当前状态」判动画是否生效，不靠「记得清理」 | 逐帧改 webview 宽 3 帧掉帧 / dtP95 21ms；pin 清理没跑到 ⇒ 首页正常、之后每个新标签页变深且内容左移 | A-1016-F3 `index.css:1818-1849`；A-1227 |
| I14 | **收起方向渐隐窗口要用 ease 反解出来的比例**，不能拿线性比例当宽度比例 | 直接套 [0.40,0.95] ⇒ 全透明时实际宽只剩 96px、已被 overflow 裁掉 =「看不到渐出」；反解 ease(u)=1−96/240≈0.6 ⇒ u≈0.268 ⇒ HI=0.27 | A-1174 `App.tsx.bak-comments` |

## 2. 数值 token（唯一产地在 CSS；改动必须同步两侧）

| 用途 | slime 取值 | slime 出处 | Loopsoar 现状 | Loopsoar 出处 |
|---|---|---|---|---|
| 侧栏宽度过渡 | 0.5s `cubic-bezier(0,0,0.2,1)` | `index.css:74-75,394,1796` | **320ms `cubic-bezier(0.2,0,0.2,1)`** | `theme.ts:53-67`、`index.html:44,48` |
| 右栏内容过渡 / 与几何对齐 | 0.28s `cubic-bezier(0.22,0.61,0.36,1)` | `index.css:1754` | 无（内容不参与过渡） | — |
| 折叠高度（卡片/树） | 0.45s 同曲线，宽度延迟 `--collapse-dur + 200ms` | `index.css:64-75,1319-1352,4675-4682` | 无折叠树；终端 240ms | `theme.ts` |
| 聊天让位凹陷 | 135ms out / 275ms in（完成 475ms） | `index.css:2040-2132` | 不存在（无满窗浮层） | — |
| 浮层几何 / 淡入 | 400ms；fade 窗口 0.40–0.95（开）/ 0–0.27（收） | `App.tsx:455,501-502,587,605,684-686` | 无 | — |
| 主进程原生让位 | 逐帧 16ms tick | `browserHost.ts:30,202-240` | **320ms + 16ms tick** | `browserHost.ts:28-30` |
| Agent 窗口 | 滑入 200ms / 滑出 160ms / 帧 16ms / 起点偏移 24px / 边距 8px | `agentWindow.ts:35-41` | 同左 | `agentWindow.ts:35-41` |
| 几何 inset | y=118（TITLE+TOP+TAB），splitter 6px | `layout.ts:56-74` | 同左 | `contracts/src/layout.ts:22,56-74` |
| Agent 窗口默认尺寸 | — | — | 420×720 | `agentWindow.ts:23-24` |

**建议**：保留 320ms 作为唯一侧栏时长（DOM 与原生已一致）；**曲线必须统一**（见 §4.1）。窗口化切换建议单列 200ms/160ms，但必须让 DOM、原生、Agent 窗口三者同曲线（见 §4.3）。

## 3. 可照搬的时序（伪代码）

### 3.1 三态切换（DOM + 原生）

```js
// 单一入口；React 只落结构一次，动画由 CSS transition + 主进程逐帧完成。
function transitionSidebar(next) {                 // "docked" | "collapsed" | "windowed"
  const gen = ++motionGen.current;                 // 可重入保护（迟到 done 不得清理新一轮）
  const wrap = wrapRef.current;
  const from = wrap.getBoundingClientRect().width; // 1) 预捕获（写任何样式之前）
  const to = next === "collapsed" ? 48 : next === "windowed" ? 0 : sidebarWidth;
  const padFrom = parseFloat(getComputedStyle(wrap).paddingLeft);
  const contentW = Math.max(280, sidebarWidth - 2 * padFrom); // 2) 内容固定宽（不随动画变）
  wrap.style.setProperty("--sb-content-w", `${contentW}px`);
  wrap.dataset.sbAnim = next;                      // 3) enter/exit 独立类，不复用
  setSidebarMode(next);                            //    仅一次 React 提交
  api.browser.setSidebarWidth({ width: to, animate: true }); // 4) 同帧发起，主进程同曲线
  // 5) done：transitionend + 时长兜底（时长从 CSS 读，不写死）
  onceWidthEnd(wrap, readCssDurationMs("--ls-dur-sidebar", 320), () => {
    if (gen !== motionGen.current) return;
    wrap.removeAttribute("data-sb-anim");
    wrap.style.removeProperty("--sb-content-w");
  });
}
```

**必须遵守**：① `to` 用 px，不能是 `auto`；② 状态类只在过渡期挂，done 摘；③ 若 `to` 与当前相等直接返回（避免无意义逐帧重排）；④ 动画中再次调用 = 从**当前插值位置**继续（主进程已有取消逻辑，见 `browserHost.ts:204-240` 与 `tests/shell/browserHost.spec.ts:367-397`）；⑤ 拖拽路径传 `animate:false` 且首帧 `transition:none`。

### 3.2 窗口化 open / close 时序（Agent 独立窗口与主窗口侧栏必须同一时钟）

```
open:
  t0  点击「小窗化」→ ui:openAgentWindow（主进程创建隐藏窗口）
  t1  ready-to-show → 主进程 push chrome:agentWindowShown（新增）
      同帧：Agent 窗口 x = 主窗口内容右缘（完全在窗外）→ 目标 x，200ms
            主窗口侧栏 419→0，200ms + 同曲线（DOM wrapper + 原生 setSidebarWidth animate:true duration:200）
  t2  结束：清类/变量；不补动画

close:
  t0  点击收回 → push chrome:agentWindowClosing（新增）
      同帧：Agent 窗口 目标 x → 主窗口内容右缘，160ms
            主窗口侧栏 0→419，160ms + 同曲线
  t1  窗口 destroy 后 push chrome:agentWindowClosed（只做状态清理，不再驱动动画）
```

**反例（现状）**：`ui:closeAgentWindow` 在 `manager.close()` 后**同步** push `chrome:agentWindowClosed`（`domains/agentWindow.ts:132-141`），侧栏在窗口还在滑出的 160ms 里已经恢复；`openAgentWindow` 返回后主窗口立刻收起侧栏，而窗口要等 `ready-to-show` 才 show（`agentWindow.ts:562-600`）——两段动作天然错拍。

## 4. 映射到 Loopsoar（现状诊断 → 改法）

### 4.1 已对齐（in-flight 修复）

- **wrapper 承载唯一宽度过渡 + 右锚 + 裁切**：`App.tsx:1081-1096`（`width: effectiveSidebarWidth`、`display:flex`、`justifyContent:flex-end`、`overflow:hidden`、`transition: width/padding 320ms MOTION.ease`）；拖拽/迷你窗关闭过渡（`:1092-1095`）。
- **卡片不再拥有 width 过渡**：`AgentSidebar.tsx:317-332`（root 恒 `width:100%`，transition 只含 opacity/border-radius/box-shadow）；`index.html:2760-2762` 同步去掉了 width，并删除 `[data-mode="collapsed"] width:48px!important`（`index.html:2763-2766`，注释写明原因）。
- **内容固定宽 + 右锚 + 不重排**：`AgentSidebar.tsx:338-348`（`marginLeft:"auto"`、固定 `width: contentWidth`、只过渡 opacity），`contentWidth = width`（`:155-157`）；由 `App.tsx:1099` 传 `Math.max(240, sidebarWidth-16)`。
- **原生同拍已接线**：`App.tsx:418-424` 传 `animate: !sidebarDraggingRef.current`；`types.d.ts:725`、`browserAdapter.ts:44-49`、`browserHost.ts:202-240` 全链路生效；host 侧已有 320ms 逐帧 + 中途取消 + 末帧对齐，测试 `tests/shell/browserHost.spec.ts:335-412`。

### 4.2 仍会复发的缝合点

| 编号 | 问题 | 证据 | 改法 |
|---|---|---|---|
| D1 | **DOM 与原生曲线不同源**：DOM `cubic-bezier(0.2,0,0.2,1)`，shell 的 `easeCubicBezier` 实现的是 `cubic-bezier(0,0,0.2,1)`（x=0.6u²+0.4u³），注释却写「与 UI CSS 一致」 | `theme.ts:53-67`、`index.html:44` vs `browserHost.ts:25,28` + `agentWindow.ts:66-84` | 统一到 `(0.2,0,0.2,1)`（改 shell 实现），或把 DOM 改回 `(0,0,0.2,1)`；并把时长/曲线放进 contracts 单一常量 + 守卫测试 |
| D2 | 320ms 同长但曲线不同：t=160ms 时进度约 0.815 vs 0.838，371px 位移差 ~8–9px；原生视图层级在 DOM 之上，会盖住/露出侧栏边缘 | 同上 | 同 D1；验收断言见 §5 |
| D3 | **窗口化与侧栏收起不同拍**：侧栏 320ms，Agent 窗口 200ms；且收起在 `openAgentWindow` 返回时就开始，窗口 ready-to-show 才出现 | `App.tsx:376-395`、`agentWindow.ts:562-600` | 新增 `chrome:agentWindowShown`，侧栏在 ready-to-show 后同帧以 200ms 收起；`setSidebarWidth` 增加 `duration` |
| D4 | **Agent 窗口滑入 = 24px 微移 + 淡入**，不是「从右缘外滑入」；起点 = 目标 + 24（`SLIDE_OFFSET`），大部分仍叠在主窗口上 | `agentWindow.ts:565`（`startX = targetBounds.x + 24`）、`:34,41`（注释与常量） | 起点改 `x = contentBounds.x + contentBounds.width`（窗外，行程=宽+8，420+8=428px）；或按 slime A-1160 取消半吊子进场动画、终态瞬现 |
| D5 | **关闭方向/距离**：终点 `workArea` 右缘而非主窗口右缘；主窗口不在屏幕右侧时行程远大于必要 | `agentWindow.ts:654-676`（`endX = workArea.x + workArea.width`）、测试 `agentWindow.spec.ts:424` | 终点改 `contentBounds.x + contentBounds.width`，语义=「收进主窗口右缘」 |
| D6 | **关闭事件早于动画**：`close()` 后同步 push closed，侧栏立即恢复，窗口仍在滑出 | `domains/agentWindow.ts:132-141` | 改两段事件（closing → closed）；UI 收到 closing 开始 160ms 展开侧栏，closed 只清状态 |
| D7 | **splitter 6px 恒扣**：splitter 在 collapsed/窗口化时不渲染（`App.tsx:1075-1077`），而原生宽度恒减 `SPLITTER_WIDTH`（`layout.ts:63`）⇒ 窗口化时网页右侧留 6px DOM 条（StartPage 露底），收起时靠 6px 缝与原生对齐 | 同左 | 方案 A：splitter 恒挂（非 docked 禁用交互）；方案 B：`computeBrowserViewBounds` 增加 `splitterWidth` 选项，UI 按是否渲染传 0/6 |
| D8 | **启动/恢复阶段误播动画**：挂载 effect 先按默认 360 调一次，偏好加载后再调（`useChatStreamEvents.ts:121`）⇒ 启动瞬间 native 与 wrapper 各动画一次 | `App.tsx:411-424`、`types.d.ts:725` | 加 `motionReady`（首帧/偏好水合完成前 `animate:false` 且 wrapper 无过渡） |
| D9 | padding 8→0 与宽度同曲线过渡带来卡片右缘 8px 漂移 | `App.tsx:1091-1095` | 可接受（贴边收拢）；若要严格右缘不动，把 8px 留白移到卡片 margin，用 transform/裁剪而非改 padding |
| D10 | 死 CSS/死约定：`.agent-sidebar-fade` 无人使用（组件用内联 opacity）；`[data-mode="float"]` fixed 小窗不可达（float 已被映射成 docked） | `index.html:2751,2767-2781,2792-2810`；`App.tsx:122-123`、`AgentSidebar.tsx:107` | 接上或删除；`isFloat`/`styles.sidebarFloat`/`floatCard` 同理由 |
| D11 | 已有测试把旧语义写死（24px 滑入、workArea 右缘收起），改行为时必须同步更新 | `agentWindow.spec.ts:319,424` | 与实现同批改，断言见 §5 |

## 5. 验证与回归清单

**每帧应测量**（参考 slime `float-trace.ts` 的字段设计，只借方法）：`wrap.getBoundingClientRect()`（left/width）、`card/inner rect`、`body`/`data-mode`、原生 `debugBounds()`（`browserHost.ts:271`：window/bounds/actual/sidebarWidth/bottomInset）、Agent 窗口 `getBounds()`（E2E 已有打印，`index.ts:429/451/464`）。

**可写成测试的断言**（逐帧跑，失败即回归）：

1. 右缘固定：`|wrap.right − innerWidth| ≤ 0.5`；卡片右缘只允许 padding 过渡带来的 ≤8px 收敛。
2. 方向单调：展开 `wrap.width` 单调不减、`wrap.left` 单调不增；收起反之；**reversals=0**（宽度/left 的差分符号反转数，slime float-trace 的核心指标）。
3. 同拍：每帧 `|native.sidebarWidth − (innerWidth − 6 − wrap.width)| ≤ 1px`；起止帧偏差 ≤ 1 帧（16ms）。
4. 无覆盖/无空白：`0 ≤ nativeRight − wrap.left ≤ 6 + 2`（原生视图不得盖住侧栏、也不得留 >6px 空白）。
5. 恒等式：`native.bounds.width + wrap.width + splitter(0|6) == 窗口内宽`（±1）。
6. 首末帧：首帧 native 仍为 from、末帧精确 to；wrapper 状态类/`--sb-content-w` 清空、opacity 复位（展开 remove、收起 `"0"`，slime I8/A-1175）。
7. 打断：150ms 处反向点击 → 从当前插值继续、不回跳（`browserHost.spec.ts:367-397` 已覆盖宿主侧）。
8. 降级：`animations=off` / `prefers-reduced-motion` ⇒ 一帧到位且 `animate:false`（CSS 侧见 `index.html:2843-2849`）。
9. 启动：偏好水合前后只允许一次瞬时布局，无 320ms 动画（D8）。
10. Agent 窗口：open x 单调左移、末帧 = `computeAgentWindowBounds`；close x 单调右移、末帧 = `contentBounds.x + width`；侧栏恢复起点 = close 起点（±1 帧）；任一帧不得出现「侧栏已可见且被滑出窗口压住」。
11. 拖拽：mousemove 后下一帧 `wrap.width` 与指针位移差 ≤1px；拖拽首帧 `transition:none`、user-select none。

**探针建议**：`LOOPSOAR_E2E_SIDEBAR_TRACE=1` 时用 rAF 采样 JSON（`{t, wrap:{l,w}, inner:{l,w}, mode, native:{w}, agentWindow:{x,opacity}}`），复用现有 E2E 钩子（`index.ts:230-260` 的 `debugEval`/`debugBounds`、`:429/451/464` 的截图与 bounds 打印）。**守卫**：静态检查所有 `browser.setSidebarWidth(` 调用点必须显式带 `animate`；`contracts` 常量与 `theme.ts` 时长一致。

## 6. Loopsoar 需要改动的位置表

| 文件:行 | 现状 | 应改法 |
|---|---|---|
| `App.tsx:1081-1096` | wrapper 已承载过渡/右锚/裁切（in-flight 修复） | 保持；补 D8 的 `motionReady` 门控、D7 的 splitter 处理 |
| `App.tsx:1075-1077` | splitter 仅 docked 渲染 | 恒挂（非 docked 禁用交互）或按渲染状态修正 native 宽度 |
| `App.tsx:376-395` | 窗口化只调 open/close，无动画时序 | 等 `chrome:agentWindowShown` 再收起侧栏；close 时等 closing 再展开 |
| `App.tsx:418-424` | effect 传 `animate: !sidebarDraggingRef`，启动/水合也动画 | 增加 `animate: hydrated && !dragging`；窗口化切换传 `duration:200/160` |
| `App.tsx:332-375` | 拖拽：状态 + 松手同步原生；已用 `sidebarDraggingRef` | 已符合 I10；补 mousemove 期间原生 `animate:false`（视图隐藏，可选） |
| `AgentSidebar.tsx:317-332` | 无 width 过渡（正确） | 保持；`isFloat`/floatCard 死代码随 D10 清理 |
| `AgentSidebar.tsx:338-348` | inner 固定宽 + marginLeft:auto（正确） | 保持；`contentWidth` 的来源改为预捕获的 `--sb-content-w`，避免窗口缩放时变化 |
| `index.html:2760-2766` | `.agent-sidebar` 过渡已去掉 width（正确） | 保持；`index.html:2751/2767-2781` 的 `.agent-sidebar-fade`、`2792-2810` 的 float fixed 规则删除或接上 |
| `browserHost.ts:25-33` | `easeCubicBezier` 导入自 agentWindow，实为 `(0,0,0.2,1)` | 与 DOM 统一曲线；`SIDEBAR_ANIMATION_MS` 从 contracts/单一常量导出并加守卫 |
| `browserHost.ts:202-240` | 320ms 逐帧、可取消、末帧对齐（正确） | 增 `duration` 参数（窗口化 200/160 用） |
| `agentWindow.ts:35-41,562-600` | 滑入 = 目标 +24px + 淡入 | 起点改主窗口内容右缘（行程=宽+8），与侧栏同 200ms 同曲线 |
| `agentWindow.ts:654-676` | 收起终点 workArea 右缘 | 终点改主窗口内容右缘；与侧栏展开同一时钟 |
| `domains/agentWindow.ts:132-141` | close 后同步 push closed | 改 `closing` / `closed` 两段 |
| `contracts/src/schemas.ts:253-260` | `animate?: boolean`（已加） | 增 `duration?: number`（100–800） |
| `contracts/src/layout.ts:56-74` | 恒扣 `SPLITTER_WIDTH` | 增 `splitterWidth` 选项（默认 6），UI 按渲染状态传值 |
| `packages/ui/src/types.d.ts:725` | `{ width; animate? }` | 加 `duration?: number` |
| `packages/shell/src/main/index.ts:1157-1162` | 注释称「坐标随主窗口移动/缩放实时更新」，实际无 move/resize 重定位（仅 :707 给 browserHost） | 增加 reposition（move/resize 且动画中不打断）或改注释 |
| `tests/shell/agentWindow.spec.ts:319,424` | 断言 24px 滑入 / workArea 右缘 | 随实现同批更新 |

## 7. 待验证 / 已知限制

- 真机观感：曲线差 ~8–9px 的覆盖条是否肉眼可见（深色主题下原生网页极少纯色，建议录一次 320ms 逐帧或抓 `capturePage` 对比）。
- D9 的 8px 右缘漂移是否被感知（贴边收拢通常可接受）。
- Agent 窗口跨显示器、主窗口拖动后的贴边行为：当前无 follow，属未实现而非回归。
- 收起态 48px 竖条 + 内容 opacity 0 的淡出与宽度过渡是否「末帧闪内容」（I8：收起 done 时宽度可能还差几 px，opacity 应保持 0 而非复位）。
