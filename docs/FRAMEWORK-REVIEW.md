# 框架灵活性审查（面向「扩展 / 插件化 / skill / MCP」）

> 结论：**骨架足够灵活，可以直接长出扩展体系**；但插件域目前只有"运行时内核"，还差一层"可安装扩展"的契约。

## 1. 现状盘点（与前期设想的对照）

| 设想能力 | 现有实现 | 结论 |
|---|---|---|
| 万物皆插件（DSH 式） | `core/plugin/*`：PluginHost + 插件清单/生命周期 + 事件总线；插件可注册工具/命令/资源 | ✅ 内核在，缺"安装/卸载/市场"契约 |
| Agent / 子代理 | `core/agent.ts` AgentRegistry + BUILTIN_AGENT；工具白名单按 Agent 解析 | ✅ 可扩展（加 Agent 即加配置） |
| 工具协议 | `core/tools.ts` 注册表 + 权限声明（read/write/terminal/network）+ 沙箱 | ✅ 新工具零改壳层 |
| 技能（skill） | 目前只有规则文件（AGENTS.md）注入，无 SKILL.md 发现机制 | ⚠️ 待补：扫描 `skills/*/SKILL.md` → 按需加载 |
| MCP | 无 | ❌ 待建：stdio/HTTP 客户端 → 工具/资源映射进注册表 |
| 模型供应 | `core/provider.ts` + 懒加载 LlmClient，保存即生效 | ✅ 加"多供应商列表"只需扩偏好/存储，不动服务层 |
| 界面扩展 | 通过 preload 白名单 + 设置分区导航；新分区=新增组件 | ✅ 低耦合 |
| 隔离安全 | 4 要素 handleTrusted + 项目隔离守卫 | ✅ 扩展新通道只需进 contracts |

## 2. 关键约束（保证"不节外生枝"）

1. 一切新能力都必须是 **contracts 通道 → gen → core 纯逻辑 → shell 域 → UI**；
2. 插件只能拿到**注册表**（工具/命令/资源），不得直接碰 electron / fs；
3. 插件权限沿用现有四类声明，走同一套沙箱与确认流程；
4. skill 和 MCP **都是"工具/能力来源"**，统一映射进 ToolRegistry，不新增第二套调用链。

## 3. 下一步实施顺序（建议）

1. **扩展域骨架**：`extensions:list/install/uninstall/enable` 通道 + `ExtensionManifest` 契约 + `core/extension` 注册/启停（先支持本地目录安装）；
2. **skill 适配**：扫描 `skills/<name>/SKILL.md`（frontmatter: name/description/tools），命中后把内容注入 volatile 段；设置里加"技能"列表；
3. **MCP 适配**：`mcp:listServers/add/remove/connect`，stdio 子进程或 SSE 客户端，工具自动注册（名称加前缀 `mcp__server__tool`）；
4. 最后才做"扩展市场/在线安装"（涉及签名与审计，优先级最低）。

## 4. 现有 UI 待办（本轮未完成）

- 多标签：后退/前进（导航栈）、历史记录、下载管理器
- 多供应商并存列表（当前单活跃 + 卡片）
- 多会话列表（当前仅最近一份持久化）
