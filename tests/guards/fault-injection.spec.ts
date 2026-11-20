/**
 * 故障注入（架构稳固性维度缺口 3/3）。
 *
 * 为什么需要这一类测试：既不缺单测也不缺 E2E，缺的是「输入是坏的时候还算不算数」的证明。
 * 只测 happy path 的架构，第一次遇到「磁盘满 / 配置被手改成非法值 / 工具后端突然消失」
 * 就会整体不可用；而这类失败恰恰是最难复现、最容易被当成「用户环境问题」的那一类。
 *
 * 本文件的约定（也是产品约定）：
 *   · 启动输入（偏好/权限）必须 total：任何磁盘状态都要返回一份可用配置，绝不抛错；
 *   · 辅助功能（历史/标签状态）损坏必须降级为空数据并留证，不能阻断主流程；
 *   · 工具失败必须 ok:false + 稳定错误码，不能抛到调用栈或变成 unhandled rejection；
 *   · 不认识的约束一律 fail-closed（宁可拒绝，不可放行）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "loopsoar-core/tools/registry";
import { checkExtensionCompatibility } from "../../packages/core/src/extensionCompat.ts";
import type { ExtensionManifest } from "../../packages/contracts/src/extension.ts";
import { loadPermissions, loadPreferences, savePreferencesPatch } from "../../packages/shell/src/main/domains/settings.ts";
import { BrowserStateStore } from "../../packages/shell/src/main/browserStateStore.ts";
import { BrowserHistoryStore } from "../../packages/shell/src/main/browserHistoryStore.ts";
import { registerBrowserTools } from "../../packages/shell/src/main/browserTools.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-fault-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("故障注入：启动输入必须 total（坏配置不能白屏）", () => {
  it("偏好结构合法但字段非法 → 回到默认值，并把坏文件留证", () => {
    const dir = tempDir();
    const file = path.join(dir, "preferences.json");
    // 这一条在修之前会 throw（mergePreferences 严格校验），启动直接失败。
    fs.writeFileSync(file, JSON.stringify({ agentMaxRounds: "not-a-number", language: 42 }), "utf8");

    const prefs = loadPreferences(dir);

    expect(prefs.agentMaxRounds).toBeGreaterThan(0);
    expect(typeof prefs.language).toBe("string");
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.startsWith("preferences.json.invalid-"))).toBe(true);
  });

  it("偏好是半截 JSON → 解析容错，回到默认值且不产生 invalid 副本", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "preferences.json"), '{"language": "zh', "utf8");
    // 半截 JSON 在 readJsonFile 就被吃掉（视为「没有配置」），不该被当成「有配置但非法」。
    expect(() => loadPreferences(dir)).not.toThrow();
    expect(loadPreferences(dir).language).toBeTruthy();
  });

  it("权限非法 → 回到默认值，不阻断启动", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "permissions.json"), JSON.stringify({ read: "definitely-not-a-level" }), "utf8");
    const perms = loadPermissions(dir);
    expect(["allow", "ask", "deny"]).toContain(perms.read as string);
  });

  it("保存偏好是原子写：不留临时文件，且能被原样读回", () => {
    const dir = tempDir();
    const saved = savePreferencesPatch(dir, { agentMaxRounds: 12 });
    expect(saved.agentMaxRounds).toBe(12);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")).length).toBe(0);
    expect(loadPreferences(dir).agentMaxRounds).toBe(12);
  });
});

describe("故障注入：辅助状态损坏必须降级而不是阻断", () => {
  it("标签状态文件损坏 → 读成空，仍可继续写入", () => {
    const dir = tempDir();
    const file = path.join(dir, "browser-state.json");
    fs.writeFileSync(file, "{{{{ not json", "utf8");
    const store = new BrowserStateStore(file, { debounceMs: 0 });

    expect(store.get("s1")).toBeNull();
    store.set("s1", { tabs: [{ url: "https://example.com/", title: "示例" }], activeIndex: 0 });
    store.flush();

    expect(new BrowserStateStore(file, { debounceMs: 0 }).get("s1")).toEqual({
      tabs: [{ url: "https://example.com/", title: "示例" }],
      activeIndex: 0,
    });
  });

  it("历史文件损坏 → 空历史 + 原名隔离留证（不静默覆盖证据）", () => {
    const dir = tempDir();
    const file = path.join(dir, "browser-history.json");
    fs.writeFileSync(file, "not json at all", "utf8");

    const store = new BrowserHistoryStore(file);

    expect(store.list()).toEqual([]);
    expect(fs.readdirSync(dir).some((name) => name.startsWith("browser-history.json.corrupt-"))).toBe(true);
  });

  it("历史只接受 http(s)：坏 URL 不落盘、不抛错", () => {
    const dir = tempDir();
    const store = new BrowserHistoryStore(path.join(dir, "browser-history.json"));
    expect(store.record({ url: "javascript:alert(1)" })).toBeNull();
    expect(store.record({ url: "file:///etc/passwd" })).toBeNull();
    expect(store.record({ url: "" })).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe("故障注入：工具失败必须是可分流的结果，不是异常", () => {
  /** 最小假宿主：只实现被调用到的面；snapshot 抛错模拟适配器崩溃。 */
  function crashingHost() {
    return {
      activeTabId: () => "tab-1",
      snapshot: async () => {
        throw new Error("renderer gone");
      },
      listTabs: () => [],
      getTab: () => null,
    };
  }

  it("浏览器后端不存在 → ok:false + NO_HOST（fail-closed，不抛）", async () => {
    const registry = new ToolRegistry();
    registerBrowserTools(registry, () => null);
    const tool = registry.get("browser_snapshot");
    expect(tool).toBeDefined();

    const result = await tool!.execute({ agentId: "a", params: {}, platform: null });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("NO_HOST");
  });

  it("适配器抛错 → ok:false + 错误码，不把异常抛给调用方", async () => {
    const registry = new ToolRegistry();
    registerBrowserTools(registry, () => crashingHost() as never);
    const tool = registry.get("browser_snapshot")!;

    const result = await tool.execute({ agentId: "a", params: {}, platform: null });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("UNKNOWN");
    expect(result.content).toContain("renderer gone");
  });

  it("未知约束（apiVersion 无法解析）→ blocked，而不是「当作没约束」放行", () => {
    const manifest = {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      apiVersion: "latest",
      permissions: [],
    } as unknown as ExtensionManifest;

    const report = checkExtensionCompatibility(manifest, { hostApiVersion: "2.0.0" });

    expect(report.status).toBe("blocked");
    expect(report.errors).toBeGreaterThan(0);
  });
});
