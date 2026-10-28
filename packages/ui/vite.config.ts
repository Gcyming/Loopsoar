import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ui 包构建配置：React 19 插件，产出到 dist/（与 tsc 的声明产出同目录，由 build 脚本顺序执行）。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});