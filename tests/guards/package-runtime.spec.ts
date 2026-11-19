/**
 * 产物可加载性守卫：package.json 的 exports 必须指向真实构建产物，且 Node 能直接 import。
 *
 * 为什么不能只测源码：此前 exports 指向 src/*.ts，单测（Vitest 走源码）全绿，但 `node`
 * 加载 `loopsoar-core/loop` 直接 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。这个守卫在 build 后
 * 用 file URL 逐个 import 导出文件，绕过测试解析器，验证“发布物真的能加载”。
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packages = ["core", "contracts", "services"] as const;

function exportsOf(pkg: (typeof packages)[number]): string[] {
  const manifest = JSON.parse(
    readFileSync(join(root, "packages", pkg, "package.json"), "utf8"),
  ) as { exports?: Record<string, string> };
  return Object.values(manifest.exports ?? {});
}

function exportKeysOf(pkg: (typeof packages)[number]): string[] {
  const manifest = JSON.parse(
    readFileSync(join(root, "packages", pkg, "package.json"), "utf8"),
  ) as { exports?: Record<string, string> };
  return Object.keys(manifest.exports ?? {}).map((key) => (key === "." ? `loopsoar-${pkg}` : `loopsoar-${pkg}/${key.slice(2)}`));
}

describe("构建产物可被 Node 加载（pnpm build 后）", () => {
  for (const pkg of packages) {
    it(`${pkg}: 所有 exports 指向 dist 且文件存在`, () => {
      const entries = exportsOf(pkg);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.startsWith("./dist/"), `${pkg} 的 export ${entry} 必须指向 dist`).toBe(true);
        const file = join(root, "packages", pkg, entry);
        expect(existsSync(file), `缺少构建产物：${file}`).toBe(true);
      }
    });
  }

  for (const pkg of packages) {
    it(`${pkg}: dist 入口可被 Node 原生 import`, () => {
      const specifiers = exportKeysOf(pkg);
      expect(specifiers.length).toBeGreaterThan(0);
      const script = `for (const s of ${JSON.stringify(specifiers)}) await import(s);`;
      // 真开一个 node 子进程，而不是在 Vitest 的 VM 里 import：
      // 只有原生 ESM 才能复现用户 `node -e "import('loopsoar-core/loop')"` 的场景。
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: join(root, "packages/shell"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(output).toBe("");
    });
  }
});
