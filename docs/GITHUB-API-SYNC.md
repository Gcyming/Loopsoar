# GitHub API 发布（网络受限时的推送通道）

本机到 GitHub 的 `git-receive-pack` 会被网络重置（`git push` 报
`Empty reply from server` / `Connection was reset`），但 GitHub REST API 可用。
`scripts/github-api-sync.mjs` 通过 Git Data API 发布**已经提交的本地历史**，
不依赖 `git push`。

## 使用

```bash
# token 只放在环境变量；不要写进仓库或命令行历史
export GH_TOKEN="$(gh auth token)"     # 或手动设置 GH_TOKEN / GITHUB_TOKEN
pnpm push:api                          # 发布当前分支到 origin 对应仓库
pnpm push:api --dry-run                # 只显示将要发布的提交
```

可选环境变量：

| 变量 | 默认 | 用途 |
|---|---|---|
| `LOOPSOAR_GITHUB_REPO` | 从 `origin` 解析 | `owner/repo` |
| `LOOPSOAR_GITHUB_BRANCH` | 当前分支 | 远端目标分支 |

## 行为与边界

1. 要求工作树干净（或显式 `--allow-dirty`）；脚本只发布 **HEAD 里的提交**，未提交修改不会被上传。
2. 要求远端分支当前 head 是本地 HEAD 的祖先；若分叉则直接失败，**从不 force push**。
3. 按本地提交顺序逐个创建 blob/tree/commit，并校验 GitHub 返回的 commit SHA 与本地完全一致；不一致就停止，不更新 ref。
4. 支持普通单 parent commit；merge commit、子模块/目录变更会明确拒绝。
5. 成功后同步更新本地 `origin/<branch>` tracking ref，便于下一次发布。

首次把 API 生成的 squash 远端与本地历史对齐时，旧本地历史保留在
`pre-api-sync-2026-11-20` tag；之后从对齐后的 head 继续提交即可。

## 验证

```bash
node --check scripts/github-api-sync.mjs
pnpm push:api --dry-run
```
