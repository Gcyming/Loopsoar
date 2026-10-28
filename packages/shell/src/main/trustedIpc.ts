/**
 * 受信 IPC 入口：所有敏感通道必须经 handleTrusted 注册。
 * 四要素校验（缺一即拒，fail-closed）：
 *   ① 通道在契约 manifest 内（不在 → 拒绝注册/拒绝调用）
 *   ② 发送帧来源可信（loopsoar:// 白名单；开发期豁免仅限本机 dev server）
 *   ③ 参数经 zod 校验（schema 缺失的通道拒绝带参调用）
 *   ④ 审计记录（channel/sender/status/reason）
 * 任何未经 handleTrusted 的裸 ipcMain.handle 都是红线（发布门 2）。
 */
import { IPC_CHANNELS, IPC_VALIDATORS } from "loopsoar-contracts/ipc";

export interface TrustedIpcDeps {
  /** 由 index.ts 注入真实 ipcMain；测试注入假对象。 */
  ipc: {
    handle(
      channel: string,
      fn: (event: unknown, payload: unknown) => Promise<unknown> | unknown,
    ): void;
  };
  audit(entry: AuditEntry): void;
}

export interface AuditEntry {
  channel: string;
  sender: string;
  status: "ok" | "rejected";
  reason?: string;
}

/** 事件对象的最小形状（真实 IpcMainInvokeEvent 结构兼容）。 */
interface SenderLike {
  senderFrame?: { url?: string } | null;
}

const registry = new Map<string, { handler: (payload: unknown) => unknown }>();

/** 供守卫测试：manifest 每条通道必有 handler；registry 中通道必在 manifest（无死码）。 */
export function getHandlerRegistry(): ReadonlyMap<string, { handler: (payload: unknown) => unknown }> {
  return registry;
}

/** 帧来源白名单：生产只认 loopsoar://；开发期（LOOPSOAR_DEV=1）允许本机 dev server。 */
function isTrustedFrameUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("loopsoar://")) return true;
  if (process.env.LOOPSOAR_DEV === "1") {
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
  }
  return false;
}

export function handleTrusted(
  deps: TrustedIpcDeps,
  channel: string,
  handler: (payload: unknown) => Promise<unknown> | unknown,
): void {
  if (!(channel in IPC_CHANNELS)) {
    // fail-closed：未在契约内的一律拒绝注册
    deps.audit({ channel, sender: "-", status: "rejected", reason: "channel 不在契约 manifest" });
    throw new Error(`IPC 通道 "${channel}" 不在契约 manifest，拒绝注册`);
  }
  if (registry.has(channel)) {
    throw new Error(`IPC 通道 "${channel}" 重复注册`);
  }
  registry.set(channel, { handler });

  deps.ipc.handle(`loopsoar:${channel}`, async (event: unknown, payload: unknown) => {
    const senderUrl = (event as SenderLike)?.senderFrame?.url;
    const audit = (status: "ok" | "rejected", reason?: string) =>
      deps.audit({ channel, sender: senderUrl ?? "-", status, reason });

    if (!isTrustedFrameUrl(senderUrl)) {
      audit("rejected", "sender 帧来源不可信");
      throw new Error(`IPC 拒绝：sender 帧来源不可信（${senderUrl ?? "未知"}）`);
    }
    const validator = IPC_VALIDATORS[channel] ?? null;
    let args: unknown = payload;
    if (validator) {
      const parsed = validator.safeParse(payload);
      if (!parsed.success) {
        audit("rejected", `参数校验失败: ${parsed.error.message}`);
        throw new Error(`IPC 拒绝：参数校验失败 ${parsed.error.message}`);
      }
      args = parsed.data;
    } else if (payload !== undefined && payload !== null) {
      audit("rejected", "该通道不接受参数");
      throw new Error(`IPC 拒绝：通道 ${channel} 不接受参数`);
    }
    audit("ok");
    return handler(args);
  });
}
