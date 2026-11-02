/**
 * 品牌常量（shell/shared/brand.ts）用例：
 *   - 关键值锁定（产品名/应用 id/数据目录/协议/浏览器分区）；
 *   - 常量之间自洽（目录名 = 产品名小写，协议 = 目录名）；
 *   - 「单一产地」静态断言：浏览器持久化分区字面量只允许出现在 brand.ts，
 *     防止各文件各写一份导致 userData/分区漂移（ISOLATION.md 的硬规则）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_ID,
  APP_NAME,
  DATA_DIR_NAME,
  PROTOCOL,
  SESSION_PARTITION,
} from "../../packages/shell/src/shared/brand.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_SRC = path.resolve(HERE, "../../packages/shell/src");
const BRAND_FILE = path.join(SHELL_SRC, "shared/brand.ts");

/** 递归收集 shell 源码文件。 */
function listShellSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|cjs|mjs)$/.test(entry.name)) out.push(full);
    }
  };
  walk(SHELL_SRC);
  return out;
}

describe("品牌常量（brand.ts）", () => {
  it("产品名 / 应用 id / 数据目录 / 协议 / 浏览器分区锁定", () => {
    expect(APP_NAME).toBe("Loopsoar");
    expect(APP_ID).toBe("com.loopsoar.app");
    expect(DATA_DIR_NAME).toBe("loopsoar");
    expect(PROTOCOL).toBe("loopsoar");
    expect(SESSION_PARTITION).toBe("persist:loopsoar-browser");
  });

  it("常量之间自洽（不出现两套真值）", () => {
    expect(DATA_DIR_NAME).toBe(APP_NAME.toLowerCase());
    expect(APP_ID).toBe(`com.${DATA_DIR_NAME}.app`);
    expect(PROTOCOL).toBe(DATA_DIR_NAME);
    expect(SESSION_PARTITION).toBe(`persist:${DATA_DIR_NAME}-browser`);
  });

  it("格式合法：应用 id 反域名、协议符合 URL scheme、分区符合 persist: 约定", () => {
    expect(APP_ID).toMatch(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/);
    expect(PROTOCOL).toMatch(/^[a-z][a-z0-9+.-]*$/);
    expect(SESSION_PARTITION).toMatch(/^persist:[a-z0-9-]+$/);
  });

  it("浏览器持久化分区字面量只出现在 brand.ts（单一产地）", () => {
    const hits = listShellSources()
      .filter((file) => fs.readFileSync(file, "utf8").includes(SESSION_PARTITION))
      .map((file) => path.relative(SHELL_SRC, file).replace(/\\/g, "/"));
    expect(hits.sort()).toEqual(["shared/brand.ts"]);
  });

  it("brand.ts 是唯一品牌模块（路径与导出形状固定）", () => {
    expect(fs.existsSync(BRAND_FILE)).toBe(true);
    const text = fs.readFileSync(BRAND_FILE, "utf8");
    for (const name of ["APP_NAME", "APP_ID", "DATA_DIR_NAME", "PROTOCOL", "SESSION_PARTITION"]) {
      expect(text).toContain(`export const ${name}`);
    }
  });
});
