# Worktree × Cloudflare：能否把隔离工作区搬到云端

> 2026-11-01 查证。2026-11-02 用户决定：**等 Loopsoar 0.1.0 完成后再评估云端执行器**；本地方案继续使用。计划见 `docs/规划/0.1.0后-Cloudflare-GitHub-产品化与同步.md`。结论：**本地 worktree 已实现，且不依赖 Cloudflare**。
> Cloudflare 上做"云端 worktree/远程编码环境"技术上可行，但**不是免费方案**，需要 Workers Paid 计划与账号授权；因此本轮不阻塞本地方案。

## 1. 本地 worktree（已实现）

- 每个会话可创建独立 `git worktree`：路径 `<dataDir>/worktrees/<workspaceId>/<sessionId>`，分支 `loopsoar/<sessionId>`；
- Agent 的文件写入/终端自动落在该 worktree（`resolveSessionRoot`：worktree > 会话工作区 > 活动工作区）；
- 面板支持 diff（文件 + 增删行 + commits）、合并回主工作区、清理；
- 合并前检查主工作区无未提交改动；冲突自动 abort 并列出冲突文件，不留下半合并状态。

## 2. Cloudflare 侧事实

| 能力 | 可用性 | 说明 |
|---|---|---|
| Workers（轻 API / 鉴权 / 同步） | Workers Free 可用 | 100k 请求/天、10ms CPU/请求；不能跑 Linux 命令、没有真实文件系统。 |
| D1 / R2 / KV（会话快照存储） | Free 有额度 | 与上一轮会话持久化方案相同；只适合存加密快照，不适合跑 git。 |
| **Cloudflare Sandboxes / Containers** | **仅 Workers Paid**（$5/月起） | 官方文档明确 "Available on Workers Paid plan"；容器按 vCPU/内存/磁盘计费，Free 计划无容器。 |
| Sandbox 内 Git | Workers Paid + Sandbox SDK | 支持 `gitCheckout` 克隆仓库、切分支、commit、跑命令/测试；私有仓库需 GitHub Token 或 outbound 注入。 |
| GitHub / Cloudflare 账号与人机验证 | 需用户本人 | OAuth 授权、域名 zone、付费计划都只能由账号持有人完成。 |

来源：
- [Cloudflare Sandboxes 概览（Available on Workers Paid plan）](https://developers.cloudflare.com/sandbox/)
- [Sandbox Git workflows（clone/分支/commit）](https://developers.cloudflare.com/sandbox/sdk/guides/git-workflows/)
- [Containers 定价（Free 为 N/A，Workers Paid 起步 $5/月）](https://developers.cloudflare.com/containers/platform/pricing/)
- [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

## 3. 如果未来要做"云端 worktree"

可行形态：

```
Loopsoar 桌面端
  ├─ 本地 git worktree（当前实现，默认）
  └─ 可选"云端执行器"：把当前 worktree 远端（或 GitHub 分支）交给 Cloudflare Sandbox 跑测试/构建
        Worker + Sandbox 容器：git clone / git worktree add / npm test
        结果回传（日志、失败用例、patch）
```

需要的前提：
1. 用户有 Cloudflare 账号并开通 **Workers Paid**（$5/月起，Free 无容器）；
2. 仓库有可访问的远端（GitHub 私有仓需要 token；本地独有提交需要 push 或打包上传）；
3. 用户明确授权上传源码（敏感文件/密钥必须排除）；
4. 自定义域名/OAuth 如需登录再配置。

## 4. 结论与建议

- **不把 Cloudflare 作为 worktree 的前置依赖**：本地 worktree 已完成核心价值（隔离改动、并行会话、可合并/可丢弃），且免费、离线可用。
- Cloudflare 的价值在"远程执行/CI 化/多设备"，不是 worktree 本身；等用户确认愿意开 Workers Paid + 提供仓库远端后，再做 POC。
- 若坚持免费，可替代用 GitHub Codespaces 免费额度或本机执行；不建议把 GitHub 仓库当云端 worktree 存储（见上一轮持久化文档）。
- 本轮未向 Cloudflare 发起任何请求，也未要求账号授权；需要时我会明确列出要用户完成的步骤（登录、验证、付费计划、域名 zone）。
