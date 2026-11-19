import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAppIconPath } from "../../packages/shell/src/main/appIcon.ts";

const ROOT = process.cwd();

describe("应用图标路径探测（dist/src/打包三种目录深度）", () => {
  it("dist bundle 运行（__dirname = packages/shell/dist）能找到 shell/resources/icon.ico", () => {
    const found = resolveAppIconPath({
      dirname: path.join(ROOT, "packages/shell/dist"),
      platform: "win32",
    });
    expect(found).toBeTruthy();
    expect(found).toBe(path.join(ROOT, "packages", "shell", "resources", "icon.ico"));
    expect(fs.existsSync(found as string)).toBe(true);
  });

  it("src 运行（__dirname = packages/shell/src/main）同样能找到", () => {
    const found = resolveAppIconPath({
      dirname: path.join(ROOT, "packages/shell/src/main"),
      platform: "win32",
    });
    expect(found).toBe(path.join(ROOT, "packages", "shell", "resources", "icon.ico"));
  });

  it("打包后从 resourcesPath 探测；非 Windows 优先 png", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-icon-"));
    fs.writeFileSync(path.join(dir, "icon.png"), "png");
    fs.writeFileSync(path.join(dir, "icon.ico"), "ico");
    const onLinux = resolveAppIconPath({ dirname: path.join(dir, "nope"), resourcesPath: dir, platform: "linux" });
    expect(onLinux).toBe(path.join(dir, "icon.png"));
    const onWindows = resolveAppIconPath({ dirname: path.join(dir, "nope"), resourcesPath: dir, platform: "win32" });
    expect(onWindows).toBe(path.join(dir, "icon.ico"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("都没有时返回 undefined（调用方保留 Electron 兜底）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-icon-empty-"));
    expect(resolveAppIconPath({ dirname: dir, platform: "win32" })).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("主进程接线：Windows 设置品牌 AUMID，主窗口/会话窗口都传图标", () => {
    const src = fs.readFileSync(path.join(ROOT, "packages/shell/src/main/index.ts"), "utf8");
    const paths = fs.readFileSync(path.join(ROOT, "packages/shell/src/main/mainPaths.ts"), "utf8");
    const mainWindow = fs.readFileSync(path.join(ROOT, "packages/shell/src/main/mainWindowFactory.ts"), "utf8");
    const brand = fs.readFileSync(path.join(ROOT, "packages/shell/src/shared/brand.ts"), "utf8");
    expect(brand).toContain('APP_ID = "com.loopsoar.app"');
    expect(src).toContain('if (process.platform === "win32") app.setAppUserModelId(APP_ID)');
    expect(paths).toContain("resolveAppIconPath(");
    expect(mainWindow).toContain("icon: appIcon,");
    // 会进任务栏的会话栏独立窗口也要图标（否则显示 Electron 默认）
    expect(src).toContain("icon: iconPath(),");
  });
});
