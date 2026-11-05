# 本轮改造 E2E 冒烟清单（2026-11-02 P0 + Agent 核心 + 浏览器功能面）

> 为什么需要：本轮改动（安全门、终端、Agent 核心、浏览器功能面）自动化测试 867+ 条全绿，
> 但以下能力依赖真实 Electron/系统进程，只能在真机点一遍。每条给出「怎么点 + 预期 + 失败时看哪里」。

## 0. 启动

```bash
cd "D:/tool/AI/real-project/Loopsoar/Parent file"
pnpm gen && pnpm check && pnpm -r typecheck && npx vitest run && pnpm build
# 干净数据目录 + 自动截图（会短暂弹出窗口后自动退出）
LOOPSOAR_DATA_DIR="$PWD/.loopsoar-data-smoke" \
LOOPSOAR_E2E_SHOT="$PWD/.loopsoar-data-smoke/shot.png" \
LOOPSOAR_E2E_HOLD_MS=1500 \
node scripts/dev-gui.mjs
# 交互验证（窗口保持）
LOOPSOAR_DATA_DIR="$PWD/.loopsoar-data-smoke" node scripts/dev-gui.mjs
```
- 构建产物：`packages/ui/dist` + `packages/shell/dist/main.bundle.mjs`（`dev-gui.mjs` 自动构建）。
- 失败先看主进程日志：`PRELOAD_NOT_FOUND` / `DID_FAIL_LOAD` / `GUI_SHOT_FAILED` / `启动失败`。
- 数据目录：`%APPDATA%\loopsoar` 或 `LOOPSOAR_DATA_DIR`。审计在 `<dataDir>/logs/audit-*.jsonl`。

## 1. 持久多环境终端（P0 新增）

| 步骤 | 预期 |
|---|---|
| 状态栏点「终端」 | 右侧面板底部出现终端抽屉；顶部 6 个配置档 chip（cmd/PowerShell/Git Bash/Python/Node/C++） |
| 不可用档（如 C++ 未装编译器） | chip 禁用，hover 显示 detail/安装提示 |
| 选 cmd 新建 → 输入 `cd /d %USERPROFILE%` → 回车 → 再 `cd` | 两次命令在同一会话、cwd 保持（持久会话） |
| 输入 `echo 你好` | 中文不乱码（cmd 已 chcp 65001） |
| Python 档新建 → 输入 `1+1` | 输出 `2`（REPL 持久状态）；再输入 `x=5` → `x*2` 输出 10 |
| Git Bash 档新建 → `pwd` → `cd /c` → `pwd` | cwd 在会话内保持 |
| Node 档新建 → `1+1` | 输出 2（REPL） |
| 输入危险命令 `rm -rf /` 或 `dd if=/dev/zero of=/dev/sda` | 被拦截：面板显示「[危险命令已拦截]」，不执行 |
| 点「中断」 | 终端进入 exited（灰点、输入禁用）；关闭后重开正常 |
| 关闭面板再打开 | 终端标签与历史回放仍在（512KB 环形缓冲） |
| 关闭应用再启动 | 终端会话不恢复（预期：进程不跨重启），运行痕迹无残留进程（任务管理器无 cmd/python 孤儿） |

失败排查：`packages/shell/src/main/terminalProfiles.ts`（探测）、`terminalSession.ts`（spawn/编码）、
主进程日志中 `terminal` 相关报错；Windows 下 PowerShell 中文乱码属已知问题（见 PROGRESS 二·二十八）。

## 2. 安全门（P0）

| 步骤 | 预期 |
|---|---|
| Agent 调 `terminal_run {command:"rm -rf /"}`（mock 或真实模型） | 工具返回 `[错误] 危险命令已拦截：…`，不执行 |
| Agent 调 `web_fetch {url:"http://127.0.0.1:61338"}` | `[错误] SSRF 拦截：…`（回环默认拦截 web 工具） |
| Agent 调 `web_fetch {url:"http://169.254.169.254/latest/meta-data"}` | SSRF 拦截（云元数据） |
| 设置·供应商「测试连接」填 `http://10.0.0.1/v1` | 返回 SSRF 拦截错误，不发起连接 |
| 地址栏输入 `http://127.0.0.1:19443`（本地页面） | 可正常浏览（浏览器守卫默认放行回环；`LOOPSOAR_STRICT_NET=1` 时拦截） |
| 文件 IPC（当前 UI 未用）：可用 devtools 调 `loopsoarAPI.workspace.read({path:"C:/Windows/win.ini"})` | 返回 `[错误] 路径越界`（仅会话工作根内可读） |
| 退出应用 | `logs/audit-YYYYMMDD.jsonl` 有本次会话条目；MCP/扩展子进程被清理（任务管理器核对） |

## 3. Agent 核心（P2 新增）

| 步骤 | 预期 |
|---|---|
| 设置·通用「Agent Loop」 | 显示「内置最小 Loop（内置）」；切换无其他 loop 时提示；回退原因行（若有）可见 |
| 手动把 preferences.json 的 loopId 改成不存在值后启动 | 自动回落内置 loop，不崩 |
| 模型返回「已保存文件」但没调用工具（可用 mock：MOCK_TOOL_NAME 不触发） | 每轮核验触发强制工具轮：界面 progress 出现「声称核验未通过」，模型被要求先用工具核实（最多 2 次） |
| 供应商 A 配置错误、B 正确（active=A） | 自动降级到 B 完成对话（日志/回复可用） |
| 设置·记忆里已有记忆；问「你还记得之前的偏好吗」 | 命中门控，volatile 注入相关记忆（回复引用历史） |
| 问「你好」 | 无信号不注入记忆（预期：减少噪声） |
| 状态栏/设置外无 UI 入口 | `ask_user` 由模型触发时弹出模态：选项/自由文本/取消；取消后模型收到「用户取消，不要编造答案」 |

## 4. 浏览器功能面（P3 新增）

| 步骤 | 预期 |
|---|---|
| 顶栏 ⟳ | 调 `browser:reload`（历史栈保持，不返回上一页） |
| 打开任意网页点 ☆ | 变实心赭石；再点取消；重启后书签仍在（`bookmarks.json`） |
| 点星标旁「⋯」 | 书签浮层列出，点击导航、悬停删除 |
| 顶栏「保存页面」 | toast 显示保存路径（`<downloadDir>/saved-pages/<title>-<ts>.html`），文件存在、含页面正文 |
| 顶栏截屏图标（快照） | SnapshotPanel 展示标题/URL/正文/可交互元素；复制正文/链接可用；Esc 关闭；打开设置时快照自动收起 |
| 有广告的页面（如新闻站） | 主进程日志出现 `[browser-guard] [adblock]`；页面广告请求被取消（Network 面板对比开关前后） |
| 设置·通用关广告拦截 | 后续请求不再按广告规则拦截（即时生效，无需重启） |
| Agent 调 `browser_screenshot` | 返回 `已截图（尺寸：WxH）…路径`，文件在会话工作根 `.loopsoar/screenshots/` |
| Agent 调 `browser_wait {selector:"h1"}` | `[就绪]`；给不存在选择器 → `[超时]` |

## 5. 记忆升级（P4，若本轮合入）

| 步骤 | 预期 |
|---|---|
| 设置·记忆 新增 3 条 → 重载设置 | 列表与统计正确 |
| Agent 调 `memory_search {query:"…"}` | 返回命中条目（含 id/分类/相关度）；`memory_add/update/delete` 可链式操作 |
| 写入第 5 闸：两个不同 agentId 写入相似内容 | 建立 crossAgent 指针而非错误合并（查看 memory.json 的 agentId/crossAgentLinks 字段） |
| 基准脚本 | `node scripts/memory-bench.mjs` 输出 P50/P95/内存三项，与 `docs/research/memory-bench-ADR-0007.md` 数字一致 |

## 6. 体验（P6）

| 步骤 | 预期 |
|---|---|
| 首次启动（干净数据目录） | 3 步向导出现；可跳过；完成后不再出现；设置·关于可重开 |
| 设置·语言切到 en-US | 已接入 i18n 的组件（Composer/终端/ask/标题栏）文案切换；未接入部分保持中文（增量） |
| Composer 粘贴图片（截图后 Ctrl+V） | 消息出现图片缩略图（附件路径），发送后模型可见附件 |
| 输入 @ | 打开文件选择器，选择后插入 `【附件】<path>` |
| 输入 `/` | 命令面板：/new /clear /stop /settings /compact /help；执行对应动作 |
| 助手消息头部 | 上下文环按已用/上限显示（不再缺失） |

## 8. 本轮已真机验证（2026-11-02 自动 E2E，证据在 docs/screenshots/）

| 项 | 结果 | 证据 |
|---|---|---|
| Electron 启动 / 新标签页 / 设置页（语言、广告拦截开关、Agent Loop 选择器） | ✅ | `e2e-round3-main.png`、`e2e-round3-settings.png` |
| 应用内终端面板打开 + **cmd 持久会话真实启动**（提示符 `D:\...\Parent file>`、工作根/中断/清屏/关闭按钮） | ✅ | `e2e-round3-terminal-session.png` |
| 广告拦截真实触发（页面请求 doubleclick.net / googlesyndication.com 被 `[browser-guard] [adblock]` 取消；本地回环页面正常放行） | ✅ | 主进程日志 + `e2e-round3-adblock*.png` |
| 书签：星标收藏 → `bookmarks.json` 持久化 → 书签浮层展示 | ✅ | `e2e-round3-bookmarks.png` |
| 页面保存（真实落盘 `saved-pages/*.html`） | ✅ | `e2e-round3-snapshot-save.png` + 落盘文件 |
| 快照面板（标题/URL/正文/可交互元素/复制） | ✅ | `e2e-round3-snapshot-save.png` |
| ask_user：mock 模型发起提问 → 弹窗选项 → 点击「生产」→ Agent 继续并收束 | ✅ | `e2e-round3-ask-user.png` |
| Gateway：设置页启动 → `/healthz`+`/v1/models`；配 mock 供应商后非流式回复 + 标准 OpenAI SSE | ✅ | `e2e-round3-gateway*.png` + curl 输出 |
| 插件：demo-plugin 子进程 ready、工具 `greet` 接入并在设置面板展示 | ✅ | `e2e-round3-plugins.png` + 主进程日志 |
| Python / Node / Git Bash / C++ 终端会话 | ✅ 6 档全部 spawn；C++ 走 vcvars（另用 MSVC 编译运行 hello world 验证） | `e2e-round3-terminals-all.png` |
| 全站 i18n：语言切到 en-US | ✅ 设置/Composer/状态栏/浏览器全部英文 | `e2e-round3-i18n-en.png` |
| 用户数据目录隔离的 Loop L2 声明式 loop 列表 | ✅ `review-only` 出现在设置列表（kind 徽标） | 设置·通用截图 |
| 记忆语义检索（llama-server 可用时） | ⏳ 环境无嵌入服务（按用户决定不引入本地模型） | platform.embed 适配已就绪 |

> E2E 辅助环境变量新增：`LOOPSOAR_E2E_CLICK_GAP_MS`（多步点击间隔，默认 500ms；终端配置档探测等异步内容建议 2500）。

## 9. 2026-11-03 整理轮真机验证

| 项 | 结果 | 证据 |
|---|---|---|
| 顶部网址栏新布局（左：后退/前进/刷新；地址栏内收藏星标；右：快照+更多） | ✅ 历史记录图标已移除，其余按钮进「更多」 | `e2e-round4-more-menu.png` |
| 「更多」菜单（历史记录/下载/收藏夹/保存页面/设置）且**浮于网页之上不被遮挡** | ✅ 原生 WebContentsView 在浮层打开时隐藏 | `e2e-round4-more-menu.png` |
| 全局历史记录（跨会话；标题显示） | ✅ 面板可见 3 条（当前页/示例站点 A/B），与当前会话无关 | `e2e-round4-global-history.png` |
| 插件与扩展合并后：设置仅「扩展」一个分区 | ✅（分区 12 个，无「插件」） | 设置截图 |
| Gateway 已彻底删除 | ✅ 包/通道/分区/菜单均不存在；守卫断言防复活 | `tests/guards/project-isolation.spec.ts` |

## 10. 2026-11-03 用户反馈整理轮真机验证

| 项 | 结果 | 证据 |
|---|---|---|
| 点「更多」时**网页不再消失**、浮层浮在网页之上 | ✅ 浮层为独立子窗口（`E2E_POPOVER_WINDOWS 1`，网页视图截图仍正常渲染） | `e2e-round5-popover-main-popover.png` + `e2e-round5-popover-main-browser-view.png` + E2E 日志 |
| 浮层不被窗口边缘截断（翻转/夹取） | ✅ 主进程 computePopoverBounds；桌面截图菜单完整可见 | 同上 |
| 悬停「更多」/收藏星标 250ms 自动弹出预览 | ✅ E2E hover（windows 2）→ 浮层打开 | `e2e-round5-hover-viewmore-popover.png` |
| 浮层「查看更多」→ 整页管理界面 | ✅ ChromePage 打开（文本「收藏夹 共 0 条…」/「历史记录 共 1 条…」） | `e2e-round5-viewmore-page.png`、`e2e-round5-global-history-page.png` |
| 历史全局（跨会话）+ 恢复标签补记 | ✅ 补记日志 `{"added":0,"merged":1}`；历史整页显示恢复的页面 | 主进程日志 + 历史整页截图 |
| 网页随窗口缩放自适应（resize/maximize/unmaximize/fullscreen/恢复） | ✅ 六步探针 `actual==bounds==page.innerWidth`（995→734→1682→734→1682→734） | `E2E_RESIZE_STEP` 日志 |
| 应用内其它下拉菜单边缘不截断 | ✅ placePopover 翻转/夹取 + resize/scroll 重定位 | 18 用例矩阵 + 真机 |

## 11. 2026-11-03 视觉/布局轮真机验证

| 项 | 结果 | 证据 |
|---|---|---|
| 默认主题为「柔和无框」；旧观感可在设置切回 | ✅ `document.documentElement.dataset.theme = soft`；classic 覆盖后侧栏边框 rgb(38,42,49)、soft 为 rgba(255,255,255,0.06) | `e2e-round6-soft-default.png`、`e2e-round6-classic-theme.png` + E2E_EVAL 探针 |
| 主题选择持久化 | ✅ 设置写入 `config/preferences.json`（theme: soft/classic），重启保持 | 配置文件 |
| 会话栏收起为 48px 图标条，网页区变宽 | ✅ 收起/展开按钮生效，模式写入 `preferences.sidebarMode: collapsed` | `e2e-round6-sidebar-collapsed.png` |
| 会话栏小窗化（浮动卡片） | ✅ 8px 外边距 + 16px 圆角 + 浮阴影卡片，模式写入 `sidebarMode: float`，不遮挡网页 | `e2e-round6-sidebar-float.png` |
| 终端全宽底部拉起（VS Code 式） | ✅ 横跨浏览器区+会话栏；网页视图让位 `bottomInset:260`，`actual.height == page.innerHeight`（166/491） | `e2e-round6-terminal-fullwidth.png` + `E2E_RESIZE_STEP` 日志 |
| 终端拖拽时网页不吞事件 | ✅ `onResizeStart/End` → `browser:setOverlay` 临时隐藏原生视图 | 代码 + 手动拖拽 |

## 12. 2026-11-03 实机 bug 修复复验

| 项 | 结果 | 证据 |
|---|---|---|
| 收起后网页视图铺满（不再留 240px 空隙） | ✅ 探针 `sidebarWidth:48`、`bounds.width=1146`、`page.innerWidth=1146`（1200 窗口） | `E2E_RESIZE_STEP` 日志 + `e2e-round6-sidebar-collapsed.png` |
| 小窗化变成真正的浮动小窗 | ✅ 340×min(68vh,620) 右下角悬浮卡片，与常驻态明显不同 | `e2e-round6-sidebar-float.png` |
| 关闭标签后音视频立即停止 | ✅ 适配器 close 先静音再销毁 WebContents；两层测试覆盖 | `webContentsAdapter.spec.ts` / `browserHost.spec.ts` |

## 13. 2026-11-03 会话栏真·独立窗口验证

| 项 | 结果 | 证据 |
|---|---|---|
| 点「小窗化」出现独立顶层窗口 | ✅ 非主窗口列表 1 项：`{"bounds":{"x":814,"y":192,"width":422,"height":720},"title":"Loopsoar","visible":true}`，可独立缩放/最大化 | `docs/screenshots/e2e-round8-agent-window-agent-window.png` + `E2E_AGENT_WINDOW_WINDOWS` 日志 |
| 小窗加载同一套 UI 的 mini 形态 | ✅ URL `loopsoar://app/index.html?mini=1&sessionId=sess-…`；DOM 探针 `{"mini":"1","sidebar":{"left":8,"top":8,"w":391,"h":667},"titlebar":false,"chrome":false}` | 同上 + `E2E_AGENT_WINDOW_DOM` 日志 |
| 主窗口网页真正铺满（侧栏让位） | ✅ `sidebarWidth:0`，浏览器视图 `bounds/actual` 宽度 1355（contentSize 1361），网页区无残留侧栏空隙 | `docs/screenshots/e2e-round8-agent-window-main-fullwidth.png` + `E2E_AGENT_WINDOW_MAIN` 日志 |
| 关闭小窗后主窗口恢复 | ✅ `E2E_AGENT_WINDOW_RESTORED {"restored":"{\"display\":\"flex\",\"splitter\":true}","browser":{"width":936,"sidebarWidth":419}}` | 同一次 E2E（`LOOPSOAR_E2E_CLOSE_AGENT_WINDOW=1`） |
| 小窗内「收回」也能恢复主窗口 | ✅ 域层主动关闭后补推 `chrome:agentWindowClosed`（单测覆盖） | `tests/shell/agentWindow.spec.ts` |

复跑命令（PowerShell）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\tool\AI\real-project\Loopsoar\Parent file\.loopsoar-data'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round8-agent-window.png'
$env:LOOPSOAR_E2E_HOVER_TITLE='小窗化'
$env:LOOPSOAR_E2E_CAPTURE_AGENT_WINDOW='1'
$env:LOOPSOAR_E2E_CLOSE_AGENT_WINDOW='1'
node scripts/dev-gui.mjs
```
## 14. 2026-11-03 定制窗口 chrome / 图标 / 中断 / hover / 动效收敛验证

| 项 | 结果 | 证据 |
|---|---|---|
| Agent 小窗无系统标题栏，自绘最小化/关闭 | ✅ `frame:false`；DOM 探针 `titlebar:false`、`chrome:false`；截图仅「Agent 对话」品牌标题栏 + 两个 SVG 图标按钮 | `docs/screenshots/e2e-round9-agent-window-agent-window.png` |
| 小窗贴主窗口右缘并从右缘滑入（非 OS 默认放置） | ✅ bounds `{"x":662,"y":118,"width":422,"height":722}`；`AGENT_TRACE` 逐帧 `x 686→662`（200ms，起点=目标+24） | `E2E_AGENT_TRACE` 日志 + 同上截图 |
| 打开小窗时主窗口原生网页视图同曲线让位 | ✅ `sidebarWidth 507→0` 逐帧插值（非瞬跳），网页宽度铺满 | `E2E_AGENT_TRACE` 日志 |
| 关闭/最小化后主窗口侧栏恢复 | ✅ `E2E_AGENT_WINDOW_RESTORED {"display":"flex","splitter":true,"sidebarWidth":507}`；事件改到窗口销毁后推送 | 同一次 E2E（`LOOPSOAR_E2E_CLOSE_AGENT_WINDOW=1`）+ 单测 |
| 主窗口最小化/最大化/关闭按钮 hover 有反馈 | ✅ `E2E_HOVER_WIN_BUTTON {"hover":true,"bg":"rgb(196,43,28)","color":"rgb(255,255,255)"}`（关闭键红色 hover） | `docs/screenshots/e2e-round9-titlebar-hover-hover.png` |
| 生成中主按钮=中断（红色停止图标、可点击） | ✅ `E2E_EVAL {"title":"停止生成","disabled":false,"icon":"url(./icons/stop.svg)","bg":"rgb(239,120,103)","busyText":"生成中"}` | `docs/screenshots/e2e-round9-composer-stop.png` |
| 运行中输入内容后立即变回发送按钮 | ✅ `{"before":"停止生成","after":"发送转向提示（运行中发送 = 转向，下一轮生效）","icon":"url(./icons/send.svg)","value":"补充一句"}` | `docs/screenshots/e2e-round9-composer-typing.png` |
| 本地 SVG 图标库替换 emoji | ✅ 42 个 1024 viewBox SVG 入库（`SOURCE.md` 映射）；`tests/ui/icons.spec.ts` 断言所有 `<Icon name>` 均有资源 | `packages/ui/public/icons/` + 截图 |

复跑命令（PowerShell）：

```powershell
# 1) 无边框小窗 + 滑入轨迹 + hover + 关闭恢复
$env:LOOPSOAR_DATA_DIR='D:\tool\AI\real-project\Loopsoar\Parent file\.loopsoar-data-mock'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round9-agent-window.png'
$env:LOOPSOAR_E2E_HOVER_TITLE='小窗化'
$env:LOOPSOAR_E2E_AGENT_TRACE='1'
$env:LOOPSOAR_E2E_CAPTURE_AGENT_WINDOW='1'
$env:LOOPSOAR_E2E_CLOSE_AGENT_WINDOW='1'
$env:LOOPSOAR_E2E_HOVER_WIN_BUTTON='2'
node scripts/dev-gui.mjs

# 2) Composer 发送↔中断（需 mock 上游）
node scripts/mock-openai-server.mjs 19500
$env:LOOPSOAR_API_KEY='sk-mock-local'
$env:LOOPSOAR_E2E_OPEN='chat&chatDelay=200'
$env:LOOPSOAR_E2E_POST_CLICK_MS='3000'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round9-composer-stop.png'
$env:LOOPSOAR_E2E_EVAL="(() => { const b = document.querySelector('.send-btn'); return JSON.stringify({ title: b.getAttribute('title'), icon: b.querySelector('.icon').style.getPropertyValue('--icon') }); })()"
node scripts/dev-gui.mjs
```

## 15. 2026-11-05 顶部标签行 + chrome 闭环外壳验证

| 项 | 结果 | 证据 |
|---|---|---|
| 标签页在最顶行左侧，窗口按钮同列右侧 | ✅ 截图顶行可见「Loopsoar 广告拦截 E2E 测试页」+ `+`，最右为最小化/最大化/关闭 | `docs/screenshots/e2e-round10-closed-frame.png` |
| 活动标签填充高亮，非活动透明无白框 | ✅ 活动标签与第二行工具条同色连成一片；无 `border` 胶囊；关闭键 hover 才出现 | 同上截图 + `packages/ui/index.html` `.tab-item` 规则 |
| 工具条只覆盖网页列，不延伸进会话栏 | ✅ 地址栏/图标止于网页列右缘（omnibox `maxWidth:720`、动作区 `marginLeft:auto`），会话栏从标题栏下满高 | 同上截图 |
| 工具条与会话栏连成抬高外壳，缝隙消失 | ✅ 像素采样：工具条空白区/会话栏/状态栏均为 `rgb(23,27,34)`；原 splitter+侧栏内边距暗缝被 `workRow` raised 底色填满 | 同上截图 + `App.tsx` `workRow` |
| 网页面板四边内缩 + 圆角，形成闭环 | ✅ DOM `browserPane` margin 8/radius 14；原生视图 `view.setBorderRadius(14)`；闭环外框可见 | 同上截图 + `browser:view` 截图 `e2e-round10-panel-browser-view.png` |
| 几何探针（1360×860、sidebar 360） | ✅ bounds/actual `{x:8,y:96,width:978,height:724}`；maximize 2048×1104 → `{x:8,y:96,width:1666,height:968}`；unmaximize 回 `978×724` | `LOOPSOAR_E2E_RESIZE` 日志 |
| 输入区与周围底色区分 | ✅ 输入卡片 `BRAND.inkRaised` + radius 14、外层透明无 borderTop | 同上截图 |

说明：`win.capturePage()` 不包含原生 `WebContentsView`，窗口级截图里网页面板显示为 StartPage 占位；页面渲染单独用 `BROWSER_VIEW_SHOT_SAVED docs/screenshots/e2e-round10-panel-browser-view.png` 验证。聊天区右缘的金色波浪线是「卷轴」自定义滚动条设计元素，不是渲染伪影。

复跑命令（PowerShell）：

```powershell
# 1) 首次用新数据目录时先点掉 onboarding，保留同一目录供第二次截图
$env:LOOPSOAR_DATA_DIR='D:\tool\AI\real-project\Loopsoar\Parent file\.loopsoar-data-e2e10'
$env:LOOPSOAR_E2E_CLICK_TEXT='跳过'
node scripts/dev-gui.mjs

# 2) 顶行标签 + 闭环外壳截图（本地测试页服务：node .tmp/adpage-server.mjs 19444）
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round10-frame-final.png'
$env:LOOPSOAR_E2E_NAV_URL='http://127.0.0.1:19444/'
$env:LOOPSOAR_E2E_NAV_WAIT_MS='2500'
$env:LOOPSOAR_E2E_HOLD_MS='900'
node scripts/dev-gui.mjs

# 3) 几何探针
$env:LOOPSOAR_E2E_RESIZE='1360x860'
node scripts/dev-gui.mjs
```

## 16. 2026-11-05 星标折叠开关 / 地址栏伸缩 / 滚动条单一化验证

| 项 | 结果 | 证据 |
|---|---|---|
| 收起/展开只剩一个入口（星标方块） | ✅ 原 rail 按钮与 header `>` 收起按钮已删除，只剩 `.sidebar-toggle` | `AgentSidebar.tsx` + 截图 |
| 收起态只显示 32×32 星标方块 | ✅ `mode=collapsed`、toggle `getBoundingClientRect().width=32`，无其他按钮 | `e2e-round11-collapsed.png` + `E2E_EVAL` |
| 展开态为长方形，星标左移 + 收起箭头渐入 | ✅ 落定 62×32；动画中帧宽 44，星标在左、右侧箭头半透明 | `e2e-round11-expanded.png`、`e2e-round11-toggle-mid.png` |
| 开关方向符合直觉（右缘固定、只左伸右收） | ✅ 动画采样 32→47→62（100ms/600ms），无跳变；右缘 `right:8` 固定 | `E2E_EVAL` 两次点击探针 |
| 收起后地址栏随网页列向右延伸 | ✅ `omni.w` 667→1132（同一窗口，仅点击开关） | `E2E_EVAL` + `e2e-round11-collapsed.png` |
| 展开后地址栏恢复原长度 | ✅ 1132→667 | `E2E_EVAL` + `e2e-round11-expanded.png` |
| 会话右侧不再出现原生滚动条按钮，仅保留波浪卷轴 | ✅ `.chat-scroll` `offsetWidth-clientWidth=0`（`scrollbar-width:none` 生效） | `E2E_EVAL` + 截图 |
| 开关 hover 有反馈 | ✅ `.sidebar-toggle:hover` 背景/文字变化（内联背景已移除） | `index.html` 规则 + 截图 |
| 回归基线 | ✅ typecheck 5/5、gen/check 逐字节一致、build 5/5、vitest 132 文件 / 1205 tests 全绿 | 终端记录 |

说明：窗口级截图仍不含原生 `WebContentsView`（`capturePage` 限制），网页面板显示为 StartPage 占位；本轮验证点均在 DOM chrome 上，地址栏/开关尺寸用 `getBoundingClientRect` 探针给出精确值。

复跑命令（PowerShell，先启动本地测试页 `node .tmp/adpage-server.mjs 19444`）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\tool\AI\real-project\Loopsoar\Parent file\.loopsoar-data-mock'
$env:LOOPSOAR_E2E_NAV_URL='http://127.0.0.1:19444/'
$env:LOOPSOAR_E2E_NAV_WAIT_MS='2200'
$env:LOOPSOAR_E2E_HOLD_MS='900'

# 1) 展开态截图 + DOM 探针（omni 宽度 / toggle 尺寸 / 滚动条厚度）
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-expanded.png'
$env:LOOPSOAR_E2E_EVAL='(() => { const r=(s)=>{const el=document.querySelector(s); if(!el) return null; const b=el.getBoundingClientRect(); return {x:Math.round(b.x),w:Math.round(b.width)};}; const sc=document.querySelector(".chat-scroll"); return JSON.stringify({omni:r(".browser-omnibox"),toggle:r(".sidebar-toggle"),sbW:sc?sc.offsetWidth-sc.clientWidth:null,mode:document.querySelector(".agent-sidebar")?.dataset.mode}); })()'
node scripts/dev-gui.mjs

# 2) 点击开关 → 收起态截图（地址栏应延伸；mode=collapsed；toggle 32）
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-collapsed.png'
$env:LOOPSOAR_E2E_HOLD_MS='1200'
$env:LOOPSOAR_E2E_EVAL='(async () => { const r=(s)=>{const ell=document.querySelector(s); if(!ell) return null; const b=ell.getBoundingClientRect(); return {x:Math.round(b.x),w:Math.round(b.width)};}; const before=r(".browser-omnibox"); document.querySelector(".sidebar-toggle")?.click(); await new Promise((res)=>setTimeout(res,900)); const sc=document.querySelector(".chat-scroll"); return JSON.stringify({before,after:r(".browser-omnibox"),toggleAfter:r(".sidebar-toggle"),sbW:sc?sc.offsetWidth-sc.clientWidth:null,mode:document.querySelector(".agent-sidebar")?.dataset.mode}); })()'
node scripts/dev-gui.mjs

# 3) 动画中帧（收起→展开 80ms 后截图，验证长方形过渡态）
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-toggle-mid.png'
$env:LOOPSOAR_E2E_HOLD_MS='60'
$env:LOOPSOAR_E2E_EVAL='(async () => { document.querySelector(".sidebar-toggle")?.click(); await new Promise((res)=>setTimeout(res,80)); return JSON.stringify({w:Math.round(document.querySelector(".sidebar-toggle")?.getBoundingClientRect().width ?? -1),mode:document.querySelector(".agent-sidebar")?.dataset.mode}); })()'
node scripts/dev-gui.mjs
```

## 17. 2026-11-05 输入区色块 / 卷轴悬停卡片 / 数据目录绝对化验证

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 输入区独立色块 | 打开聊天页截图（`e2e-round11-composer.png`） | 底部输入区为深色带（`--ls-bg`），输入卡片 raised + 圆角，与会话面分层明确 |
| 卷轴悬停卡片 | `LOOPSOAR_E2E_HOVER_RAIL=1` + 一条用户消息 | 卡片显示「● n / total 话题标签」，悬浮在卷轴左侧、跟随鼠标；日志 `[E2E] RAIL_HOVER hovered` |
| 无话题标签时降级 | 空会话 hover | 卡片序号显示百分比，文本显示上下文占用（不出现空白卡片） |
| 相对数据目录启动 | `LOOPSOAR_DATA_DIR=.loopsoar-data` 启动 | 不弹 `Error: Path must be absolute`；日志 `dataDir=<绝对路径>` |
| 归一化单测 | `vitest run tests/shell/dataDir.spec.ts` | 4/4 通过 |

复跑命令（PowerShell；先启动 mock LLM 与本地测试页）：

```powershell
# mock LLM（终端 1）与本地测试页（终端 2）
node scripts/mock-openai-server.mjs 19500
node .tmp/adpage-server.mjs 19444

$env:LOOPSOAR_DATA_DIR='D:\tool\AI\real-project\Loopsoar\Parent file\.loopsoar-data-mock'
$env:LOOPSOAR_API_KEY='sk-mock-local'
$env:LOOPSOAR_E2E_OPEN='chat&chatDelay=200'
$env:LOOPSOAR_E2E_CHAT_TEXT='请用一句话介绍 Loopsoar 的卷轴设计'
$env:LOOPSOAR_E2E_HOVER_RAIL='1'
$env:LOOPSOAR_E2E_HOLD_MS='2800'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-composer.png'
node scripts/dev-gui.mjs

# 相对路径数据目录回归（应正常启动并保存截图）
$env:LOOPSOAR_DATA_DIR='.loopsoar-data-mock'
$env:LOOPSOAR_E2E_SHOT='.tmp/rel-dir-check.png'
node scripts/dev-gui.mjs
```

## 18. 2026-11-05 输入框本体色块 / slime 式编织卷轴验证

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 输入框本体变色 | 打开聊天页截图（`e2e-round11-rail-braid.png`） | 输入框本体为深色（`--ls-bg`）圆角块，周围/消息区保持会话面 raised 底色（修正第 17 节「整条色带」方案） |
| 卷轴双股编织 | 打开聊天页截图（`e2e-round11-rail-braid.png`） | 卷轴呈 linen/ochre **同一波长**双股反向交叉的规整麻花（λ≈86、振幅≤3px、光晕收窄），滚动时波纹流动 |
| 卷轴悬停 | `LOOPSOAR_E2E_HOVER_RAIL=1` + 有消息的会话 | 指针附近两股收拢并侧推，卡片显示「● n / total 标签」；截图 `e2e-round11-rail-braid-hover.png`，日志 `[E2E] RAIL_HOVER hovered` |
| 回归基线 | `pnpm typecheck && pnpm check && pnpm build && npx vitest run` | 5/5、逐字节一致、5/5、133 文件 / 1209 tests 全绿 |

复跑命令（PowerShell）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\tool\AI\real-project\Loopsoar\Parent file\.loopsoar-data-mock'
$env:LOOPSOAR_E2E_OPEN='chat'
$env:LOOPSOAR_E2E_HOVER_RAIL='1'
$env:LOOPSOAR_E2E_HOLD_MS='1400'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-rail-braid.png'
node scripts/dev-gui.mjs
```

## 19. 2026-11-05 卷轴外观回退 + 悬停突起验证

> 本节结论取代第 18 节的外观部分：双股编织被用户判定「越来越乱」，外观已回退到原细线，仅保留 slime 式悬停突起；输入框本体色块保留。

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 静止外观回退 | 打开聊天页截图（`e2e-round11-rail-final.png`） | 右侧为**极细亚麻/赭石双股波浪线** + 视口提亮段 + 话题圆点，无粗编织/大光晕 |
| 悬停突起 | `LOOPSOAR_E2E_HOVER_RAIL=1` + 有消息的会话（`e2e-round11-rail-bump.png`） | 指针高度处整条线向聊天区一侧平滑鼓出明显包络（**向外突起**，不是收拢），上下渐变自然；日志 `[E2E] RAIL_HOVER hovered` |
| 悬停卡片回归 | 同上 | 卡片仍显示「● n / total 标签」 |
| 输入框本体色块回归 | 同截图 | 输入框本体为深色圆角块，周围保持会话面底色 |
| 回归基线 | `pnpm typecheck && pnpm check && pnpm build && npx vitest run` | 5/5、逐字节一致、5/5、133 文件 / 1209 tests 全绿 |

复跑命令（PowerShell）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\\tool\\AI\\real-project\\Loopsoar\\Parent file\\.loopsoar-data-mock'
$env:LOOPSOAR_E2E_OPEN='chat'
$env:LOOPSOAR_E2E_HOVER_RAIL='1'
$env:LOOPSOAR_E2E_HOLD_MS='1400'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-rail-bump.png'
node scripts/dev-gui.mjs
```

## 20. 2026-11-05 卷轴突起平滑化 + 悬停卡片对比度验证

> 承接第 19 节：突起幅度已生效，但用户实机仍觉得「打结」、卡片不可见；本节验证 ADR-0027 的平滑包络与卡片对比度修复。

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 静止外观不变 | 打开聊天页截图（`e2e-round11-rail-smooth.png`） | 仍为极细双股波浪线 + 视口提亮段 + 话题圆点，无粗编织/大光晕 |
| 突起平滑（无打结） | `LOOPSOAR_E2E_HOVER_RAIL=1`（`e2e-round11-rail-smooth-bump.png`） | 指针高度处为**单一平滑外鼓包络**，两股线在突起区重合、无 S 形交叉；离开后回缩并恢复波纹 |
| 悬停卡片对比度 | 同上 | 深色卡片（`--ls-bg`）+ 可见描边 + 阴影，显示「● n / total 标签」，不再与会话面融为一体 |
| 卡片文案/序号 | `RAIL_TIP` 日志 | `display:flex`、`text` 形如 `1 / 1你：…`，tipRect 非零 |
| 回归基线 | `pnpm typecheck && pnpm check && pnpm build && npx vitest run` | 5/5、逐字节一致、5/5、133 文件 / 1209 tests 全绿 |

复跑命令（PowerShell）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\\tool\\AI\\real-project\\Loopsoar\\Parent file\\.loopsoar-data-mock'
$env:LOOPSOAR_E2E_OPEN='chat'
$env:LOOPSOAR_E2E_HOVER_RAIL='1'
$env:LOOPSOAR_E2E_HOLD_MS='2000'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-rail-smooth-bump.png'
node scripts/dev-gui.mjs
```

> 合成鼠标偶发被下一帧 pointerleave 清掉悬停态（`RAIL_TIP display:none`），重跑即可；真机悬停稳定。

## 21. 2026-11-05 卷轴按 slime wave 重做（Loopsoar 品牌配色）验证

> 承接第 20 节：突起已平滑，但用户要求静态外观必须是参考作品那种「双股编织」；本节验证 ADR-0028 的几何移植与品牌配色。

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 静止编织外观 | 打开聊天页截图（`e2e-round11-rail-wave.png`） | 亚麻白主股 + 赭石辅股的双股编织麻花；视口段提亮、两端渐隐；无粗块、无话题圆点 |
| 悬停鼓包 | `LOOPSOAR_E2E_HOVER_RAIL=1`（`e2e-round11-rail-wave-hover.png`） | 指针高度两股收拢并向聊天区鼓出**单峰平滑包络**（峰值约 13px），上下过渡连续 |
| 悬停卡片 | 同上，查看 `[E2E] RAIL_TIP` | `display:flex`、`text` 形如 `1 / 1你：…`、tipRect 非零；深色卡片 + 可见描边 |
| 参数默认值 / 存储键 | 设置 → 外观 → 卷轴参数 | 默认 w12 / amp55 / lam46 / lam53 / spd1 / tap90；localStorage 键为 `loopsoar_rail_params_chat_v2`，旧键已被清理 |
| 回归基线 | `pnpm typecheck && pnpm check && pnpm build && npx vitest run` | 5/5、逐字节一致、5/5、133 文件 / 1209 tests 全绿 |

复跑命令（PowerShell；聊天内容需要 mock LLM，端口 19500）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\\tool\\AI\\real-project\\Loopsoar\\Parent file\\.loopsoar-data-mock'
$env:LOOPSOAR_API_KEY='sk-mock-local'
$env:LOOPSOAR_E2E_OPEN='chat&chatDelay=300'
$env:LOOPSOAR_E2E_HOVER_RAIL='1'
$env:LOOPSOAR_E2E_HOLD_MS='2500'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-rail-wave-hover.png'
node scripts/dev-gui.mjs
```

> 若没有启动 mock 服务，聊天区为空、卷轴仍会绘制；截图里没有话题卡片属预期。

## 22. 2026-11-05 卷轴外观回退原版 + 突起坐标即时定位验证

> 承接第 21 节：用户要求保留原版配色/高光，只借鉴参考作品的悬停突起；同时修复「下一次悬停时突起从上次位置滑到当前位置」。本节验证 ADR-0029。

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 原版外观 | 打开聊天页截图（`e2e-round11-rail-restored.png`） | 暖金双细线 + 视口段提亮 + 话题圆点，和 ADR-0027 完全一致 |
| 悬停突起 + 高光 | `LOOPSOAR_E2E_HOVER_RAIL=1`（`e2e-round11-rail-restored-hover.png`） | 指针高度处平滑向外鼓包（峰值约 14px），同时该段线条高亮；卡片正常显示 |
| 突起坐标即时定位 | `LOOPSOAR_E2E_HOVER_RAIL=2`（`e2e-round11-rail-reenter.png`） | 45% 悬停 → 移出轨道 → 75% 重新进入；重新进入后突起中心立即位于 75% 处，不从 45% 滑过来 |
| 像素测量 | 对截图右缘按行取线位置，算突起中心 | 突起中心 y≈675（物理像素），与 75% 重新进入点（逻辑 y≈540 × DPR 1.25）一致 |
| 参数默认值 / 存储键 | 设置 → 外观 → 卷轴参数 | 默认 w16 / amp48 / lam86 / lam112 / spd0.8 / tap130；localStorage 键 `loopsoar_rail_params_chat_v3`，v1/v2 旧键被清理 |
| 回归基线 | `pnpm typecheck && pnpm check && pnpm build && npx vitest run` | 5/5、逐字节一致、5/5、133 文件 / 1209 tests 全绿 |

复跑命令（PowerShell）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\\tool\\AI\\real-project\\Loopsoar\\Parent file\\.loopsoar-data-mock'
$env:LOOPSOAR_API_KEY='sk-mock-local'
$env:LOOPSOAR_E2E_OPEN='chat&chatDelay=300'
$env:LOOPSOAR_E2E_HOVER_RAIL='2'
$env:LOOPSOAR_E2E_HOLD_MS='3200'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-rail-reenter.png'
node scripts/dev-gui.mjs
```

> 判读方法：把截图右缘裁出来，逐行取最左侧线条像素 x，扣掉基线后取偏差加权中心；中心应落在重新进入的高度附近。

## 23. 2026-11-05 卷轴突起宽度固定（大窗口下整条线被拉弯的修复）

> 承接第 22 节：用户反馈「鼠标放上去后的反馈又崩了」。根因是突起高斯宽度按轨道高度百分比缩放。本节验证 ADR-0030。

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 局部突起（非整条线大弯） | `LOOPSOAR_E2E_HOVER_RAIL=1` 截图后目视右缘 | 突起只出现在指针上下约 ±50px，其余线段保持原版细波浪 |
| 突起坐标即时定位 | `LOOPSOAR_E2E_HOVER_RAIL=2`（`e2e-round11-rail-bump-fixed.png`） | 45% 悬停 → 移出 → 75% 重新进入；突起直接出现在 75% 处 |
| 像素测量 | 右缘逐行取最亮线像素，计算位移中心 | 突起中心 y≈675（物理像素），与重新进入指针物理位置 674.75 相差 <1px；峰值位移约 -18px（逻辑约 14.4px） |
| 外观不变 | 同一截图目视 | 暖金双细线 + 视口提亮 + 圆点、悬停高光与原版一致 |
| 回归基线 | `pnpm typecheck && pnpm check && pnpm build && npx vitest run` | 5/5、逐字节一致、5/5、133 文件 / 1209 tests 全绿 |

复跑命令（PowerShell）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\\tool\\AI\\real-project\\Loopsoar\\Parent file\\.loopsoar-data-mock'
$env:LOOPSOAR_API_KEY='sk-mock-local'
$env:LOOPSOAR_E2E_OPEN='chat&chatDelay=300'
$env:LOOPSOAR_E2E_HOVER_RAIL='2'
$env:LOOPSOAR_E2E_HOLD_MS='3200'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-rail-bump-fixed.png'
node scripts/dev-gui.mjs
```

> 若窗口为高 DPI / 最大化，仍应看到同样「局部」的突起（`bumpSigma=20` 与轨道高度无关）。

## 24. 2026-11-05 卷轴突起幅度调小验证

> 承接第 23 节：用户反馈突起仍偏大。本节验证 ADR-0031（宽度 20→16、峰值 16→11.2px）。

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 突起幅度 | `LOOPSOAR_E2E_HOVER_RAIL=1`（`e2e-round11-rail-bump-small.png`） | 指针处轻微外鼓，峰值约 11px（逻辑），只到正文边缘、不压文字 |
| 突起形态 | 右缘 4× 放大目视 | 圆润单包、无折角；上下沿用原版细双线 |
| 像素测量 | 逐行取最亮线像素算位移 | 峰值约 -14 物理像素（逻辑 11.2px），突起中心 y≈487 与指针 487.85 一致 |
| 回归基线 | `pnpm typecheck && pnpm check && pnpm build && npx vitest run` | 5/5、逐字节一致、5/5、133 文件 / 1209 tests 全绿 |

复跑命令（PowerShell）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\\tool\\AI\\real-project\\Loopsoar\\Parent file\\.loopsoar-data-mock'
$env:LOOPSOAR_API_KEY='sk-mock-local'
$env:LOOPSOAR_E2E_OPEN='chat&chatDelay=300'
$env:LOOPSOAR_E2E_HOVER_RAIL='1'
$env:LOOPSOAR_E2E_HOLD_MS='1800'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-rail-bump-small.png'
node scripts/dev-gui.mjs
```

## 25. 2026-11-05 卷轴凹陷防裁切 + 突起紧凑可调验证

> 承接第 24 节：凹陷末端/光晕不再被窗口右缘裁切；突起更紧凑显眼；突起参数开放到设置；删除拖拽提示。本节验证 ADR-0032。

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 凹陷不裁切 | `LOOPSOAR_E2E_HOVER_RAIL=2` 截图（`e2e-round11-rail-compact.png`） | 突起两翼的 dip 与光晕完整显示，右缘不出现硬切；基线距窗口右缘约 19px（1702 宽时 x≈1683） |
| 突起紧凑显眼 | 同上，4× 放大（`...-compact-crop.png`） | 高斯宽度 13px、峰值 13px；上下凹陷更贴近突起，整体一眼可见但不压正文 |
| 突起参数可调 | 设置 → 外观 → 卷轴参数（`e2e-round11-rail-settings.png`） | 出现「悬停突起幅度（4–24px）」「悬停突起宽度（8–32px）」两个滑杆，拖动即时生效并持久化 |
| 拖拽提示已删 | 鼠标悬停卷轴 | 不再出现浏览器原生 tooltip「拖动卷轴滚动 · 悬停查看位置」，只有自定义卡片 |
| 旧参数兼容 | 已有 v3 localStorage 数据启动 | 缺 `bumpReach/bumpSigma` 时自动补 13/13，不重置用户已调的其它参数 |
| 回归基线 | `pnpm typecheck && pnpm check && pnpm build && npx vitest run` | 5/5、逐字节一致、5/5、133 文件 / 1209 tests 全绿 |

复跑命令（PowerShell）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\\tool\\AI\\real-project\\Loopsoar\\Parent file\\.loopsoar-data-mock'
$env:LOOPSOAR_API_KEY='sk-mock-local'
$env:LOOPSOAR_E2E_OPEN='chat&chatDelay=300'
$env:LOOPSOAR_E2E_HOVER_RAIL='2'
$env:LOOPSOAR_E2E_HOLD_MS='3200'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-rail-compact.png'
node scripts/dev-gui.mjs
```

## 26. 2026-11-05 卷轴悬停流动开关验证

> 用户要求：鼠标悬停在卷轴上时是否停止流动，交给用户自行选择。本节验证 ADR-0033。

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 默认不暂停 | 全新数据目录启动 → 聊天页悬停卷轴 | 波浪继续流动（`DEFAULT_CHAT_RAIL.pause=false`），突起与卡片仍正常 |
| 开关可开 | 设置 → 外观 → 卷轴参数 → 勾选「悬停时暂停流动」 | 勾选后悬停时波浪冻结；取消勾选恢复流动，设置即时生效并持久化 |
| 说明文案 | 同一卡片 | 复选框下方显示说明：「开关决定鼠标停在卷轴上时波浪是否停止流动；默认关闭（继续流动）。悬停突起与话题卡片不受影响。」 |
| 强制暂停场景 | 系统「减少动画」/ 拖拽卷轴 / 荡漾速度为 0 | 始终暂停，与开关无关 |
| 回归基线 | `pnpm typecheck && pnpm check && pnpm build && npx vitest run` | 5/5、逐字节一致、5/5、133 文件 / 1212 tests 全绿 |

复跑命令（PowerShell）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\\tool\\AI\\real-project\\Loopsoar\\Parent file\\.loopsoar-data-mock'
$env:LOOPSOAR_E2E_OPEN='settings&section=appearance'
$env:LOOPSOAR_E2E_HOLD_MS='1200'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round11-rail-pause-switch.png'
node scripts/dev-gui.mjs
```

## 27. 2026-11-05 网页/会话分区间隙收紧 + 顶部阴影删除验证

> 承接第 26 节；用户要求「网页与会话只隔一线」并删除会话顶部滚动阴影。本节验证 ADR-0034。

| 验证点 | 操作 | 期望 |
| --- | --- | --- |
| 分区间隙 | DOM 探针取 `.browser-toolbar` 右缘与 `.agent-sidebar` 左缘 | 差值 = 2px（splitter）；页框自身 8px 内缩另计，视觉缝约 10px |
| 会话内容宽度 | 同上取 `.agent-sidebar` 宽度 | 等于 `sidebarWidth`（不再被 wrapper padding / `-16` 双重扣减） |
| 顶部阴影 | 查询 `.scroll-fade-mask.is-top` | 元素不存在（已删除），截图顶部无暗色渐变带 |
| 底部渐隐 | 查询 `.scroll-fade-mask.is-bottom` | 仍存在，未滚到底时可见 |
| 原生视图对齐 | `debugBounds` / `browserHost.syncBounds` | x=8、y=96、width=窗口-侧栏-2-16、height 不变（splitter 2px 已进契约） |
| 回归基线 | `pnpm typecheck && pnpm check && pnpm build && npx vitest run` | 5/5、逐字节一致、5/5、133 文件 / 1212 tests 全绿 |

复跑命令（PowerShell）：

```powershell
$env:LOOPSOAR_DATA_DIR='D:\\tool\\AI\\real-project\\Loopsoar\\Parent file\\.loopsoar-data-mock'
$env:LOOPSOAR_E2E_OPEN='chat'
$env:LOOPSOAR_E2E_HOLD_MS='900'
$env:LOOPSOAR_E2E_SHOT='docs/screenshots/e2e-round12-gap.png'
$env:LOOPSOAR_E2E_EVAL='(() => { const tb=document.querySelector(".browser-toolbar")?.getBoundingClientRect(); const sb=document.querySelector(".agent-sidebar")?.getBoundingClientRect(); return { gap: tb&&sb?sb.x-(tb.x+tb.width):null, topMask: !!document.querySelector(".scroll-fade-mask.is-top") }; })()'
node scripts/dev-gui.mjs
```

> 实测结果：`E2E_EVAL {"tb":{"x":0,"w":852.6},"sb":{"x":854.6,"w":507},"gap":2,"topMask":false,...}`。

## 7. 回归基线（必须全绿后才提交）

```bash
pnpm -r typecheck
npx vitest run          # 预期 ≥ 109 文件 / 867+ tests
pnpm gen && pnpm check
pnpm build
```
