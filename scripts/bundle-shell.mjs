/**
 * 主进程打包（GUI 运行用）：
 * workspace 包在源码态通过 exports 指向 .ts（供 tsc/vitest 使用），但 Electron 的 Node 运行时只认 JS；
 * 因此用 esbuild 把 shell 主进程连同 workspace 源码打成一个 ESM 文件（electron 保持 external）。
 * 产物：packages/shell/dist/main.bundle.mjs
 */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * workspace 包在 dev bundle 里直接走源码。
 *
 * 为什么必须这样做：packages/* 的 exports 指向 dist，loopsoar-core/tool_loop 这类子路径
 * 会被解析到旧 dist —— 改了 core/services 源码却打不进 bundle，界面看起来「没生效」。
 * 这里把包名映射到 packages/<pkg>/src，并把相对 .js 说明符回退到 .ts（源码内部用 .js 后缀）。
 */
const ROOT = process.cwd();
const PKG_DIR = { "loopsoar-core": "core", "loopsoar-contracts": "contracts", "loopsoar-services": "services" };
const workspaceSource = {
  name: "workspace-source",
  setup(ctx) {
    ctx.onResolve({ filter: /^loopsoar-(core|contracts|services)(\/.*)?$/ }, (args) => {
      const [pkg, ...rest] = args.path.split("/");
      const dir = PKG_DIR[pkg];
      if (!dir) return null;
      const sub = rest.join("/") || "index";
      if (pkg === "loopsoar-contracts" && sub === "ipc") {
        const ipc = path.join(ROOT, "packages/contracts/gen/ipc.ts");
        return existsSync(ipc) ? { path: ipc } : null;
      }
      const base = path.join(ROOT, "packages", dir, "src", sub);
      for (const candidate of [base + ".ts", path.join(base, "index.ts")]) {
        if (existsSync(candidate)) return { path: candidate };
      }
      return null;
    });
    // 源码内部 import "./x.js" 指向同目录 x.ts；不映射会把缺文件当成模块。
    ctx.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const absolute = path.resolve(args.resolveDir, args.path);
      if (existsSync(absolute)) return null;
      const asTs = absolute.replace(/\.js$/, ".ts");
      return existsSync(asTs) ? { path: asTs } : null;
    });
  },
};

await rmSync("packages/shell/dist/main.bundle.mjs", { force: true });

const result = await build({
  entryPoints: ["packages/shell/src/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "packages/shell/dist/main.bundle.mjs",
  external: ["electron"],
  plugins: [workspaceSource],
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
