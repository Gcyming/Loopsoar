# ADR-0152 Loop 压缩诊断与未知窗口兜底

日期：2026-11-28
状态：已采纳

## 背景

用户打开「设置 · Loop 工作台」后问：上下文压缩去哪里了？Loop 编辑是否真的作用到 Agent？检查发现：

- 压缩阈值是全局设置（通用 · contextCompressRatio），不在 Loop 定义里；Loop 页没有任何提示，用户看不到它。
- ChatService 只在模型能力表给出 contextWindow 时才向 runToolLoop 传 context；自定义供应商/模型不填窗口时，loop 内压缩被整体跳过（回合前压缩反而有 128k 兜底）。
- 当前活动模型窗口 1,048,576 tokens，75% 触发点约 786k；普通会话远低于该值，所以即使接线正确也看不到压缩事件。
- 用户正在编辑 core-loop-custom，但 loops/ 目录只有 example.json，preferences.loopId=core-loop；Agent 仍在跑内置 loop。

## 决策

- ChatService 对 contextWindow 做 128k 兜底（与回合前压缩同一口径），未知窗口也把 context 传进 runToolLoop，保证 loop 内压缩真的运行。
- Loop 工作台顶部增加「上下文压缩已接入 Loop」状态卡：显示全局阈值、目标比例、每轮检测语义，并提供「调整阈值」跳转通用设置。
- 状态卡明确「保存并启用后下一轮对话生效；阶段开关同时收窄模型可见工具与执行器」，把 Loop 编辑到 Agent 的链路写清楚。
- 不把压缩阈值复制成 Loop 字段：它是全局预算策略，复制会产生二套配置源。

## 后果

- 模型窗口未标注时，长工具轮也会在 128k 兜底预算下折叠早期消息；已知 1M 窗口仍按 75% 阈值（约 786k）触发，这是按模型真实容量设计的，不是失联。
- 用户可在 Loop 页直接看到压缩状态并跳转调整；如需更早触发，可下调全局阈值或使用 /compact。
