/**
 * 插件宿主（ADR-0011）：manifest 校验 / 装载卸载 / builtin 保护 / 工具贡献真实现。
 */
import { describe, expect, it } from "vitest";
import { PluginHost } from "../../packages/core/src/plugin/host.ts";
import { validateManifest, type PluginManifest } from "../../packages/core/src/plugin/manifest.ts";
import { ContributionScope } from "../../packages/core/src/plugin/scope.ts";

function mf(partial: Partial<PluginManifest> & { name: string }): PluginManifest {
  return { version: "1.0.0", origin: "user", provides: ["tools"], ...partial };
}

describe("插件清单校验", () => {
  it("合法清单无错误", () => {
    expect(validateManifest(mf({ name: "demo-plugin" }))).toEqual([]);
  });

  it("非法名 / 未知 provides / 未知 contributes / 自引 requires → 报错", () => {
    const errors = validateManifest({
      name: "Bad Name",
      version: "",
      origin: "user",
      provides: ["tools", "teleport" as never],
      requires: ["Bad Name"],
      contributes: { unknownKey: true } as never,
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.join()).toMatch(/插件名/);
    expect(errors.join()).toMatch(/未知贡献点/);
    expect(errors.join()).toMatch(/未知键/);
    expect(errors.join()).toMatch(/自引/);
  });

  it("provides 去重检查", () => {
    const errors = validateManifest(mf({ name: "dup", provides: ["tools", "tools"] }));
    expect(errors.join()).toMatch(/重复/);
  });
});

describe("贡献点作用域", () => {
  it("逆序 dispose + 幂等 + 单失败不阻断", () => {
    const scope = new ContributionScope();
    const order: string[] = [];
    scope.register({ label: "a", dispose: () => { order.push("a"); } });
    scope.register({ label: "b", dispose: () => { order.push("b"); throw new Error("b 失败"); } });
    scope.register({ label: "c", dispose: () => { order.push("c"); } });
    const errors = scope.disposeAll();
    expect(order).toEqual(["c", "b", "a"]); // 逆序
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("b 失败");
    expect(scope.disposeAll()).toEqual([]); // 幂等
  });

  it("销毁后拒绝新注册（fail-closed）", () => {
    const scope = new ContributionScope();
    scope.disposeAll();
    expect(() => scope.register({ label: "x", dispose: () => {} })).toThrow(/已销毁/);
  });
});

describe("插件宿主", () => {
  it("装载 → 卸载（逆序 dispose）→ 工具贡献一并撤销", () => {
    const host = new PluginHost();
    host.load({ manifest: mf({ name: "p1", provides: ["tools"] }) });
    host.registerTools("p1", [{ name: "p1_tool", description: "x", permissions: { read: true } }]);
    expect(host.toolsProvider("p1")?.length).toBe(1);
    const errors = host.unload("p1");
    expect(errors).toEqual([]);
    expect(host.list().length).toBe(0);
    expect(host.toolsProvider("p1")).toBeNull(); // 卸载后为 null（不是空数组）
  });

  it("builtin 插件不可卸载（系统根保护）", () => {
    const host = new PluginHost();
    host.load({ manifest: mf({ name: "core-tools", origin: "builtin" }) });
    const errors = host.unload("core-tools");
    expect(errors[0]).toMatch(/builtin/);
    expect(host.list().length).toBe(1);
  });

  it("工具贡献要求先声明 provides: tools；未声明 → 抛错", () => {
    const host = new PluginHost();
    host.load({ manifest: mf({ name: "p2", provides: ["settings"] }) });
    expect(() => host.registerTools("p2", [])).toThrow(/provides: tools/);
  });

  it("未声明 provides: tools 的插件 toolsProvider 返回 null", () => {
    const host = new PluginHost();
    host.load({ manifest: mf({ name: "p3", provides: ["settings"] }) });
    expect(host.toolsProvider("p3")).toBeNull();
  });

  it("依赖未装载 → 装载失败；批量装载按拓扑序 + 环检测", () => {
    const host = new PluginHost();
    expect(() => host.load({ manifest: mf({ name: "child", requires: ["parent"] }) })).toThrow(/未装载/);

    const host2 = new PluginHost();
    host2.loadAll([
      { manifest: mf({ name: "app", requires: ["lib"] }) },
      { manifest: mf({ name: "lib" }) },
    ]);
    expect(host2.loadOrder()).toEqual(["lib", "app"]);

    const host3 = new PluginHost();
    expect(() =>
      host3.loadAll([
        { manifest: mf({ name: "a", requires: ["b"] }) },
        { manifest: mf({ name: "b", requires: ["a"] }) },
      ]),
    ).toThrow(/依赖环/);
  });

  it("systemRoots 只含 builtin 来源", () => {
    const host = new PluginHost();
    host.load({ manifest: mf({ name: "b1", origin: "builtin" }) });
    host.load({ manifest: mf({ name: "u1", origin: "user" }) });
    expect(host.systemRoots().map((m) => m.name)).toEqual(["b1"]);
  });
});
