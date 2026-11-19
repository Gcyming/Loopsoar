# 外层容器清点与归档建议（2026-11-19）

> 仓库真实根：`D:\tool\AI\real-project\Loopsoar\Parent file`。
> 外层 `D:\tool\AI\real-project\Loopsoar` 只是容器目录。本文件是执行前的清点与建议；**执行记录见 §0**，历史清单保留作对照。

## 0. 执行记录（2026-11-19 20:22）

- 已归档：`前期准备工作/`、旧 `docs/`、旧 `e2e-evidence/`、`Parent%20file/` → `_archive-2026-11-19.tar.gz`（131MB，746 条目，已 `tar -tzf` 验证可读）。
- 已删除：上述已归档目录、`.tmp/`、`.tmp-chrome*/`（4 个）、空 `packages/`、空 `loopsoar download/`、外层空 `.git/`。
- 已保留：`Parent file/`（真实仓库）、`loopsoar webfrontenddev/`、`.memsearch/`、`.slime/`、`.pnpm-store/`、`icon/`、`IDEA.md`、`icon-512.png`、`audit-fixes-2026-11-19.patch`、归档包。

## 1. 清点

| 路径 | 大小 | 内容 | 建议 |
| --- | --- | --- | --- |
| `Parent file/` | — | **真实仓库**（git 仓库根） | 保留 |
| `loopsoar webfrontenddev/` | 1.3M | 官网静态站产物（index/docs/changelog 等） | 保留（独立交付物） |
| `前期准备工作/` | 3.2M | 立项前调研/命名/借鉴资料 | 已归档并删除（历史资料） |
| `docs/` | 52K | 旧文档快照（4 个文件，与仓库 docs 重复） | 已归档并删除 |
| `e2e-evidence/` | 133M | 旧 E2E 截图（仓库内已有新的 e2e-evidence） | 已归档并删除 |
| `.tmp/` | 379M | 临时脚本/探针/中间产物 | 已删除 |
| `.tmp-chrome*/`（4 个） | 159M | E2E 用 Chrome profile 缓存 | 已删除 |
| `.git/` | 80K | 空仓库（**没有任何 commit**） | 已删除（空仓库，无 commit） |
| `.memsearch/` | 44K | 记忆插件数据 | 保留 |
| `.pnpm-store/` | 8K | 旧 pnpm store 缓存 | 保留（体积很小） |
| `.slime/` | 4K | 旧记忆笔记 | 保留（数据文件） |
| `packages/` | 0 | 空骨架目录 | 已删除 |
| `loopsoar download/` | 0 | 空目录 | 已删除 |
| `Parent%20file/` | 10K | URL 编码残留（`.tmp-bench` 数据） | 已归档并删除 |
| `icon/` | 883K | 品牌资源 | 保留 |
| `IDEA.md`、`icon-512.png` | 25K | 项目一句话定位 / 图标 | 保留 |

## 2. 执行命令（已执行，保留作记录）

```bash
cd "D:/tool/AI/real-project/Loopsoar"

# ① 先归档（不删）：历史资料 + 旧文档 + 旧 E2E 证据
tar -czf "_archive-2026-11-19.tar.gz" "前期准备工作" "docs" "e2e-evidence" "Parent%20file"

# ② 确认归档可解开后再删
tar -tzf "_archive-2026-11-19.tar.gz" | head

# ③ 临时目录可直接删（不归档）
rm -rf .tmp .tmp-chrome .tmp-chrome-qa .tmp-chrome-qa2 .tmp-chrome-qa3
```

## 3. 明确不做

- 不删除/移动 `Parent file`（仓库本体）、`loopsoar webfrontenddev`（官网产物）、`IDEA.md`、`icon-512.png`；
- 不动 `.memsearch`（记忆数据）；
- 外层 `.git` 是空仓库，删除与否单独确认（它不影响 `Parent file/.git`）。
