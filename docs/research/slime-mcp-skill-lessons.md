# 研究：slime 的 skill / MCP 失败复盘（Loopsoar 的前车之鉴）

来源（只读参考，未改动 `D:\pilot project` 任何文件）：
- `core/mcp_client.py`（1096 行，stdio + HTTP/SSE 双传输）
- `core/skill_engine.py`（432 行）
- `tests/test_mcp.py`（回归用例名）
- 运行日志 `*.log` 中的 `[mcp]` / `[skills]` 警告（统计出现次数）

## 一、MCP 侧真实故障与教训

| 证据 | 故障机制 | Loopsoar 对策 |
|---|---|---|
| 日志 7 次 `[mcp] dead 启动失败: connect refused` | 启动失败只记日志、直接置 dead，无重试/退避/用户可操作入口 | 显式 `error` 状态 + lastError + 指数退避自动重连（上限 3 次）+ UI 手动重连 |
| `_terminate_tree` 注释：uvx/npx 的孙进程成孤儿并持有管道 → reader 永久阻塞 | **Windows 必须杀进程树**（`taskkill /T /F`），只 kill 直接子进程会泄漏并卡死读取 | 清理时 Windows 用 `taskkill /T /F`，再 terminate→kill 兜底 |
| `_stderr_drain` 注释 P0-2：stderr 满 64KB 会阻塞子进程 | 不消费 stderr → 子进程写日志时假死 | 持续消费 stderr + 保留环形缓冲（诊断 UI） |
| 日志 7 次 `工具名 'mcp_search' 冲突，改用 'mcp_search_N'` | 多服务器工具名冲突直接覆盖/丢工具 | 注册时检测冲突，确定性地加 `_2/_3` 后缀 |
| 日志 7 次 `tools/list 不可用: Method not found` | 服务器没声明能力仍强行调用 → 报错噪音 | 按 `initialize.result.capabilities` **能力门控**：未声明就不请求 |
| 日志 7 次 `tools/list_changed 已刷新` | 服务器动态变更工具，客户端不刷新 → 调用到已下线的旧工具 | 处理 `notifications/tools/list_changed`，重新拉取后**原子替换**工具集 |
| `test_flip_framing_toggles` / `test_serialize_content_length_after_flip` | 部分实现用 LSP 风格 `Content-Length` 帧而非换行 JSON；握手探测失败要能切换 | 解码器自动探测两种帧格式；initialize 超时后切换帧格式重试一次 |
| `test_notification_before_response` | 通知可能先于响应到达，必须按 id 分发而不是按顺序 | 解码/分发按 id，通知独立处理；迟到响应丢弃 |
| `test_timeout_does_not_kill` | 单次请求超时不应毁掉整条连接 | 请求超时只 reject 该请求并清理 pending，连接保留 |
| `test_reconnect_after_death` / `test_reconnect_gives_up_after_limit` | 崩后要重连，但必须有上限防重连风暴 | 1s→2s→4s 退避，3 次后转 `error` 等人工 |
| `test_start_all_failure_isolated` | 一个服务器失败不得拖垮其它服务器/应用启动 | 每个服务器独立生命周期；启动失败仅该条 error |
| `test_concurrent_refresh_no_duplicate` | 并发刷新工具列表会重复注册 | 注册表注册前查重 + 刷新串行化（in-flight 去重） |
| 环境变量全量传给子进程 | 会把 API Key 等泄漏给第三方 MCP 进程 | 环境变量**白名单**（PATH/SystemRoot/TEMP/HOME/APPDATA…）+ 仅配置显式 env |

## 二、Skill 侧真实故障与教训

| 证据 | 故障机制 | Loopsoar 对策 |
|---|---|---|
| `_load_single_skill` 中 manifest 解析失败 → 只 warning 并回退 `name=目录名` | 单个坏技能不能拖垮整库 | 单文件容错：解析失败跳过该文件，不影响其它技能 |
| SKILL.md 没有 frontmatter 时 `body = content.strip()`（正文当全文） | 强制 frontmatter 会把大量第三方技能拒之门外 | frontmatter **可选**：缺失时用目录名兜底 + 首段/首标题提取 description |
| `_extract_description` 支持 `## 功能` / `# 标题`，去除 Markdown 标记 | 描述质量影响模型是否用技能 | 描述提取 + 去 Markdown + 截断 |
| `skill.py` 自定义执行函数被**主动禁用**（安全），只保留 SKILL.md 指导 | 技能里塞可执行代码 = 任意代码执行 | Loopsoar 技能**只做提示词注入**（已如此），绝不执行技能内代码 |
| `search()`：名称命中权重 3 > 描述/tags 1，空查询返回全部（截断 limit） | 命中质量靠权重而非“包含即命中” | 打分：名称精确 5 / 名称包含 3 / tags 2 / whenToUse 2 / description 1；Top-N 截断 |
| `_SKILL_BODY_LIMIT` 截断技能正文 | 大技能一次性灌爆上下文 | 命中注入正文上限（默认 4000 字符），其余只给摘要 |
| `MAX_SKILL_DESCRIPTION_LENGTH` 限制描述长度 | 列表注入体积失控 | 清单项描述截断（120 字） |
| 日志 104 次 `已加载 N 个技能，注册 skill_search/skill_lookup` | 渐进披露：先给清单，模型再按需读取全文 | 保留“清单 + 命中注入”两段式，避免全量注入 |

## 三、结论（Loopsoar 生命周期的 8 条铁律）

1. **握手必须有超时与帧格式探测**：5s 超时 → 切换 Content-Length 帧 → 重试一次 → 失败转 error，不阻塞启动。
2. **能力门控**：initialize 返回什么才请求什么（tools/resources/prompts）。
3. **注册原子化**：新工具集就绪后再替换旧集；冲突加后缀；并发刷新去重。
4. **调用超时只影响单次请求**，区分“RPC 错误 / 传输失败 / 超时”三类返回文案。
5. **清理必须杀进程树**，并 resolve 所有 pending、注销工具、清定时器；应用退出时统一 shutdown。
6. **故障隔离**：单服务器/单技能/单扩展失败不拖垮整体。
7. **安全默认**：环境白名单、技能不执行代码、工具权限 fail-closed（未声明能力按 network 处理）。
8. **可诊断**：每个子系统保留 lastError + stderr 环 + 状态机，UI 可见、可手动重试。
