/**
 * Vitest workspace source resolution.
 *
 * Vitest 在存在 `vitest.workspace.ts` 时不会应用根 `vitest.config.ts`，所以这套
 * 解析必须由 workspace 的 project 直接引用；否则 shell 源码里的 `loopsoar-core/*`
 * 仍会被 Vite 外部化到旧 dist，出现“改源码、测试仍跑产物”的假绿。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.dirname(fileURLToPath(import.meta.url));

const packages: Record<string, { src: string; extra?: Record<string, string> }> = {
  "loopsoar-core": { src: path.join(root, "packages/core/src") },
  "loopsoar-services": { src: path.join(root, "packages/services/src") },
  "loopsoar-contracts": {
    src: path.join(root, "packages/contracts/src"),
    extra: { ipc: path.join(root, "packages/contracts/gen/ipc.ts") },
  },
};

export const aliases = [
  { find: /^loopsoar-contracts\/ipc$/, replacement: path.join(root, "packages/contracts/gen/ipc.ts") },
  { find: /^loopsoar-contracts$/, replacement: path.join(root, "packages/contracts/src/index.ts") },
  { find: /^loopsoar-contracts\/(.*)$/, replacement: `${path.join(root, "packages/contracts/src")}/$1` },
  { find: /^loopsoar-core$/, replacement: path.join(root, "packages/core/src/index.ts") },
  { find: /^loopsoar-core\/(.*)$/, replacement: `${path.join(root, "packages/core/src")}/$1` },
  { find: /^loopsoar-services$/, replacement: path.join(root, "packages/services/src/index.ts") },
  { find: /^loopsoar-services\/(.*)$/, replacement: `${path.join(root, "packages/services/src")}/$1` },
];

export function resolveSource(specifier: string): string | null {
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

export const sourcePlugin = {
  name: "loopsoar-workspace-source",
  enforce: "pre" as const,
  resolveId(source: string) {
    return resolveSource(source);
  },
};
