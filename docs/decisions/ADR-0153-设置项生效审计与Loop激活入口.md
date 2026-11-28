# ADR-0153 设置项生效审计与 Loop 激活入口

日期：2026-11-28
状态：已采纳

## 背景

用户要求彻查设置里「徒有其表」的项目，并让自定义 Loop 真正成为可用的卖点。审计以「UI 控件 → 偏好/配置文件 → 运行时消费者」三段核对，而不是只看设置页能否保存。

## 发现并修复

1. **供应商 RPM**：`providers.json.rpm` 只被读写，没有任何请求节流；设置页却提供「上游 RPM 兜底」。已在 coreServices 的 LLM 客户端外层加按供应商共享的最小请求间隔（rpm=1 即 60s 一次），留空不限制。
2. **权限 · 额外授权工作目录**：`permissions.workspaceRoots` 只落盘，沙箱从未读取；设置页输入完全无效。现在启动时写入 `SandboxManager.allowedDirs`，保存权限时通过 `onPermissionsSaved` 即时替换；相对路径按本次判定的工作根解析。
3. **权限 · 危险操作始终确认**：`confirmDangerousAlways` 没有任何消费者，且危险命令原本由 hard_rules 直接硬拦截，不可能通过设置放行。已移除这个可点开关，改为固定说明「硬规则始终拦截，不提供关闭开关」。
4. **记忆检索后端**：`memoryVectorBackend` 只在启动创建 MemoryService 时读取，切换后不会即时生效；同时 UI 的 label/hint i18n 缺失，页面显示原始 key。已补中英文案并明确「重启生效」。
5. **Loop 启用入口**：保存已有 loop 时，如果未勾选「保存后立即启用」，用户看不出它没生效；列表也没有单独的启用按钮。现在保存提示区分「已保存未启用/已启用」，并为选中但非当前的 loop 增加「设为当前」按钮。

## 核对为真实生效（UI → 消费者）

- 通用：语言、动效（dataset.animations）、浏览器打开布局（index 预检）、广告拦截（webRequest）、恢复会话（useChatStreamEvents）、关闭行为（主窗口）、Agent 轮次/工具/重复阈值（getAgentLimits）、自动记忆、自动技能候选、搜索引擎、下载目录、工作区根、记忆库路径。
- 外观：soft/classic/扩展主题、卷轴参数（localStorage → TopicRail）、动效。
- 权限：四个类别策略、敏感步骤始终确认。
- 供应商：API Key（加密库）、端点协议、请求头模板、模型能力/上下文/最大输出、RPM（本轮修复）。
- 规则/技能/MCP/扩展/浏览器扩展/定时任务/终端环境/存储/关于：均接真实 IPC 或只读诊断。

## 未做/保留

- Loop 声明里的 `temperature` 仍是留存字段：`LlmRequest` 没有 temperature，UI 未暴露；如要支持，需要给 OpenAI/Anthropic 两个客户端都加采样参数并明确默认值。
- `memoryVectorBackend` 仍是重启生效（现在已在 UI 注明），未做在线重建 MemoryService。
