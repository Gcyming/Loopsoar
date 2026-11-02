/**
 * 沙箱作用域根：checkPermission(req, { workspaceRoot }) 只影响本次判定，
 * 不回写实例全局根；两个不同 workspaceRoot 的判定互不影响（多会话并发工具调用的正确性基础）。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";

const GLOBAL_ROOT = path.resolve("loopsoar-test-global");
const ROOT_A = path.resolve("loopsoar-test-ws-a");
const ROOT_B = path.resolve("loopsoar-test-ws-b");

function makeSandbox(): SandboxManager {
  const sandbox = new SandboxManager();
  sandbox.setWorkspaceRoot(GLOBAL_ROOT);
  return sandbox;
}

describe("SandboxManager · 按次判定作用域根（不修改全局根）", () => {
  it("传入 workspaceRoot 时按该根判定：根内放行、根外拒绝", () => {
    const sandbox = makeSandbox();
    const inside = sandbox.checkPermission(
      { agentId: "a", toolName: "file_read", kind: "read", target: path.join(ROOT_A, "a.txt") },
      { workspaceRoot: ROOT_A },
    );
    expect(inside.action).toBe("allow");
    expect(inside.reason).not.toContain("越界");

    const outside = sandbox.checkPermission(
      { agentId: "a", toolName: "file_read", kind: "read", target: path.join(GLOBAL_ROOT, "g.txt") },
      { workspaceRoot: ROOT_A },
    );
    expect(outside.action).toBe("deny");
    expect(outside.reason).toContain("越出");
  });

  it("判定结束后全局根保持不变（后续无 opts 的判定仍按全局根）", () => {
    const sandbox = makeSandbox();
    // 先用会话 A 的根做一次判定（旧实现会 setWorkspaceRoot(ROOT_A)）
    sandbox.checkPermission(
      { agentId: "a", toolName: "file_read", kind: "read", target: path.join(ROOT_A, "a.txt") },
      { workspaceRoot: ROOT_A },
    );
    // 全局根仍是 GLOBAL_ROOT：全局根内的目标不应被判越界
    const globalDecision = sandbox.checkPermission({
      agentId: "a",
      toolName: "file_read",
      kind: "read",
      target: path.join(GLOBAL_ROOT, "g.txt"),
    });
    expect(globalDecision.reason).not.toContain("越界");
    expect(globalDecision.action).toBe("allow");
    // 反过来：A 的根内目标在无 opts 时属于越界（证明没有被污染成 ROOT_A）
    const aDecision = sandbox.checkPermission({
      agentId: "a",
      toolName: "file_read",
      kind: "read",
      target: path.join(ROOT_A, "a.txt"),
    });
    expect(aDecision.action).toBe("deny");
    expect(aDecision.reason).toContain("越出");
  });

  it("两个不同 workspaceRoot 交替判定互不影响（并发会话不串根）", () => {
    const sandbox = makeSandbox();
    const targetA = path.join(ROOT_A, "a.txt");
    const targetB = path.join(ROOT_B, "b.txt");
    for (let i = 0; i < 20; i += 1) {
      const a = sandbox.checkPermission(
        { agentId: "a", toolName: "file_read", kind: "read", target: targetA },
        { workspaceRoot: ROOT_A },
      );
      const b = sandbox.checkPermission(
        { agentId: "b", toolName: "file_read", kind: "read", target: targetB },
        { workspaceRoot: ROOT_B },
      );
      // 交叉访问必须被拒（A 的目标不能用 B 的根放行）
      const crossed = sandbox.checkPermission(
        { agentId: "a", toolName: "file_read", kind: "read", target: targetA },
        { workspaceRoot: ROOT_B },
      );
      expect(a.action).toBe("allow");
      expect(b.action).toBe("allow");
      expect(crossed.action).toBe("deny");
      expect(crossed.reason).toContain("越出");
    }
  });

  it("相对路径按作用域根解析（含 ../ 越界拒绝）", () => {
    const sandbox = makeSandbox();
    const ok = sandbox.checkPermission(
      { agentId: "a", toolName: "file_write", kind: "write", target: path.join("docs", "a.md") },
      { workspaceRoot: ROOT_A },
    );
    expect(ok.reason).not.toContain("越界");

    const escape = sandbox.checkPermission(
      { agentId: "a", toolName: "file_write", kind: "write", target: path.join("..", "outside.txt") },
      { workspaceRoot: ROOT_A },
    );
    expect(escape.action).toBe("deny");
    expect(escape.reason).toContain("越出");
  });

  it("空/空白 workspaceRoot 视为未传：回退全局根（fail-safe）", () => {
    const sandbox = makeSandbox();
    for (const workspaceRoot of ["", "   "]) {
      const globalDecision = sandbox.checkPermission(
        {
          agentId: "a",
          toolName: "file_read",
          kind: "read",
          target: path.join(GLOBAL_ROOT, "g.txt"),
        },
        { workspaceRoot },
      );
      expect(globalDecision.reason).not.toContain("越界");
      const aDecision = sandbox.checkPermission(
        { agentId: "a", toolName: "file_read", kind: "read", target: path.join(ROOT_A, "a.txt") },
        { workspaceRoot },
      );
      expect(aDecision.action).toBe("deny");
    }
  });

  it("setWorkspaceRoot 兼容性保留：无 opts 时仍按最后设置的全局根判定", () => {
    const sandbox = new SandboxManager();
    sandbox.setWorkspaceRoot(ROOT_B);
    const inside = sandbox.checkPermission({
      agentId: "a",
      toolName: "file_read",
      kind: "read",
      target: path.join(ROOT_B, "b.txt"),
    });
    expect(inside.action).toBe("allow");
  });
});
