# Loopsoar

> 浏览器优先的 Agent harness（Loopsoar 基础程序框架）

一个「灵活但非常稳固」的 monorepo 骨架：契约单源、引擎纯逻辑、壳层可替换、安全 fail-closed、守卫测试先行。全部 TypeScript（严格模式），包管理器 pnpm（workspace），运行平台 Windows + Node 24。

---

## 包结构

| 包名 | 说明 | 负责人 |
|---|---|---|
| `loopsoar-contracts` | 契约单源（schema / security-policy / 生成器） | S2 |
| `loopsoar-core` | 纯逻辑引擎（零 electron 依赖） | S3 / S4 |
| `loopsoar-services` | 域服务（chat / engine / 工具循环） | S5 |
| `loopsoar-shell` | Electron 壳（反 God file，域拆分） | S6 |
| `loopsoar-ui` | React 19 渲染层（Vite 构建） | S7 |
| `loopsoar-sidecar` | 二进制侧车打包装配（P9 实现） | S1 |

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
```

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
