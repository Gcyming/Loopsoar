import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeExtensionProtocolHandler } from "../../packages/shell/src/main/extensionProtocol.ts";
import type { ExtensionHost } from "../../packages/shell/src/main/extensions.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-proto-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeHost(ext: { dir: string; enabled: boolean; views: Array<{ id: string; title: string; entry: string }> }): ExtensionHost {
  return {
    list: () => [
      {
        dir: ext.dir,
        enabled: ext.enabled,
        installedAt: 1,
        manifest: { id: "demo", name: "Demo", version: "1.0.0", contributes: { views: ext.views } },
      },
    ],
  } as unknown as ExtensionHost;
}

describe("扩展富 UI 协议", () => {
  it("只服务声明了 views 的已启用扩展，并注入严格 CSP", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "index.html"), "<html>ok</html>");
    const handler = makeExtensionProtocolHandler(
      fakeHost({ dir, enabled: true, views: [{ id: "panel", title: "Panel", entry: "index.html" }] }),
    );
    const response = await handler(new Request("loopsoar-ext://demo/index.html"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>ok</html>");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("script-src loopsoar-ext://demo");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const disabled = makeExtensionProtocolHandler(
      fakeHost({ dir, enabled: false, views: [{ id: "panel", title: "Panel", entry: "index.html" }] }),
    );
    expect((await disabled(new Request("loopsoar-ext://demo/index.html"))).status).toBe(404);

    const noViews = makeExtensionProtocolHandler(fakeHost({ dir, enabled: true, views: [] }));
    expect((await noViews(new Request("loopsoar-ext://demo/index.html"))).status).toBe(404);
  });

  it("拒绝目录逃逸与不存在的文件", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "index.html"), "ok");
    fs.writeFileSync(path.join(path.dirname(dir), "secret.txt"), "secret");
    const handler = makeExtensionProtocolHandler(
      fakeHost({ dir, enabled: true, views: [{ id: "panel", title: "Panel", entry: "index.html" }] }),
    );
    expect((await handler(new Request("loopsoar-ext://demo/..%2fsecret.txt"))).status).toBe(404);
    expect((await handler(new Request("loopsoar-ext://demo/%2e%2e%2fsecret.txt"))).status).toBe(404);
    expect((await handler(new Request("loopsoar-ext://demo/missing.html"))).status).toBe(404);
  });
});
