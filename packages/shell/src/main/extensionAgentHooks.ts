/**
 * 扩展代码级事件钩子 → ChatService 适配层。
 *
 * 放在壳层而不是 services：services 不应知道扩展运行时；事件失败一律 fail-open，
 * 因为真正的安全边界是工具权限/沙箱/确认，事件钩子只做增强（如注入提示、审计）。
 */
import type { ExtensionRuntime } from "./extensionRuntime.js";

export interface ExtensionAgentHooks {
  onTurnStart: (input: { sessionId: string; userText: string }) => Promise<{ promptAppend?: string } | undefined>;
  onTurnEnd: (input: { sessionId: string; userText: string; result: { status: string; reason?: string; usage?: unknown } }) => void;
  beforeTool: (input: { toolName: string; args: Record<string, unknown>; sessionId: string }) => Promise<{ allow: boolean; reason?: string } | undefined>;
  afterTool: (input: { toolName: string; args: Record<string, unknown>; sessionId: string; ok: boolean; error?: string }) => void;
}

export function createExtensionAgentHooks(getRuntime: () => ExtensionRuntime | undefined): ExtensionAgentHooks {
  return {
    onTurnStart: async ({ sessionId, userText }) => {
      const runtime = getRuntime();
      if (!runtime) return undefined;
      const outcome = await runtime.dispatchEvent("turn.start", { sessionId, userText, at: Date.now() });
      const appends: string[] = [];
      for (const item of outcome.results) {
        const value = item.result;
        if (value && typeof value === "object" && typeof (value as { promptAppend?: unknown }).promptAppend === "string") {
          appends.push((value as { promptAppend: string }).promptAppend);
        }
      }
      return appends.length > 0 ? { promptAppend: appends.join("\n\n") } : undefined;
    },
    onTurnEnd: ({ sessionId, userText, result }) => {
      void getRuntime()?.dispatchEvent("turn.end", {
        sessionId,
        userText,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      });
    },
    beforeTool: async ({ toolName, args, sessionId }) => {
      const runtime = getRuntime();
      if (!runtime) return undefined;
      const outcome = await runtime.dispatchEvent("tool.before", { toolName, args, sessionId, at: Date.now() });
      return outcome.allow ? undefined : { allow: false, reason: outcome.reason ?? "扩展否决" };
    },
    afterTool: ({ toolName, args, sessionId, ok, error }) => {
      void getRuntime()?.dispatchEvent("tool.after", {
        toolName,
        args,
        sessionId,
        ok,
        ...(error ? { error } : {}),
        at: Date.now(),
      });
    },
  };
}
