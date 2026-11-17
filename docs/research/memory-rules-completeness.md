# 记忆与规则：完整度与同类 Harness 对照

复核时间：2026-11-17。对象：Loopsoar 的 memory 与 rules 两条线。对照：Claude Code、Cursor、GitHub Copilot、Windsurf、WorkBuddy/CodeBuddy、Cline。

## 1. 判定口径

「完整」不等于功能最多，而是同时满足：

1. 有持久化真相（文件/数据库）与可恢复路径。
2. 有作用域（全局/项目/工作区/会话）与隔离。
3. 有写入治理（去重、合并、容量、失败降级）。
4. 有反馈闭环（从使用中学习，但不由模型单方面承诺）。
5. 有可观测性（统计、历史、回滚、评测）。
6. 与工具/Loop 有明确接缝，而不是孤立页面。

## 2. 对照矩阵

| 能力 | Loopsoar | Claude Code | Cursor | Copilot | Windsurf | WorkBuddy | Cline |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 持久项目指令 | AGENTS.md / CLAUDE.md 兼容 | CLAUDE.md + AGENTS.md | .cursor/rules | AGENTS.md + instructions | .windsurf/rules + AGENTS.md | Rules 文件 | .clinerules |
| 全局/用户级规则 | 全局 rules/*.md | 用户/组织 CLAUDE.md | User/Team Rules | 组织 instructions | 全局/系统规则 | 全局规则 | 全局规则 |
| 路径/按需规则 | 项目级 + 守卫编译 | .claude/rules paths | alwaysApply/globs/description | applyTo | activation modes | 多层规则 | 文件规则 |
| 自动记忆 | vault capture + 五门 + 索引 | Auto memory（MEMORY.md 200 行/25KB） | 无同等长期记忆 | Copilot Memory | Cascade Memories | Memory 每晚抽取 | Memory Bank |
| 记忆检索 | 关键词 + hash 向量；门控召回 | 记忆索引 + 语义检索 | 代码库检索 | 仓库/个人记忆 | 按相关召回 | 相关背景注入 | 文件读取 |
| 记忆治理 | 去重/合并/失效/归档/容量/回顾 | 索引压缩/清理 | 无 | Dreaming 增删改 | 手动/自动 | 用户增删改 | 手动维护 |
| 记忆评测 | memory-eval-vault（recall@1/3、MRR） | 无公开离线评测 | 无 | 产品内 | 无 | 无 | 无 |
| 规则候选 | 硬约束 + 工具失败 + 纠正 + AI 回顾 | 无候选层 | 无 | Dreaming 提案 | 无 | 无 | 无 |
| 候选证据/来源 | quote + tool failure + session | 无 | 无 | PR/会话 | 无 | 无 | 无 |
| 规则编辑/作用域 | 采纳前改写 + 项目/全局 | 手写文件 | 手写文件 | PR | 手写文件 | 手写文件 | 手写文件 |
| 规则→工具守卫 | 路径 + 包管理器命令 | hooks（需配置） | 无 | 无 | 无 | 无 | 无 |
| 冲突/重复检测 | 词法级 | 无 | 无 | 无 | 无 | 无 | 无 |
| 自检清单 | 规则投影，排除守卫/冲突 | 无 | 无 | 无 | 无 | 无 | 无 |
| 规则统计 | 注入次数 + 命中次数 | 无 | 无 | 使用分析 | 无 | 无 | 无 |
| 变更历史/回滚 | before/after 快照 + 回滚 | git 管理文件 | git | PR | git | 手动 | git |
| AI 反思 | 会话回顾候选（人工确认） | 无 | 无 | Dreaming PR | 无 | 无 | 无 |
| 多 Agent 共享 | 全局规则 + 工作区记忆；无 per-agent 命名空间 | 子 Agent 自动记忆 | 无 | 多客户端共享 | 无 | 无 | 无 |

说明：Claude 的 hooks 可以阻止动作，但不是「规则文本自动编译成守卫」；Loopsoar 的守卫是规则消费者，不需要用户另写 hook。Copilot Dreaming 可以改 instruction，但走 PR；Loopsoar 目前是候选 + 人工确认，不自动改仓库。

## 3. Loopsoar 的相对优势

1. **规则生命周期完整**：候选 → 证据 → 人工改写/选作用域 → 写入 → 守卫 → 体检 → 清单 → 统计 → 历史/回滚。主流 harness 大多停在「手写规则 + 注入」。
2. **证据链**：候选保留 quote、工具失败、会话来源；Dreaming 更自动，但边界是 PR，Loopsoar 是本地候选队列，反馈更快。
3. **可解释的守卫**：路径/命令守卫直接从规则文本编译，命中进 stats，用户能看到「哪条规则真的在拦」。
4. **记忆是文件真相**：vault + 索引 + fs.watch + 后台核对 + 迁移；比纯 JSON/数据库方案更容易备份、diff、恢复。
5. **评测可复现**：memory-eval-vault 给出 recall/MRR，不靠主观「感觉变聪明了」。

## 4. 相对不足

1. **语义检索**：hash 向量只做候选召回，跨语言/同义改写弱；Claude/Copilot 有更强的检索栈。外部 embedding（BGE-M3）仍是规划项。
2. **自动记忆的广度**：Claude 的 auto memory 会主动判断「未来是否有用」并写主题文件；Loopsoar 仍以回合捕获 + 五门为主，主动整理依赖 review/merge。
3. **多 Agent**：没有 per-agent 规则/记忆命名空间；当前运行时不具备该维度，强行加会是假功能。
4. **规则 diff 视图**：历史有 before/after 快照，UI 只显示摘要，没有 unified diff。
5. **评审闭环**：还没有把「接受的 code review comment」直接变成候选；目前靠对话/工具失败/AI 回顾。

## 5. 完整性结论

- **规则板块：完整，且在治理维度超过主流 harness。** 候选、守卫、体检、清单、统计、历史/回滚形成闭环；没有「只写不执行、只增不减、改了不能退」的缺口。
- **记忆板块：完整，检索维度与顶级 harness 仍有差距。** 存储/治理/回顾/评测闭环成立；语义召回是下一阶段的外接能力，不是当前架构缺失。
- **不会为了对齐清单而硬塞多 Agent 或自动改写规则。** 这两项需要产品维度（多 Agent 会话/团队评审）真实存在后再做。

## 6. 发布前建议

1. 跑一次 memory-eval-vault，记录 recall@1/3、MRR 作为 release note 的基线。
2. 用真实项目跑一遍「候选 → 改写 → 采纳 → 守卫命中 → 回滚」的 E2E，确认用户路径无断点。
3. 检查 stats/history 文件在升级/旧数据下的迁移（已由测试覆盖）。
4. 发布说明里明确：规则守卫是保守的路径/包管理器守卫，不是通用命令沙箱。
