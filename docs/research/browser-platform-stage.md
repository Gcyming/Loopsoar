# 浏览器平台收尾研究记录（2026-11-13）

本轮为「浏览器基础平台」收尾，并为未来自研搜索引擎做接口/数据准备。以下为落地结论与依据。

## 1. 站点图标（favicon）

- Electron `webContents` 事件 `page-favicon-updated` 给出候选图标 URL 列表；取第一个即可。
- 渲染层 CSP 为 `default-src 'self'; img-src 'self' data:` → 外网 favicon URL 会被拦截，必须在主进程抓取并转 `data:image/*;base64`。
- 抓取走浏览器分区 `session.fetch`（复用代理/守卫语义），限制 96KB、6 小时缓存（失败也缓存空结果，避免页面反复触发）。
- 图标到达通常晚于导航：历史条目用 `updateFavicon` 迟到更新（不改排序/访问次数）；标签状态即时推送。
- 回退：没有图标时显示首字母 tile（历史/快捷入口）或 globe（空标签），与 Chrome/Edge 行为一致。

## 2. 开发者工具（F12）

- WebContentsView 的调试前端是 Chromium 自带 `devtools://devtools/bundled/devtools_app.html`；`webContents.openDevTools({ mode: "detach" })` 用独立窗口，避免 dock 模式与 WebContentsView 几何互相抢占。
- `before-input-event` 是网页内快捷键（F12 / Ctrl+Shift+I）唯一可靠入口；主窗口 DOM 的 keydown 只覆盖地址栏等 DOM 焦点。
- 关键坑：本仓库的 `browserRequestGuard` 会拦截非 http(s)/ws(s) 协议，导致 devtools 前端 `ERR_BLOCKED_BY_CLIENT`。已放行 `devtools:`、`chrome-extension:`、`chrome:`，并让异步 DNS 层跳过这些协议（否则会把 hostname=devtools 拿去解析）。
- 参考：Electron WebContents API（openDevTools / isDevToolsOpened / closeDevTools）。

## 3. 浏览器扩展（Chrome/Edge 系）

- 官方文档明确：Electron 只支持**未打包扩展**，`.crx` 不能直接 loadExtension，且只实现 Chrome 扩展 API 的一个子集（https://www.electronjs.org/docs/latest/api/extensions）。
- 支持的 Manifest Key 包括 name/version/permissions/content_scripts/background/host_permissions（MV3）/devtools_page 等；API 覆盖 chrome.devtools.*、extension、management、runtime、scripting、storage、system.storage、tabs（部分）、webRequest。
- 因此实现分两层：
  1. 本地未打包目录安装（与官方能力一致）；
  2. Chrome 应用商店链接/ID → 官方 update2 端点下载 CRX → 解析 CRX2/CRX3 头 → ZIP 解包（stored/deflate，拒绝 `..` 穿越）→ loadExtension，弥补「商店插件不能直接装」的缺口。
- 局限：打包扩展、商店自动更新、未实现的 Chrome API 仍不可用；设置页必须显式展示兼容性与失败原因，避免用户误以为全兼容。
- 扩展资源加载依赖 `chrome-extension://` 协议，与本轮 DevTools 一起被请求守卫放行。
- 参考：Electron Chrome Extension Support、session.extensions API（Electron 45 已迁到 `session.extensions.*`）。

## 4. 终端系统

- 现有持久终端已具备：六种 profile（cmd / PowerShell / Git Bash / Python / Node / C++ 工具链）、ANSI 渲染、回放缓冲、空闲回收、并发上限、环境变量白名单、危险命令拦截。
- 本轮补「可观测性」：`terminal:diagnose` 复用同一份 profile 探测，额外探测 git/node/npm/pnpm/python/rg/curl；设置「终端环境」页展示可用性/版本/安装提示，支持重新检测。
- Windows 特有的坑：`npm`/`pnpm` 实际是 `.cmd` 脚本，`execFile` 不解析 PATHEXT → 必须用 `.cmd` 候选 + `shell: true`（命令白名单硬编码，无注入面）；`python` 可能是 Store 别名，优先 `py -3`。
- 终端面板验证：打开面板 → 选「命令提示符」→ 新建终端 → 输出 `D:\试验场>`、状态「就绪」；API 侧 echo 回放 `LOOP_TERM_OK`。

## 5. 面向自研搜索引擎的准备（下一阶段）

- 现状：地址栏搜索走偏好 `searchEngine`（bing/google/baidu）→ 直接导航到对应搜索 URL；浏览器历史已持久化 title/favicon/visitCount/visitedAt。
- 下一阶段可先做「搜索引擎抽象层」：把「输入 → 查询串 → 结果页」从硬编码 URL 改为 provider 接口（search URL 模板 + 可选的本地索引/排序模块），复用既有 omnibox 契约与设置页搜索引擎选择。
- 数据面已具备：历史/书签/标签都可作为轻量信号；后续再引入本地索引与抓取管线（需单独的隐私与网络策略 ADR）。
