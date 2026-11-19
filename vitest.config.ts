/**
 * Resolve workspace packages back to their source files during Vitest runs.
 * Production package exports point at dist (see package-runtime guard); tests
 * must exercise current src, otherwise stale dist can produce false green.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const packages: Record<string, { src: string; extra?: Record<string, string> }> = {
  "loopsoar-core": { src: path.join(root, "packages/core/src") },
  "loopsoar-services": { src: path.join(root, "packages/services/src") },
  "loopsoar-contracts": {
    src: path.join(root, "packages/contracts/src"),
    extra: { ipc: path.join(root, "packages/contracts/gen/ipc.ts") },
  },
};

function resolveSource(specifier: string): string | null {
  for (const [name, entry] of Object.entries(packages)) {
    if (specifier === name) {
      const index = path.join(entry.src, "index.ts");
      return fs.existsSync(index) ? index : null;
    }
    if (!specifier.startsWith(`${name}/`)) continue;
    const subpath = specifier.slice(name.length + 1);
    const extra = entry.extra?.[subpath];
    if (extra && fs.existsSync(extra)) return extra;
    const candidates = [
      path.join(entry.src, `${subpath}.ts`),
      path.join(entry.src, subpath, "index.ts"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  return null;
}

export default defineConfig({
  ssr: { noExternal: [/^loopsoar-/] },
  test: {
    server: {
      deps: {
        // 关键：否则 Vite 会把 workspace 包当外部依赖，直接 require 其 dist，
        // 导致“测试跑源码”的承诺失效（改源码后仍测旧产物）。
        inline: [/^loopsoar-/],
      },
    },
  },
  resolve: {
    // alias 必须覆盖嵌套依赖（仅靠 resolveId 插件时，shell 源码里的包名仍可能被 Vite
    // 外部化到 dist）；顺序敏感：先精确子路径，再包名。
    alias: [
      { find: /^loopsoar-contracts\/ipc$/, replacement: path.join(root, "packages/contracts/gen/ipc.ts") },
      { find: /^loopsoar-contracts$/, replacement: path.join(root, "packages/contracts/src/index.ts") },
      { find: /^loopsoar-contracts\/(.*)$/, replacement: `${path.join(root, "packages/contracts/src")}/$1` },
      { find: /^loopsoar-core$/, replacement: path.join(root, "packages/core/src/index.ts") },
      { find: /^loopsoar-core\/(.*)$/, replacement: `${path.join(root, "packages/core/src")}/$1` },
      { find: /^loopsoar-services$/, replacement: path.join(root, "packages/services/src/index.ts") },
      { find: /^loopsoar-services\/(.*)$/, replacement: `${path.join(root, "packages/services/src")}/$1` },
    ],
  },
  plugins: [
    {
      name: "loopsoar-workspace-source",
      enforce: "pre",
      resolveId(source) {
        return resolveSource(source);
      },
    },
  ],
});
