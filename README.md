# Loopsoar

> 浏览器优先的 Agent harness（Loopsoar 基础程序框架）

一个「灵活但非常稳固」的 monorepo 骨架：契约单源、引擎纯逻辑、壳层可替换、安全 fail-closed、守卫测试先行。全部 TypeScript（严格模式），包管理器 pnpm（workspace），运行平台 Windows + Node 24。

---

## 包结构

| 包名 | 说明 | 负责人 |
|---|---|---|
| `loopsoar-contracts` | 契约单源（schema / security-policy / 生成器） | S2 |
| `loopsoar-core` | 纯逻辑引擎（零 electron 依赖） | S3 / S4 |
| `loopsoar-services` | 域服务（chat / events / 工具循环） | S5 |
| `loopsoar-shell` | Electron 壳（反 God file，域拆分） | S6 |
| `loopsoar-ui` | React 19 渲染层（Vite 构建） | S7 |

---

## 命令速查

```bash
# 安装依赖（由 S8 执行，S1 不运行）
pnpm install

# 生成契约（contracts 生成物入库）
pnpm gen

# 校验生成物一致性（不一致则退出码 1）
pnpm check

# 全包构建
pnpm build

# 全包类型检查
pnpm typecheck

# 测试（vitest workspace：packages/* + tests）
pnpm test

# Windows 内测包（NSIS 安装包 + zip + SHA256SUMS）
pnpm package:win
# 只组装运行目录（release/app），不调用 electron-builder
pnpm package:stage
```

## 打包（Windows 内测包）

- 产物目录：`release/dist/`（已 gitignore）
  - `Loopsoar-Setup-<version>.exe` — NSIS 安装包（按用户安装，可选目录）
  - `Loopsoar-<version>-win-x64.zip` — 免安装版
  - `SHA256SUMS.txt`、`RELEASE-NOTES-<version>.md`
- 配置：`electron-builder.yml`；构建脚本：`scripts/package.mjs`
- 版本单一产地：`packages/shell/src/shared/brand.ts` 的 `APP_VERSION`，根与 shell 的
  `package.json` 必须同步（`tests/shell/appVersion.spec.ts` 守门）。
- 构建中间产物放在系统临时目录：安装器构建期会执行一次安装器来生成卸载程序，
  仓库目录若带继承性 DENY ACL（受限沙箱/安全软件）会让 NSIS 报 "Error writing temporary file"。
- 上游补丁：`patches/app-builder-lib@26.18.0.patch`（说明见文件内注释）。
- 随包原生模块：`better-sqlite3`（N-API 预编译）与 `sqlite-vec`（`vec0.dll`），由 `extraResources`
  放到 `resources/native/node_modules`（asar 外）；默认仍是 flat 向量后端，设置里选择后才加载，
  失败自动降级。
- 进程树守护：`packages/shell/resources/jobGuard.exe`（源码 `packages/shell/tools/jobGuard.cs`，
  构建时用系统 `csc.exe` 编译）；强杀主进程后由 Windows Job Object 回收子进程。
- 自动更新：`electron-updater` + `latest.yml`（`publish` 配 GitHub Releases）；打包态延迟检查，
  下载/安装需用户确认。未签名构建不启用签名校验，正式启用见 `docs/发布阶段.md` §6。
- 内测包不签名；发布前跑 `docs/releases/UPGRADE-DRILL.md` 的升级/回滚演练。

## 安装与升级

- 内测用户：从 GitHub Releases 下载 `Loopsoar-Setup-<version>.exe`，核对 `SHA256SUMS.txt` 后再安装。
- **覆盖安装**（推荐）：直接运行新版本安装包，用户数据目录保留，启动时若版本变化会自动备份到
  `<数据目录>\backups\pre-<旧版本>-<时间戳>`。
- **卸载重装**：卸载只删除程序目录，默认保留 `%APPDATA%\loopsoar`（或 `LOOPSOAR_DATA_DIR`）；
  需要彻底清理时手动删除数据目录。
- **回滚**：安装旧版本安装包即可；数据兼容性由启动迁移与自动备份兜底（演练见 `docs/releases/UPGRADE-DRILL.md`）。
- 发布（维护者）：`node scripts/github-release.mjs --tag v<version> --notes docs/releases/RELEASE-NOTES-<version>.md`
  （需要 `GH_TOKEN`；会创建 GitHub Release 并上传 exe/zip/blockmap/latest.yml/SHA256SUMS）。

---

## 文档

- 规划与设定：`docs/规划/`
  - `P0-验证计划.md` — 开工前必须完成的验证工作线
  - `MVP-验收表.md` — 最小可交付版本验收标准
  - `设定-Agent-Loop与插件体系.md` — Agent-Loop 可插拔 · 万物皆插件 · 好用低门槛
  - `Loopsoar-初步项目规划.md` — v0.3/v0.2 主体规划
- 架构决策：`docs/decisions/ADR.md` — **自入库起为活文档**，根目录旧副本（若存在）仅作存档参考。

---

## 边界

- S1 只写 ROOT 根文件（本目录）、`docs/` 复制、`packages/sidecar/` 占位。
- 禁止写 `packages/contracts`、`packages/core`、`packages/services`、`packages/shell`、`packages/ui`、`tests/`（由对应子代理执行）。
- S1 不运行 `pnpm install`、不执行构建/测试（统一由 S8 完成）。
- `git init` 已在 ROOT 执行（无 commit，由 S8 统一提交）。
