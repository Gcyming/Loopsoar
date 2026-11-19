/**
 * 沙箱工作区判定：相对路径必须按工作区根解析（否则 file_write 等工具会被误判越界）。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { nodePathPort } from "../../packages/core/src/platform/node.ts";

function makeSandbox(root: string) {
  const sandbox = new SandboxManager({ workspaceRoot: root, paths: nodePathPort });
  sandbox.syncKnownTools(["file_write"]);
  return sandbox;
}

describe("沙箱 · 工作区路径判定", () => {
  it("相对路径在工作区内 → 允许进入策略判定（不因越界直接 deny）", () => {
    const root = process.cwd();
    const sandbox = makeSandbox(root);
    const decision = sandbox.checkPermission({
      agentId: "a",
      toolName: "file_write",
      target: path.join("docs", "a.md"),
      kind: "write",
    });
    expect(decision.reason).not.toContain("越界");
  });

  it("绝对路径在工作区内 → 同理", () => {
    const root = process.cwd();
    const sandbox = makeSandbox(root);
    const decision = sandbox.checkPermission({
      agentId: "a",
      toolName: "file_write",
      target: path.join(root, "docs", "a.md"),
      kind: "write",
    });
    expect(decision.reason).not.toContain("越界");
  });

  it("越出工作区的相对/绝对路径 → deny", () => {
    const root = process.cwd();
    const sandbox = makeSandbox(root);
    for (const target of ["../outside.txt", path.join(root, "..", "outside.txt")]) {
      const decision = sandbox.checkPermission({ agentId: "a", toolName: "file_write", target, kind: "write" });
      expect(decision.action).toBe("deny");
      expect(decision.reason).toContain("越出");
    }
  });
});
