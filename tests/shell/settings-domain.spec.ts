/**
 * settings 域：偏好/权限/规则/供应商测试 的落盘与读取（真实临时目录，不启 electron）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetHandlerRegistryForTests } from "../../packages/shell/src/main/trustedIpc.ts";
import {
  currentRulesPrompt,
  loadPermissions,
  loadPreferences,
  readRulesSnapshot,
  registerSettingsDomain,
  settingsPaths,
  type SettingsDeps,
} from "../../packages/shell/src/main/domains/settings.ts";
import type { LoopsoarPlatform } from "../../packages/core/src/platform/types.ts";

interface Captured {
  handlers: Map<string, (event: unknown, payload: unknown) => Promise<unknown>>;
}

function makeEnv(root: string, env: Record<string, string | undefined> = {}): { deps: SettingsDeps; captured: Captured } {
  const dataDir = path.join(root, "data");
  const configDir = path.join(dataDir, "config");
  const workspaceRoot = path.join(root, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const captured: Captured = { handlers: new Map() };
  const deps: SettingsDeps = {
    ipc: {
      handle: (channel: string, fn: unknown) => {
        captured.handlers.set(channel.replace(/^loopsoar:/, ""), fn as never);
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
  return { deps, captured };
}

const TRUSTED_EVENT = { senderFrame: { url: "loopsoar://app/index.html" } };

async function invoke(captured: Captured, channel: string, payload?: unknown): Promise<unknown> {
  const handler = captured.handlers.get(channel);
  if (!handler) throw new Error(`未注册 handler：${channel}`);
  return handler(TRUSTED_EVENT, payload);
}

let root: string;

beforeEach(() => {
  __resetHandlerRegistryForTests();
  root = mkdtempSync(path.join(tmpdir(), "loopsoar-settings-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("settings 域：通用偏好", () => {
  it("默认值 → 保存 → 落盘 → 再读取一致", async () => {
    const { captured } = makeEnv(root);
    const before = (await invoke(captured, "settings:getPreferences")) as {
      preferences: { animations: string };
    };
    expect(before.preferences.animations).toBe("full");

    await invoke(captured, "settings:setPreferences", {
      language: "en-US",
      animations: "reduced",
      restoreSession: false,
      searchEngine: "duckduckgo",
      downloadDir: "D:/dl",
    });

    const file = path.join(root, "data", "config", "preferences.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).searchEngine).toBe("duckduckgo");

    const after = (await invoke(captured, "settings:getPreferences")) as {
      preferences: { language: string; animations: string };
    };
    expect(after.preferences.language).toBe("en-US");
    expect(after.preferences.animations).toBe("reduced");
  });

  it("非法偏好被契约校验拒绝（渲染层不能写坏配置）", async () => {
    const { captured } = makeEnv(root);
    await expect(
      invoke(captured, "settings:setPreferences", {
        language: "zh-CN",
        animations: "warp-speed",
        restoreSession: true,
        searchEngine: "bing",
      }),
    ).rejects.toThrow(/参数校验失败/);
  });
});

describe("settings 域：权限", () => {
  it("默认 fail-closed → 保存 → 读取", async () => {
    const { captured } = makeEnv(root);
    const before = (await invoke(captured, "settings:getPermissions")) as {
      permissions: { write: string; confirmDangerousAlways: boolean };
    };
    expect(before.permissions.write).toBe("confirm");
    expect(before.permissions.confirmDangerousAlways).toBe(true);

    await invoke(captured, "settings:setPermissions", {
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

describe("settings 域：规则（AGENTS.md）", () => {
  it("读取项目 AGENTS.md 并合并进注入文本", async () => {
    const { deps, captured } = makeEnv(root);
    const workspaceAgents = path.join(deps.workspaceRoot, "AGENTS.md");
    writeFileSync(workspaceAgents, "# 项目规则\n- 构建：pnpm build", "utf8");

    const snapshot = readRulesSnapshot(deps);
    expect(snapshot.workspace.exists).toBe(true);
    expect(snapshot.merged.included.length).toBe(1);
    expect(currentRulesPrompt(deps)).toContain("pnpm build");

    const viaIpc = (await invoke(captured, "settings:getRules")) as {
      workspace: { content: string; exists: boolean };
      merged: { text: string };
    };
    expect(viaIpc.workspace.exists).toBe(true);
    expect(viaIpc.merged.text).toContain("pnpm build");
  });

  it("CLAUDE.md 兼容回退（无 AGENTS.md 时）", async () => {
    const { deps, captured } = makeEnv(root);
    writeFileSync(path.join(deps.workspaceRoot, "CLAUDE.md"), "claude 规则", "utf8");
    const viaIpc = (await invoke(captured, "settings:getRules")) as {
      workspace: { path: string; content: string };
      claudeCompat: boolean;
    };
    expect(viaIpc.claudeCompat).toBe(true);
    expect(viaIpc.workspace.path.endsWith("CLAUDE.md")).toBe(true);
    expect(viaIpc.workspace.content).toContain("claude 规则");
  });

  it("保存规则：双文件落盘 + 启用状态 + 合并结果", async () => {
    const { deps, captured } = makeEnv(root);
    const result = (await invoke(captured, "settings:setRules", {
      global: { enabled: true, content: "全局：回答用中文" },
      workspace: { enabled: false, content: "项目：只改 src/ 下文件" },
    })) as { merged: { included: { scope: string }[]; skipped: { reason: string }[] } };

    const paths = settingsPaths(deps);
    expect(existsSync(paths.globalRules)).toBe(true);
    expect(readFileSync(paths.globalRules, "utf8")).toContain("回答用中文");
    expect(readFileSync(path.join(deps.workspaceRoot, "AGENTS.md"), "utf8")).toContain("只改 src/");
    expect(result.merged.included.map((i) => i.scope)).toEqual(["global"]);
    expect(result.merged.skipped[0].reason).toBe("已停用");
  });

  it("规则过大 → 整体拒绝（不写入半截）", async () => {
    const { deps, captured } = makeEnv(root);
    const huge = "x".repeat(40 * 1024);
    await expect(
      invoke(captured, "settings:setRules", {
        global: { enabled: true, content: huge },
        workspace: { enabled: true, content: "" },
      }),
    ).rejects.toThrow(/规则保存被拒绝|参数校验失败/);
    expect(existsSync(settingsPaths(deps).globalRules)).toBe(false);
  });
});

describe("settings 域：诊断 / 关于 / 供应商测试", () => {
  it("诊断与关于返回稳定结构", async () => {
    const { captured } = makeEnv(root, { LOOPSOAR_API_KEY: "sk-secret" });
    const diag = (await invoke(captured, "settings:diagnostics")) as {
      paths: Record<string, string>;
      versions: Record<string, string>;
    };
    expect(diag.paths.dataDir).toContain(root);
    expect(diag.versions.app).toBe("9.9.9-test");

    const about = (await invoke(captured, "settings:about")) as { name: string; appId: string };
    expect(about.name).toBe("Loopsoar");
    expect(about.appId).toBe("com.loopsoar.app");

    const provider = (await invoke(captured, "settings:getProvider")) as {
      hasApiKey: boolean;
      configured: boolean;
    };
    expect(provider.hasApiKey).toBe(true);
    expect(provider.configured).toBe(false);
  });

  it("testProvider：成功/失败均返回可读结果（不回传密钥）", async () => {
    const { captured } = makeEnv(root, { LOOPSOAR_API_KEY: "sk-secret" });
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
      const ok = (await invoke(captured, "settings:testProvider", {
        provider: "p",
        baseUrl: "https://api.example.com/v1",
        model: "m",
      })) as { ok: boolean; message: string };
      expect(ok.ok).toBe(true);
      expect(ok.message).not.toContain("sk-secret");

      globalThis.fetch = (async () =>
        new Response("bad key", { status: 401 })) as typeof fetch;
      const bad = (await invoke(captured, "settings:testProvider", {
        provider: "p",
        baseUrl: "https://api.example.com/v1",
        model: "m",
      })) as { ok: boolean; status?: number };
      expect(bad.ok).toBe(false);
      expect(bad.status).toBe(401);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
