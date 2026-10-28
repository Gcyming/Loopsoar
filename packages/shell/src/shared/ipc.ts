/**
 * IPC 契约重导出（契约单源在 loopsoar-contracts）。
 * 注意：main 进程直接用这些生成物；preload 不 import 本文件（CJS 预加载脚本
 * 通过 additionalArguments 接收序列化后的白名单，避免 CJS/ESM 互操作问题）。
 */
export {
  IPC_CHANNELS,
  IPC_VALIDATORS,
  buildPreloadWhitelist,
  EVENT_NAMES,
} from "loopsoar-contracts/ipc";

/** 通道全名：主进程/预加载统一用 `loopsoar:<channel>` 作为 ipcMain 通道名。 */
export function channelName(channel: string): string {
  return `loopsoar:${channel}`;
}
