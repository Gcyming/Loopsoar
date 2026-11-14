/**
 * 守卫：浏览器工具名单「单一产地」（第二阶段 Slice A）。
 *
 * contracts.BROWSER_AGENT_TOOLS 是会话「浏览器控制」剔除的名单；
 * browserTools.ts 是真正注册工具的地方——两边只要漂移一个名字，
 * 就会出现「开关关了但某个 browser_* 仍然可见」的静默漏洞。
 * 本片不改 browserTools.ts 行为，只用守卫把两边钉在一起。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BROWSER_AGENT_TOOLS } from "../../packages/contracts/src/schemas.ts";

describe("守卫：浏览器工具名单单源", () => {
  it("browserTools.ts 的注册名与 BROWSER_AGENT_TOOLS 完全一致", () => {
    const source = readFileSync(
      path.join(process.cwd(), "packages/shell/src/main/browserTools.ts"),
      "utf8",
    );
    const registered = [...source.matchAll(/name:\s*"(browser_[a-z_]+)"/g)].map((match) => match[1]);
    expect(registered.length).toBeGreaterThan(0);
    expect(new Set(registered)).toEqual(new Set(BROWSER_AGENT_TOOLS));
  });

  it("web_fetch 不在浏览器名单里（网络权限域，不随开关）", () => {
    expect(BROWSER_AGENT_TOOLS).not.toContain("web_fetch");
  });
});
