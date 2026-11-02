/**
 * 主进程打包（GUI 运行用）：
 * workspace 包在源码态通过 exports 指向 .ts（供 tsc/vitest 使用），但 Electron 的 Node 运行时只认 JS；
 * 因此用 esbuild 把 shell 主进程连同 workspace 源码打成一个 ESM 文件（electron 保持 external）。
 * 产物：packages/shell/dist/main.bundle.mjs
 */
import { execSync } from "node:child_process";
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

// gateway 的 exports 指向 dist，bundle 前先确保编译产物是最新的
execSync("pnpm --filter loopsoar-gateway build", { stdio: "inherit" });
await rmSync("packages/shell/dist/main.bundle.mjs", { force: true });

const result = await build({
  entryPoints: ["packages/shell/src/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "packages/shell/dist/main.bundle.mjs",
  // gateway 内部依赖 fastify（CJS + 动态 require）：ESM 输出里需要 createRequire 兜底
  // （否则运行时报「Dynamic require of node:events is not supported」）
  // gateway 惰性动态导入 + fastify 为 CJS：保持 external，由 Electron 从 node_modules 解析
  // （gateway 的 exports 指向 dist 编译产物；打包阶段需把 node_modules 一并分发）。
  external: ["electron", "loopsoar-gateway"],
  sourcemap: false,
  logLevel: "info",
  metafile: true,
});

const outputs = Object.values(result.metafile?.outputs ?? {});
const bytes = outputs.reduce((sum, o) => sum + o.bytes, 0);
console.log(`bundle 完成：packages/shell/dist/main.bundle.mjs（${(bytes / 1024).toFixed(1)} KB）`);

// 扩展运行时 worker 必须是独立文件（spawn 子进程用），随主包一起产出
mkdirSync("packages/shell/dist", { recursive: true });
copyFileSync("packages/shell/src/main/extensionWorker.mjs", "packages/shell/dist/extensionWorker.mjs");
copyFileSync("packages/shell/src/main/pluginWorker.mjs", "packages/shell/dist/pluginWorker.mjs");
copyFileSync("packages/shell/src/main/scriptLoopWorker.mjs", "packages/shell/dist/scriptLoopWorker.mjs");
console.log("worker 完成：packages/shell/dist/extensionWorker.mjs");
