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

## 7. 回归基线（必须全绿后才提交）

```bash
pnpm -r typecheck
npx vitest run          # 预期 ≥ 109 文件 / 867+ tests
pnpm gen && pnpm check
pnpm build
```
