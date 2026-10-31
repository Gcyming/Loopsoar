/**
 * 终端工具：真实执行一条命令，验证输出/退出码/超时/权限声明。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { registerTerminalTools } from "../../packages/shell/src/main/terminalTools.ts";

function makeTool(cwd: string) {
  const registry = new ToolRegistry();
  registerTerminalTools(registry, () => cwd);
  return registry.get("terminal_run")!;
}

describe("终端工具", () => {
  it("执行命令返回输出与退出码，声明 terminal 权限", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-term-"));
    fs.writeFileSync(path.join(cwd, "ok.mjs"), "console.log('term-ok')\n", "utf8");
    const tool = makeTool(cwd);
    expect(tool.permissions.terminal).toBe(true);
    const result = await tool.execute({ agentId: "a", params: { command: "node ok.mjs" }, platform: {} });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("term-ok");
    expect(result.content).toContain("[退出码 0]");
    try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch { /* Windows 上进程句柄释放稍慢 */ }
  }, 20000);

  it("非零退出码 → ok:false（但保留输出）", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-term-"));
    const tool = makeTool(cwd);
    const command = process.platform === "win32" ? "exit /b 3" : "exit 3";
    const result = await tool.execute({ agentId: "a", params: { command }, platform: {} });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[退出码 3]");
    try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch { /* Windows 上进程句柄释放稍慢 */ }
  }, 20000);

  it("超时命令被终止并返回超时原因", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-term-"));
    fs.writeFileSync(path.join(cwd, "hang.mjs"), "setTimeout(() => {}, 10000);\n", "utf8");
    const tool = makeTool(cwd);
    const result = await tool.execute({
      agentId: "a",
      params: { command: "node hang.mjs", timeoutMs: 1200 },
      platform: {},
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("超时");
    try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch { /* Windows 上进程句柄释放稍慢 */ }
  }, 25000);
});
