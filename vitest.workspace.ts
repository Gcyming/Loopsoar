import { defineWorkspace } from "vitest/config";

// 工作区只收 tests/**（守卫与集成用例）；包内源码由 vitest 直接加载。
export default defineWorkspace([
  {
    test: {
      name: "loopsoar-tests",
      environment: "node",
      include: ["tests/**/*.spec.ts"],
    },
  },
]);
