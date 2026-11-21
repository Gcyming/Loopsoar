/**
 * 主进程打包（GUI 运行用）：
 * workspace 包在源码态通过 exports 指向 .ts（供 tsc/vitest 使用），但 Electron 的 Node 运行时只认 JS；
 * 因此用 esbuild 把 shell 主进程连同 workspace 源码打成一个 ESM 文件（electron 保持 external）。
 * 产物：packages/shell/dist/main.bundle.mjs
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

await rmSync("packages/shell/dist/main.bundle.mjs", { force: true });

const result = await build({
  entryPoints: ["packages/shell/src/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "packages/shell/dist/main.bundle.mjs",
  external: ["electron"],
  // electron-updater / builder-util-runtime 是 CJS，内部有动态 require("events") 之类；
  // ESM bundle 里没有 require，esbuild 的 __require 会直接抛 "Dynamic require ... is not supported"。
  // 用 createRequire 在 bundle 顶部补出真正的 require，__require 检测到后就会走它。
  banner: {
    js: 'import { createRequire as __loopsoarCreateRequire } from "node:module"; const require = __loopsoarCreateRequire(import.meta.url);',
  },
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
copyFileSync("packages/shell/src/main/scriptLoopWorker.mjs", "packages/shell/dist/scriptLoopWorker.mjs");
console.log("worker 完成：packages/shell/dist/extensionWorker.mjs");
