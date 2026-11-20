/**
 * 扩展安装来源选择（纯逻辑，不 import electron）。
 * 宿主注入两个最小对话框能力，index.ts 负责绑定真实 Electron dialog。
 */

export interface ExtensionPickerDialogs {
  messageBox(options: {
    type: "question";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
  }): Promise<{ response: number }>;
  openDialog(options: {
    title: string;
    properties: Array<"openFile" | "openDirectory">;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export async function pickExtensionSource(dialogs: ExtensionPickerDialogs): Promise<string | null> {
  const choice = await dialogs.messageBox({
    type: "question",
    title: "安装扩展",
    message: "选择扩展来源",
    detail: "支持已解压的扩展目录，或带 loopsoar.extension.json 的 .zip 包。",
    buttons: ["选择 .zip 包", "选择扩展目录", "取消"],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice.response === 2) return null;
  const result = await dialogs.openDialog(
    choice.response === 0
      ? { title: "选择扩展包", properties: ["openFile"], filters: [{ name: "Loopsoar 扩展包", extensions: ["zip"] }] }
      : { title: "选择扩展目录", properties: ["openDirectory"] },
  );
  return result.canceled ? null : (result.filePaths[0] ?? null);
}
