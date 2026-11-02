/**
 * 敏感步骤写死确认（执行器级）：即使权限策略 = allow、沙箱 = allow，登录/支付/不可撤销动作
 * 也必须经过一次 PermRequestBus 挂起确认；`sensitiveAlwaysConfirm: false` 时才退回纯类别策略。
 *
 * 为什么不用 ChatService.stream 走完整链路：本测试要精确断言「是否弹确认、确认原因、会话白名单是否被写入」，
 * 直接测 InternalToolExecutor 更快也更确定（不依赖 LLM 脚本与事件合批）。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatService, InternalToolExecutor, PermRequestBus, type PermissionRequestEvent } from "../../packages/services/src/chat.ts";
import { MockLlmClient } from "../../packages/core/src/llm/index.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager } from "../../packages/core/src/sandbox.ts";
import { createNodePlatform } from "../../packages/core/src/platform/node.ts";
import type { Permissions } from "../../packages/core/src/permissions.ts";

/** 全 allow 策略：证明敏感步骤的确认不是来自类别策略。 */
function allowAllPolicy(): Permissions {
  return {
    read: "allow",
    write: "allow",
    terminal: "allow",
    network: "allow",
    workspaceRoots: [],
    confirmDangerousAlways: false,
  };
}

/** 全 allow 沙箱（真实沙箱语义由 core/sandbox 单测覆盖），并记录会话白名单写入。 */
function allowSandbox(): { sandbox: SandboxManager; approved: string[] } {
  const approved: string[] = [];
  const sandbox = {
    checkPermission: () => ({ action: "allow" as const, level: 4, reason: "test allow" }),
    approveToolForSession: (_agentId: string, toolName: string) => {
      approved.push(toolName);
    },
  } as unknown as SandboxManager;
  return { sandbox, approved };
}

function makeRegistry(onClick?: () => void): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "browser_click",
    description: "点击页面元素",
    permissions: { network: true },
    schema: z.object({ target: z.string() }),
    execute: async () => {
      onClick?.();
      return { ok: true, content: "clicked" };
    },
  });
  registry.register({
    name: "terminal_run",
    description: "执行命令",
    permissions: { terminal: true },
    schema: z.object({ command: z.string() }),
    execute: async () => ({ ok: true, content: "ran" }),
  });
  registry.register({
    name: "file_read",
    description: "读取文件",
    permissions: { read: true },
    schema: z.object({ path: z.string() }),
    execute: async () => ({ ok: true, content: "read" }),
  });
  return registry;
}

interface Harness {
  executor: InternalToolExecutor;
  permBus: PermRequestBus;
  approved: string[];
  requests: PermissionRequestEvent[];
}

function makeExecutor(opts: { sensitiveAlwaysConfirm?: () => boolean } = {}): Harness {
  const registry = makeRegistry();
  const { sandbox, approved } = allowSandbox();
  const permBus = new PermRequestBus(80); // 极短超时：若测试漏 resolve，快速 deny 而不是挂 300s
  const requests: PermissionRequestEvent[] = [];
  const executor = new InternalToolExecutor({
    registry,
    sandbox,
    permissionPolicy: allowAllPolicy,
    permBus,
    agentId: "test-agent",
    sessionId: "s1",
    sensitiveAlwaysConfirm: opts.sensitiveAlwaysConfirm,
    onPermissionRequest: (request) => {
      requests.push(request);
    },
  });
  return { executor, permBus, approved, requests };
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时：预期中的确认请求没有出现");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("敏感步骤写死确认", () => {
  it("策略 allow + 沙箱 allow，点击「登录」仍强制确认，且原因可展示", async () => {
    const h = makeExecutor();
    const promise = h.executor.invoke({ id: "c1", name: "browser_click", args: { target: "登录" } });
    await waitFor(() => h.permBus.size === 1);

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].toolName).toBe("browser_click");
    expect(h.requests[0].category).toBe("login");
    expect(h.requests[0].reason).toContain("敏感步骤：登录/账号");

    h.permBus.resolve(h.requests[0].requestId, "allow-once");
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toBe("clicked");
  });

  it("默认（未注入开关）即为写死确认：终端 rm -rf 即使 terminal=allow 也要问", async () => {
    const h = makeExecutor();
    const promise = h.executor.invoke({ id: "c2", name: "terminal_run", args: { command: "rm -rf ./dist" } });
    await waitFor(() => h.permBus.size === 1);
    expect(h.requests[0].reason).toContain("敏感步骤：不可撤销操作");
    h.permBus.resolve(h.requests[0].requestId, "allow-once");
    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it("sensitiveAlwaysConfirm: false → 不强制确认，退回纯类别策略（allow 直接执行）", async () => {
    const h = makeExecutor({ sensitiveAlwaysConfirm: () => false });
    const result = await h.executor.invoke({ id: "c3", name: "browser_click", args: { target: "立即支付" } });
    expect(result.ok).toBe(true);
    expect(h.permBus.size).toBe(0);
    expect(h.requests).toHaveLength(0);
  });

  it("非敏感动作不触发（避免每次点击都弹窗）", async () => {
    const h = makeExecutor();
    const result = await h.executor.invoke({ id: "c4", name: "browser_click", args: { target: "#search-submit" } });
    expect(result.ok).toBe(true);
    expect(h.requests).toHaveLength(0);
  });

  it("用户拒绝敏感步骤 → 工具不执行，拒绝文案带敏感原因", async () => {
    const h = makeExecutor();
    const promise = h.executor.invoke({ id: "c5", name: "browser_click", args: { target: "确认订单" } });
    await waitFor(() => h.permBus.size === 1);
    h.permBus.resolve(h.requests[0].requestId, "deny");
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("denied");
    expect(result.content).toContain("敏感步骤：支付/交易");
    expect(result.content).toContain("确认被拒绝");
  });

  it("敏感步骤的 allow-session 不写入会话白名单：下一次仍单独确认", async () => {
    const h = makeExecutor();
    const first = h.executor.invoke({ id: "c6", name: "browser_click", args: { target: "登录" } });
    await waitFor(() => h.permBus.size === 1);
    h.permBus.resolve(h.requests[0].requestId, "allow-session");
    expect((await first).ok).toBe(true);
    expect(h.approved).toEqual([]); // 未被 approveToolForSession 记住

    const second = h.executor.invoke({ id: "c7", name: "browser_click", args: { target: "登录" } });
    await waitFor(() => h.permBus.size === 1); // 第二次仍然弹确认
    expect(h.requests).toHaveLength(2);
    h.permBus.resolve(h.requests[1].requestId, "deny");
    expect((await second).ok).toBe(false);
  });

  it("只读工具即使参数含敏感词也不确认（分类器只认动作型工具）", async () => {
    const h = makeExecutor();
    const result = await h.executor.invoke({ id: "c8", name: "file_read", args: { path: "支付说明.md" } });
    expect(result.ok).toBe(true);
    expect(h.requests).toHaveLength(0);
  });
});

/* ───────── ChatServiceOptions.sensitiveAlwaysConfirm 的真实穿透（stream 级） ───────── */

async function runStreamWithSensitiveFlag(
  sensitiveAlwaysConfirm: (() => boolean) | undefined,
  counter: { n: number },
): Promise<{ status: string }> {
  const mock = new MockLlmClient();
  // 第 1 轮：模型请求点击「登录」；第 2 轮：收尾文本（被拦下时也会走到这里）
  mock.addScript([
    { kind: "tool_call", toolCall: { id: "t1", name: "browser_click", args: { target: "登录" } } },
    { kind: "done" },
  ]);
  mock.addScript([{ kind: "text", text: "完成" }, { kind: "done" }]);

  const registry = makeRegistry(() => {
    counter.n += 1;
  });
  const sandbox = new SandboxManager();
  sandbox.syncKnownTools(["browser_click"]);

  const service = new ChatService({
    llm: mock,
    platform: createNodePlatform(),
    registry,
    sandbox,
    agent: { name: "敏感步骤测试", role: "测试" },
    permTimeoutMs: 80, // 强制确认超时后按拒绝结算，测试不会挂 300s
    // 类别策略全 allow：证明下面的拦截只可能来自「敏感步骤写死确认」
    permissionPolicy: allowAllPolicy,
    ...(sensitiveAlwaysConfirm ? { sensitiveAlwaysConfirm } : {}),
  });
  const result = await service.stream({ message: "go", sessionId: "s1" });
  return { status: result.status };
}

describe("ChatServiceOptions.sensitiveAlwaysConfirm 透传到执行器", () => {
  it("默认 true：策略 allow 下敏感点击仍被拦下（工具未执行）", async () => {
    const counter = { n: 0 };
    const result = await runStreamWithSensitiveFlag(undefined, counter);
    expect(result.status).toBe("done");
    expect(counter.n).toBe(0);
  });

  it("显式 false：退回纯类别策略，allow 下直接执行", async () => {
    const counter = { n: 0 };
    const result = await runStreamWithSensitiveFlag(() => false, counter);
    expect(result.status).toBe("done");
    expect(counter.n).toBe(1);
  });
});
