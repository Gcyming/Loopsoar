/**
 * Loopsoar 主窗口（React DOM）的右键菜单。
 *
 * 网页里的右键由 WebContentsView 的原生 context-menu 处理（browserPageContextMenu.ts）；
 * 这里补上应用自身界面的右键：输入框的剪切/复制/粘贴、选中文字的复制、
 * 「引用到对话」、设置、重载界面、检查元素。没有这一层时，Chromium 默认不弹菜单。
 */
import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from "electron";

export function attachAppContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params: ContextMenuParams) => {
    if (win.isDestroyed()) return;
    // 标签条有自己的 React 右键菜单（固定/静音/复制…）；Electron 的 context-menu
    // 仍会为同一手势触发主进程事件，若不拦住会同时弹出两套菜单。
    // 标签条位于窗口顶部 TITLE_BAR_HEIGHT（40px）；内容区从 40px 之后开始。
    if (params.y < 40) return;
    const selected = params.selectionText?.trim() ?? "";
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      items.push(
        { label: "撤销", role: "undo", enabled: params.editFlags.canUndo },
        { label: "重做", role: "redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { label: "剪切", role: "cut", enabled: params.editFlags.canCut },
        { label: "复制", role: "copy", enabled: params.editFlags.canCopy },
        { label: "粘贴", role: "paste", enabled: params.editFlags.canPaste },
        { label: "全选", role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
    } else if (selected) {
      items.push(
        { label: "复制", role: "copy" },
        {
          label: "引用到 Loopsoar 对话",
          click: () => {
            if (win.isDestroyed()) return;
            win.webContents.send("loopsoar:ui:compose", { text: selected });
          },
        },
      );
    } else {
      items.push({ label: "复制", role: "copy", enabled: false });
    }
    items.push(
      { type: "separator" },
      {
        label: "设置",
        click: () => {
          if (!win.isDestroyed()) win.webContents.send("loopsoar:ui:openSettings", { section: "general" });
        },
      },
      { label: "重新加载界面", click: () => win.webContents.reload() },
      { label: "检查元素", click: () => win.webContents.inspectElement(params.x, params.y) },
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}
