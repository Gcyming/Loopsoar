# ADR-0015 工作区（挂载项目文件夹）+ 会话级 Git Worktree

- **背景**：2026-11-01 用户要求新建"工作区"：专门挂载指定工作文件夹（主项目区域）；参考 slime 的成品，同时构建 Loopsoar 自己的设计。并要求对标主流 Agent 更新 worktree，优化 vibe coding 体验。用户还提出可查证 worktree 能否与 Cloudflare 结合；若结合则先做 Cloudflare。
- **调研**：
  - slime：工作区 = 按项目文件夹分组的会话列表；新会话先选文件夹再选 Agent；右侧栏基于该文件夹提供文件/Git/终端；其 worktree 主要用于 Swarm 子 Worker 隔离（`.slime-worktrees/<session>/<worker>`），不是面向用户的会话级隔离。
  - 主流：Cursor 3 提供 `/worktree` 与 `/best-of-n`（每个任务一个隔离 worktree，可并行比较）；Claude Code 支持 worktree 并行会话；Codex 的云端环境也以 git worktree 为隔离单位。
  - Cloudflare：Sandboxes/Containers 仅 Workers Paid；免费 Workers 无文件系统/无法执行 git。结论：本地 worktree 不依赖 Cloudflare；云端执行器需付费计划与用户账号/仓库远端，本轮不推进。
- **决策**：
  1. **工作区是一等实体**：`WorkspaceStore` 持久化 `{id,name,root}` 与 activeId；一个工作区挂载一个本地项目文件夹，不复制/不移动文件。
  2. **会话归属工作区**：`PersistedSession.workspaceId`；新建会话继承当前活动工作区；旧会话首次打开补绑；切换会话时活动工作区跟随该会话。UI 侧栏显示当前会话的工作区，工作区面板可挂载/切换/删除（有会话绑定时拒绝删除）。
  3. **会话工作根解析单一产地**：`resolveSessionRoot` = 会话 worktree（存在）> 会话工作区 > 活动工作区 > 兜底；文件/终端工具与沙箱权限每次按 `ctx.sessionId` 解析，后台会话不串根。
  4. **worktree 面向每个会话**：`git worktree add -b loopsoar/<session>` 到 `<dataDir>/worktrees/<workspaceId>/<sessionId>`；Agent 后续文件/终端自动落在 worktree；支持 diff（文件/行数/提交）、合并回主工作区、清理；只操作 `loopsoar/*` 分支且路径必须在管理目录内。
  5. **合并安全**：主工作区有未提交改动拒绝合并；worktree 先提交再 `--no-ff` 合并；冲突自动 `merge --abort` 并返回冲突文件，不留半合并状态；清理默认 force 删除 worktree+branch（UI 二次确认）。
  6. **本地优先，Cloudflare 后置**：worktree 核心不依赖网络；云执行器（Sandbox）仅作为未来选项，需 Workers Paid + 账号 + 仓库远端，未获用户批准不实现。
- **理由**：工作区解决"项目根目录与上下文"问题，worktree 解决"多会话并行改动互不污染"问题；两者通过"会话→工作区→worktree"的单一解析链结合，避免再出现全局 workspaceRoot 被后台会话改写的串台。Git CLI 是跨平台、可审计的最小实现；不自研 worktree 存储。
- **替代方案**：
  - 一个会话复制一份完整仓库——被否（磁盘/索引成本高，且不是 git 语义）；
  - 全局单工作区 + 每会话分支——被否（切换分支影响用户当前文件）；
  - 只做 UI 分组、不隔离文件——被否（Agent 并行会互相覆盖）；
  - 先做 Cloudflare 远程 worktree——被否（需付费计划/账号，且本地核心价值未落地）。
- **验证方式**：`workspaceStore.spec.ts`（挂载/去重/删除）、`gitWorktree.spec.ts`（创建/隔离 diff/合并/清理/脏主仓拒绝）、`workspaceRoot.spec.ts`（优先级/回退）、`fileTools.spec.ts`（按会话根写入）、全量单测/typecheck/gen/check/build；E2E 证据 `gui-89-workspace-panel.png`、`gui-90-worktree-created.png`。
- **状态**：✅ 工作区 + 会话级 worktree 已实现（本地）；🟡 Cloudflare 云端执行器未实现（有意后置，见 `docs/research/worktree-cloudflare.md`）
- **回退条件**：若 Git worktree 在 Windows 长路径/权限场景出现不可修复问题，降级为"每会话独立分支 + 临时目录复制"；工作区与根解析规则不变。
- **复核时间**：云端执行器立项前 / 多工作区并行任务上线前
