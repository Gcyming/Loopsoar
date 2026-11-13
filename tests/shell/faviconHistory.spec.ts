/**
 * 历史条目 favicon：data: URL 净化、合并、updateFavicon、重启后仍保留。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserHistoryStore } from "../../packages/shell/src/main/browserHistoryStore.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-favicon-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("历史 favicon", () => {
  it("记录时保存 data URL，updateFavicon 后可重启恢复", () => {
    const file = path.join(dir, "browser-history.json");
    const store = new BrowserHistoryStore(file);
    store.record({ url: "https://example.com/", title: "Example", favicon: PNG });
    expect(store.list()[0]?.favicon).toBe(PNG);

    const other = "data:image/svg+xml;base64,PHN2Zy8+";
    expect(store.updateFavicon("https://example.com/", other)).toBe(true);
    expect(store.list()[0]?.favicon).toBe(other);

    const restored = new BrowserHistoryStore(file);
    expect(restored.list()[0]?.favicon).toBe(other);
  });

  it("拒绝非图片 / 超长 favicon 且不影响标题记录", () => {
    const store = new BrowserHistoryStore(path.join(dir, "browser-history.json"));
    store.record({ url: "https://example.com/", title: "Example", favicon: "https://example.com/favicon.ico" });
    expect(store.list()[0]?.favicon).toBeUndefined();
    expect(store.updateFavicon("https://example.com/", "javascript:alert(1)")).toBe(false);
    expect(store.list()[0]?.favicon).toBeUndefined();
  });
});
