/**
 * 打包态路径回归测试：asar 内的 worker 必须映射到 app.asar.unpacked 才能被子进程执行。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstExisting, toUnpackedPath, withUnpackedCandidates } from "../../packages/shell/src/main/packagedPaths.js";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-paths-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("toUnpackedPath", () => {
  it("Windows 路径把 app.asar 换成 app.asar.unpacked", () => {
    expect(toUnpackedPath("C:/app/resources/app.asar/dist/extensionWorker.mjs")).toBe(
      "C:/app/resources/app.asar.unpacked/dist/extensionWorker.mjs",
    );
  });

  it("没有 app.asar 段时原样返回", () => {
    expect(toUnpackedPath("C:/repo/packages/shell/dist/extensionWorker.mjs")).toBe(
      "C:/repo/packages/shell/dist/extensionWorker.mjs",
    );
  });
});

describe("withUnpackedCandidates", () => {
  it("unpacked 变体排在原路径之前，且不重复", () => {
    const list = withUnpackedCandidates(["C:/a/app.asar/dist/w.mjs", "C:/a/dist/w.mjs"]);
    expect(list[0]).toContain("app.asar.unpacked");
    expect(list.filter((item) => item.includes("app.asar.unpacked"))).toHaveLength(1);
    expect(list).toHaveLength(3);
  });
});

describe("firstExisting", () => {
  it("返回第一个存在的文件；都不存在时返回 fallback", () => {
    const real = path.join(tmp, "worker.mjs");
    fs.writeFileSync(real, "//");
    expect(firstExisting([path.join(tmp, "missing.mjs"), real], "fallback")).toBe(real);
    expect(firstExisting([path.join(tmp, "missing.mjs")], "fallback")).toBe("fallback");
  });
});
