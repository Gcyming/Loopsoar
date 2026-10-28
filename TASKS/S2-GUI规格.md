# S2 GUI 规格（阶段三·基础可视化界面）

> 前置：阶段二框架已验收（212 用例全绿、D0 通过、BrowserAdapter 冻结、Provider 闭环通）。
> 铁律（用户强制）：**绝不与 pilot project（slime）串扰**——本轮所有改动只在
> `D:\tool\AI\real-project\Loopsoar\Parent file` 内；品牌资产（图标/logo/配色）必须为 Loopsoar 原创，
> 不引用、不复制、不覆盖 slime 的任何文件；守卫测试强制检查。

## 0. 目标（最基础的 GUI，能看见、能对话、能导航）

1. 主窗口完整布局：顶部栏（品牌 + 地址/搜索一体框 + 操作按钮）｜左侧浏览器视图区｜右侧 Agent 面板｜底部状态条；
2. 真实 IPC 接线（经 preload 白名单）：`runtime.bootStatus` / `agents.list` / `settings.getProvider` / `chat.stream` / `chat.stop` / `browser.navigate` / `browser.snapshot`；
3. 事件流：`chat:stream:chunk|reasoning|tool|progress|done|error|heartbeat` 实时渲染到对话面板；
4. 浏览器视图区：真实 `WebContentsView` 挂载在布局区域（导航后显示真实网页），窗口缩放时同步 bounds；
5. 品牌：Loopsoar 原创 logo（SVG）+ 窗口图标（PNG），单一产地，仓库内自持；
6. 协议：`loopsoar://app/index.html` 服务真实构建产物（ui/dist），含路径穿越防护。

## 1. 布局契约（单一产地）

`packages/contracts/src/layout.ts`：
- `LAYOUT = { TOP_BAR_HEIGHT: 48, SIDEBAR_WIDTH: 320, STATUS_BAR_HEIGHT: 32 }`；
- `computeBrowserViewBounds(windowSize, layout)`：返回浏览器视图区的 `{x,y,width,height}`（原生视图定位）；
- UI 与 shell 都只从契约取数，禁止各自硬编码（守卫测试检查）。

## 2. 目录分工

| 文件 | 职责 |
|---|---|
| `packages/contracts/src/layout.ts` | 布局常量 + 浏览器区几何计算（纯函数，可测） |
| `packages/contracts/src/schemas.ts` | EVENTS 补充 reasoning/tool/progress（事件白名单） |
| `packages/shell/src/main/uiProtocol.ts`（新） | UI 产物路径解析 + `loopsoar://` 请求→文件映射（含穿越防护，纯函数可测） |
| `packages/shell/src/main/browserHost.ts`（新） | WebContentsView 宿主（依赖注入，不 import electron）：懒创建、navigate/snapshot/screenshot、resize 同步 |
| `packages/shell/src/main/domains/browserAdapter.ts` | 接真实 BrowserHost（替换 D0 占位） |
| `packages/shell/src/main/index.ts` | 唯一 electron import：注册 scheme 特权、协议、窗口、BrowserHost 装配、E2E 截图钩子 |
| `packages/shell/resources/icon.png` | Loopsoar 原创窗口图标（脚本生成） |
| `packages/ui/public/logo.svg` | Loopsoar 原创 logo |
| `packages/ui/src/App.tsx` | 完整布局 + 真实 IPC 交互 |
| `packages/ui/src/types.d.ts` | loopsoarAPI 声明补齐（settings 域 + 事件类型） |

## 3. 交互定义

- 顶部栏：品牌 logo + 名称｜omnibox（回车导航；无 scheme 补 `https://`，仅允许 http/https，拒绝 javascript:/file:/data:）｜按钮「导航」「快照」「停止」；
- 浏览器区：未导航时显示 Loopsoar 起始页（品牌标语 + 快捷键提示）；导航后原生 WebContentsView 覆盖该区域；
- Agent 面板：消息列表（user/assistant/tool/reasoning 分色）+ 输入框 + 发送/停止；流式 chunk 追加到当前 assistant 消息；done 时显示状态徽标；
- 状态条：boot 状态｜Agent 名｜Provider 状态（未配置/已配置可用）｜当前 URL。

## 4. 安全与隔离

- 渲染进程 `sandbox: true + contextIsolation: true + nodeIntegration: false`（已具备），只经 preload 白名单调用；
- 协议服务只读 ui/dist，越界路径返回 403（`..`/绝对路径/符号链接逃逸）；
- 导航仅允许 http/https（normalizeUrl 白名单校验，拒绝 javascript:/file:/data:）；
- 品牌资产：仅 `packages/ui/public` 与 `packages/shell/resources` 内自持文件；守卫禁止 shell/ui 源码出现 slime/pilot 资产路径。

## 5. 验收

1. `pnpm -r typecheck`、`pnpm test`（全绿）、`pnpm build`；
2. Electron 真跑（Electron 45 + `--no-sandbox`，受限会话标准参数）→ 截图证据落 `docs/screenshots/gui-1.png`；
3. 隔离守卫扩展通过（无旧项目资产引用）；
4. 交互冒烟：启动即显示布局与状态条数据；omnibox 导航 data/本地页 → 浏览器区出现真实内容（截图验证）。

---

## 6. GUI-2 增补（品牌主题 + 自定义标题栏）

> 触发：用户反馈「主题色不符合应用图标配色」「顶部 File 行与更上面一行改成自定义」。

### 6.1 品牌三色（单一来源：UI 内 `BRAND` 常量）

| 角色 | 色值 | 用途 |
|---|---|---|
| 深墨 `#111318` | 底板 | 窗口背景 / 标题栏 / 状态条 |
| 亚麻白 `#F4EFE6` | 主文本 | 正文、标题 |
| 赭石 `#C8763C` | 强调色 | 主按钮、选中态、副标题、滚动条 hover |
| 派生 | `#17191e` / `#15171c` / `#262a31` / `#a8a29a` | 抬升面 / 面板 / 边框 / 次级文本 |

### 6.2 自定义标题栏（36px，`LAYOUT.TITLE_BAR_HEIGHT`）

- 原生标题栏与菜单栏全部移除：`titleBarStyle: "hidden"` + `Menu.setApplicationMenu(null)`；
- 标题栏左侧：∞ 图标 + Loopsoar 字标（拖动区 `-webkit-app-region: drag`，双击最大化）；
- 右侧：最小化 / 最大化（还原）/ 关闭，经 `window:*` 受信通道驱动主进程（`window:minimize|maximize|close|state`）；
- 关闭按钮 hover 为 Windows 红 `#c42b1c`；所有按钮 `no-drag`；
- 布局联动：原生浏览器视图 y 偏移 = 标题栏 + 顶栏（`computeBrowserViewBounds` 已含 TITLE_BAR_HEIGHT），窗口缩放自动重算。

---

## 7. GUI-3 增补（图标系统 + 交互反馈/动画）

### 7.1 图标（来源：本地图标库 `D:\tool\AI\real-project\Loopsoar\icon`）

- 拷入 `packages/ui/public/icons/`（26 个：back/forward/reload/search/capture/star/star-filled/history/home/
  plus/minimize/close/stop/send/agent/bolt/bulb/spinner/check/warning/folder/file/terminal/puzzle/more/arrow-go）；
- 渲染方式：SVG 作为 CSS `mask`（`--icon` 变量）+ `background-color: currentColor` —— 颜色随主题/禁用态自动变化；
- 用途：标题栏窗口控制、浏览器工具栏、地址栏搜索/收藏、快照/更多、侧栏 Agent 图标、发送/停止、状态点、起始页提示。

### 7.2 交互反馈（借鉴 slime 已打磨实践，实测于其 `gui/src/renderer/index.css`）

| 模式 | 实现 |
|---|---|
| 按钮 hover | 上浮 `translateY(-1px)` + 软阴影（ochre 色调），120ms |
| 按钮按下 | `translateY(0) scale(.97)`；图标按钮 `scale(.88)`，80ms 回弹 |
| 键盘可达 | `:focus-visible` 2px 焦点环（不打扰鼠标用户） |
| 流式吐字 | 新增量单元「由右到左 + 由浅到深」：`left: 3px → 0` + `opacity 0 → 1`，260ms `cubic-bezier(.22,.61,.36,1)`（**位移用 left 不用 transform**——内联元素上 transform 会被静默忽略） |
| 流式光标 | ochre 方块 `blink` 闪烁（1s step-end） |
| 加载 | `spin` 1s 线性旋转（busy 时显示在输入区） |
| 状态点 | `pulseDot` 2.4s 呼吸 |
| 新消息 | 180ms 淡入 + 4px 上移（列表行级，不做浮层进场动画——避免"抽搐"） |
| 通知 | 底部 toast 180ms 淡入，点击关闭 |
| 减动效 | `prefers-reduced-motion` 下**去掉位移/缩放、保留不透明度渐入**（slime 教训：整块 `animation:none` 会让用户"什么都看不到"） |


