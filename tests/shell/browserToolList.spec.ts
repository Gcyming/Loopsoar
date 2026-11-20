/**
 * 守卫：浏览器工具名单「单一产地」（第二阶段 Slice A）。
 *
 * contracts.BROWSER_AGENT_TOOLS 是会话「浏览器控制」剔除的名单；
 * browserTools(.ts 与 browserTools/ 目录) 是真正注册工具的地方——两边只要漂移一个名字，
 * 就会出现「开关关了但某个 browser_* 仍然可见」的静默漏洞。
 *
 * 扫描范围跟随目录结构：工具族按 nav/interact/capture 拆分后仍全部被这条守卫覆盖，
 * 新加一族只要落在这个目录里就自动受约束（拆文件不能成为绕过守卫的方式）。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BROWSER_AGENT_TOOLS } from "../../packages/contracts/src/schemas.ts";

const MAIN = path.join(process.cwd(), "packages/shell/src/main");

/** browserTools.ts + browserTools/*.ts + browserDataTools.ts（注册浏览工具的完整集合）。 */
function browserToolSources(): string[] {
  const files = [path.join(MAIN, "browserTools.ts"), path.join(MAIN, "browserDataTools.ts")];
  const dir = path.join(MAIN, "browserTools");
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (/\.(ts|tsx)$/.test(entry.name)) files.push(path.join(dir, entry.name));
  }
  return files.map((file) => readFileSync(file, "utf8"));
}

describe("守卫：浏览器工具名单单源", () => {
  it("browserTools 注册名与 BROWSER_AGENT_TOOLS 完全一致", () => {
    const source = browserToolSources().join("\n");
    const registered = [...source.matchAll(/name:\s*"(browser_[a-z_]+)"/g)].map((match) => match[1]);
    expect(registered.length).toBeGreaterThan(0);
    expect(new Set(registered)).toEqual(new Set(BROWSER_AGENT_TOOLS));
  });

  it("web_fetch 不在浏览器名单里（网络权限域，不随开关）", () => {
    expect(BROWSER_AGENT_TOOLS).not.toContain("web_fetch");
  });
});

