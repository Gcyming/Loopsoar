/**
 * 守卫：裸 ipcMain.handle 只允许白名单例外。
 *
 * 受信通道必须经 handleTrusted（契约 manifest + 来源 + zod + 审计）。
 * 唯一例外是浏览器页 preload 的应用商店安装通道：发送帧来自网页而不是 loopsoar://，
 * 因此由 index.ts 自己校验「发送者必须是浏览器标签页」。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const ALLOWED = new Set(["packages/shell/src/main/index.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path.join(dir, entry.name)));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}

describe("守卫：裸 ipcMain.handle 白名单", () => {
  it("只有 index.ts 允许注册非受信通道", () => {
    const hits = sourceFiles(path.join(ROOT, "packages/shell/src"))
      .flatMap((file) => {
        const relative = path.relative(ROOT, file).replaceAll("\\", "/");
        const text = readFileSync(file, "utf8");
        return [...text.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)].map((match) => ({
          file: relative,
          channel: match[1],
        }));
      })
      .filter((hit) => !ALLOWED.has(hit.file));

    expect(hits, hits.map((hit) => `${hit.file}: ${hit.channel}`).join("\n")).toEqual([]);
  });
});
