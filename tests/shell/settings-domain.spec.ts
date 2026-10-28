/**
 * settings 域：偏好/权限/规则条目/诊断/供应商测试 的落盘与读取（真实临时目录，不启 electron）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetHandlerRegistryForTests } from "../../packages/shell/src/main/trustedIpc.ts";
import {
  currentRulesPrompt,
  loadPermissions,
  loadPreferences,
  readRuleEntries,
  registerSettingsDomain,
  settingsPaths,
  type SettingsDeps,
} from "../../packages/shell/src/main/domains/settings.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

function makeEnv(root: string, env: Record<string, string | undefined> = {}) {
  const dataDir = path.join(root, "data");
  const configDir = path.join(dataDir, "config");
  const workspaceRoot = path.join(root, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const handlers = new Map<string, (e: unknown, p: unknown) => Promise<unknown>>();
  const deps: SettingsDeps = {
    ipc: {
      handle: (channel: string, fn: unknown) => {
        handlers.set(channel.replace(/^loopsoar:/, ""), fn as never);
      },
    },
    audit: () => {},
    platform: {} as LoopsoarPlatform,
    dataDir,
    configDir,
    workspaceRoot,
    env,
    appVersion: "9.9.9-test",
  };
  registerSettingsDomain(deps);
  return { deps, handlers };
}

const TRUSTED = { senderFrame: { url: "loopsoar://app/index.html" } };

async function invoke(
  handlers: Map<string, (e: unknown, p: unknown) => Promise<unknown>>,
  channel: string,
  payload?: unknown,
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册 handler：${channel}`);
  return handler(TRUSTED, payload);
}

const FULL_PREFS = {
  language: "zh-CN" as const,
  animations: "full" as const,
  restoreSession: true,
  searchEngine: "bing" as const,
  downloadDir: "",
  workspaceRoot: "",
  memoryStorePath: "",
  memoryAutoCapture: true,
  sidebarWidth: 360,
};

let root: string;

beforeEach(() => {
  __resetHandlerRegistryForTests();
  root = mkdtempSync(path.join(tmpdir(), "loopsoar-settings-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("settings 域：通用偏好", () => {
  it("默认值（含记忆开关）→ 保存 → 落盘读取一致", async () => {
    const { handlers } = makeEnv(root);
    const before = (await invoke(handlers, "settings:getPreferences")) as {
      preferences: { animations: string; memoryAutoCapture: boolean };
      locations: { dataDir: string; defaultMemoryFile: string };
    };
    expect(before.preferences.animations).toBe("full");
    expect(before.preferences.memoryAutoCapture).toBe(true);
    expect(before.locations.dataDir).toContain(root);

    await invoke(handlers, "settings:setPreferences", {
      ...FULL_PREFS,
      animations: "reduced",
      memoryAutoCapture: false,
    });
    const file = path.join(root, "data", "config", "preferences.json");
    expect(JSON.parse(readFileSync(file, "utf8")).animations).toBe("reduced");
    expect(loadPreferences(path.join(root, "data", "config")).memoryAutoCapture).toBe(false);
  });

  it("非法偏好被契约校验拒绝", async () => {
    const { handlers } = makeEnv(root);
    await expect(
      invoke(handlers, "settings:setPreferences", { ...FULL_PREFS, animations: "warp" }),
    ).rejects.toThrow(/参数校验失败/);
  });
});

describe("settings 域：权限", () => {
  it("默认 fail-closed → 保存 → 读取", async () => {
    const { handlers } = makeEnv(root);
    const before = (await invoke(handlers, "settings:getPermissions")) as {
      permissions: { write: string; terminal: string };
    };
    expect(before.permissions.write).toBe("confirm");
    expect(before.permissions.terminal).toBe("confirm");

    await invoke(handlers, "settings:setPermissions", {
      read: "allow",
      write: "confirm",
      terminal: "deny",
      network: "allow",
      workspaceRoots: ["D:/w1"],
      confirmDangerousAlways: true,
    });
    expect(loadPermissions(path.join(root, "data", "config")).terminal).toBe("deny");
  });
});

describe("settings 域：规则条目（逐条增删）", () => {
  it("项目 AGENTS.md → 生成 workspace 条目并合并进注入文本", async () => {
    const { deps, handlers } = makeEnv(root);
    writeFileSync(path.join(deps.workspaceRoot, "AGENTS.md"), "# 项目规则\n- 构建：pnpm build", "utf8");

    const entries = readRuleEntries(deps);
    const ws = entries.find((e) => e.scope === "workspace")!;
    expect(ws.content).toContain("pnpm build");
    expect(currentRulesPrompt(deps)).toContain("pnpm build");

    const viaIpc = (await invoke(handlers, "settings:getRules")) as {
      entries: { scope: string; content: string }[];
      merged: { text: string };
    };
    expect(viaIpc.entries.some((e) => e.scope === "workspace" && e.content.includes("pnpm build"))).toBe(true);
    expect(viaIpc.merged.text).toContain("pnpm build");
  });

  it("新建全局规则 + 项目规则 → 双文件落盘 + 合并顺序（全局在前）", async () => {
    const { deps, handlers } = makeEnv(root);
    const result = (await invoke(handlers, "settings:setRules", {
      entries: [
        { name: "风格.md", scope: "global", enabled: true, content: "全局：用中文回答" },
        { scope: "workspace", enabled: true, content: "项目：只改 src/ 下文件" },
      ],
    })) as { entries: { scope: string; name: string; enabled: boolean }[]; merged: { included: { scope: string }[] } };

    const paths = settingsPaths(deps);
    expect(existsSync(path.join(paths.globalRulesDir, "风格.md"))).toBe(true);
    expect(readFileSync(path.join(deps.workspaceRoot, "AGENTS.md"), "utf8")).toContain("只改 src/");
    expect(result.merged.included.map((i) => i.scope)).toEqual(["global", "workspace"]);
    expect(result.entries.filter((e) => e.enabled).length).toBeGreaterThanOrEqual(2);
  });

  it("停用条目 → 不进入合并，但保留内容", async () => {
    const { deps, handlers } = makeEnv(root);
    await invoke(handlers, "settings:setRules", {
      entries: [{ name: "off.md", scope: "global", enabled: false, content: "不要注入" }],
    });
    const prompt = currentRulesPrompt(deps);
    expect(prompt).not.toContain("不要注入");
    const entries = readRuleEntries(deps);
    expect(entries.find((e) => e.name === "off.md")?.enabled).toBe(false);
  });

  it("删除全局条目 → 文件被移除", async () => {
    const { deps, handlers } = makeEnv(root);
    await invoke(handlers, "settings:setRules", {
      entries: [{ name: "temp.md", scope: "global", enabled: true, content: "临时" }],
    });
    const file = path.join(settingsPaths(deps).globalRulesDir, "temp.md");
    expect(existsSync(file)).toBe(true);
    await invoke(handlers, "settings:setRules", { entries: [], deleted: ["global:temp.md"] });
    expect(existsSync(file)).toBe(false);
  });

  it("非法文件名 → 拒绝整体保存（不写半截）", async () => {
    const { deps, handlers } = makeEnv(root);
    await expect(
      invoke(handlers, "settings:setRules", {
        entries: [{ name: "../escape.md", scope: "global", enabled: true, content: "x" }],
      }),
    ).rejects.toThrow(/规则保存被拒绝/);
    const dir = settingsPaths(deps).globalRulesDir;
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
  });

  it("规则超大 → 拒绝（契约层 32768 上限）", async () => {
    const { handlers } = makeEnv(root);
    await expect(
      invoke(handlers, "settings:setRules", {
        entries: [{ name: "big.md", scope: "global", enabled: true, content: "x".repeat(40 * 1024) }],
      }),
    ).rejects.toThrow(/规则保存被拒绝|参数校验失败/);
  });
});

describe("settings 域：诊断 / 关于 / 供应商", () => {
  it("诊断与关于结构稳定（路径与实际数据目录一致）", async () => {
    const { handlers } = makeEnv(root, { LOOPSOAR_API_KEY: "sk-secret" });
    const diag = (await invoke(handlers, "settings:diagnostics")) as {
      paths: Record<string, string>;
      versions: Record<string, string>;
    };
    expect(diag.paths.dataDir).toContain(root);
    expect(diag.paths.memoryFile).toContain("memory.json");
    expect(diag.versions.app).toBe("9.9.9-test");

    const about = (await invoke(handlers, "settings:about")) as { name: string; appId: string };
    expect(about.name).toBe("Loopsoar");
    expect(about.appId).toBe("com.loopsoar.app");

    const provider = (await invoke(handlers, "settings:getProvider")) as {
      hasApiKey: boolean;
      configured: boolean;
    };
    expect(provider.hasApiKey).toBe(true);
    expect(provider.configured).toBe(false);
  });

  it("testProvider：成功/失败返回可读结果（不回传密钥）", async () => {
    const { handlers } = makeEnv(root, { LOOPSOAR_API_KEY: "sk-secret" });
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
      const okRes = (await invoke(handlers, "settings:testProvider", {
        provider: "p",
        baseUrl: "https://api.example.com/v1",
        model: "m",
      })) as { ok: boolean; message: string };
      expect(okRes.ok).toBe(true);
      expect(okRes.message).not.toContain("sk-secret");

      globalThis.fetch = (async () => new Response("bad", { status: 401 })) as typeof fetch;
      const badRes = (await invoke(handlers, "settings:testProvider", {
        provider: "p",
        baseUrl: "https://api.example.com/v1",
        model: "m",
      })) as { ok: boolean; status?: number };
      expect(badRes.ok).toBe(false);
      expect(badRes.status).toBe(401);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
