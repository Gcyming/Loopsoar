# D0 存量评估：browser 工具三档清单

> 依据：前期准备《slime-能力全景与实现方式》记载 slime 有 13 个 browser 工具（基于 `<webview>`），
> 但**具体工具名与实现细节以 slime 源码为准**（本仓未迁移源码，本清单按能力面评估）。
> 结论先行：**13 个能力面全部可在 WebContentsView 路线上实现**；其中导航/快照/点击/输入/滚动/截图/等待/JS 注入
> 已由 `packages/shell/dev/d0-probe/main.cjs` 实测通过；多标签/下载/历史/弹窗/缓存分区属接线工作，不构成架构风险。

## 复用（语义不变，仅换底层调用）

| 能力 | 复用方式 |
|---|---|
| 导航（navigate） | `webContents.loadURL` + dom-ready 等待（probe 已验证） |
| 快照（snapshot） | 注入 `data-loops-el` 编号 + `executeJavaScript` 抓元素列表（probe 已验证） |
| 点击（click） | 编号→CSS 选择器→`el.click()`（probe 已验证） |
| 输入（type） | 原生 setter + input/change 事件（React 受控组件兼容，probe 已验证） |
| 滚动（scroll） | `window.scrollBy/scrollTo`（probe 已验证） |
| 截图（screenshot） | `webContents.capturePage()` → base64 PNG（probe 已产出 shot.png） |
| 等待（wait） | `setTimeout`（trivial） |
| JS 注入（execute_js） | `webContents.executeJavaScript`（probe 已验证） |

## 改造（实现替换，工具参数与返回语义保持）

| 能力 | 改造点 |
|---|---|
| 多标签/多视图 | 每个标签一个 `WebContentsView`，由外壳管理布局与生命周期（`BaseWindow.contentView.addChildView`） |
| 页面历史 | 用 `webContents.navigationHistory`（Electron 新 API）替代 webview 内含历史 |
| 下载 | `session.on("will-download")` + 下载管理器（落盘路径受权限层约束） |
| 弹窗/target=_blank | `webContents.setWindowOpenHandler` 决定「同视图打开 / 新视图 / 拒绝」 |
| 缓存与登录态 | `session.fromPartition("persist:loopsoar-browser")`（品牌单一产地已在 brand.ts） |

## 重写（受官方弃用影响的旧语义）

| 能力 | 原因 |
|---|---|
| 广告拦截 | slime 走 webview 注入；改为 `session.webRequest.onBeforeRequest` 拦截（语义等价，实现重写） |
| 元素级「无障碍树」快照 | webview 下可读 accessibility tree；WebContentsView 下统一用「注入编号 + DOM 提取」（本仓已按此实现） |
| 页面内 find/高亮 | 依赖 webview 的 findInPage 包装；改为 `webContents.findInPage` + CSS 高亮注入 |

## 待用户手动验证（probe 无法覆盖）

1. 真实第三方站点（含登录页）的导航与登录态保持；
2. 弹窗（`window.open`/`target=_blank`）在目标站点上的行为；
3. 下载触发与进度回调；
4. 多标签并发下的内存/CPU 表现。
