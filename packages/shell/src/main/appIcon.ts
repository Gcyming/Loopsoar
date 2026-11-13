import fs from "node:fs";
import path from "node:path";

/**
 * 应用图标探测上下文（纯函数，便于单测；`__dirname`/`process.*` 由调用方注入）。
 *
 * 为什么需要多候选：主进程有三种运行形态，目录深度各不相同——
 *   · 开发态 bundle：`packages/shell/dist/main.bundle.mjs` → `{dirname}/../resources`
 *   · 开发态 src：`packages/shell/src/main/index.ts` → `{dirname}/../../resources`
 *   · 打包后：图标作为 extraResources 落到 `process.resourcesPath` 下
 * 早先只写死 `../../resources`，dist 运行时解析到不存在的 `packages/resources`，
 * 图标静默缺失 → 窗口/任务栏显示 Electron 默认图标（用户报障）。
 */
export interface AppIconSearch {
  /** 主进程入口所在目录（dist 运行 = packages/shell/dist；src 运行 = packages/shell/src/main）。 */
  dirname: string;
  /** 打包后进程 resourcesPath（开发态通常指向 electron 安装目录，探测不到就走其它候选）。 */
  resourcesPath?: string;
  /** 进程 cwd（开发态 = 仓库 `Parent file`，作为最后兜底）。 */
  cwd?: string;
  /** 目标平台：Windows 优先多档 `.ico`（任务栏清晰），其它平台优先 `.png`。 */
  platform?: NodeJS.Platform;
}

/**
 * 按优先级探测应用图标，返回首个存在的绝对路径；找不到返回 undefined（调用方保留 Electron 兜底）。
 * 同一根目录内先试平台首选扩展名，再试另一种，避免只有 png 时整窗图标丢失。
 */
export function resolveAppIconPath(input: AppIconSearch): string | undefined {
  const platform = input.platform ?? process.platform;
  const names = platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png", "icon.ico"];
  const roots: string[] = [
    path.join(input.dirname, "../resources"), // dist bundle 运行
    path.join(input.dirname, "../../resources"), // src/main 运行
  ];
  if (input.resourcesPath) {
    roots.push(path.join(input.resourcesPath, "icons"), input.resourcesPath); // 打包后
  }
  if (input.cwd) {
    roots.push(path.join(input.cwd, "packages/shell/resources"), path.join(input.cwd, "resources"));
  }
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
