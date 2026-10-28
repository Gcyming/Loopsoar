/**
 * 受信 IPC 四要素反例（发布门 2 前置）：帧来源 / 参数校验 / 通道白名单。
 * 直接调用 registry 里的 handler，不依赖 electron。
 */
import { describe, expect, it } from "vitest";
import {
  getHandlerRegistry,
  handleTrusted,
  type TrustedIpcDeps,
} from "../../packages/shell/src/main/trustedIpc.ts";

type Handler = (event: unknown, payload: unknown) => Promise<unknown> | unknown;

function fakeDeps(): TrustedIpcDeps {
  return {
    ipc: { handle: () => {} },
    audit: () => {},
  };
}

function registerProbeChannel(): Handler {
  const existing = getHandlerRegistry().get("browser:snapshot");
  if (existing) return existing.handler as unknown as Handler; // 已注册（测试间共享模块状态）
  const deps = fakeDeps();
  // 用 manifest 内一个未被其他测试占用的通道做隔离注册
  handleTrusted(deps, "browser:snapshot", () => ({ ok: true }));
  const entry = getHandlerRegistry().get("browser:snapshot");
  if (!entry) throw new Error("probe 通道未注册");
  return entry.handler as unknown as Handler;
}

describe("受信 IPC 四要素（fail-closed）", () => {
  it("① 通道不在契约 manifest → 拒绝注册", () => {
    const deps = fakeDeps();
    expect(() => handleTrusted(deps, "evil:channel", () => ({}))).toThrow(/不在契约/);
  });

  it("② 不受信的帧来源（https://evil.com）→ 拒绝调用", async () => {
    const handler = registerProbeChannel();
    await expect(handler({ senderFrame: { url: "https://evil.com/" } }, undefined)).rejects.toThrow(/帧来源不可信/);
  });

  it("② 缺少帧信息来源 → 拒绝（fail-closed）", async () => {
    const handler = registerProbeChannel();
    await expect(handler({}, undefined)).rejects.toThrow(/帧来源不可信/);
  });

  it("③ 参数不符合契约 schema → 拒绝", async () => {
    const deps = fakeDeps();
    // 用 chat:stream（要求 message: string）验证参数校验分支
    handleTrusted(deps, "chat:stream", () => ({ ok: true }));
    const entry = getHandlerRegistry().get("chat:stream");
    const handler = entry!.handler as unknown as Handler;
    await expect(
      handler({ senderFrame: { url: "loopsoar://app/index.html" } }, { message: 123 }),
    ).rejects.toThrow(/参数校验失败/);
  });

  it("③ 无参通道收到多余参数 → 拒绝", async () => {
    const deps = fakeDeps();
    handleTrusted(deps, "boot:status", () => ({ ok: true }));
    const handler = getHandlerRegistry().get("boot:status")!.handler as unknown as Handler;
    await expect(
      handler({ senderFrame: { url: "loopsoar://app/index.html" } }, { unexpected: true }),
    ).rejects.toThrow(/不接受参数/);
  });

  it("④ 合法帧 + 合法参数 → 正常返回", async () => {
    const deps = fakeDeps();
    handleTrusted(deps, "app:version", () => ({ version: "test" }));
    const handler = getHandlerRegistry().get("app:version")!.handler as unknown as Handler;
    const result = await handler({ senderFrame: { url: "loopsoar://app/index.html" } }, undefined);
    expect(result).toEqual({ version: "test" });
  });
});
