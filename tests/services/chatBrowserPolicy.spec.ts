/**
 * Slice G：浏览器动作的「策略档 vs 沙箱级」分层 + 敏感步骤兜底。
 *
 * 断言三件事：
 *   ① 策略按 browser 档判定：allow 不弹窗 / confirm 弹 / deny 直接拒绝；
 *   ② 沙箱仍按 network（L4）判定：browser 不新增沙箱档位（PermissionKind 保持四档）；
 *   ③ browser=allow 不等于全放开：登录 / 支付 / 不可撤销动作仍逐次强制确认，且 browser=allow 不放行 network 档工具。
 *
 * 为什么直接测 InternalToolExecutor：本测试要精确断言「是否弹确认 / 沙箱收到的 kind / 工具是否真的执行」，
 * 走 ChatService.stream 会引入 LLM 脚本与事件合批噪声；策略到流式的端到端穿透由 chatSensitive.spec.ts 覆盖。
 */
import { describe, expect, it } from "vitest";
import { z, type ZodTypeAny } from "zod";
import { InternalToolExecutor, PermRequestBus, type PermissionRequestEvent } from "../../packages/services/src/chat.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";
import { SandboxManager, type PermissionReq, type SandboxScope } from "../../packages/core/src/sandbox.ts";
import { mergePermissions, type Permissions } from "../../packages/core/src/permissions.ts";

/** 交给沙箱的 kind 记录：证明 browser 工具在沙箱层走的是 network（L4）。 */
interface SandboxCall {
  toolName: string;
  kind: string;
}

/** 全 allow 基线；单个用例再按需收紧某一档。 */
const ALL_ALLOW: Partial<Permissions> = {
  read: "allow",
  write: "allow",
  terminal: "allow",
  network: "allow",
  browser: "allow",
};

function policyOf(overrides: Partial<Permissions>): Permissions {
  return mergePermissions({ ...ALL_ALLOW, ...overrides });
}

function makeRegistry(executed: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  const add = (name: string, permissions: Record<string, boolean>, args: ZodTypeAny): void => {
    registry.register({
      name,
      description: name,
      permissions,
      schema: args,
      execute: async () => {
        executed.push(name);
        return { ok: true, content: `${name}-ok` };
      },
    });
  };
  add("browser_click", { browser: true }, z.object({ target: z.string() }));
  add("browser_navigate", { browser: true }, z.object({ url: z.string() }));
  add("browser_snapshot", { read: true }, z.object({}));
  add("web_fetch", { network: true }, z.object({ url: z.string() }));
  return registry;
}

interface Harness {
  executor: InternalToolExecutor;
  permBus: PermRequestBus;
  requests: PermissionRequestEvent[];
  executed: string[];
  sandboxCalls: SandboxCall[];
}

function makeHarness(policy: Permissions, opts: { sensitiveAlwaysConfirm?: () => boolean } = {}): Harness {
  const executed: string[] = [];
  const requests: PermissionRequestEvent[] = [];
  const sandboxCalls: SandboxCall[] = [];
  const registry = makeRegistry(executed);

  // 真实沙箱（L4 默认 confirm）+ 一层记录器：既证明「真的按 network 判」，又保留真实分级行为。
  const real = new SandboxManager();
  real.syncKnownTools(registry.list().map((tool) => tool.name));
  const sandbox = {
    checkPermission: (req: PermissionReq, scope?: SandboxScope) => {
      sandboxCalls.push({ toolName: req.toolName, kind: req.kind });
      return real.checkPermission(req, scope);
    },
    approveToolForSession: (agentId: string, toolName: string, sessionId?: string) =>
      real.approveToolForSession(agentId, toolName, sessionId),
  } as unknown as SandboxManager;

  const permBus = new PermRequestBus(120); // 极短超时：漏 resolve 时快速 deny，不挂 300s
  const executor = new InternalToolExecutor({
    registry,
    sandbox,
    permissionPolicy: () => policy,
    permBus,
    agentId: "test-agent",
    sessionId: "s1",
    ...(opts.sensitiveAlwaysConfirm ? { sensitiveAlwaysConfirm: opts.sensitiveAlwaysConfirm } : {}),
    onPermissionRequest: (request) => {
      requests.push(request);
    },
  });
  return { executor, permBus, requests, executed, sandboxCalls };
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时：预期中的确认请求没有出现");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("浏览器动作：策略按 browser 档、沙箱按 network 级", () => {
  it("browser=allow → 直接执行不弹确认，沙箱仍收到 kind=network（L4）", async () => {
    const h = makeHarness(policyOf({}));
    const result = await h.executor.invoke({ id: "b1", name: "browser_click", args: { target: "#search-submit" } });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("browser_click-ok");
    expect(h.requests).toHaveLength(0);
    expect(h.executed).toEqual(["browser_click"]);
    expect(h.sandboxCalls).toEqual([{ toolName: "browser_click", kind: "network" }]);
  });

  it("browser=confirm → 弹确认；允许后执行", async () => {
    const h = makeHarness(policyOf({ browser: "confirm" }));
    const promise = h.executor.invoke({ id: "b2", name: "browser_click", args: { target: "#a" } });
    await waitFor(() => h.permBus.size === 1);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].toolName).toBe("browser_click");
    expect(h.requests[0].kind).toBe("network"); // 弹窗展示的等级仍是沙箱语义（L4）
    expect(h.executed).toEqual([]);
    h.permBus.resolve(h.requests[0].requestId, "allow-once");
    expect((await promise).ok).toBe(true);
    expect(h.executed).toEqual(["browser_click"]);
  });

  it("browser=deny → 直接拒绝：不弹确认、不执行", async () => {
    const h = makeHarness(policyOf({ browser: "deny" }));
    const result = await h.executor.invoke({ id: "b3", name: "browser_navigate", args: { url: "https://example.com/" } });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("policy-denied");
    expect(result.content).toContain("browser");
    expect(h.requests).toHaveLength(0);
    expect(h.executed).toEqual([]);
  });

  it("browser=allow 不放行 network 档：web_fetch 仍按 network=confirm 弹确认", async () => {
    const h = makeHarness(policyOf({ network: "confirm" }));
    const promise = h.executor.invoke({ id: "b4", name: "web_fetch", args: { url: "https://example.com/" } });
    await waitFor(() => h.permBus.size === 1);
    expect(h.requests[0].toolName).toBe("web_fetch");
    h.permBus.resolve(h.requests[0].requestId, "deny");
    expect((await promise).ok).toBe(false);
    expect(h.executed).toEqual([]);
  });

  it("只读探测不被 browser 档牵连：browser_snapshot 走 read，无需确认", async () => {
    const h = makeHarness(policyOf({ browser: "deny", read: "allow" }));
    const result = await h.executor.invoke({ id: "b5", name: "browser_snapshot", args: {} });
    expect(result.ok).toBe(true);
    expect(h.requests).toHaveLength(0);
    expect(h.executed).toEqual(["browser_snapshot"]);
  });
});

describe("敏感步骤兜底：browser=allow 也不放行登录/支付/不可撤销", () => {
  it("browser=allow 下点击「立即支付」仍然逐次确认", async () => {
    const h = makeHarness(policyOf({}));
    const promise = h.executor.invoke({ id: "s1", name: "browser_click", args: { target: "立即支付" } });
    await waitFor(() => h.permBus.size === 1);
    expect(h.requests[0].category).toBe("payment");
    expect(h.requests[0].reason).toContain("敏感步骤：支付/交易");
    expect(h.executed).toEqual([]);
    h.permBus.resolve(h.requests[0].requestId, "allow-once");
    expect((await promise).ok).toBe(true);
    expect(h.executed).toEqual(["browser_click"]);
  });

  it("browser=allow 下导航到支付页仍然确认；拒绝则不执行", async () => {
    const h = makeHarness(policyOf({}));
    const promise = h.executor.invoke({
      id: "s2",
      name: "browser_navigate",
      args: { url: "https://shop.example.com/checkout/pay" },
    });
    await waitFor(() => h.permBus.size === 1);
    expect(h.requests[0].category).toBe("payment");
    h.permBus.resolve(h.requests[0].requestId, "deny");
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("denied");
    expect(h.executed).toEqual([]);
  });

  it("敏感步骤的 allow-session 不写会话白名单：下一次仍单独确认", async () => {
    const h = makeHarness(policyOf({}));
    const first = h.executor.invoke({ id: "s3", name: "browser_click", args: { target: "登录" } });
    await waitFor(() => h.permBus.size === 1);
    h.permBus.resolve(h.requests[0].requestId, "allow-session");
    expect((await first).ok).toBe(true);

    const second = h.executor.invoke({ id: "s4", name: "browser_click", args: { target: "登录" } });
    await waitFor(() => h.permBus.size === 1);
    expect(h.requests).toHaveLength(2);
    h.permBus.resolve(h.requests[1].requestId, "deny");
    expect((await second).ok).toBe(false);
  });
});
