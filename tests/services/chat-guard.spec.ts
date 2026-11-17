import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InternalToolExecutor, PermRequestBus } from "../../packages/services/src/chat.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { DEFAULT_PERMISSIONS } from "../../packages/core/src/permissions.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function makeExecutor(guard?: (input: { target?: string; toolName: string; args: Record<string, unknown>; sessionId: string; kind?: string; workspaceRoot?: string }) => { action: "allow" | "deny"; reason?: string } | null) {
  const root = mkdtempSync(path.join(tmpdir(), "loopsoar-guard-"));
  const sandbox = new SandboxManager();
  sandbox.setWorkspaceRoot(root);
  const registry = new ToolRegistry();
  let executed = 0;
  registry.register({
    name: "write_file",
    description: "test write",
    permissions: { write: true },
    schema: z.object({ path: z.string() }),
    execute: async () => {
      executed += 1;
      return { ok: true, content: "written" };
    },
  });
  const executor = new InternalToolExecutor({
    registry,
    sandbox,
    resolveWorkspaceRoot: () => root,
    permissionPolicy: () => ({ ...DEFAULT_PERMISSIONS, write: "allow" as const }),
    permBus: new PermRequestBus(1_000),
    agentId: "tester",
    sessionId: "s1",
    guardToolCall: guard,
  });
  return { executor, executed: () => executed, root };
}

describe("规则守卫进入工具执行闸", () => {
  it("规则 deny → 工具不执行，返回 rule-denied", async () => {
    let seen = "";
    const { executor, executed, root } = makeExecutor((input) => {
      seen = input.target ?? "";
      return input.target?.includes("dist")
        ? { action: "deny", reason: "不要修改 dist/" }
        : null;
    });
    const result = await executor.invoke({ name: "write_file", args: { path: path.join(root, "dist/app.js") } });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("rule-denied");
    expect(result.content).toContain("规则禁止");
    expect(executed()).toBe(0);
    expect(seen).toBe(path.join(root, "dist/app.js"));
  });

  it("未命中规则 → 正常执行", async () => {
    const { executor, executed, root } = makeExecutor((input) =>
      input.target?.includes("dist") ? { action: "deny", reason: "x" } : null,
    );
    const result = await executor.invoke({ name: "write_file", args: { path: path.join(root, "src/app.ts") } });
    expect(result.ok, result.content).toBe(true);
    expect(executed()).toBe(1);
  });

  it("没有注入守卫 → 行为不变", async () => {
    const { executor, executed, root } = makeExecutor();
    const result = await executor.invoke({ name: "write_file", args: { path: path.join(root, "dist/app.js") } });
    expect(result.ok, result.content).toBe(true);
    expect(executed()).toBe(1);
  });
});
