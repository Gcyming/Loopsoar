/**
 * 守卫：契约生成物与生成器逐字节一致（契约单源）。
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

describe("守卫：契约单源同步", () => {
  it("pnpm --filter loopsoar-contracts check 通过（生成物与生成器一致）", () => {
    const cwd = process.cwd();
    try {
      const out = execFileSync("pnpm --filter loopsoar-contracts check", {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
        shell: true, // Windows 下经 cmd 解析 pnpm.cmd
      });
      expect(out).toContain("校验通过");
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        `契约校验失败：\n${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`,
      );
    }
  }, 150_000);
});
