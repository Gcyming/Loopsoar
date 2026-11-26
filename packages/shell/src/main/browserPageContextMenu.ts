/**
 * 网页面右键菜单（原生 WebContentsView 内的右键）。
 *
 * 为什么这里必须用 Electron 原生 Menu：网页是 WebContentsView，DOM 右键菜单浮层
 * 无法覆盖原生视图；`context-menu` 事件是唯一可靠入口。
 *
 * 与普通浏览器菜单的差异（Agent 浏览器定位）：
 *   · 选中文字可以直接「引用到 Loopsoar 对话」，不自动发送，用户还能编辑；
 *   · 链接可以直接在右侧新标签打开，保持「浏览 + Agent 协作」同屏；
 *   · 保留复制/剪切/粘贴等编辑命令，避免用户右键输入框时无菜单可用。
 */
import { clipboard, Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";
import { isContextMenuSuppressed } from "./domains/window.js";

export interface PageContextMenuOptions {
  webContents: WebContents;
  getWindow: () => BrowserWindow | null;
  onNewTab: (url: string) => void;
  onAskAgent: (text: string) => void;
  /** 检查元素：优先交给应用底部的 DevTools 面板，避免 Chromium 默认侧边停靠。 */
  onInspectElement?: (x: number, y: number) => void;
}

const attached = new WeakSet<WebContents>();

function navigation(webContents: WebContents): {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
} | null {
  try {
    const history = (webContents as unknown as { navigationHistory?: {
      canGoBack?: () => boolean;
      canGoForward?: () => boolean;
      goBack?: () => void;
      goForward?: () => void;
    } }).navigationHistory;
    if (history) {
      return {
        canGoBack: () => history.canGoBack?.() === true,
        canGoForward: () => history.canGoForward?.() === true,
        goBack: () => history.goBack?.(),
        goForward: () => history.goForward?.(),
      };
    }
  } catch {
    // 旧 Electron / 已销毁
  }
  return null;
}

export function attachPageContextMenu(options: PageContextMenuOptions): void {
  const wc = options.webContents;
  if (!wc || attached.has(wc)) return;
  attached.add(wc);
  wc.on("context-menu", (_event, params: ContextMenuParams) => {
    if (isContextMenuSuppressed()) return;
    const win = options.getWindow();
    if (!win || win.isDestroyed()) return;
    const nav = navigation(wc);
    const hasSelection = Boolean(params.selectionText?.trim());
    const link = params.linkURL?.trim();
    const canEdit = params.isEditable;
    const template: MenuItemConstructorOptions[] = [];

    if (nav) {
      template.push(
        { label: "后退", enabled: nav.canGoBack(), click: () => nav.goBack() },
        { label: "前进", enabled: nav.canGoForward(), click: () => nav.goForward() },
        { label: "刷新", click: () => wc.reload() },
        { type: "separator" },
      );
    }

    if (link) {
      template.push(
        { label: "在右侧新建标签页", click: () => options.onNewTab(link) },
        { label: "复制链接地址", click: () => clipboard.writeText(link) },
        { type: "separator" },
      );
    }

    if (hasSelection && !canEdit) {
      template.push(
        { label: "复制", role: "copy" },
        {
          label: "引用到 Loopsoar 对话",
          click: () => options.onAskAgent(params.selectionText.trim()),
        },
        { type: "separator" },
      );
    } else if (canEdit) {
      template.push(
        { label: "撤销", role: "undo", enabled: params.editFlags.canUndo },
        { label: "重做", role: "redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { label: "剪切", role: "cut", enabled: params.editFlags.canCut },
        { label: "复制", role: "copy", enabled: params.editFlags.canCopy },
        { label: "粘贴", role: "paste", enabled: params.editFlags.canPaste },
        { label: "全选", role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
      if (hasSelection) {
        template.push({
          label: "引用到 Loopsoar 对话",
          click: () => options.onAskAgent(params.selectionText.trim()),
        });
      }
      template.push({ type: "separator" });
    } else {
      template.push({ label: "复制页面地址", click: () => clipboard.writeText(wc.getURL()) });
    }
    if (!canEdit) {
      template.push({ label: "全选", role: "selectAll" });
    }
    template.push({ type: "separator" }, {
      label: "检查元素",
      click: () => {
        if (options.onInspectElement) options.onInspectElement(params.x, params.y);
        else wc.inspectElement(params.x, params.y);
      },
    });

    Menu.buildFromTemplate(template).popup({ window: win });
  });
}
