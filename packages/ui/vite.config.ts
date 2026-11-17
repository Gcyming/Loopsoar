import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ui 包构建配置：React 19 插件，产出到 dist/（与 tsc 的声明产出同目录，由 build 脚本顺序执行）。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React 运行时单独成块：主包只留产品代码，避免每次改 UI 都把 React 重新打进 649KB 大块。
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
});