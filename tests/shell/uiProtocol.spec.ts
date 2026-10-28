/**
 * loopsoar:// 协议映射（安全性核心）：路径穿越必须拒绝，MIME 正确。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  contentTypeFor,
  mapRequestToFile,
  resolveUiDistDir,
  uiDistCandidates,
  UI_ENTRY,
} from "../../packages/shell/src/main/uiProtocol.ts";

const DIST = path.resolve("C:/fake/ui/dist");

describe("路由映射", () => {
  it("根路径 → index.html", () => {
    const m = mapRequestToFile("loopsoar://app/", DIST);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.filePath).toBe(path.resolve(DIST, UI_ENTRY));
      expect(m.contentType).toContain("text/html");
    }
  });

  it("静态资源映射 + MIME", () => {
    const js = mapRequestToFile("loopsoar://app/assets/index-abc.js", DIST);
    expect(js.ok).toBe(true);
    if (js.ok) expect(js.contentType).toContain("text/javascript");
    const svg = mapRequestToFile("loopsoar://app/logo.svg", DIST);
    expect(svg.ok).toBe(true);
    if (svg.ok) expect(svg.contentType).toBe("image/svg+xml");
  });

  it("拒绝 ../ 穿越（含编码形态）：映射结果永远不得逃出 dist", () => {
    for (const bad of [
      "loopsoar://app/../../../Windows/win.ini",
      "loopsoar://app/%2e%2e/%2e%2e/etc/passwd",
      "loopsoar://app/..%5c..%5csecret.txt",
    ]) {
      const m = mapRequestToFile(bad, DIST);
      if (m.ok) {
        // URL 解析器会先折叠 ../（/Windows/win.ini），映射仍必须落在 dist 内
        expect(path.relative(DIST, m.filePath).startsWith(".."), `逃逸：${bad} → ${m.filePath}`).toBe(false);
      } else {
        expect([400, 403, 404]).toContain(m.status);
      }
    }
  });

  it("拒绝非 app 主机", () => {
    const m = mapRequestToFile("loopsoar://evil/index.html", DIST);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.status).toBe(404);
  });

  it("contentTypeFor 未知扩展名 → octet-stream", () => {
    expect(contentTypeFor("a.unknownext")).toBe("application/octet-stream");
  });
});

describe("UI 产物目录发现", () => {
  it("候选路径覆盖 src/dist/cwd 三种运行形态", () => {
    const candidates = uiDistCandidates("C:/repo/packages/shell/src/main", "C:/repo").map((c) =>
      c.replace(/\\/g, "/"),
    );
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    expect(candidates.some((c) => c.includes("packages/ui/dist"))).toBe(true);
    expect(candidates.some((c) => c === "C:/repo/packages/ui/dist")).toBe(true);
  });

  it("resolveUiDistDir：无 index.html 返回 null，有则命中", () => {
    const dir = path.join(tmpdir(), `loopsoar-ui-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    expect(resolveUiDistDir([dir])).toBeNull();
    writeFileSync(path.join(dir, UI_ENTRY), "<html></html>");
    expect(resolveUiDistDir([dir])).toBe(dir);
    expect(existsSync(path.join(dir, UI_ENTRY))).toBe(true);
  });
});
