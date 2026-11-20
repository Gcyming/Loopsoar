# `vercel-labs/agent-desktop` 解析与本地化取舍

> 参考：<https://github.com/vercel-labs/agent-desktop>（Apache-2.0，Computer use CLI / C library，Rust）。
> 注意：本文只借鉴架构语义与交互模式，**没有逐行复制其源码**；若后续拷贝代码，必须保留 Apache-2.0 许可与 NOTICE。

## 1. 它是什么

- 面向 AI Agent 的**桌面操作 CLI**，不是浏览器 DOM Agent：通过 macOS Accessibility / Windows UIA / Linux AT-SPI 观察原生窗口，再按 ref 或坐标操作。
- 61 个命令，覆盖 snapshot、click、type、key、scroll、drag、window、clipboard、sandbox、notification、screenshot 等；同时提供 C ABI、MCP server 与版本化技能。
- 默认 headless，`--headed` 才显示光标/覆盖层；这和我们“Agent 标签页 + 覆盖层光标”的产品方向一致，但它的观察面是桌面，不是网页。

## 2. 核心模块（从仓库结构读出）

| 模块 | 作用 | 对 Loopsoar 的启发 |
| --- | --- | --- |
| `crates/core/src/snapshot` | 可持久化快照、`complete`/`truncated`、`--skeleton`、`--root` 下钻 | 快照必须说明完整性；密集页面先看地图再下钻 |
| `crates/core/src/refs` | 快照作用域 ref、重新识别、`STALE_REF`/`AMBIGUOUS_TARGET` | ref 不能静默落到相似元素 |
| `crates/core/src/actionability` | 可见/可点/可编辑判定 | 点击前先证明目标可行动 |
| `crates/core/src/wait` | 按 selector 等状态，动作后观察 | 动作后验证，不把“已派发”当“已生效” |
| `crates/core/src/response` | JSON envelope、错误码、`delivery`/`retry` disposition | 失败语义要机器可读 |
| `crates/core/src/cursor_overlay` | 光标/高亮可视化 | 已有覆盖层光标，可继续增强解释性 |
| `crates/core/src/trace` / `session` | 动作追踪与会话隔离 | 浏览器侧缺 trace/replay |
| `skills/` | 二进制自带版本化技能 | 技能应与版本同源，而不是外部漂移 |

## 3. 已抽出并本地化的 4 个点

### 3.1 坐标点击（对应其 `mouse-click --xy`）

**借鉴点：** ref 点击和坐标点击并存；坐标点击明确“只证明派发坐标，不证明哪个元素收到”。

**Loopsoar 实现：**

- `packages/shell/src/main/browserPoint.ts`
  - `buildPointProbeScript()`：`elementFromPoint` 读取命中元素、尺寸、文案、可点击语义；
  - `buildPointClickScript()`：真实输入不可用时的降级 DOM click；
  - `performPointProbe()` / `performPointClick()`：脚本异常转可行动错误，不抛断整轮。
- `packages/shell/src/main/browserTools.ts` 的 `browser_click`：
  - schema 支持 `target` 或 `x/y`，二者互斥；
  - `space="image"` 按 `devicePixelRatio` 换算截图设备像素；
  - 坐标点击同样走敏感文案二次确认；
  - 光标移动后复测同坐标；元素换人返回 `TARGET_MOVED`，不盲点；
  - 真实输入失败才降级，并在结果里明说“已降级为脚本点击”。

**本地化增强（相对参考仓库）：**

- 坐标点击会先探测，不容许对页面空白静默成功；
- 坐标点击复用 Loopsoar 的敏感步骤确认与权限层；
- 截图结果同时给出 CSS 视口 / DPR / 图像尺寸，降低视觉模型点偏概率。

### 3.2 快照完整性（对应其 `complete` / partial snapshot）

**借鉴点：** 快照被预算截断时返回“部分树 + complete=false”，而不是一个空错误；调用方必须读完整性字段。

**Loopsoar 实现：**

- `browser_snapshot` 头增加 `complete=true|false`；
- 元素列表被截断时明确“本视图还有 N 个未显示”；
- 新增 `view="skeleton"`：只显示地标/标题/按钮，先看地图，再切 `full`；
- 保留原有 `#eN` 编号，不改变动作协议。

**未照搬：** `--root` 子树下钻需要适配器提供父子树；当前 `BrowserSnapshot.elements` 是扁平列表，先不假装支持。

### 3.3 动作投递语义（对应其 `delivery` / `retry` disposition）

**借鉴点：** “已点击”不等于“已生效”；有副作用的动作失败后不能盲目重试。

**Loopsoar 实现：**

- `browser_click` 成功结果追加 `投递=delivered_unverified（retry=unsafe）`；
- 降级脚本点击单独标注；
- 失败保留 `STALE_REF` / `TARGET_MOVED` / `NO_TARGET` / `CLICK_FAILED` 等错误码，模型可按码决策。

**未照搬：** 没有引入完整 `delivered_verified` 状态，因为浏览器端没有可靠的“应用层持久化”读回；只承诺“未验证”，不伪造已验证。

### 3.4 快照作用域 ref（已迁移）

**借鉴点：** ref 属于某次快照；过期/多候选必须显式失败。

**Loopsoar 实现：** `RefRegistry` 改为**标签内单调分配** ref：第一次快照 e1..eN，重快照从 e{N+1} 起；旧 `#e5` 不再存在于注册表，动作返回 `STALE_REF`，不会静默落到新元素。导航 `clear()` 只清条目、不重置计数器，因此跨导航也不会复用。

**未照搬：** 没有引入参考仓库的 `AMBIGUOUS_TARGET` 重新识别（Loopsoar 的 ref 存的是稳定 selector，不是原生句柄），也没有做 `#<gen>:eN` 的显式代数前缀；单调分配已经解决本轮最危险的旧 ref 复用问题。

## 4. 明确不借鉴的

- Rust / C ABI / 原生平台适配层：Loopsoar 已有 Electron + CDP 双后端，重写没有收益。
- 61 个桌面命令与 sandbox provider：不是浏览器 Agent 的核心；引入会扩大攻击面。
- 默认 headless 的桌面光标策略：Loopsoar 的产品价值之一就是用户能看见 Agent 在做什么；保留 headed 覆盖层。
- 其 macOS 特有的 AX 地址/身份模型：Windows/Linux 语义不同，不能直接移植。

## 5. 结论

它最值得拿的不是代码，而是**“观察完整性 + ref 身份 + 投递语义 + 坐标兜底”**这四件事。Loopsoar 本轮已经把前三件中的可落地部分和坐标兜底做进浏览器工具；ref 代数是下一个高价值切片，但不适合和本轮混在一起改。
