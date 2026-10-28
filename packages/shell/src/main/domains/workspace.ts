/**
 * workspace 域：file:read / file:write。
 * 文件能力经 core 的 platform 适配层（FsAdapter），不直接碰 Node API。
 * 写上限（5MB）取自契约单源 security-policy，与核心工具层同源。
 */
import { FILE_WRITE_MAX_BYTES } from "loopsoar-contracts/security-policy";
import type { LoopsoarPlatform } from "loopsoar-core/platform";
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";

export interface WorkspaceDeps extends TrustedIpcDeps {
  platform: LoopsoarPlatform;
}

export function registerWorkspaceDomain(deps: WorkspaceDeps): void {
  handleTrusted(deps, "file:read", async (payload) => {
    const { path, offset = 0, limit = 1000 } = payload as {
      path: string;
      offset?: number;
      limit?: number;
    };
    try {
      const text = await deps.platform.fs.readFileUtf8(path);
      const lines = text.split(/\r?\n/);
      const page = lines.slice(offset, offset + limit);
      return { ok: true, content: page.join("\n"), totalLines: lines.length };
    } catch (err) {
      return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handleTrusted(deps, "file:write", async (payload) => {
    const { path, content } = payload as { path: string; content: string };
    if (content.length > FILE_WRITE_MAX_BYTES) {
      return { ok: false, content: "[错误] 内容超过 5MB 单文件写入上限" };
    }
    try {
      await deps.platform.fs.writeFileUtf8(path, content);
      return { ok: true, content: `已写入 ${path}` };
    } catch (err) {
      return { ok: false, content: `[错误] ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}
