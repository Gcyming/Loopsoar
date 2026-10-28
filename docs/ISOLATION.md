# 项目环境隔离（与 slime / pilot project 不串扰）

> 目的：Loopsoar 与 `D:\pilot project`（slime）同机并行开发时，**代码、数据、端口、进程、配置全部隔离**，
> 任何一方升级/崩溃/改配置都不影响另一方。硬规则由守卫测试 `tests/guards/project-isolation.spec.ts` 强制执行。

## 1. 代码隔离

| 规则 | 说明 |
|---|---|
| 不跨仓库 import | Loopsoar 源码（packages/*/src）不得 `import`/`require` 任何含 `pilot` / `slime` 的模块路径 |
| 不引用旧路径 | 源码中不得出现 `D:\pilot project` 一类旧仓库绝对路径 |
| 不共享构建产物 | 各自 `node_modules`、`dist`、锁文件独立；不共用 pnpm store 之外的任何目录 |
| 参考可以，拷贝禁止 | 允许阅读 slime 源码学习语义；实现必须按 Loopsoar 架构重写（ADR 与 S0 规格为唯一依据） |

## 2. 运行时端口（避免同机并行冲突）

| 用途 | Loopsoar | slime（避免冲突） |
|---|---|---|
| OpenAI 兼容网关 | **19210**（`LOOPSOAR_GATEWAY_PORT` 可覆盖） | 19110 / 19000 |
| 嵌入服务（llama-server embeddings） | **8991**（`createNodePlatform({ embedBaseUrl })` 可覆盖） | 8999 |
| 本地 chat 模型服务 | 由 `model_server` 动态分配时避开上述两端口区间 | 18082 + 100 区间 |

> 端口冲突属于「串扰」的典型形态：两个应用同时监听同一端口会导致 A 的请求打到 B 的实例（模型、数据、鉴权全串）。
> 守卫测试会检查源码中的默认端口不许是 slime 用过的值。

## 3. 数据与配置隔离

| 项 | Loopsoar | slime |
|---|---|---|
| Windows 用户数据根 | `%APPDATA%\loopsoar`（shell 启动时 `app.setPath("userData", ...)` 显式落位） | `%APPDATA%\slime` 等 |
| 品牌标识 | `com.loopsoar.app` / `loopsoar://` / `persist:loopsoar-browser` | `com.slime.app` / `slime://` |
| 记忆/知识目录 | `%APPDATA%\loopsoar\Knowledge`（永存双根） | 各自目录 |
| 模型文件 | 独立模型目录（不与 slime 共享加载中的 GGUF；共享只读权重文件时也要各自 llama-server 实例） | — |
| 配置/密钥 | `%APPDATA%\loopsoar\config`（加密存储），不读取 slime 配置 | — |

## 4. 进程与子代理隔离

- 子代理 `cwd` 一律为 `D:\tool\AI\real-project\Loopsoar\Parent file`，禁止写 `D:\pilot project` 下任何文件（只读参考需显式说明）。
- Loopsoar 的 Electron 进程、llama-server、gateway 进程各自命名（`loopsoar-*`），不 kill 非本项目的进程。
- 沙箱工作目录默认 `process.cwd()`（Loopsoar 仓库根），越界写默认拒绝（fail-closed）。

## 5. 守卫（CI 必跑）

`tests/guards/project-isolation.spec.ts` 断言：
1. 源码无 `pilot`/`slime` 模块导入、无旧仓库绝对路径；
2. gateway 默认端口 ≠ slime 端口且 = 19210；
3. embed 默认端口 ≠ 8999 且 = 8991；
4. shell 启动代码把 `userData` 显式落到 `DATA_DIR_NAME`（loopsoar）。
