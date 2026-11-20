/**
 * 扩展域装配：把宿主/运行时/市场/原生对话框接进 IPC 域。
 * 独立成模块控制 index.ts 体积，并把「对话框文案」从启动装配里剥离。
 */
import type { ExtensionHost } from "./extensions.js";
import type { ExtensionRuntime } from "./extensionRuntime.js";
import { registerExtensionsDomain } from "./domains/extensions.js";
import { openDirectoryNative } from "./mainPaths.js";
import type { TrustedIpcDeps } from "./trustedIpc.js";

export interface ExtensionWiringOptions {
  deps: TrustedIpcDeps;
  extensions: ExtensionHost;
  runtime: ExtensionRuntime;
  configDir: string;
  push: (event: string, payload: unknown) => void;
  /** 原生选择器（index.ts 注入 Electron dialog 绑定，本模块不 import electron）。 */
  pickSource: () => Promise<string | null>;
  openPath: (path: string) => Promise<string>;
}

export function registerExtensionWiring(opts: ExtensionWiringOptions): void {
  registerExtensionsDomain({
    ...opts.deps,
    extensions: opts.extensions,
    configDir: opts.configDir,
    extensionStatus: () => opts.runtime.statuses(),
    startExtension: (id) => opts.runtime.start(id),
    stopExtension: (id) => opts.runtime.stop(id),
    sendExtensionViewMessage: (id, viewId, message) => opts.runtime.sendViewMessage(id, viewId, message),
    push: opts.push,
    pickExtensionSource: opts.pickSource,
    openExtensionsDir: async () => {
      const error = await openDirectoryNative(opts.extensions.dirPath(), opts.openPath);
      if (error) console.log(`[Loopsoar] 打开扩展目录失败：${error}`);
      return error === "";
    },
  });
}
