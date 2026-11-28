import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ShortcutsStore, normalizeShortcutUrl } from "../../packages/shell/src/main/shortcutsStore.js";

const make = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shortcuts-"));
  return { dir, store: new ShortcutsStore(dir) };
};

describe("快捷方式存储", () => {
  it("补全协议：只写域名时按 https 处理", () => {
    expect(normalizeShortcutUrl("example.com")).toEqual({ ok: true, url: "https://example.com/" });
    expect(normalizeShortcutUrl("javascript:alert(1)").ok).toBe(false);
    expect(normalizeShortcutUrl("").ok).toBe(false);
  });

  it("新增后能读回，且同网址去重", () => {
    const { dir, store } = make();
    try {
      const first = store.add({ url: "https://a.example", title: "A" });
      expect(first.ok).toBe(true);
      const duplicate = store.add({ url: "https://a.example/" });
      expect(duplicate.ok && duplicate.duplicate).toBe(true);
      expect(store.list()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("上限淘汰最早添加的", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shortcuts-"));
    try {
      let clock = 0;
      const store = new ShortcutsStore(dir, { now: () => (clock += 1), maxItems: 3 });
      for (let i = 1; i <= 5; i += 1) store.add({ url: `https://s${i}.example`, title: `S${i}` });
      expect(store.list().map((item) => item.title)).toEqual(["S3", "S4", "S5"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("编辑标题/网址；网址冲突时拒绝", () => {
    const { dir, store } = make();
    try {
      const a = store.add({ url: "https://a.example", title: "A" });
      const b = store.add({ url: "https://b.example", title: "B" });
      if (!a.ok || !b.ok) throw new Error("准备失败");
      expect(store.update(a.shortcut.id, { title: "改名" }).ok).toBe(true);
      expect(store.list()[0].title).toBe("改名");
      expect(store.update(a.shortcut.id, { url: "https://b.example" }).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("移除与置顶；落盘是原子写且能重新读回", () => {
    const { dir, store } = make();
    try {
      const a = store.add({ url: "https://a.example", title: "A" });
      const b = store.add({ url: "https://b.example", title: "B" });
      if (!a.ok || !b.ok) throw new Error("准备失败");
      expect(store.moveToFront(b.shortcut.id)).toBe(true);
      expect(store.list().map((item) => item.title)).toEqual(["B", "A"]);
      expect(store.remove(a.shortcut.id)).toBe(true);
      expect(store.remove("missing")).toBe(false);
      const reopened = new ShortcutsStore(dir);
      expect(reopened.list().map((item) => item.title)).toEqual(["B"]);
      expect(JSON.parse(readFileSync(path.join(dir, "shortcuts.json"), "utf8")).version).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
