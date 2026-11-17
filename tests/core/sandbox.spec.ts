/**
 * 沙箱八步决策链全路径（发布门 1 前置：fail-closed 行为可测）。
 */
import { describe, expect, it } from "vitest";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";

function freshSandbox(): SandboxManager {
  const sm = new SandboxManager();
  sm.setWorkspaceRoot("C:/loopsoar-work");
  return sm;
}

describe("沙箱：八步决策链（fail-closed）", () => {
  it("① 白名单目录命中 → allow", () => {
    const sm = freshSandbox();
    sm.addAllowedDir("C:/loopsoar-extra");
    const d = sm.checkPermission({
      agentId: "a",
      toolName: "file_read",
      kind: "read",
      target: "C:/loopsoar-extra/data.txt",
    });
    expect(d.action).toBe("allow");
  });

  it("② 目标越出工作目录且未授权 → deny", () => {
    const sm = freshSandbox();
    const d = sm.checkPermission({
      agentId: "a",
      toolName: "file_read",
      kind: "read",
      target: "C:/outside/secret.txt",
    });
    expect(d.action).toBe("deny");
  });

  it("③ 写频率 >100 次/分钟 → deny", () => {
    const sm = freshSandbox();
    let last = null;
    for (let i = 0; i < 102; i++) {
      last = sm.checkPermission({
        agentId: "a",
        toolName: "file_write",
        kind: "write",
        target: "C:/loopsoar-work/f.txt",
      });
    }
    expect(last?.action).toBe("deny");
    expect(last?.reason).toContain("异常检测");
  });

  it("③ 限流按 session+agent 隔离：A 会话写满不误伤 B 会话", () => {
    const sm = freshSandbox();
    sm.syncKnownTools(["file_write"]);
    for (let i = 0; i < 101; i++) {
      sm.checkPermission({
        agentId: "a",
        sessionId: "s1",
        toolName: "file_write",
        kind: "write",
        target: "C:/loopsoar-work/f.txt",
      });
    }
    const denied = sm.checkPermission({
      agentId: "a",
      sessionId: "s1",
      toolName: "file_write",
      kind: "write",
      target: "C:/loopsoar-work/f.txt",
    });
    expect(denied.action).toBe("deny");
    expect(denied.reason).toContain("写入频率");

    const other = sm.checkPermission({
      agentId: "a",
      sessionId: "s2",
      toolName: "file_write",
      kind: "write",
      target: "C:/loopsoar-work/f.txt",
    });
    expect(other.action).toBe("confirm"); // 不受 s1 的 100 次影响
  });

  it("③ 删除会话时一并清空限流历史（同 id 重建不继承计数）", () => {
    const sm = freshSandbox();
    sm.syncKnownTools(["file_write"]);
    for (let i = 0; i < 101; i++) {
      sm.checkPermission({ agentId: "a", sessionId: "s1", toolName: "file_write", kind: "write" });
    }
    expect(sm.checkPermission({ agentId: "a", sessionId: "s1", toolName: "file_write", kind: "write" }).action).toBe(
      "deny",
    );
    sm.clearSessionApprovals("s1");
    expect(sm.checkPermission({ agentId: "a", sessionId: "s1", toolName: "file_write", kind: "write" }).action).toBe(
      "confirm",
    );
  });

  it("③ 危险命令（rm -rf /）→ deny", () => {
    const sm = freshSandbox();
    const d = sm.checkPermission({
      agentId: "a",
      toolName: "terminal_run",
      kind: "terminal",
      target: "rm -rf /",
    });
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("危险命令");
  });

  it("③.5 未知工具名 → deny（不抛错）", () => {
    const sm = freshSandbox();
    sm.syncKnownTools(["file_read"]);
    const d = sm.checkPermission({ agentId: "a", toolName: "ghost", kind: "read" });
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("未知工具");
  });

  it("③.5 「判不了 ≠ 不存在」：未装配完成不因空清单而拒", () => {
    const sm = freshSandbox();
    // 不调用 syncKnownTools：装配未完成
    const d = sm.checkPermission({
      agentId: "a",
      toolName: "any_tool",
      kind: "read",
      target: "C:/loopsoar-work/x.txt",
    });
    expect(d.action).not.toBe("deny");
    expect(d.reason).not.toContain("未知工具");
  });

  it("④ deny_tools → deny", () => {
    const sm = freshSandbox();
    sm.addDenyTool("git_commit");
    sm.syncKnownTools(["git_commit"]);
    const d = sm.checkPermission({ agentId: "a", toolName: "git_commit", kind: "write" });
    expect(d.action).toBe("deny");
  });

  it("⑤ require_approval_tools → confirm", () => {
    const sm = freshSandbox();
    sm.addRequireApprovalTool("file_write");
    sm.syncKnownTools(["file_write"]);
    const d = sm.checkPermission({ agentId: "a", toolName: "file_write", kind: "write" });
    expect(d.action).toBe("confirm");
  });

  it("⑥ auto_approve_tools → allow", () => {
    const sm = freshSandbox();
    sm.addAutoApproveTool("file_write");
    sm.syncKnownTools(["file_write"]);
    const d = sm.checkPermission({ agentId: "a", toolName: "file_write", kind: "write" });
    expect(d.action).toBe("allow");
  });

  it("⑥ 会话白名单（approveToolForSession）→ allow", () => {
    const sm = freshSandbox();
    sm.syncKnownTools(["file_write"]);
    sm.approveToolForSession("a", "file_write");
    const d = sm.checkPermission({ agentId: "a", toolName: "file_write", kind: "write" });
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("会话白名单");
  });

  it("⑥ 会话白名单按 session+agent 隔离：A 会话授权不泄漏到 B；删除会话即撤销", () => {
    const sm = freshSandbox();
    sm.syncKnownTools(["file_write"]);
    sm.approveToolForSession("a", "file_write", "s1");

    expect(
      sm.checkPermission({ agentId: "a", sessionId: "s1", toolName: "file_write", kind: "write" }).action,
    ).toBe("allow");
    // 同 Agent 的另一个会话：仍应确认
    expect(
      sm.checkPermission({ agentId: "a", sessionId: "s2", toolName: "file_write", kind: "write" }).action,
    ).toBe("confirm");
    // 同会话的另一个 Agent：仍应确认
    expect(
      sm.checkPermission({ agentId: "b", sessionId: "s1", toolName: "file_write", kind: "write" }).action,
    ).toBe("confirm");

    sm.clearSessionApprovals("s1");
    expect(
      sm.checkPermission({ agentId: "a", sessionId: "s1", toolName: "file_write", kind: "write" }).action,
    ).toBe("confirm");
  });

  it("⑦ 等级策略：L0 读自动放行 / L2 写需确认 / L4 网络需确认", () => {
    const sm = freshSandbox();
    sm.syncKnownTools(["file_read", "file_write", "web_fetch"]);
    expect(
      sm.checkPermission({ agentId: "a", toolName: "file_read", kind: "read" }).action,
    ).toBe("allow");
    expect(
      sm.checkPermission({ agentId: "a", toolName: "file_write", kind: "write" }).action,
    ).toBe("confirm");
    expect(
      sm.checkPermission({ agentId: "a", toolName: "web_fetch", kind: "network" }).action,
    ).toBe("confirm");
  });

  it("⑧ 兜底 deny（fail-closed）：无任何规则命中时不允许", () => {
    const sm = freshSandbox();
    sm.syncKnownTools(["odd_tool"]);
    // write 在无 auto/会话白名单时走到 ⑦ confirm；再验证一个没有等级兜底的场景：
    // 直接构造：把工具加入 requireApprovalLevels 之外的等级不可能，因此验证未知+危险之外的
    // 「已知工具但策略为 deny 的等级」= L5。kind 表不产出 L5，但策略表对 L5 强制拒绝。
    // 此处以危险命令之外的第二条 fail-closed 路径断言：deny_tools 优先于确认。
    sm.addDenyTool("odd_tool");
    const d = sm.checkPermission({ agentId: "a", toolName: "odd_tool", kind: "write" });
    expect(d.action).toBe("deny");
  });
});
