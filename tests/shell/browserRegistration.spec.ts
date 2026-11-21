import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  browserLaunchCommand,
  registerAsBrowser,
  windowsBrowserRegistryEntries,
  type RegistryEntry,
} from "../../packages/shell/src/main/browserRegistration.js";

const input = {
  appName: "Loopsoar",
  executablePath: "C:\\Program Files\\Loopsoar\\Loopsoar.exe",
  packaged: true,
  platform: "win32" as const,
};

function entry(entries: RegistryEntry[], key: string, name?: string): RegistryEntry | undefined {
  return entries.find((item) => item.key === key && item.name === name);
}

describe("系统浏览器注册：Windows 能力声明与 URL 命令", () => {
  it("打包后命令直接启动 exe，并把系统传入的 URL 放到 %1", () => {
    expect(browserLaunchCommand(input)).toBe('"C:\\Program Files\\Loopsoar\\Loopsoar.exe" "%1"');
  });

  it("开发期命令先加载 Electron appPath，再传 URL", () => {
    expect(
      browserLaunchCommand({
        executablePath: "C:\\Tools\\electron.exe",
        appPath: "C:\\repo\\packages\\shell\\dist\\main.bundle.mjs",
      }),
    ).toBe('"C:\\Tools\\electron.exe" "C:\\repo\\packages\\shell\\dist\\main.bundle.mjs" "%1"');
  });

  it("注册 StartMenuInternet、Capabilities、ProgID 与 RegisteredApplications", () => {
    const entries = windowsBrowserRegistryEntries(input);
    const clientKey = "HKCU\\Software\\Clients\\StartMenuInternet\\Loopsoar";
    const capabilities = `${clientKey}\\Capabilities`;
    const progId = "LoopsoarHTML";

    expect(entry(entries, clientKey)?.value).toBe("Loopsoar");
    expect(entry(entries, `${clientKey}\\shell\\open\\command`)?.value).toContain('"%1"');
    expect(entry(entries, capabilities, "ApplicationName")?.value).toBe("Loopsoar");
    expect(entry(entries, `${capabilities}\\URLAssociations`, "http")?.value).toBe(progId);
    expect(entry(entries, `${capabilities}\\URLAssociations`, "https")?.value).toBe(progId);
    expect(entry(entries, "HKCU\\Software\\RegisteredApplications", "Loopsoar")?.value).toBe(
      "Software\\Clients\\StartMenuInternet\\Loopsoar\\Capabilities",
    );
    expect(entry(entries, `HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`)?.value).toContain(
      '"%1"',
    );
  });

  it("通过 reg.exe 写入时每条都带 /f，且开发期缺 appPath 会明确失败", () => {
    const calls: string[][] = [];
    const ok = registerAsBrowser(input, (args) => calls.push(args));
    expect(ok.ok).toBe(true);
    expect(ok.registered).toBe(true);
    expect(calls.length).toBe(windowsBrowserRegistryEntries(input).length);
    expect(calls.every((args) => args.includes("/f"))).toBe(true);

    const bad = registerAsBrowser(
      { ...input, packaged: false, appPath: null },
      () => {
        throw new Error("不应写入注册表");
      },
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("appPath");
  });

  it("Linux 写入 WebBrowser desktop entry，系统才能把它当成浏览器", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-browser-"));
    try {
      const envResult = registerAsBrowser(
        {
          ...input,
          platform: "linux",
          executablePath: "/opt/Loopsoar/loopsoar",
          env: { HOME: dir, XDG_DATA_HOME: path.join(dir, "share") },
        },
        () => {
          throw new Error("Linux 不应调用 reg.exe");
        },
      );
      expect(envResult.ok).toBe(true);
      const file = path.join(dir, "share", "applications", "loopsoar.desktop");
      expect(fs.existsSync(file)).toBe(true);
      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain("Categories=Network;WebBrowser;");
      expect(text).toContain("x-scheme-handler/https");
      expect(text).toContain('"/opt/Loopsoar/loopsoar" %U');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
