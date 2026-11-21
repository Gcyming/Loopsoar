/**
 * 测试环境防呆：阻止 `require("electron")` 触发二进制下载。
 *
 * 背景：pnpm 会按 peer 上下文生成多个 electron 副本（如 `electron@45.0.0_supports-color@…`），
 * 其中只有部分带 dist/path.txt。若测试间接 import 了做值导入的壳层模块（e2eHooks、
 * mainWindowFactory 等），Node 会加载 electron/index.js；它发现没有 path.txt 就 spawn
 * install.js 从 GitHub 下载——本机到 GitHub 被重置，整个测试套件会挂在这里（实测 6 分钟无进展）。
 *
 * 设置 ELECTRON_OVERRIDE_DIST_PATH 后，electron/index.js 会直接返回
 * `<该目录>/electron`，不做存在性检查、也不下载；测试只把它当路径字符串，不需要真实二进制。
 */
if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
  process.env.ELECTRON_OVERRIDE_DIST_PATH = process.cwd();
}
