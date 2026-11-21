import { defineWorkspace } from "vitest/config";
import { aliases, sourcePlugin } from "./vitest.shared";

// 工作区只收 tests/**（守卫与集成用例）；包内源码由 vitest 直接加载。
// 注意：workspace 存在时根 vitest.config.ts 不生效，源码解析必须在这里挂载。
export default defineWorkspace([
  {
    resolve: { alias: aliases },
    plugins: [sourcePlugin],
    ssr: { noExternal: [/^loopsoar-/] },
    test: {
      name: "loopsoar-tests",
      environment: "node",
      include: ["tests/**/*.spec.ts"],
      // 防止间接 import electron 时触发二进制下载（见文件内说明）。
      setupFiles: ["tests/setup/electron-env.ts"],
      server: { deps: { inline: [/^loopsoar-/] } },
    },
  },
]);
