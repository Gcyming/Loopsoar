/**
 * documents 域：把用户主动选择/拖入的本地文档交给主进程的预览装配。
 *
 * 渲染层只传路径；扩展名校验、大小限制、LibreOffice 转换和标签页打开都在主进程完成，
 * 这样网页 preload/拖拽不会直接接触文件系统能力。
 */
import type { TrustedIpcDeps } from "../trustedIpc.js";
import { handleTrusted } from "../trustedIpc.js";

export interface DocumentsDeps extends TrustedIpcDeps {
  openDocument?: (file: string, sessionId?: string) => Promise<{
    ok: boolean;
    tabId?: string;
    title?: string;
    error?: string;
  }>;
  /** 浏览器页 preload（非受信 loopsoar:// 帧）的 Office 拖放：校验 webContents 归属后转给宿主。 */
  browserHost?: {
    hasWebContents(webContentsId: number): boolean;
    handleLocalFilePath(webContentsId: number, file: string): boolean;
  };
}

export function registerDocumentsDomain(deps: DocumentsDeps): void {
  handleTrusted(deps, "documents:open", async (payload) => {
    const p = payload as { path?: string };
    const file = String(p?.path ?? "").trim();
    if (!file) return { ok: false, error: "缺少文件路径" };
    if (!deps.openDocument) return { ok: false, error: "当前环境无法打开文档" };
    try {
      return await deps.openDocument(file);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 浏览器页 preload 直接拖入：发送者不是 loopsoar:// 帧，不能走 handleTrusted；
  // 单独做「必须属于本宿主浏览器标签」校验，再让 BrowserHost 找到对应会话打开预览。
  if (!deps.browserHost) return;
  deps.ipc.handle("loopsoar-browser:local-file-drop", async (event, payload) => {
    const senderId = Number((event as { sender?: { id?: number } } | null)?.sender?.id ?? -1);
    if (!Number.isInteger(senderId) || !deps.browserHost?.hasWebContents(senderId)) {
      return { ok: false, error: "来源不是 Loopsoar 浏览器标签页" };
    }
    const raw = payload as { path?: unknown };
    const file = typeof raw?.path === "string" ? raw.path.trim() : "";
    if (!file || file.length > 2048) return { ok: false, error: "文件路径非法" };
    const opened = deps.browserHost.handleLocalFilePath(senderId, file);
    return opened ? { ok: true } : { ok: false, error: "不支持的文档类型或标签已关闭" };
  });
}
