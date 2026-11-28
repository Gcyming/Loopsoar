# ADR-0148 选项提问（决策分叉）与 loop 内上下文压缩

- 日期：2026-11-28
- 状态：✅ 已验证（typecheck core/services/shell/ui 全绿；core/ask 逻辑 14 项检查通过，见「验证」）
- 关联：ADR-0016（ask_user 初版）、ADR-0045/0047（长度续写）、`packages/core/src/contextCompress.ts`、`packages/core/src/tool_loop.ts`、`packages/shell/src/main/askBus.ts`、`packages/ui/src/AskUserDialog.tsx`

## 背景

三件事在实现层是同一个问题：**Agent 与用户之间的信息交换缺少「结构化」与「时机」**。

1. `ask_user` 初版只有 `options: string[]`：用户只能凭选项名猜代价，模型也无法标注推荐项；
   没有多选、没有「跳过但继续」，取消与跳过被混成同一个 cancelled（Agent 只能二选一：编答案或停住）。
2. 上下文压缩只在**回合开始前**对持久化历史做一次（`ChatService.run`），而工具轮会在同一回合内
   追加大量工具结果 —— 长工具任务跑到一半就撑爆窗口。
3. 上下文进度环按「4 字符 = 1 token」估算已渲染正文：中文被低估约 3.5 倍，且看不见 system 提示、
   工具 schema 与工具结果，导致「环还很空、上游已经 400」。

## 决策

### 1. 选项提问 = 决策分叉（结构化选项）

`ask_user` 参数升级为：
`question` / `header`（分类徽章）/ `options`（2~6 个，每项 `label` + `description` = 选择后果）/
`recommendation`（0 起下标，有把握才填）/ `multiSelect` / `allowFreeText`。
只给 1 个选项会被拒绝（那是确认框，不是决策分叉）；不传选项则退化为纯文本提问（要路径/端口这类信息时合法）。

- 传输层向后兼容：`string[]` 仍接受，归一成 `{ label, value }`；事件始终推送结构化 `AskUserOption[]`。
- 回答语义拆成四种：`choice`（单选）/ `choices`（多选）/ `answer`（自填）/ `skipped`（跳过但继续）/
  `cancelled`（fail-closed，绝不伪造）。跳过时工具返回「按假设继续，但不要声称是用户的选择」。
- 推荐项只能有一个：归一函数先清空全部标记再标一个，避免「双推荐」。
- UI：`AskUserDialog` 展示 label + 后果、推荐徽章、数字键 1-8 直选、多选勾选 + 确认、跳过按钮；
  `Esc` 取消、`Ctrl+Enter` 提交自填文本、Tab 焦点圈定。

**为什么不是「更长的字符串选项」**：提问的成本由用户承担，用户需要的是「选这个会付出什么代价」，
而不是多一个同义词。没有后果说明时，用户只能随便点一个或直接关掉 —— 提问白问。

### 2. 提问时机写进工具描述（而不是靠模型自觉）

工具描述明确三条使用门槛（方向真分叉 / 现在问比返工省 / 无合理默认值），并写入实证结论：

- 目标类澄清只在执行早期有价值（轨迹约 10% 后价值趋近于零）；
- 输入类澄清可维持到约 50%；
- 任何澄清拖到中段之后再问，效果比不问更差。
  因此：**目标/约束必须在动手前问；执行中只问数据/输入缺口**。

### 3. token 估算与 loop 内压缩

- `estimateTokens`：CJK ≈ 1 字/token，其余 ≈ 3.6 字符/token（确定性、零依赖）。
  `estimateMessagesTokens` 含工具参数；`estimateToolsTokens` 把工具 schema 计入 prompt。
- `compressForLoop(messages, { contextWindowTokens, toolsTokens })`：每轮 LLM 请求前调用。
  - 触发 0.75×窗口、目标 0.55×窗口（可调）；
  - system 消息永远保留；最近 N 条原文保留；边界落在 `tool` 上时回头补齐 `assistant(tool_calls)`，
    绝不切开工具调用对（否则上游 400）；
  - 早期消息折叠成**滚动纪要**：上一版纪要原样带入、只按行/字数裁剪，**不二次摘要**
    （二次摘要会让同一段信息每轮再打一次折，几轮后用户最初的目标就消失）；
  - 纪要行数/字数双上限，超出时保留最早一行（目标）+ 最近若干行；仍超阈值 → `stillOverBudget`，
    loop 只提示一次并建议 /compact 或新建会话。
- 回合前压缩（`ChatService`）与 `/compact` 改用 `budgetCharsForTokenTarget`：按这批消息自己的
  token/字符比把 token 目标换算成字符预算，中英混排都能落在目标附近（旧 `historyBudgetChars` 的
  window×1.2 字符对中文相当于允许 1.2×窗口 token，压缩永不触发）。

### 4. 上下文进度：估算 + 实测双源

- `tool_loop` 每轮请求前 emit `progress.context = { used, cap, pct, source: "estimated" }`；
- 上游返回 `usage.inputTokens` 时再 emit 一次 `source: "measured"`（最权威，覆盖估算）；
- UI `useContextUsage` 优先用实测值，未上报时按字符类别本地兜底；不再只在 done 之后更新。
- 预算换算与进度环共用同一套 token 估算，避免「环显示 40%、实际已 90%」的口径分裂。

## 后果

- `ask_user` 的事件负载形状变了（options 从 string[] → 对象数组）。旧壳层字符串输入仍兼容（UI 归一），
  但**监听 `ask:user` 的外部消费者**需要按新形状读取；本次同步更新了 UI 类型与 E2E 验收文案。
- loop 内压缩会替换 `conversation`：工具结果仍完整保存在 UI 工具卡/会话记录中，纪要只是模型可见的摘要。
- 压缩是确定性的（不额外调用模型）：省一次请求/费用/失败面，但摘要质量不如 LLM 摘要 —— 这是有意的取舍，
  符合「宁可可预测地少记，也不要随机地失忆」。
- 组合根 `App.tsx` 保持在 1446 行（架构守卫棘轮）：新逻辑拆到 `contextUsage.ts` / `askTypes.ts`；
  `types.d.ts` 从 1400 行降到 1390（ask 类型拆到 `askTypes.ts` 后再转发）。

## 参考

- 本地成功案例：slime 的「决策分叉窗口」（`ask_user`：question/header/options/consequences/recommendation）。
- Claude Code `AskUserQuestion`（多选题、header ≤12 字、2~4 选项、options 带 description）。
- Letta Code `AskUserQuestion`、OpenAI Codex `request_user_input`（PR #9472）、pydantic-ai harness `ask-user`。
- CIGAsk: Teaching LLMs to Clarify via Counterfactual Information Gain（ACL 2026 Findings, 2026.findings-emnlp.314）：
  只靠提示词会让模型「要么什么都问、要么问得含糊」；提问必须能回收信息。
- Ask Early, Ask Late, Ask Right: When Does Clarification Timing Matter for Long-Horizon Agents?
  （arXiv 2605.07937）：目标澄清约 10% 轨迹后失效、输入澄清约 50%，中段后提问差于不问。

## 验证

- `pnpm -r typecheck`（core / contracts / services / shell / ui）全绿。
- 新增/更新测试：`tests/core/contextCompress.spec.ts`（token 估算、loop 压缩、滚动纪要、工具对边界）、
  `tests/core/toolLoopContext.spec.ts`（loop 内压缩 + estimated/measured 进度）、
  `tests/shell/askBus.spec.ts`（归一/推荐/多选/跳过/取消，保留原有用例）。
- 本机沙箱禁止 esbuild/vitest 派生子进程（`spawn EPERM`），因此用 tsc 编译到临时目录 + node 断言脚本
  跑同一批逻辑（压缩/进度 11 项 + ask 归一/总线 3 项 + ask 工具端 5 项，共 19 项全过）；
  vitest 用例保留给正常 CI/开发环境。

## 追加：v0.0.2 一日使用反馈（2026-11-28）

- **网页圆角回归**：`BROWSER_VIEW_RADIUS` 曾被设为 0（方形铺满）；恢复 12，四角遮罩几何改为跟随常量，颜色仍由渲染层 `--ls-surface-raised` 同步。
- **附件入口**：拖入文件此前被 preload 的 Office 拖放处理器全局截获 → 直接 `documents.open` 新页。现在 `[data-composer-dropzone]` 区域优先：preload 用 webUtils 解析真实路径并派发 `loopsoar:composer-files`，Composer 插入 `【附件】path【/附件】`；Office 文件不再抢走导航。
- **附件解析**：闭合标记让路径与正文可同行；旧格式仍兼容（混排时不会再出现「.png 除了作业…」）。
- **图片可见性**：模型能力明确为 `vision=false` 时，工具截图不回灌并在会话里提示原因（不再静默丢弃）；`file_read` 命中图片扩展时给出可执行提示，而不是二进制乱码。图片输入受设置·通用「图片输入」隐私开关控制。
- **设置**：新增「图片输入（视觉）」开关与「上下文压缩阈值」60%~90%；阈值同时用于回合前压缩与 loop 每轮压缩。
- **提问形态**：`ask_user` 从全屏模态改为会话内卡片（网页保持可见，`baseOverlay` 不再因提问遮住原生视图）；回答后卡片消失，工具结果写入会话。
