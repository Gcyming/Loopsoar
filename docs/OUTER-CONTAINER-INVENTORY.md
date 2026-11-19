# 外层容器清点与归档建议（2026-11-19）

> 仓库真实根：`D:\tool\AI\real-project\Loopsoar\Parent file`。
> 外层 `D:\tool\AI\real-project\Loopsoar` 只是容器目录，**本轮不删除、不移动任何文件**，只给清单与建议。
> 为什么不自动做：handoff §3 P3-2 要求「先确认哪些是历史备份」，删除/移动外层文件不属于代码改动，误删不可恢复。

## 1. 清点

| 路径 | 大小 | 内容 | 建议 |
| --- | --- | --- | --- |
| `Parent file/` | — | **真实仓库**（git 仓库根） | 保留 |
| `loopsoar webfrontenddev/` | 1.3M | 官网静态站产物（index/docs/changelog 等） | 保留（独立交付物） |
| `前期准备工作/` | 3.2M | 立项前调研/命名/借鉴资料 | 归档后删（历史资料） |
| `docs/` | 52K | 旧文档快照（4 个文件，与仓库 docs 重复） | 归档后删 |
| `e2e-evidence/` | 133M | 旧 E2E 截图（仓库内已有新的 e2e-evidence） | 归档后删 |
| `.tmp/` | 379M | 临时脚本/探针/中间产物 | 可直接删（无源码价值） |
| `.tmp-chrome*/`（4 个） | 159M | E2E 用 Chrome profile 缓存 | 可直接删（下次运行会重建） |
| `.git/` | 80K | 空仓库（**没有任何 commit**） | 建议删，避免误以为外层是仓库 |
| `.memsearch/` | 44K | 记忆插件数据 | 保留 |
| `.pnpm-store/`、`.slime/`、`packages/`、`icon/`、`loopsoar download/`、`Parent%20file/` | 0–956K | 空目录 / URL 编码残留（`Parent%20file` 只有 .tmp-bench 数据） | 确认后删（`icon` 有品牌资源，先看再删） |
| `IDEA.md`、`icon-512.png` | 25K | 项目一句话定位 / 图标 | 保留 |

## 2. 建议操作（需你确认后执行）

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
