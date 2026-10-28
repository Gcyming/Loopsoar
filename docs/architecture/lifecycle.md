# Loopsoar 扩展 / 技能 / MCP 生命周期（握手 → 注册 → 调用 → 清理）

三体隔离见 ADR-0007。本文件规定每个子系统的**状态机、超时、失败策略与清理责任**。

## 1. MCP（stdio JSON-RPC）

状态机：`idle → connecting → ready → error → (retry) connecting …`

### 1.1 握手（connect）
1. 读取并校验 `mcp.json` 条目；
2. `spawn` 子进程：**环境变量白名单** + 显式 env；Windows 仅对 `npx/npm/pnpm/uvx/uv/yarn/bun/cmd/powershell` 走 shell；
3. 起 `stdout` 解码器（自动探测 **换行 JSON** 与 **Content-Length** 帧）与 `stderr` 环（最近 20 行）；
4. 发送 `initialize`（`protocolVersion=2024-11-05`、clientInfo），**5s 超时**；
   - 超时 → 切换帧格式，**重试一次**；
5. 发送 `notifications/initialized`；
6. 读取 `initialize.result.capabilities` 作为能力快照。

### 1.2 注册（register）
1. 仅当 `capabilities.tools` 存在才请求 `tools/list`（资源/提示词同理，未声明不请求）；
2. 工具名规范化：`mcp__<server>__<tool>`；
3. **冲突处理**：注册表已存在同名 → 追加 `_2/_3`（确定性，不静默覆盖）；
4. 权限映射：`annotations.readOnlyHint=true → {read}`，否则 `{network}`（fail-closed）；
5. **原子替换**：新列表全部注册成功后，才注销该服务器旧工具；`tools/list_changed` 通知触发同一流程（in-flight 去重）。

### 1.3 调用（call）
- 未连接时按需 connect；发布 `state=ready` 才可调用；
- 单次请求超时 8s：**只 reject 该请求**并清理 pending，不断连接；
- 错误分类文案：`RPC 错误(code/message)` / `传输失败` / `超时`；
- 工具返回 `content[]` 合并为文本，`isError` 透传为 `ok=false`。

### 1.4 清理（disconnect / shutdown / 应用退出）
1. 注销该服务器全部工具（含冲突后缀变体：按 `mcp__<server>__` 前缀匹配）；
2. 终止进程树：Windows `taskkill /PID <pid> /T /F`，再 terminate→kill 兜底；
3. resolve/reject 所有 pending 并清定时器；
4. 状态回 `idle`，保留 lastError 供 UI 展示；
5. 非预期退出 → 指数退避重连（1s/2s/4s，最多 3 次）→ 仍失败置 `error` 等人工重连。

## 2. 技能（Skills）

1. **发现**：`skills/<id>/SKILL.md`；frontmatter 可选——缺失时 `name=目录名`，description 从首个标题/首段提取（去 Markdown、截断 120 字）；
2. **容错**：单个文件解析失败只跳过该技能并记录原因，不影响整库；
3. **命中（打分，非包含即命中）**：
   - 名称精确 5 / 名称包含 3 / tags 命中 2 / whenToUse 命中 2 / description 命中 1；
   - 中文按 **2-gram** 切分做子串匹配；英文按小写词；
   - 取 Top-N（默认 3）注入正文，正文截断 4000 字符；未命中只注入清单（Top 20，描述截断）；
4. **清理/禁用**：禁用后不参与打分与注入；扫描与列表均为幂等操作；
5. 技能**永不执行代码**、不注册工具。

## 3. 扩展（Extensions）

1. **发现**：`extensions/<dir>/loopsoar.extension.json`；校验失败跳过并汇报；
2. **稳定性**：同 id 多目录 → 首个生效并告警；启用状态原子落盘；卸载仅允许扩展根目录内（路径穿越防护）；
3. 运行时（下一阶段）：入口在**子进程**中加载，工具通过注册表桥接，超时/崩溃隔离，禁用即注销。

## 4. 失败隔离矩阵

| 故障 | 影响范围 | 处理 |
|---|---|---|
| 单个 MCP 启动失败 | 仅该服务器 | error + 退避重试 + UI 可见 |
| 单个 MCP 进程退出 | 该服务器工具注销 | 自动重连（上限 3 次） |
| MCP 单次调用超时 | 仅该调用 | reject + 连接保留 |
| 单个技能解析失败 | 仅该技能 | 跳过 + 原因列表 |
| 单个扩展清单损坏 | 仅该扩展 | 跳过 + 原因列表 |
| 任一子系统扫描/连接异常 | 不阻断启动与对话 | 降级并在对应设置分区展示 |
