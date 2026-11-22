/**
 * 文档预览运行时：把「本地路径 → LibreOffice/PDF 准备 → 浏览器标签页」编成一条链路。
 *
 * 主进程组合根只应持有入口（组合根行数预算），所以这里集中处理：
 *   - 拖拽/下载/显式打开的统一入口；
 *   - 转换失败时走 UI 的一次性提示；
 *   - `documents:open` IPC 域注册。
 * 浏览器宿主只负责最后的 file:// PDF 标签页，不接触转换细节。
 */
import path from "node:path";
import type { BrowserHost } from "./browserHost.js";
import { registerDocumentsDomain } from "./domains/documents.js";
import { officeDocumentTitle, prepareOfficePreview, warmOfficePreview } from "./officePreview.js";
import type { TrustedIpcDeps } from "./trustedIpc.js";

export interface DocumentPreviewResult {
  ok: boolean;
  tabId?: string;
  title?: string;
  error?: string;
}

export interface DocumentRuntimeOptions {
  getHost: () => BrowserHost | null;
  dataDir: string;
  /** 转换/打开失败时给 UI 的提示；由组合根注入，避免模块直接依赖 rendererBus。 */
  notify?: (message: string) => void;
}

export interface DocumentRuntime {
  open: (file: string, sessionId?: string, notify?: boolean) => Promise<DocumentPreviewResult>;
  /** 主窗口/网页拖入：失败时提示。 */
  onDrop: (file: string, sessionId: string) => void;
  /** will-download 截获：返回 true 表示已接管，不再走系统 Save As。 */
  handleDownload: (file: string) => boolean;
  /** 注册 documents:open（渲染层 preload 的拖拽入口）。 */
  register: (deps: TrustedIpcDeps) => void;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

/** 转换期间占用同一个标签页，转换完直接替换为 PDF，避免用户面对空白/无响应。 */
function previewLoadingPage(title: string): string {
  const safeTitle = escapeHtml(title);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${safeTitle}</title><style>
  html,body{height:100%;margin:0;background:#1d1f24;color:#d9d4c8;font:13px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}
  body{display:flex;align-items:center;justify-content:center}
  .box{text-align:center;max-width:560px;padding:32px}
  .spinner{width:26px;height:26px;margin:0 auto 16px;border:2px solid #5a5142;border-top-color:#d28a3b;border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .t{font-size:15px;font-weight:600;color:#f1e9dc;margin-bottom:8px}
  .s{color:#a9a294}
  </style></head><body><div class="box"><div class="spinner"></div><div class="t">正在准备「${safeTitle}」</div><div class="s">Office 文档正在转换为可预览格式，首次打开通常需要 5–15 秒；完成后会自动显示。</div></div></body></html>`)}`;
}

function previewErrorPage(title: string, error: string): string {
  const safeTitle = escapeHtml(title);
  const safeError = escapeHtml(error);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${safeTitle}</title><style>
  html,body{height:100%;margin:0;background:#1d1f24;color:#d9d4c8;font:13px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}
  body{display:flex;align-items:center;justify-content:center}.box{max-width:620px;padding:32px;text-align:center}
  .t{font-size:15px;font-weight:600;color:#f1e9dc;margin-bottom:10px}.e{color:#e08a72;background:#2a201e;border:1px solid #5a3630;border-radius:8px;padding:10px 14px;text-align:left;white-space:pre-wrap;word-break:break-word}
  </style></head><body><div class="box"><div class="t">无法预览「${safeTitle}」</div><div class="e">${safeError}</div></div></body></html>`)}`;
}

export function createDocumentRuntime(options: DocumentRuntimeOptions): DocumentRuntime {
  const cacheDir = path.join(options.dataDir, "office-preview");
  // 启动后后台预热 LibreOffice 的 profile/font cache；有原生 Office 时函数会直接返回。
  // 不阻塞窗口创建，也不等待结果；失败只影响兜底转换速度，不影响应用启动。
  void warmOfficePreview({ cacheDir }).catch(() => undefined);
  const open = async (file: string, sessionId?: string, notify = false): Promise<DocumentPreviewResult> => {
    const host = options.getHost();
    if (!host) {
      const error = "浏览器尚未就绪";
      if (notify) options.notify?.(error);
      return { ok: false, error };
    }
    const notifyText = (message: string): void => {
      if (!notify) return;
      // ui:toast 的 schema 上限 300 字符；异常里常带超长 data:/file: URL，不能原样丢给 IPC。
      options.notify?.(message.length > 280 ? `${message.slice(0, 279)}…` : message);
    };
    const title = officeDocumentTitle(file);
    const isPdf = path.extname(file).toLowerCase() === ".pdf";
    let tabId: string | undefined;
    try {
      // Office 需要转换：先开标签页显示转换进度，转换完成在同一标签替换为 PDF。
      // PDF 直接打开，不额外闪一帧加载页。
      if (!isPdf) {
        const loading = await host.openLocalPreview(previewLoadingPage(title), sessionId, title);
        if (!loading.ok) {
          const error = loading.error || "无法打开文档预览";
          notifyText(error);
          return { ok: false, tabId: loading.tabId, error };
        }
        tabId = loading.tabId;
      }
      const prepared = await prepareOfficePreview(file, {
        cacheDir,
        onProgress: (message) => {
          if (notify) notifyText(message);
        },
      });
      const opened = await host.openLocalPreview(prepared.pdf, sessionId, prepared.title, tabId ? { tabId } : {});
      if (!opened.ok) {
        const error = opened.error || "无法打开文档预览";
        if (tabId) await host.openLocalPreview(previewErrorPage(title, error), sessionId, `${title}（预览失败）`, { tabId }).catch(() => undefined);
        notifyText(error);
        return { ok: false, tabId: opened.tabId, error };
      }
      return { ok: true, tabId: opened.tabId, title: prepared.title };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (tabId) {
        await host
          .openLocalPreview(previewErrorPage(title, error), sessionId, `${title}（预览失败）`, { tabId })
          .catch(() => undefined);
      }
      notifyText(error);
      return { ok: false, error };
    }
  };

  return {
    open,
    onDrop: (file, sessionId) => {
      void open(file, sessionId, true);
    },
    handleDownload: (file) => {
      void open(file, undefined, true);
      return true;
    },
    register: (deps) => {
      const browserHost = options.getHost();
      registerDocumentsDomain({
        ...deps,
        ...(browserHost ? { browserHost } : {}),
        openDocument: (file) => open(file, undefined, true),
      });
    },
  };
}
