/**
 * 守卫：契约生成物与生成器逐字节一致（契约单源）。
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const GEN_FILES = ["ipc-manifest.json", "ipc.ts", "security-policy.json"] as const;
const digest = (file: string): string =>
  createHash("sha256").update(readFileSync(path.join(ROOT, "packages/contracts/gen", file))).digest("hex");

describe("守卫：契约单源同步", () => {
  it("pnpm --filter loopsoar-contracts check 通过（生成物与生成器一致，且不改写 gen/）", () => {
    const before = GEN_FILES.map(digest);
    const cwd = process.cwd();
    try {
      const out = execFileSync("pnpm --filter loopsoar-contracts check", {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
        shell: true, // Windows 下经 cmd 解析 pnpm.cmd
      });
      expect(out).toContain("校验通过");
      expect(GEN_FILES.map(digest)).toEqual(before);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        `契约校验失败：\n${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`,
      );
    }
  }, 150_000);
});
