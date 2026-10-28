/**
 * 主进程打包（GUI 运行用）：
 * workspace 包在源码态通过 exports 指向 .ts（供 tsc/vitest 使用），但 Electron 的 Node 运行时只认 JS；
 * 因此用 esbuild 把 shell 主进程连同 workspace 源码打成一个 ESM 文件（electron 保持 external）。
 * 产物：packages/shell/dist/main.bundle.mjs
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";

await rmSync("packages/shell/dist/main.bundle.mjs", { force: true });

const result = await build({
  entryPoints: ["packages/shell/src/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "packages/shell/dist/main.bundle.mjs",
  external: ["electron"],
  sourcemap: false,
  logLevel: "info",
  metafile: true,
});

const outputs = Object.values(result.metafile?.outputs ?? {});
const bytes = outputs.reduce((sum, o) => sum + o.bytes, 0);
console.log(`bundle 完成：packages/shell/dist/main.bundle.mjs（${(bytes / 1024).toFixed(1)} KB）`);
